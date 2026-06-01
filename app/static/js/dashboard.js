(() => {
  const FIXED_SCALES = [1, 3, 6, 9, 12, 15, 18, 21, 24];
  const INDICATOR_NAMES = {
    SPI: "Standardized Precipitation Index (SPI)",
    SSI: "Standardized Soil Moisture Index (SSI)",
    SRI: "Standardized Runoff Index (SRI)",
    SSFI: "Standardized Streamflow Index (SSFI)",
    SRHI: "Standardized Relative Humidity Index (SRHI)",
    SGI: "Standardised Groundwater level Index (SGI)",
    SSWSI: "Standardized Surface Water Supply Index (SSWSI)",
    SWSI: "Standardized Water Storage Index (SWSI)"
  };

  let pyodide = null;
  let map = null;
  let markerLayer = null;
  let rasterLayer = null;
  let rasterLegend = null;
  let chart = null;
  let gridPreview = null;
  let gridOutput = null;
  let pyodideReady = false;
  let h5wasmModule = null;
  let mapScaleIndex = 0;
  let mapDateIndex = 0;
  let shouldPersistGridOutput = false;

  let stationResults = {};
  let stationMetaDates = {};
  let stationPoints = {};
  let stationOrder = [];
  let selectedScales = [];
  let stationIndex = 0;
  let scaleIndex = 0;
  let currentRunId = null;
  let currentRunPayload = null;
  let jobsPage = 1;
  const JOBS_PAGE_SIZE = 5;
  const RUN_BUTTON_LABEL = '<i class="bx bx-play-circle me-1"></i>Run Calculation';
  const CSV_DOWNLOAD_LABEL = '<i class="bx bx-download me-1"></i>Download Results (CSV)';
  const NC_DOWNLOAD_LABEL = '<i class="bx bx-cloud-download me-1"></i>Download Results (NetCDF)';
  const NC_DOWNLOAD_BUSY_LABEL = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Preparing NetCDF';

  function buildScaleChecklist() {
    const wrap = document.getElementById("scaleList");
    wrap.classList.add("scale-grid");
    wrap.innerHTML = "";
    FIXED_SCALES.forEach((s) => {
      const id = `sc_${s}`;
      const row = document.createElement("div");
      row.className = "form-check scale-item";
      row.innerHTML = `<input class="form-check-input scale-cb" type="checkbox" id="${id}" value="${s}" ${s <= 12 ? "checked" : ""}>
      <label class="form-check-label" for="${id}">${s}</label>`;
      wrap.appendChild(row);
    });
  }

  function selectedScaleValues() {
    return [...document.querySelectorAll(".scale-cb:checked")].map((e) => parseInt(e.value, 10));
  }

  function updateNavVisibility() {
    const prevStation = document.getElementById("prevStation");
    const nextStation = document.getElementById("nextStation");
    const prevScale = document.getElementById("prevScale");
    const nextScale = document.getElementById("nextScale");
    const stationEnabled = stationOrder.length > 1;
    const scaleEnabled = selectedScales.length > 1;
    prevStation.disabled = !stationEnabled;
    nextStation.disabled = !stationEnabled;
    prevScale.disabled = !scaleEnabled;
    nextScale.disabled = !scaleEnabled;
  }

  function rasterVariableForScale(sc) {
    if (!gridOutput?.variables) return null;
    return gridOutput.variables[sc] || gridOutput.variables[String(sc)] || null;
  }

  function rasterCacheKeyForScale(sc) {
    if (!gridOutput?.cacheKeys) return null;
    return gridOutput.cacheKeys[sc] || gridOutput.cacheKeys[String(sc)] || null;
  }

  function hasMapGridOutput() {
    const sc = selectedScales[Math.max(0, Math.min(mapScaleIndex, selectedScales.length - 1))];
    return Boolean(
      gridPreview
      && selectedScales.length
      && gridOutput?.width
      && gridOutput?.height
      && gridOutput?.timeCount
      && (rasterVariableForScale(sc) || rasterCacheKeyForScale(sc))
    );
  }

  function validMapDateStart(sc) {
    return Math.max(0, Number(sc || 1) - 1);
  }

  function updateMapControls() {
    const controls = document.getElementById("mapControls");
    const meta = document.getElementById("mapMeta");
    if (!controls || !meta) return;

    const hasGrid = hasMapGridOutput();
    controls.classList.toggle("d-none", !gridPreview);
    const prevScale = document.getElementById("prevMapScale");
    const nextScale = document.getElementById("nextMapScale");
    const prevDate = document.getElementById("prevMapDate");
    const nextDate = document.getElementById("nextMapDate");
    const sc = selectedScales[Math.max(0, Math.min(mapScaleIndex, selectedScales.length - 1))];
    const timeCount = Number(gridOutput?.timeCount || gridPreview?.dates?.length || 0);
    const firstDate = validMapDateStart(sc);
    const lastDate = Math.max(firstDate, timeCount - 1);
    const scaleEnabled = hasGrid && selectedScales.length > 1;
    const dateEnabled = hasGrid && lastDate > firstDate;
    [prevScale, nextScale].forEach((btn) => { if (btn) btn.disabled = !scaleEnabled; });
    [prevDate, nextDate].forEach((btn) => { if (btn) btn.disabled = !dateEnabled; });

    if (!gridPreview) {
      meta.textContent = "";
      return;
    }
    const dates = gridPreview.dates || [];
    const dateLabel = dates[mapDateIndex] || "-";
    meta.textContent = hasGrid
      ? `Map Raster | Scale: ${sc} | Date: ${dateLabel}`
      : "Map Raster | Only the saved preview layer is available for this run.";
  }

  function updateDownloadButtons(payload = null) {
    const csvBtn = document.getElementById("downloadCsvBtn");
    const ncBtn = document.getElementById("downloadNcBtn");
    const variables = payload?.gridOutput?.variables || {};
    const cacheKeys = payload?.gridOutput?.cacheKeys || {};
    if (csvBtn) {
      csvBtn.innerHTML = CSV_DOWNLOAD_LABEL;
      csvBtn.disabled = !currentRunId;
    }
    if (ncBtn) {
      ncBtn.innerHTML = NC_DOWNLOAD_LABEL;
      ncBtn.disabled = !(currentRunId && (Object.keys(variables).length || Object.keys(cacheKeys).length));
    }
  }

  function setNcDownloadLoading(loading) {
    const ncBtn = document.getElementById("downloadNcBtn");
    if (!ncBtn) return;
    ncBtn.innerHTML = loading ? NC_DOWNLOAD_BUSY_LABEL : NC_DOWNLOAD_LABEL;
    ncBtn.disabled = loading ? true : !currentRunId;
  }

  function showError(message) {
    const body = document.getElementById("errorModalBody");
    body.textContent = message;
    const modalEl = document.getElementById("errorModal");
    const modal = new bootstrap.Modal(modalEl);
    modal.show();
  }

  async function initPyodideRuntime() {
    pyodide = await loadPyodide();
    await pyodide.loadPackage("numpy");
    await pyodide.runPythonAsync(`
import numpy as np

def _norminv(arr):
    p = np.asarray(arr, dtype=float)
    x = np.full_like(p, np.nan, dtype=float)
    p = np.clip(p, 1e-12, 1 - 1e-12)
    a = np.array([-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
                  1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00])
    b = np.array([-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
                  6.680131188771972e+01, -1.328068155288572e+01])
    c = np.array([-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
                  -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00])
    d = np.array([7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
                  3.754408661907416e+00])
    plow = 0.02425
    phigh = 1 - plow

    low = p < plow
    high = p > phigh
    mid = ~(low | high)

    if np.any(low):
        q = np.sqrt(-2 * np.log(p[low]))
        x[low] = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                 ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if np.any(high):
        q = np.sqrt(-2 * np.log(1 - p[high]))
        x[high] = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
                  ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if np.any(mid):
        q = p[mid] - 0.5
        r = q * q
        x[mid] = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
                 (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    return x

def _emp_prob(d):
    d = np.asarray(d, dtype=float).reshape(-1)
    nnn = len(d)
    bp = np.zeros(nnn, dtype=float)
    for i in range(nnn):
        bp[i] = np.sum(d <= d[i])
    return (bp - 0.44) / (nnn + 0.12)

def sdat_vector(td, sc):
    td = np.asarray(td, dtype=float).reshape(-1)
    n = len(td)
    si = np.zeros(n, dtype=float)
    if np.sum(td >= 0) / len(td) != 1:
        si[n - 1] = np.nan
        return si.tolist()
    si[:sc-1] = np.nan
    a1 = []
    for i in range(sc):
        a1.append(td[i:n-sc+i+1])
    y = np.sum(np.column_stack(a1), axis=1)
    nn = len(y)
    si1 = np.zeros(nn, dtype=float)
    for k in range(12):
        d = y[k:nn:12]
        si1[k:nn:12] = _emp_prob(d)
    si1 = np.clip(si1, 1e-12, 1 - 1e-12)
    si1 = _norminv(si1)
    si[sc-1:] = si1
    return si.tolist()

sdat_grid_cache = {}

def sdat_grid_summary(cube_flat, time_count, height, width, sc, include_grid=True, cache_key=None):
    cube = np.asarray(cube_flat, dtype=float).reshape((time_count, height * width))
    out = np.full((time_count, height * width), np.nan, dtype=float)
    valid = np.all(cube >= 0, axis=0)
    if np.any(valid) and sc <= time_count:
        valid_idx = np.where(valid)[0]
        valid_cube = cube[:, valid_idx]
        cs = np.vstack([np.zeros((1, valid_cube.shape[1]), dtype=float), np.cumsum(valid_cube, axis=0)])
        y = cs[sc:, :] - cs[:-sc, :]
        nn = y.shape[0]
        si1 = np.full_like(y, np.nan, dtype=float)
        for k in range(12):
            rows = np.arange(k, nn, 12)
            if rows.size == 0:
                continue
            d = y[rows, :]
            counts = np.empty_like(d, dtype=float)
            for i in range(d.shape[0]):
                counts[i, :] = np.sum(d <= d[i:i+1, :], axis=0)
            probs = (counts - 0.44) / (d.shape[0] + 0.12)
            si1[rows, :] = _norminv(probs)
        out[sc-1:, valid_idx] = si1

    with np.errstate(all="ignore"):
        mean_series = np.nanmean(out, axis=1)

    finite_rows = np.where(np.isfinite(out).any(axis=1))[0]
    heat_index = int(finite_rows[-1]) if finite_rows.size else max(0, time_count - 1)
    heat = out[heat_index, :]
    if cache_key is not None:
        sdat_grid_cache[str(cache_key)] = out
    result = {
        "mean": mean_series.tolist(),
        "heat": heat.tolist(),
        "timeIndex": heat_index
    }
    if include_grid:
        result["grid"] = out.reshape(-1).tolist()
    return result

def sdat_grid_slice(cache_key, time_index):
    out = sdat_grid_cache[str(cache_key)]
    return out[int(time_index), :].tolist()
    `);
    pyodideReady = true;
  }

  function setRunButtonState(disabled, label) {
    const btn = document.getElementById("runBtn");
    if (!btn) return;
    btn.disabled = disabled;
    if (label) btn.innerHTML = label;
  }

  function setUploadStatus(message, busy = false, visible = true) {
    const wrap = document.getElementById("uploadStatus");
    const text = document.getElementById("uploadStatusText");
    if (!wrap || !text) return;
    wrap.classList.toggle("d-none", !visible);
    const spinner = wrap.querySelector(".spinner-border");
    if (spinner) spinner.classList.toggle("d-none", !busy);
    text.textContent = message;
  }

  function setVisualizationLoading(loading, scope = "both") {
    const chartOverlay = document.getElementById("chartLoadingOverlay");
    const mapOverlay = document.getElementById("mapLoadingOverlay");
    const chartBusy = scope === "both" || scope === "chart";
    const mapBusy = scope === "both" || scope === "map";
    if (chartOverlay) chartOverlay.classList.toggle("d-none", !(loading && chartBusy));
    if (mapOverlay) mapOverlay.classList.toggle("d-none", !(loading && mapBusy));
  }

  function releaseSelectedInputFile(message = "Input file released from browser memory.") {
    const input = document.getElementById("dataFile");
    if (input) input.value = "";
    setUploadStatus(message, false, true);
  }

  function initMap() {
    map = L.map("map").setView([25, 10], 2);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap"
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function clearRasterLegend() {
    if (rasterLegend) {
      map.removeControl(rasterLegend);
      rasterLegend = null;
    }
  }

  function updateRasterLegend(min, max, title) {
    clearRasterLegend();
    const low = -3;
    const high = 3;
    let gradient = "linear-gradient(90deg, rgb(220, 0, 0), rgb(245, 247, 250), rgb(0, 80, 255))";
    const labels = `<span>${low.toFixed(2)}</span><span>0.00</span><span>${high.toFixed(2)}</span>`;
    rasterLegend = L.control({ position: "bottomright" });
    rasterLegend.onAdd = () => {
      const div = L.DomUtil.create("div", "sdat-raster-legend");
      div.innerHTML = `
        <div class="sdat-raster-legend-title">${title || "SDAT value"}</div>
        <div class="sdat-raster-legend-bar" style="background: ${gradient}"></div>
        <div class="sdat-raster-legend-labels">
          ${labels}
        </div>
      `;
      return div;
    };
    rasterLegend.addTo(map);
  }

  function blendColor(a, b, t) {
    const clamped = Math.max(0, Math.min(1, t));
    return a.map((value, i) => Math.round(value + (b[i] - value) * clamped));
  }

  function finiteMinMax(values) {
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (const raw of values || []) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      count += 1;
    }
    return count ? { min, max } : null;
  }

  function initChart() {
    chart = echarts.init(document.getElementById("seriesChart"));
    window.addEventListener("resize", () => chart.resize());
  }

  function downloadPayloadAsCsv(payload, filename) {
    const rows = ["STATION,SCALE,DATE,VALUE"];
    const sOrder = payload.stationOrder || [];
    const sDates = payload.stationMetaDates || {};
    const sResults = payload.stationResults || {};
    for (const sid of sOrder) {
      const scaleMap = sResults[sid] || {};
      for (const [sc, arr] of Object.entries(scaleMap)) {
        const dates = sDates[sid] || [];
        arr.forEach((v, i) => rows.push(`${sid},${sc},${fmtYm(dates[i], i)},${v}`));
      }
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function pad4Bytes(bytes) {
    const pad = (4 - (bytes.length % 4)) % 4;
    if (!pad) return bytes;
    const out = new Uint8Array(bytes.length + pad);
    out.set(bytes);
    return out;
  }

  function asciiBytes(text) {
    return new TextEncoder().encode(String(text));
  }

  function int32Bytes(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value >>> 0, false);
    return out;
  }

  function doubleBytes(values) {
    const arr = Array.from(values || []);
    const out = new Uint8Array(arr.length * 8);
    const view = new DataView(out.buffer);
    arr.forEach((value, i) => {
      const n = value === null || value === undefined ? NaN : Number(value);
      view.setFloat64(i * 8, Number.isFinite(n) ? n : NaN, false);
    });
    return out;
  }

  function ncString(text) {
    const raw = asciiBytes(text);
    return concatBytes([int32Bytes(raw.length), pad4Bytes(raw)]);
  }

  function ncAttrs(attrs) {
    const entries = Object.entries(attrs || {});
    if (!entries.length) return concatBytes([int32Bytes(0), int32Bytes(0)]);
    const parts = [int32Bytes(12), int32Bytes(entries.length)];
    entries.forEach(([name, value]) => {
      const raw = asciiBytes(value);
      parts.push(ncString(name), int32Bytes(2), int32Bytes(raw.length), pad4Bytes(raw));
    });
    return concatBytes(parts);
  }

  function concatBytes(parts) {
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    parts.forEach((part) => {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  function ncVariableHeader(variable, begin) {
    const parts = [
      ncString(variable.name),
      int32Bytes(variable.dimIds.length),
      ...variable.dimIds.map(int32Bytes),
      ncAttrs(variable.attrs),
      int32Bytes(6),
      int32Bytes(variable.dataBytes.length),
      int32Bytes(begin)
    ];
    return concatBytes(parts);
  }

  function buildGridNetcdf(payload) {
    const grid = payload.gridOutput;
    if (!grid?.variables || !Object.keys(grid.variables).length) {
      throw new Error("This run does not contain gridded NetCDF output.");
    }

    const width = Number(grid.width);
    const height = Number(grid.height);
    const timeCount = Number(grid.timeCount);
    const latitudes = grid.latitudes || [];
    const longitudes = grid.longitudes || [];
    const times = (grid.timeValues || []).length === timeCount
      ? grid.timeValues.map(Number)
      : Array.from({ length: timeCount }, (_, i) => i);
    const indicator = grid.indicator || "SDAT";
    if (latitudes.length !== height || longitudes.length !== width) {
      throw new Error("Stored gridded output is missing valid latitude/longitude coordinates.");
    }

    const dims = [["time", timeCount], ["lat", height], ["lon", width]];
    const variables = [
      {
        name: "time",
        dimIds: [0],
        attrs: { units: grid.timeUnits || "months since 2001-01-01", calendar: "gregorian" },
        dataBytes: pad4Bytes(doubleBytes(times))
      },
      {
        name: "lat",
        dimIds: [1],
        attrs: { units: "degrees_north" },
        dataBytes: pad4Bytes(doubleBytes(latitudes))
      },
      {
        name: "lon",
        dimIds: [2],
        attrs: { units: "degrees_east" },
        dataBytes: pad4Bytes(doubleBytes(longitudes))
      }
    ];

    Object.entries(grid.variables).forEach(([scale, values]) => {
      if (!Array.isArray(values) || values.length !== timeCount * height * width) {
        throw new Error(`Stored NetCDF output for scale ${scale} is incomplete.`);
      }
      variables.push({
        name: `${indicator}_${scale}`,
        dimIds: [0, 1, 2],
        attrs: {
          units: "standardized index",
          long_name: `${indicator} scale ${scale}`,
          coordinates: "time lat lon"
        },
        dataBytes: pad4Bytes(doubleBytes(values))
      });
    });

    const dimParts = [int32Bytes(10), int32Bytes(dims.length)];
    dims.forEach(([name, size]) => dimParts.push(ncString(name), int32Bytes(size)));
    const dimPart = concatBytes(dimParts);
    const globalAttrs = ncAttrs({
      title: "SDAT gridded output",
      source: "Standardized Drought Analysis Dashboard",
      spatial_ref: "WGS84 / EPSG:4326"
    });

    const buildHeader = (begins) => {
      const varParts = [int32Bytes(11), int32Bytes(variables.length)];
      variables.forEach((variable, i) => varParts.push(ncVariableHeader(variable, begins[i] || 0)));
      return concatBytes([
        asciiBytes("CDF"),
        new Uint8Array([1]),
        int32Bytes(0),
        dimPart,
        globalAttrs,
        concatBytes(varParts)
      ]);
    };

    let begins = new Array(variables.length).fill(0);
    while (true) {
      const header = pad4Bytes(buildHeader(begins));
      let cursor = header.length;
      const next = [];
      variables.forEach((variable) => {
        next.push(cursor);
        cursor += variable.dataBytes.length;
      });
      if (next.every((value, i) => value === begins[i])) {
        const blobBytes = concatBytes([header, ...variables.map((variable) => variable.dataBytes)]);
        return new Blob([blobBytes], { type: "application/x-netcdf" });
      }
      begins = next;
    }
  }

  async function hydrateGridOutputFromCache(payload) {
    const grid = payload?.gridOutput;
    if (!grid?.cacheKeys) return payload;
    const variables = { ...(grid.variables || {}) };
    for (const [scale, cacheKey] of Object.entries(grid.cacheKeys)) {
      if (!variables[scale]) {
        const values = await gridAllValuesFromCache(cacheKey);
        if (values) variables[scale] = values;
      }
    }
    return {
      ...payload,
      gridOutput: {
        ...grid,
        variables
      }
    };
  }

  async function downloadPayloadAsNetcdf(payload, filename) {
    const hydrated = await hydrateGridOutputFromCache(payload);
    const blob = buildGridNetcdf(hydrated);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function columnByNames(cols, names) {
    const lower = cols.map((c) => c.toLowerCase().trim());
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return cols[i];
    }
    return null;
  }

  function parseMonthlyDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;

    let m = text.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/);
    if (m) {
      return {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3] || 1)
      };
    }

    m = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      return {
        year: Number(m[3]),
        month: a > 12 ? b : a,
        day: a > 12 ? a : b
      };
    }

    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate()
      };
    }
    return null;
  }

  function monthlyDateKey(value) {
    const parsed = parseMonthlyDate(value);
    if (!parsed || parsed.month < 1 || parsed.month > 12) return null;
    return parsed.year * 10000 + parsed.month * 100 + Math.max(1, parsed.day || 1);
  }

  function formatMonthlyDate(value, idx) {
    const parsed = parseMonthlyDate(value);
    if (!parsed || parsed.month < 1 || parsed.month > 12) {
      return String(idx + 1).padStart(2, "0");
    }
    return `${parsed.year}-${String(parsed.month).padStart(2, "0")}`;
  }

  function parseTabular(text) {
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true });
    const cols = parsed.meta.fields || [];
    const required = ["ID", "DATE", "VALUE", "LAT", "LONG", "ELEV"];
    const norm = cols.map((c) => String(c).trim().toUpperCase());
    const missing = required.filter((h) => !norm.includes(h));
    if (missing.length) {
      throw new Error(`Invalid format. Missing required headers: ${missing.join(", ")}. Expected headers: ID,DATE,VALUE,LAT,LONG,ELEV`);
    }
    const idCol = cols[norm.indexOf("ID")];
    const dateCol = cols[norm.indexOf("DATE")];
    const valCol = cols[norm.indexOf("VALUE")];
    const latCol = cols[norm.indexOf("LAT")];
    const lonCol = cols[norm.indexOf("LONG")];

    const groups = {};
    let rowOrder = 0;
    for (const r of parsed.data) {
      const id = String(r[idCol] ?? "ST01");
      const v = Number(r[valCol]);
      if (!Number.isFinite(v)) continue;
      if (!groups[id]) groups[id] = { rows: [], points: [] };
      const dateValue = dateCol ? String(r[dateCol] ?? "") : "";
      groups[id].rows.push({
        value: v,
        date: dateValue,
        dateKey: monthlyDateKey(dateValue),
        order: rowOrder
      });
      rowOrder += 1;
      if (latCol && lonCol && Number.isFinite(Number(r[latCol])) && Number.isFinite(Number(r[lonCol]))) {
        groups[id].points.push([Number(r[latCol]), Number(r[lonCol])]);
      }
    }
    Object.values(groups).forEach((rec) => {
      rec.rows.sort((a, b) => {
        if (a.dateKey !== null && b.dateKey !== null) return a.dateKey - b.dateKey;
        if (a.dateKey !== null) return -1;
        if (b.dateKey !== null) return 1;
        return a.order - b.order;
      });
      rec.values = rec.rows.map((row) => row.value);
      rec.dates = rec.rows.map((row) => row.date);
      delete rec.rows;
    });
    return groups;
  }

  function fmtYm(s, idx) {
    if (!s) return String(idx + 1).padStart(2, "0");
    return formatMonthlyDate(s, idx);
  }

  function renderChart() {
    if (!stationOrder.length || !selectedScales.length) return;
    const stationId = stationOrder[stationIndex];
    const sc = selectedScales[scaleIndex];
    const series = stationResults[stationId][sc];
    const rawDates = stationMetaDates[stationId] || [];
    const labels = series.map((_, i) => fmtYm(rawDates[i], i));
    const indicatorKey = document.getElementById("indicatorType").value;

    document.getElementById("resultMeta").innerHTML =
      `<span class="result-pill">Station: ${stationId}</span><span class="result-pill">Scale: ${sc}</span>`;

    chart.setOption({
      animation: false,
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          const p = params.find((x) => x.seriesName && x.seriesName.length > 0) || params[0];
          const val = Number(p.data);
          const txt = Number.isFinite(val) ? val.toFixed(3) : p.data;
          return `${p.axisValue}<br/>${indicatorKey}-${sc}: ${txt}`;
        }
      },
      legend: { data: [`${indicatorKey}-${sc}`] },
      toolbox: { feature: { dataZoom: { yAxisIndex: "none" }, restore: {}, saveAsImage: {} } },
      grid: { left: 60, right: 24, top: 40, bottom: 85 },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: { rotate: 45, formatter: (v) => v }
      },
      yAxis: {
        type: "value",
        name: INDICATOR_NAMES[indicatorKey],
        nameLocation: "middle",
        nameGap: 48
      },
      dataZoom: [
        { type: "inside", start: 0, end: 100 },
        { type: "slider", start: 0, end: 100, height: 20, bottom: 20 }
      ],
      series: [
        {
          name: `${indicatorKey}-${sc}`,
          type: "line",
          z: 10,
          showSymbol: false,
          smooth: false,
          lineStyle: { color: "#5b6b88", width: 2 },
          data: series
        },
        {
          name: "",
          type: "line",
          silent: true,
          tooltip: { show: false },
          showSymbol: false,
          lineStyle: { width: 0, opacity: 0 },
          symbol: "none",
          areaStyle: { color: "rgba(0, 80, 255, 0.60)" },
          data: series.map((v) => (Number.isFinite(v) && v > 0 ? v : 0)),
          z: 2
        },
        {
          name: "",
          type: "line",
          silent: true,
          tooltip: { show: false },
          showSymbol: false,
          lineStyle: { width: 0, opacity: 0 },
          symbol: "none",
          areaStyle: { color: "rgba(220, 0, 0, 0.60)" },
          data: series.map((v) => (Number.isFinite(v) && v < 0 ? v : 0)),
          z: 2
        }
      ]
    }, true);
  }

  async function computeForStation(values, scales) {
    if (!pyodideReady || !pyodide) {
      throw new Error("Pyodide runtime is still loading. Please wait a few seconds and run again.");
    }
    const out = {};
    for (const sc of scales) {
      pyodide.globals.set("js_td", values);
      pyodide.globals.set("js_sc", sc);
      const pyOut = await pyodide.runPythonAsync("sdat_vector(js_td, int(js_sc))");
      out[sc] = pyOut.toJs ? pyOut.toJs() : pyOut;
    }
    return out;
  }

  async function computeForGrid(cube, scales, includeFullGrid = true) {
    if (!pyodideReady || !pyodide) {
      throw new Error("Pyodide runtime is still loading. Please wait a few seconds and run again.");
    }
    const flat = [];
    cube.bands.forEach((band) => {
      for (const value of band) flat.push(Number(value));
    });

    const summaries = {};
    const cachePrefix = `grid_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    for (const sc of scales) {
      const cacheKey = `${cachePrefix}_${sc}`;
      pyodide.globals.set("js_cube_flat", flat);
      pyodide.globals.set("js_time_count", cube.timeCount);
      pyodide.globals.set("js_height", cube.height);
      pyodide.globals.set("js_width", cube.width);
      pyodide.globals.set("js_sc", sc);
      pyodide.globals.set("js_include_grid", includeFullGrid);
      pyodide.globals.set("js_cache_key", cacheKey);
      const pyOut = await pyodide.runPythonAsync(
        "sdat_grid_summary(js_cube_flat, int(js_time_count), int(js_height), int(js_width), int(js_sc), bool(js_include_grid), str(js_cache_key))"
      );
      const jsOut = pyOut.toJs ? pyOut.toJs({ dict_converter: Object.fromEntries }) : pyOut;
      jsOut.cacheKey = cacheKey;
      summaries[sc] = jsOut;
    }
    return summaries;
  }

  function drawStations(groups) {
    markerLayer.clearLayers();
    const pts = [];
    Object.entries(groups).forEach(([sid, rec]) => {
      if (rec.points.length) {
        const p = rec.points[0];
        pts.push(p);
        L.circleMarker(p, {
          radius: 7,
          color: "#0050ff",
          fillColor: "#2a7fff",
          fillOpacity: 0.9,
          weight: 2
        }).addTo(markerLayer).bindPopup(sid);
      }
    });
    if (pts.length) {
      map.fitBounds(pts, { padding: [20, 20] });
      setTimeout(() => map.invalidateSize(), 50);
    } else {
      alert("No valid LAT/LONG station coordinates were found in the file.");
    }
  }

  function syntheticDates(count) {
    return Array.from({ length: count }, (_, i) => `T${String(i + 1).padStart(3, "0")}`);
  }

  function syntheticMonthlyDates(count, start = "2001-01-01") {
    const base = new Date(`${String(start).slice(0, 10)}T00:00:00Z`);
    const y0 = Number.isNaN(base.getTime()) ? 2001 : base.getUTCFullYear();
    const m0 = Number.isNaN(base.getTime()) ? 0 : base.getUTCMonth();
    return Array.from({ length: count }, (_, i) => {
      const month = m0 + i;
      const y = y0 + Math.floor(month / 12);
      const m = ((month % 12) + 12) % 12;
      return `${y}-${String(m + 1).padStart(2, "0")}`;
    });
  }

  function addUtcMonths(date, months) {
    return new Date(Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + Math.round(Number(months)),
      date.getUTCDate() || 1
    ));
  }

  function formatDateYm(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  function labelsFromTime(timeValues, units, count) {
    const values = Array.from(timeValues || []).map(Number);
    const unitText = String(units || "").trim();
    const since = unitText.match(/^(seconds?|minutes?|hours?|days?|months?|years?)\s+since\s+(\d{4}-\d{1,2}(?:-\d{1,2})?)/i);
    if (since && values.length === count) {
      const unit = since[1].toLowerCase();
      const originText = since[2].length === 7 ? `${since[2]}-01` : since[2];
      const origin = new Date(`${originText}T00:00:00Z`);
      if (!Number.isNaN(origin.getTime())) {
        return values.map((value, i) => {
          let date;
          if (unit.startsWith("month")) {
            date = addUtcMonths(origin, value);
          } else if (unit.startsWith("year")) {
            date = addUtcMonths(origin, value * 12);
          } else {
            const factors = { second: 1000, seconds: 1000, minute: 60000, minutes: 60000, hour: 3600000, hours: 3600000, day: 86400000, days: 86400000 };
            date = new Date(origin.getTime() + value * (factors[unit] || 86400000));
          }
          return formatDateYm(date) || syntheticMonthlyDates(count, originText)[i];
        });
      }
    }

    if (values.length === count && values.every((value) => Number.isFinite(value))) {
      const parsed = values.map((value) => {
        const s = String(Math.trunc(value));
        if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
        if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
        return null;
      });
      if (parsed.every(Boolean)) return parsed;
    }

    return syntheticMonthlyDates(count);
  }

  function normalizeBbox(bbox) {
    if (!bbox || bbox.length !== 4 || bbox.some((v) => !Number.isFinite(Number(v)))) {
      throw new Error("Raster must include a valid WGS84 bounding box.");
    }
    return bbox.map(Number);
  }

  function ncName(item) {
    return String(typeof item === "string" ? item : item?.name ?? "").trim();
  }

  function ncDimName(reader, dimRef) {
    if (typeof dimRef === "number") return ncName((reader.dimensions || [])[dimRef]);
    if (typeof dimRef === "string") return dimRef.trim();
    if (typeof dimRef?.id === "number") return ncName((reader.dimensions || [])[dimRef.id]);
    if (typeof dimRef?.index === "number") return ncName((reader.dimensions || [])[dimRef.index]);
    return ncName(dimRef);
  }

  function ncDimIndex(reader, dimRef) {
    const dims = reader.dimensions || [];
    if (typeof dimRef === "number") return dimRef;
    if (typeof dimRef?.id === "number") return dimRef.id;
    if (typeof dimRef?.index === "number") return dimRef.index;
    const name = ncDimName(reader, dimRef);
    return dims.findIndex((d) => ncName(d) === name);
  }

  function ncVariableDimIndex(reader, variable, fallbackName) {
    const refs = variable?.dimensions || [];
    if (!refs.length) return -1;
    const idx = ncDimIndex(reader, refs[0]);
    if (idx >= 0) return idx;
    const name = fallbackName.toLowerCase();
    return (reader.dimensions || []).findIndex((d) => ncName(d).toLowerCase() === name);
  }

  function ncDimSize(reader, dimRef) {
    const name = ncDimName(reader, dimRef);
    const dim = typeof dimRef === "number"
      ? (reader.dimensions || [])[dimRef]
      : (reader.dimensions || []).find((d) => ncName(d) === name);
    return Number(dim?.size ?? dim?.length ?? 0);
  }

  function findNcVariable(reader, names) {
    const wanted = names.map((n) => n.toLowerCase());
    return (reader.variables || []).find((v) => wanted.includes(ncName(v).toLowerCase()));
  }

  function getNcData(reader, variable) {
    return Array.from(reader.getDataVariable(ncName(variable)));
  }

  function ncAttributeValues(variable, names) {
    const wanted = names.map((name) => name.toLowerCase());
    return (variable.attributes || [])
      .filter((attr) => wanted.includes(ncName(attr).toLowerCase()))
      .flatMap((attr) => Array.isArray(attr.value) ? attr.value : [attr.value])
      .map(Number)
      .filter((value) => Number.isFinite(value));
  }

  function ncAttributeText(variable, names) {
    const wanted = names.map((name) => name.toLowerCase());
    const attr = (variable.attributes || []).find((item) => wanted.includes(ncName(item).toLowerCase()));
    if (!attr) return "";
    const value = Array.isArray(attr.value) ? attr.value.join("") : attr.value;
    return String(value ?? "").replace(/\0/g, "").trim();
  }

  function flatIndex(indices, sizes) {
    let idx = indices[0];
    for (let i = 1; i < sizes.length; i++) idx = idx * sizes[i] + indices[i];
    return idx;
  }

  async function parseNetcdfClassic(ab) {
    const ReaderClass = window.netcdfjs?.NetCDFReader || window.NetCDFReader || window.netcdfjs;
    if (!ReaderClass) throw new Error("NetCDF parser is not available.");
    const reader = new ReaderClass(ab);
    const vars = reader.variables || [];
    const latVar = findNcVariable(reader, ["lat", "latitude", "y"]);
    const lonVar = findNcVariable(reader, ["lon", "longitude", "x"]);
    const timeVar = findNcVariable(reader, ["time"]);
    if (!latVar || !lonVar) throw new Error("NetCDF must include 1D lat/latitude and lon/longitude coordinate variables.");

    const lats = getNcData(reader, latVar).map(Number);
    const lons = getNcData(reader, lonVar).map(Number);
    const timeValues = timeVar ? getNcData(reader, timeVar) : [];
    const timeUnits = timeVar ? ncAttributeText(timeVar, ["units"]) : "";
    const height = lats.length;
    const width = lons.length;
    const coordNames = [ncName(latVar).toLowerCase(), ncName(lonVar).toLowerCase(), "time"];
    const dataVar = vars.find((v) => {
      const dims = (v.dimensions || []).map((dim) => ncDimName(reader, dim));
      return dims.length === 3 && !coordNames.includes(ncName(v).toLowerCase());
    });
    if (!dataVar) throw new Error("NetCDF must include one 3D data variable with exactly time, lat, and lon dimensions.");

    const dimRefs = dataVar.dimensions || [];
    const dimNames = dimRefs.map((dim) => ncDimName(reader, dim));
    const dimSizes = dimRefs.map((dim) => ncDimSize(reader, dim));
    const lowerDims = dimNames.map((name) => name.toLowerCase());
    let timePos = lowerDims.findIndex((name) => name === "time");
    let latPos = lowerDims.findIndex((name) => ["lat", "latitude", "y"].includes(name));
    let lonPos = lowerDims.findIndex((name) => ["lon", "longitude", "x"].includes(name));

    const dataDimIndices = dimRefs.map((dim) => ncDimIndex(reader, dim));
    const timeDimIndex = timeVar ? ncVariableDimIndex(reader, timeVar, "time") : -1;
    const latDimIndex = ncVariableDimIndex(reader, latVar, "lat");
    const lonDimIndex = ncVariableDimIndex(reader, lonVar, "lon");
    if (timePos < 0 && timeDimIndex >= 0) timePos = dataDimIndices.indexOf(timeDimIndex);
    if (latPos < 0 && latDimIndex >= 0) latPos = dataDimIndices.indexOf(latDimIndex);
    if (lonPos < 0 && lonDimIndex >= 0) lonPos = dataDimIndices.indexOf(lonDimIndex);

    if (timePos < 0 || latPos < 0 || lonPos < 0) {
      const used = new Set([latPos, lonPos].filter((pos) => pos >= 0));
      if (timePos < 0) {
        timePos = dimSizes.findIndex((size, pos) => !used.has(pos) && size === timeValues.length);
        if (timePos >= 0) used.add(timePos);
      }
      if (latPos < 0) {
        latPos = dimSizes.findIndex((size, pos) => !used.has(pos) && size === height);
        if (latPos >= 0) used.add(latPos);
      }
      if (lonPos < 0) {
        lonPos = dimSizes.findIndex((size, pos) => !used.has(pos) && size === width);
      }
    }

    if (timePos < 0 || latPos < 0 || lonPos < 0 || new Set([timePos, latPos, lonPos]).size !== 3) {
      throw new Error(
        `NetCDF data variable dimensions could not be mapped to time/lat/lon. Detected dimensions: ${dimNames.join(", ")} (${dimSizes.join(" x ")}).`
      );
    }

    const timeCount = dimSizes[timePos];
    if (dimSizes[latPos] !== height || dimSizes[lonPos] !== width) {
      throw new Error("NetCDF data dimensions do not match lat/lon coordinate lengths.");
    }

    const fillValues = ncAttributeValues(dataVar, ["_FillValue", "missing_value"]);
    const values = getNcData(reader, dataVar).map((raw) => {
      const value = Number(raw);
      return fillValues.includes(value) ? NaN : value;
    });
    const bands = [];
    for (let t = 0; t < timeCount; t++) {
      const band = new Array(height * width);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const indices = new Array(dimNames.length).fill(0);
          indices[timePos] = t;
          indices[latPos] = y;
          indices[lonPos] = x;
          band[y * width + x] = values[flatIndex(indices, dimSizes)];
        }
      }
      bands.push(band);
    }

    const latBounds = finiteMinMax(lats);
    const lonBounds = finiteMinMax(lons);
    return {
      bands,
      timeCount,
      width,
      height,
      latitudes: lats,
      longitudes: lons,
      timeValues: timeValues.length === timeCount ? timeValues.map(Number) : Array.from({ length: timeCount }, (_, i) => i),
      timeUnits,
      bbox: [lonBounds.min, latBounds.min, lonBounds.max, latBounds.max],
      dates: labelsFromTime(timeValues, timeUnits, timeCount),
      flipY: lats[0] < lats[lats.length - 1]
    };
  }

  function isClassicNetcdf(ab) {
    const u8 = new Uint8Array(ab, 0, Math.min(4, ab.byteLength));
    return u8[0] === 0x43 && u8[1] === 0x44 && u8[2] === 0x46;
  }

  function isHdf5Netcdf(ab) {
    const u8 = new Uint8Array(ab, 0, Math.min(8, ab.byteLength));
    return u8[0] === 0x89 && u8[1] === 0x48 && u8[2] === 0x44 && u8[3] === 0x46
      && u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a;
  }

  async function loadH5Wasm() {
    if (h5wasmModule) return h5wasmModule;
    const mod = await import("https://cdn.jsdelivr.net/npm/h5wasm@0.10.1/dist/esm/hdf5_hl.js");
    const h5 = mod.default?.File ? mod.default : mod;
    const Module = h5.ready ? await h5.ready : null;
    h5._sdatFS = Module?.FS || h5.FS || h5.Module?.FS;
    h5wasmModule = h5;
    return h5wasmModule;
  }

  function h5Keys(group) {
    if (typeof group.keys === "function") return Array.from(group.keys());
    if (Array.isArray(group.keys)) return group.keys;
    if (group.children && typeof group.children === "object") return Object.keys(group.children);
    return [];
  }

  function h5Get(group, key) {
    if (typeof group.get === "function") return group.get(key);
    return group.children?.[key] || group[key];
  }

  function h5Type(obj) {
    return String(obj?.type || obj?.constructor?.name || "").toLowerCase();
  }

  function flattenArray(value) {
    if (value && ArrayBuffer.isView(value)) return Array.from(value);
    if (!Array.isArray(value)) return value === undefined || value === null ? [] : [value];
    const out = [];
    const stack = [...value].reverse();
    while (stack.length) {
      const item = stack.pop();
      if (Array.isArray(item)) {
        for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
      } else if (item && ArrayBuffer.isView(item)) {
        for (const v of item) out.push(v);
      } else {
        out.push(item);
      }
    }
    return out;
  }

  function h5DatasetValue(dataset) {
    let raw;
    if (typeof dataset.slice === "function") {
      const shape = h5Shape(dataset);
      try {
        raw = dataset.slice(shape.map((size) => [0, size, 1]));
      } catch (_) {
        raw = undefined;
      }
    }
    if (raw === undefined) raw = typeof dataset.value === "function" ? dataset.value() : dataset.value;
    if (raw && ArrayBuffer.isView(raw)) return Array.from(raw);
    if (Array.isArray(raw)) return flattenArray(raw);
    if (raw !== undefined && raw !== null) return [raw];
    if (typeof dataset.to_array === "function") return flattenArray(dataset.to_array());
    throw new Error(`Cannot read NetCDF v4 dataset ${dataset.name || ""}.`);
  }

  function h5Shape(dataset) {
    const rawShape = typeof dataset.shape === "function" ? dataset.shape() : dataset.shape;
    const rawDims = typeof dataset.dims === "function" ? dataset.dims() : dataset.dims;
    const rawMax = typeof dataset.maxshape === "function" ? dataset.maxshape() : dataset.maxshape;
    return Array.from(rawShape || rawDims || rawMax || []).map(Number).filter((value) => Number.isFinite(value));
  }

  function h5AttrValue(dataset, names) {
    const attrs = typeof dataset.attrs === "function" ? dataset.attrs() : dataset.attrs || {};
    const wanted = names.map((name) => name.toLowerCase());
    const key = Object.keys(attrs).find((name) => wanted.includes(name.toLowerCase()));
    if (!key) return null;
    const attr = attrs[key];
    let value = typeof attr?.value === "function" ? attr.value() : attr?.value ?? attr;
    if (Array.isArray(value)) value = value.length === 1 ? value[0] : value;
    if (ArrayBuffer.isView(value)) value = Array.from(value);
    if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      return new TextDecoder().decode(new Uint8Array(value)).replace(/\0/g, "").trim();
    }
    return value;
  }

  function h5AttrText(dataset, names) {
    const value = h5AttrValue(dataset, names);
    if (Array.isArray(value)) return value.join("").replace(/\0/g, "").trim();
    return String(value ?? "").replace(/\0/g, "").trim();
  }

  function collectH5Datasets(group, prefix = "") {
    const out = [];
    const stack = [{ group, prefix, depth: 0 }];
    const visited = new Set();
    while (stack.length) {
      const current = stack.pop();
      const keys = h5Keys(current.group);
      for (const key of keys) {
        let child;
        try {
          child = h5Get(current.group, key);
        } catch (_) {
          continue;
        }
        const path = `${current.prefix}/${key}`.replace(/^\/+/, "");
        const id = child?.path || path;
        if (visited.has(id)) continue;
        visited.add(id);

        const shape = h5Shape(child);
        const type = h5Type(child);
        if (shape.length > 0 || type.includes("dataset")) {
          out.push({ path, name: key, dataset: child, shape });
        } else if ((type.includes("group") || type.includes("file")) && current.depth < 8) {
          stack.push({ group: child, prefix: path, depth: current.depth + 1 });
        }
      }
    }
    return out;
  }

  function findH5Variable(datasets, names) {
    const wanted = names.map((name) => name.toLowerCase());
    return datasets.find((item) => wanted.includes(item.name.toLowerCase()) || wanted.includes(item.path.toLowerCase()));
  }

  function h5DimensionNames(dataset, shape) {
    const labels = typeof dataset.get_dimension_labels === "function" ? dataset.get_dimension_labels() : null;
    if (Array.isArray(labels) && labels.length === shape.length) {
      return labels.map((label) => String(label || "").toLowerCase());
    }
    const dimLabels = h5AttrValue(dataset, ["DIMENSION_LABELS", "_Netcdf4Dimid"]);
    if (Array.isArray(dimLabels) && dimLabels.length === shape.length) {
      return dimLabels.map((label) => String(label || "").toLowerCase());
    }
    return [];
  }

  async function parseNetcdfHdf5(ab) {
    let h5;
    try {
      h5 = await loadH5Wasm();
    } catch (err) {
      throw new Error("NetCDF v4 support requires h5wasm. Please check the browser network connection and try again.");
    }

    const FS = h5._sdatFS || h5.FS || h5.Module?.FS;
    if (!FS) throw new Error("h5wasm filesystem is not available.");
    const filename = `sdat_${Date.now()}_${Math.random().toString(16).slice(2)}.nc`;
    FS.writeFile(filename, new Uint8Array(ab));
    let fileHandle = null;
    try {
      fileHandle = new h5.File(filename, "r");
      const datasets = collectH5Datasets(fileHandle);
      const latItem = findH5Variable(datasets, ["lat", "latitude", "y"]);
      const lonItem = findH5Variable(datasets, ["lon", "longitude", "x"]);
      const timeItem = findH5Variable(datasets, ["time"]);
      if (!latItem || !lonItem) throw new Error("NetCDF v4 must include 1D lat/latitude and lon/longitude coordinate variables.");

      const lats = h5DatasetValue(latItem.dataset).map(Number);
      const lons = h5DatasetValue(lonItem.dataset).map(Number);
      const timeValues = timeItem ? h5DatasetValue(timeItem.dataset).map(Number) : [];
      const timeUnits = timeItem ? h5AttrText(timeItem.dataset, ["units"]) : "";
      const height = lats.length;
      const width = lons.length;
      const coordPaths = new Set([latItem.path, lonItem.path, timeItem?.path].filter(Boolean));
      const dataItem = datasets.find((item) =>
        item.shape.length === 3
        && !coordPaths.has(item.path)
        && item.shape.some((size) => size === height)
        && item.shape.some((size) => size === width)
      );
      if (!dataItem) throw new Error("NetCDF v4 must include one 3D data variable with time, lat, and lon dimensions.");

      const dimSizes = dataItem.shape.map(Number);
      const dimLabels = h5DimensionNames(dataItem.dataset, dimSizes);
      let timePos = dimLabels.findIndex((name) => name === "time");
      let latPos = dimLabels.findIndex((name) => ["lat", "latitude", "y"].includes(name));
      let lonPos = dimLabels.findIndex((name) => ["lon", "longitude", "x"].includes(name));

      const used = new Set();
      if (timePos < 0 && timeValues.length) timePos = dimSizes.findIndex((size) => size === timeValues.length);
      if (timePos >= 0) used.add(timePos);
      if (latPos < 0) {
        latPos = dimSizes.findIndex((size, pos) => !used.has(pos) && size === height);
        if (latPos >= 0) used.add(latPos);
      }
      if (lonPos < 0) {
        lonPos = dimSizes.findIndex((size, pos) => !used.has(pos) && size === width);
      }
      if (timePos < 0) {
        timePos = dimSizes.findIndex((_, pos) => pos !== latPos && pos !== lonPos);
      }

      if (timePos < 0 || latPos < 0 || lonPos < 0 || new Set([timePos, latPos, lonPos]).size !== 3) {
        throw new Error(`NetCDF v4 data variable dimensions could not be mapped to time/lat/lon. Detected shape: ${dimSizes.join(" x ")}.`);
      }

      const timeCount = dimSizes[timePos];
      const fillValues = flattenArray([h5AttrValue(dataItem.dataset, ["_FillValue"]), h5AttrValue(dataItem.dataset, ["missing_value"])])
        .map(Number)
        .filter((value) => Number.isFinite(value));
      const values = h5DatasetValue(dataItem.dataset).map((raw) => {
        const value = Number(raw);
        return fillValues.includes(value) ? NaN : value;
      });
      const bands = [];
      for (let t = 0; t < timeCount; t++) {
        const band = new Array(height * width);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const indices = new Array(dimSizes.length).fill(0);
            indices[timePos] = t;
            indices[latPos] = y;
            indices[lonPos] = x;
            band[y * width + x] = values[flatIndex(indices, dimSizes)];
          }
        }
        bands.push(band);
      }

      const latBounds = finiteMinMax(lats);
      const lonBounds = finiteMinMax(lons);
      return {
        bands,
        timeCount,
        width,
        height,
        latitudes: lats,
        longitudes: lons,
        timeValues: timeValues.length === timeCount ? timeValues : Array.from({ length: timeCount }, (_, i) => i),
        timeUnits,
        bbox: [lonBounds.min, latBounds.min, lonBounds.max, latBounds.max],
        dates: labelsFromTime(timeValues, timeUnits, timeCount),
        flipY: lats[0] < lats[lats.length - 1]
      };
    } finally {
      if (fileHandle && typeof fileHandle.close === "function") fileHandle.close();
      try {
        FS.unlink(filename);
      } catch (_) {
        // Ignore cleanup failures in the in-memory filesystem.
      }
    }
  }

  async function parseNetcdf(file) {
    const ab = await file.arrayBuffer();
    if (isClassicNetcdf(ab)) return parseNetcdfClassic(ab);
    if (isHdf5Netcdf(ab)) return parseNetcdfHdf5(ab);
    try {
      return await parseNetcdfClassic(ab);
    } catch (_) {
      return parseNetcdfHdf5(ab);
    }
  }

  function drawRasterLayer(raster) {
    if (rasterLayer) map.removeLayer(rasterLayer);
    const { data, width, height, bbox } = raster;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(width, height);
    const range = finiteMinMax(data);
    if (!range) throw new Error("Raster heatmap has no finite SDAT values to display.");
    const { min, max } = range;
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = Math.floor(i / width);
      const srcIndex = raster.flipY ? (height - 1 - y) * width + x : i;
      const v = Number(data[srcIndex]);
      let color = [0, 0, 0];
      if (Number.isFinite(v)) {
        const clipped = Math.max(-3, Math.min(3, v));
        color = v < 0
          ? blendColor([245, 247, 250], [220, 0, 0], Math.abs(clipped) / 3)
          : blendColor([245, 247, 250], [0, 80, 255], clipped / 3);
      }
      img.data[i * 4] = color[0];
      img.data[i * 4 + 1] = color[1];
      img.data[i * 4 + 2] = color[2];
      img.data[i * 4 + 3] = Number.isFinite(v) ? 180 : 0;
    }
    ctx.putImageData(img, 0, 0);
    const bounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
    rasterLayer = L.imageOverlay(canvas.toDataURL("image/png"), bounds, { opacity: 0.85 }).addTo(map);
    updateRasterLegend(min, max, raster.title || "SDAT value");
    map.fitBounds(bounds);
  }

  function rasterSlice(values, timeIndex, height, width) {
    const size = height * width;
    const start = timeIndex * size;
    return values.slice(start, start + size);
  }

  async function gridSliceFromCache(cacheKey, timeIndex) {
    if (!cacheKey || !pyodideReady || !pyodide) return null;
    pyodide.globals.set("js_cache_key", cacheKey);
    pyodide.globals.set("js_time_index", timeIndex);
    const pyOut = await pyodide.runPythonAsync("sdat_grid_slice(str(js_cache_key), int(js_time_index))");
    return pyOut.toJs ? pyOut.toJs() : pyOut;
  }

  async function gridAllValuesFromCache(cacheKey) {
    if (!cacheKey || !pyodideReady || !pyodide) return null;
    pyodide.globals.set("js_cache_key", cacheKey);
    const pyOut = await pyodide.runPythonAsync("sdat_grid_cache[str(js_cache_key)].reshape(-1).tolist()");
    return pyOut.toJs ? pyOut.toJs() : pyOut;
  }

  async function drawCurrentRasterMap() {
    if (!gridPreview) {
      updateMapControls();
      return;
    }

    const clampedScaleIndex = Math.max(0, Math.min(mapScaleIndex, selectedScales.length - 1));
    mapScaleIndex = clampedScaleIndex;
    const sc = selectedScales[clampedScaleIndex];
    const indicatorKey = document.getElementById("indicatorType").value;
    const timeCount = Number(gridOutput?.timeCount || gridPreview.dates?.length || 0);
    const firstDate = validMapDateStart(sc);
    mapDateIndex = Math.max(firstDate, Math.min(mapDateIndex, Math.max(firstDate, timeCount - 1)));
    const values = rasterVariableForScale(sc);
    const cacheKey = rasterCacheKeyForScale(sc);

    if (values && gridOutput?.height && gridOutput?.width) {
      drawRasterLayer({
        data: rasterSlice(values, mapDateIndex, Number(gridOutput.height), Number(gridOutput.width)),
        width: Number(gridOutput.width),
        height: Number(gridOutput.height),
        bbox: gridPreview.bbox,
        flipY: gridPreview.flipY,
        title: `${indicatorKey}-${sc} | ${gridPreview.dates?.[mapDateIndex] || ""}`
      });
    } else if (cacheKey && gridOutput?.height && gridOutput?.width) {
      const slice = await gridSliceFromCache(cacheKey, mapDateIndex);
      if (slice) {
        drawRasterLayer({
          data: slice,
          width: Number(gridOutput.width),
          height: Number(gridOutput.height),
          bbox: gridPreview.bbox,
          flipY: gridPreview.flipY,
          title: `${indicatorKey}-${sc} | ${gridPreview.dates?.[mapDateIndex] || ""}`
        });
      }
    } else if (gridPreview.layers?.[sc]) {
      const previewDate = gridPreview.layerTimeIndex?.[sc] ?? 0;
      mapDateIndex = previewDate;
      drawRasterLayer({
        data: gridPreview.layers[sc],
        width: gridPreview.width,
        height: gridPreview.height,
        bbox: gridPreview.bbox,
        flipY: gridPreview.flipY,
        title: `${indicatorKey}-${sc} | ${gridPreview.dates?.[previewDate] || "preview"}`
      });
    }
    updateMapControls();
  }

  function resetMapControlsToLatest() {
    mapScaleIndex = 0;
    const sc = selectedScales[mapScaleIndex];
    const latest = gridPreview?.layerTimeIndex?.[sc];
    mapDateIndex = Number.isFinite(Number(latest))
      ? Number(latest)
      : Math.max(validMapDateStart(sc), Number(gridOutput?.timeCount || gridPreview?.dates?.length || 1) - 1);
  }

  async function runTabular(file) {
    setVisualizationLoading(true);
    try {
      setUploadStatus("Reading CSV/TXT data...", true);
      const text = await file.text();
      setUploadStatus("Parsing station records...", true);
      const groups = parseTabular(text);
      selectedScales = selectedScaleValues();
      gridPreview = null;
      gridOutput = null;
      mapScaleIndex = 0;
      mapDateIndex = 0;
      if (rasterLayer) {
        map.removeLayer(rasterLayer);
        rasterLayer = null;
      }
      clearRasterLegend();
      updateMapControls();
      stationResults = {};
      stationMetaDates = {};
      stationPoints = {};
      stationOrder = Object.keys(groups);

      for (const sid of stationOrder) {
        stationResults[sid] = await computeForStation(groups[sid].values, selectedScales);
        stationMetaDates[sid] = groups[sid].dates;
        stationPoints[sid] = groups[sid].points.length ? groups[sid].points[0] : null;
      }

      drawStations(groups);
      stationIndex = 0;
      scaleIndex = 0;
      updateNavVisibility();
      renderChart();
      document.getElementById("indicatorType").disabled = true;
      setUploadStatus("Station data loaded.", false);
    } finally {
      setVisualizationLoading(false);
    }
  }

  async function runRaster(file) {
    setVisualizationLoading(true);
    try {
      setUploadStatus("Reading NetCDF data...", true);
      selectedScales = selectedScaleValues();
      let raster;
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".nc")) raster = await parseNetcdf(file);
      else throw new Error("Unsupported format. Please upload CSV, TXT, or NetCDF (.nc).");
      if (selectedScales.some((sc) => sc > raster.timeCount)) {
        throw new Error(`Selected scale is longer than the raster time dimension (${raster.timeCount} time steps).`);
      }
      markerLayer.clearLayers();

      setUploadStatus("Computing pixel-wise SDAT grid...", true);
      const outputValueCount = raster.timeCount * raster.height * raster.width * selectedScales.length;
      const includeFullGrid = outputValueCount <= 8000000;
      shouldPersistGridOutput = outputValueCount <= 2000000;
      const summaries = await computeForGrid(raster, selectedScales, includeFullGrid);
      const meanResults = {};
      const layers = {};
      const layerTimeIndex = {};
      const variables = {};
      const cacheKeys = {};
      selectedScales.forEach((sc) => {
        meanResults[sc] = summaries[sc].mean;
        layers[sc] = summaries[sc].heat;
        layerTimeIndex[sc] = summaries[sc].timeIndex;
        if (includeFullGrid && summaries[sc].grid) variables[sc] = summaries[sc].grid;
        if (summaries[sc].cacheKey) cacheKeys[sc] = summaries[sc].cacheKey;
      });

      gridPreview = {
        width: raster.width,
        height: raster.height,
        bbox: raster.bbox,
        dates: raster.dates,
        flipY: raster.flipY,
        layers,
        layerTimeIndex
      };
      gridOutput = {
        indicator: document.getElementById("indicatorType").value,
        width: raster.width,
        height: raster.height,
        timeCount: raster.timeCount,
        latitudes: raster.latitudes,
        longitudes: raster.longitudes,
        timeValues: raster.timeValues,
        timeUnits: raster.timeUnits,
        variables,
        cacheKeys
      };
      stationResults = { GRID_MEAN: meanResults };
      stationMetaDates = { GRID_MEAN: raster.dates };
      stationPoints = { GRID_MEAN: null };
      stationOrder = ["GRID_MEAN"];
      stationIndex = 0;
      scaleIndex = 0;
      resetMapControlsToLatest();
      updateNavVisibility();
      renderChart();
      await drawCurrentRasterMap();
      document.getElementById("indicatorType").disabled = true;
      setUploadStatus(
        shouldPersistGridOutput
          ? "NetCDF grid loaded."
          : "NetCDF grid loaded. Full raster navigation is available in this browser session; large NetCDF output is not saved in history.",
        false
      );
    } finally {
      setVisualizationLoading(false);
    }
  }

  async function logRun(runName, inputType, filename, payload) {
    const res = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_name: runName, input_type: inputType, filename, status: "done", payload })
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || "Run save failed.");
    }
    const data = await res.json();
    currentRunId = data.job_id;
    currentRunPayload = payload;
    updateDownloadButtons(payload);
    htmx.trigger("body", "refreshJobs");
  }

  async function restoreRun(jobId) {
    setVisualizationLoading(true);
    try {
      const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs/${jobId}`);
    if (!r.ok) return;
    const data = await r.json();
    const p = data.payload || {};
    if (!p.stationResults || !p.selectedScales || !p.stationOrder) return;
    currentRunId = data.id;
    currentRunPayload = p;
    stationResults = p.stationResults;
      stationMetaDates = p.stationMetaDates || {};
      stationPoints = p.stationPoints || {};
      gridPreview = p.gridPreview || null;
      gridOutput = p.gridOutput || null;
      selectedScales = p.selectedScales;
      stationOrder = p.stationOrder;
      stationIndex = 0;
      scaleIndex = 0;
      mapScaleIndex = 0;
      mapDateIndex = 0;
      const groups = {};
      stationOrder.forEach((sid) => {
        const pt = stationPoints[sid];
        if (pt && pt.length === 2) groups[sid] = { points: [pt] };
      });
      if (gridPreview) {
        markerLayer.clearLayers();
        resetMapControlsToLatest();
      } else {
        if (rasterLayer) {
          map.removeLayer(rasterLayer);
          rasterLayer = null;
        }
        clearRasterLegend();
        if (Object.keys(groups).length) drawStations(groups);
        else markerLayer.clearLayers();
      }
      updateNavVisibility();
      renderChart();
      await drawCurrentRasterMap();
      updateDownloadButtons(p);
      document.getElementById("indicatorType").disabled = true;
    } finally {
      setVisualizationLoading(false);
    }
  }

  function clearResultsView() {
    currentRunId = null;
    currentRunPayload = null;
    stationResults = {};
    stationMetaDates = {};
    stationPoints = {};
    stationOrder = [];
    selectedScales = selectedScaleValues();
    stationIndex = 0;
    scaleIndex = 0;
    mapScaleIndex = 0;
    mapDateIndex = 0;
    gridPreview = null;
    gridOutput = null;
    shouldPersistGridOutput = false;
    document.getElementById("resultMeta").innerHTML = "";
    if (chart) chart.clear();
    if (rasterLayer) {
      map.removeLayer(rasterLayer);
      rasterLayer = null;
    }
    markerLayer.clearLayers();
    clearRasterLegend();
    updateNavVisibility();
    updateMapControls();
    updateDownloadButtons(null);
  }

  async function loadJobsTablePage(page) {
    const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs`);
    if (!r.ok) return;
    const jobs = await r.json();
    const totalPages = Math.max(1, Math.ceil(jobs.length / JOBS_PAGE_SIZE));
    jobsPage = Math.max(1, Math.min(page, totalPages));
    const start = (jobsPage - 1) * JOBS_PAGE_SIZE;
    const sub = jobs.slice(start, start + JOBS_PAGE_SIZE);
    const tbody = document.querySelector("#jobsContainer tbody");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!sub.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-muted">No jobs yet.</td></tr>';
    } else {
      sub.forEach((j) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="text-start">
            <div class="dropdown">
              <button class="btn btn-sm btn-icon btn-outline-secondary" data-bs-toggle="dropdown" type="button">⋯</button>
              <ul class="dropdown-menu">
                <li><button class="dropdown-item restore-run-btn" data-job-id="${j.id}" type="button"><i class="bx bx-reset me-2"></i>Restore</button></li>
                <li><button class="dropdown-item run-download-btn" data-job-id="${j.id}" type="button"><i class="bx bx-download me-2"></i>Download CSV</button></li>
                <li><button class="dropdown-item run-download-nc-btn" data-job-id="${j.id}" type="button"><i class="bx bx-cloud-download me-2"></i>Download NetCDF</button></li>
                <li><button class="dropdown-item text-danger run-delete-btn" data-job-id="${j.id}" type="button"><i class="bx bx-trash me-2"></i>Delete</button></li>
              </ul>
            </div>
          </td>
          <td>${j.run_name || ""}</td>
          <td>${j.input_type}</td>
          <td>${j.filename || ""}</td>
          <td><span class="badge bg-label-success">${j.status}</span></td>
          <td>${j.created_at}</td>
        `;
        tbody.appendChild(tr);
      });
    }
    document.getElementById("jobsPageInfo").textContent = `Page ${jobsPage} / ${totalPages}`;
    document.getElementById("jobsPrevBtn").disabled = jobsPage <= 1;
    document.getElementById("jobsNextBtn").disabled = jobsPage >= totalPages;
  }

  function bindEvents() {
    document.getElementById("runBtn").addEventListener("click", async () => {
      let started = false;
      let ncSavePending = false;
      try {
        if (!pyodideReady || !pyodide) {
          showError("Pyodide runtime is still loading. Please wait a few seconds and run again.");
          return;
        }
        const f = document.getElementById("dataFile");
        const runName = document.getElementById("runNameInput").value.trim();
        const missing = [];
        if (!f.files.length) missing.push("choose an input file");
        if (!runName) missing.push("enter a Run Name");
        if (missing.length) {
          showError(`Before running the calculation, please ${missing.join(" and ")}.`);
          return;
        }
        const file = f.files[0];
        const lower = file.name.toLowerCase();
        currentRunId = null;
        currentRunPayload = null;
        updateDownloadButtons(null);
        started = true;
        setRunButtonState(true, '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Running Calculation');
        if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
          await runTabular(file);
          await logRun(runName, "tabular", file.name, {
            stationOrder,
            stationMetaDates,
            stationPoints,
            selectedScales,
            stationResults,
            gridPreview,
            gridOutput: null
          });
          releaseSelectedInputFile("Station data calculated. Input file released from browser memory.");
        } else if (lower.endsWith(".nc")) {
          await runRaster(file);
          setRunButtonState(false, RUN_BUTTON_LABEL);
          setNcDownloadLoading(true);
          ncSavePending = true;
          await logRun(runName, "matrix", file.name, {
            stationOrder,
            stationMetaDates,
            stationPoints,
            selectedScales,
            stationResults,
            gridPreview,
            gridOutput: shouldPersistGridOutput ? gridOutput : { ...gridOutput, variables: {} }
          });
          ncSavePending = false;
          releaseSelectedInputFile("NetCDF data calculated. Input file released from browser memory.");
        }
        else showError("Unsupported format. Please upload CSV, TXT, or NetCDF (.nc).");
      } catch (err) {
        showError(err?.message || "Invalid input format. Minimum required headers are: ID,DATE,VALUE,LAT,LONG,ELEV");
        setUploadStatus("Data loading failed.", false, true);
        if (ncSavePending) {
          setNcDownloadLoading(false);
          updateDownloadButtons(null);
          ncSavePending = false;
        }
      } finally {
        if (started && pyodideReady) {
          setRunButtonState(false, RUN_BUTTON_LABEL);
        }
      }
    });

    document.getElementById("dataFile").addEventListener("change", () => {
      document.getElementById("indicatorType").disabled = false;
      const f = document.getElementById("dataFile");
      if (f.files.length) {
        setUploadStatus("Checking selected file...", true);
        window.setTimeout(() => setUploadStatus("File selected. Ready to run.", false), 450);
      } else {
        setUploadStatus("", false, false);
      }
    });

    document.getElementById("prevStation").addEventListener("click", () => {
      if (!stationOrder.length) return;
      stationIndex = (stationIndex - 1 + stationOrder.length) % stationOrder.length;
      renderChart();
    });
    document.getElementById("nextStation").addEventListener("click", () => {
      if (!stationOrder.length) return;
      stationIndex = (stationIndex + 1) % stationOrder.length;
      renderChart();
    });
    document.getElementById("prevScale").addEventListener("click", () => {
      if (!selectedScales.length) return;
      scaleIndex = (scaleIndex - 1 + selectedScales.length) % selectedScales.length;
      renderChart();
    });
    document.getElementById("nextScale").addEventListener("click", () => {
      if (!selectedScales.length) return;
      scaleIndex = (scaleIndex + 1) % selectedScales.length;
      renderChart();
    });

    document.getElementById("prevMapScale").addEventListener("click", async () => {
      if (!hasMapGridOutput()) return;
      setVisualizationLoading(true, "map");
      try {
      mapScaleIndex = (mapScaleIndex - 1 + selectedScales.length) % selectedScales.length;
      const sc = selectedScales[mapScaleIndex];
      mapDateIndex = Math.max(validMapDateStart(sc), Math.min(mapDateIndex, Number(gridOutput.timeCount) - 1));
      await drawCurrentRasterMap();
      } finally {
        setVisualizationLoading(false, "map");
      }
    });
    document.getElementById("nextMapScale").addEventListener("click", async () => {
      if (!hasMapGridOutput()) return;
      setVisualizationLoading(true, "map");
      try {
      mapScaleIndex = (mapScaleIndex + 1) % selectedScales.length;
      const sc = selectedScales[mapScaleIndex];
      mapDateIndex = Math.max(validMapDateStart(sc), Math.min(mapDateIndex, Number(gridOutput.timeCount) - 1));
      await drawCurrentRasterMap();
      } finally {
        setVisualizationLoading(false, "map");
      }
    });
    document.getElementById("prevMapDate").addEventListener("click", async () => {
      if (!hasMapGridOutput()) return;
      setVisualizationLoading(true, "map");
      try {
      const sc = selectedScales[mapScaleIndex];
      const firstDate = validMapDateStart(sc);
      const lastDate = Number(gridOutput.timeCount) - 1;
      mapDateIndex = mapDateIndex <= firstDate ? lastDate : mapDateIndex - 1;
      await drawCurrentRasterMap();
      } finally {
        setVisualizationLoading(false, "map");
      }
    });
    document.getElementById("nextMapDate").addEventListener("click", async () => {
      if (!hasMapGridOutput()) return;
      setVisualizationLoading(true, "map");
      try {
      const sc = selectedScales[mapScaleIndex];
      const firstDate = validMapDateStart(sc);
      const lastDate = Number(gridOutput.timeCount) - 1;
      mapDateIndex = mapDateIndex >= lastDate ? firstDate : mapDateIndex + 1;
      await drawCurrentRasterMap();
      } finally {
        setVisualizationLoading(false, "map");
      }
    });

    document.getElementById("indicatorType").addEventListener("change", renderChart);

    document.getElementById("downloadCsvBtn").addEventListener("click", async () => {
      if (!currentRunId) return;
      const payload = currentRunPayload || await (async () => {
        const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs/${currentRunId}`);
        if (!r.ok) return null;
        const data = await r.json();
        currentRunPayload = data.payload || {};
        return currentRunPayload;
      })();
      if (!payload) return;
      downloadPayloadAsCsv(payload, `run_${currentRunId}.csv`);
    });

    document.getElementById("downloadNcBtn").addEventListener("click", async () => {
      if (!currentRunId) return;
      try {
        const payload = currentRunPayload || await (async () => {
          const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs/${currentRunId}`);
          if (!r.ok) return null;
          const data = await r.json();
          currentRunPayload = data.payload || {};
          return currentRunPayload;
        })();
        if (!payload) return;
        await downloadPayloadAsNetcdf(payload, `run_${currentRunId}.nc`);
      } catch (err) {
        showError(err?.message || "This run does not contain gridded NetCDF output.");
      }
    });

    document.body.addEventListener("click", async (e) => {
      const restoreBtn = e.target.closest(".restore-run-btn");
      if (restoreBtn) {
        await restoreRun(restoreBtn.getAttribute("data-job-id"));
      }
      const dlBtn = e.target.closest(".run-download-btn");
      if (dlBtn) {
        const runId = dlBtn.getAttribute("data-job-id");
        const payload = currentRunId === Number(runId) && currentRunPayload ? currentRunPayload : await (async () => {
          const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs/${runId}`);
          if (!r.ok) return null;
          const data = await r.json();
          return data.payload || {};
        })();
        if (!payload) return;
        downloadPayloadAsCsv(payload, `run_${runId}.csv`);
      }
      const dlNcBtn = e.target.closest(".run-download-nc-btn");
      if (dlNcBtn) {
        const runId = dlNcBtn.getAttribute("data-job-id");
        try {
          const payload = currentRunId === Number(runId) && currentRunPayload ? currentRunPayload : await (async () => {
            const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs/${runId}`);
            if (!r.ok) return null;
            const data = await r.json();
            return data.payload || {};
          })();
          if (!payload) return;
          await downloadPayloadAsNetcdf(payload, `run_${runId}.nc`);
        } catch (err) {
          showError(err?.message || "This run does not contain gridded NetCDF output.");
        }
      }
      const delBtn = e.target.closest(".run-delete-btn");
      if (delBtn) {
        const runId = delBtn.getAttribute("data-job-id");
        const r = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs/${runId}`, { method: "DELETE" });
        if (r.ok) {
          await loadJobsTablePage(1);
          const jobsRes = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs`);
          const jobs = jobsRes.ok ? await jobsRes.json() : [];
          if (!jobs.length) clearResultsView();
          else if (String(currentRunId) === String(runId)) await restoreRun(jobs[0].id);
        }
      }
    });

    document.getElementById("jobsPrevBtn").addEventListener("click", async () => {
      await loadJobsTablePage(jobsPage - 1);
    });
    document.getElementById("jobsNextBtn").addEventListener("click", async () => {
      await loadJobsTablePage(jobsPage + 1);
    });
  }

  async function boot() {
    buildScaleChecklist();
    initMap();
    initChart();
    setVisualizationLoading(true);
    setRunButtonState(true, '<i class="bx bx-loader-alt bx-spin me-1"></i>Loading Runtime');
    bindEvents();
    try {
      await initPyodideRuntime();
      setRunButtonState(false, '<i class="bx bx-play-circle me-1"></i>Run Calculation');
    } catch (err) {
      setRunButtonState(true, '<i class="bx bx-error-circle me-1"></i>Runtime Failed');
      showError(err?.message || "Pyodide runtime failed to load.");
      return;
    }
    updateNavVisibility();
    const jobsRes = await fetch(`/api/projects/${window.SDAT_PROJECT_ID}/jobs`);
    const jobs = jobsRes.ok ? await jobsRes.json() : [];
    if (jobs.length > 0) {
      await restoreRun(jobs[0].id);
    } else {
      // Auto-generate sample result for empty project: SPI + 3-month.
      document.getElementById("indicatorType").value = "SPI";
      document.getElementById("indicatorType").disabled = false;
      document.querySelectorAll(".scale-cb").forEach((cb) => { cb.checked = false; });
      const sc3 = document.getElementById("sc_3");
      if (sc3) sc3.checked = true;
      const sampleText = await fetch("/static/data/Sample.csv").then((r) => r.text());
      const groups = parseTabular(sampleText);
      selectedScales = [3];
      stationResults = {};
      stationMetaDates = {};
      stationPoints = {};
      stationOrder = Object.keys(groups);
      for (const sid of stationOrder) {
        stationResults[sid] = await computeForStation(groups[sid].values, selectedScales);
        stationMetaDates[sid] = groups[sid].dates;
        stationPoints[sid] = groups[sid].points.length ? groups[sid].points[0] : null;
      }
      drawStations(groups);
      stationIndex = 0;
      scaleIndex = 0;
      renderChart();
      setVisualizationLoading(false);
      document.getElementById("indicatorType").disabled = true;
      await logRun("Auto Sample SPI-3", "tabular", "Sample.csv", {
        stationOrder,
        stationMetaDates,
        stationPoints,
        selectedScales,
        stationResults,
        gridPreview: null,
        gridOutput: null
      });
    }
    await loadJobsTablePage(1);
    document.body.addEventListener("refreshJobs", async () => {
      await loadJobsTablePage(1);
    });
  }

  boot();
})();
