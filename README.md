# Standardized Drought Analysis Toolbox

The Standardized Drought Analysis Toolbox is a browser-centered implementation of the Standardized Drought Analysis Toolbox (SDAT). It calculates nonparametric standardized drought indices from station time series and gridded NetCDF datasets, then visualizes the results as interactive time series, station maps, and raster map layers.

The dashboard is designed for weak VPS environments: the expensive SDAT calculation runs in the browser with Pyodide/NumPy, while the FastAPI server only serves the UI and stores lightweight project/job history in SQLite.

## Scientific Background

SDAT follows the nonparametric standardized drought indicator framework introduced in:

- Farahmand A., AghaKouchak A., 2015, *A Generalized Framework for Deriving Nonparametric Standardized Drought Indicators*, Advances in Water Resources, 76, 140-145, doi: `10.1016/j.advwatres.2014.11.012`.
- Hao Z., AghaKouchak A., Nakhjiri N., Farahmand A., 2014, *Global Integrated Drought Monitoring and Prediction System*, Scientific Data, 1:140001, doi: `10.1038/sdata.2014.1`.

The Python module under `SDAT/` mirrors the original MATLAB SDAT calculation logic and is tested against an independent MATLAB-style reference implementation. If you keep the original MATLAB toolbox in this checkout, place it under `MATLAB/SDAT MATLAB/`; the Python examples can use that sample data when it is available.

## What The Dashboard Does

- Creates project workspaces and stores job/run history in SQLite.
- Accepts station `CSV/TXT` files with required headers.
- Accepts gridded NetCDF classic/v3 and NetCDF v4/HDF5 files.
- Calculates SDAT indices for selected monthly scales: `1, 3, 6, 9, 12, 15, 18, 21, 24`.
- Supports indicator labels for SPI, SSI, SRI, SSFI, SRHI, SGI, SSWSI, and SWSI.
- Draws Apache ECharts time series with positive/negative area shading.
- Draws Leaflet station maps and raster SDAT maps.
- Lets users move through stations, scales, and raster dates.
- Exports CSV for all runs and NetCDF for gridded runs when output is available in the current browser session or stored history.

## Architecture

```text
Browser
  - Frest UI template
  - HTMX / JavaScript
  - Apache ECharts
  - Leaflet
  - Pyodide + NumPy for SDAT computation
  - netcdfjs for NetCDF classic/v3
  - h5wasm for NetCDF v4/HDF5

FastAPI server
  - Serves pages and static assets
  - Stores project/job metadata in SQLite
  - Does not receive or persist uploaded raw datasets

SQLite
  - app/data/sdat.db
```

User-uploaded data is read by the browser. After a run finishes, the selected file input is cleared so the browser releases the file reference. The server stores only project/job metadata and calculated payloads selected for history.

## Repository Layout

```text
app/
  main.py                  FastAPI app
  db.py                    SQLite project/job storage
  data/                    Runtime SQLite database location
  templates/               Jinja/Frest pages
  static/js/dashboard.js   Client-side SDAT dashboard logic
  static/js/landing.js     Landing-page onboarding/project UI
  static/css/sdat.css      Dashboard-specific styling
  static/data/             Sample datasets

SDAT/
  core.py                  Python SDAT vector/matrix implementation
  io_utils.py              Input helpers
  cli.py                   Command line interface

deployment/nginx/
  default.conf             Nginx config used by docker-compose

tests/
  test_core.py             MATLAB-style parity tests
```

## Input Data

### Station CSV/TXT

Station files must include these headers exactly:

```csv
ID,DATE,VALUE,LAT,LONG,ELEV
```

Each row is one monthly observation.

Example:

```csv
ID,DATE,VALUE,LAT,LONG,ELEV
ST001,2001-01-01,42.1,35.70,51.40,1200
ST001,2001-02-01,38.4,35.70,51.40,1200
ST001,2001-03-01,51.2,35.70,51.40,1200
```

Supported date styles include:

- `YYYY-MM-DD`
- `YYYY/MM/DD`
- `YYYY-MM`
- `M/D/YYYY`
- `D/M/YYYY` when the first component is greater than 12

For reliable scientific workflows, prefer ISO dates such as `2001-03-01`.

### Gridded NetCDF

NetCDF files must be WGS84 / EPSG:4326 time stacks with:

- A longitude coordinate named `lon`, `longitude`, or `x`
- A latitude coordinate named `lat`, `latitude`, or `y`
- A time coordinate named `time`
- One 3D data variable with dimensions equivalent to `time`, `lat`, `lon`

Accepted dimension orders include:

```text
variable(time, lat, lon)
variable(time, y, x)
variable(lat, lon, time)
```

The `time` variable should include a CF-style units attribute, for example:

```text
months since 2001-01-01
days since 2001-01-01
```

Missing values are read from `_FillValue` and `missing_value` when present.

## Sample Data

Available sample files:

- `app/static/data/Sample.csv`
- `app/static/data/TerraClimate_ppt.nc`

The dashboard also exposes `Sample.csv` through:

```text
/sample-csv
```

## Local Development

### Requirements

- Python 3.11 recommended
- A modern browser
- Internet access from the browser for CDN assets:
  - Pyodide
  - h5wasm
  - netcdfjs
  - ECharts
  - PapaParse
  - HTMX

### Install

```bash
python -m pip install -r requirements.txt
```

### Run FastAPI Locally

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open:

```text
http://127.0.0.1:8000
```

### Run Tests

```bash
python -m unittest discover -s tests -p "test_*.py"
```

### Useful Local Make Commands

```bash
make install
make run
make test
```

## Docker Run

Build and start both the FastAPI app and the bundled Nginx container:

```bash
docker compose up --build -d
```

Default Docker URL on the host:

```text
http://127.0.0.1:18080
```

Change the host port:

```bash
HOST_PORT=127.0.0.1:18081 docker compose up --build -d
```

Bind only to localhost, useful when another reverse proxy is installed on the VPS:

```bash
HOST_PORT=127.0.0.1:18080 docker compose up --build -d
```

Docker persistence:

```text
./app/data:/app/app/data
```

This keeps `sdat.db` on the host.

Useful Docker Make commands:

```bash
make docker-up
make docker-logs
make docker-down
```

Use a custom port:

```bash
make docker-up HOST_PORT=127.0.0.1:18080
```

## VPS Deployment With Reverse Proxy

Recommended production pattern:

```text
Internet
  -> Host Nginx or Caddy on ports 80/443
  -> Docker Nginx published on 127.0.0.1:18080
  -> FastAPI container on port 8000
```

### 1. Start The App Bound To Localhost

On the VPS:

```bash
make docker-up HOST_PORT=127.0.0.1:18080
```

or directly:

```bash
HOST_PORT=127.0.0.1:18080 docker compose up --build -d
```

Verify:

```bash
curl http://127.0.0.1:18080/healthz
```

Expected:

```json
{"status":"ok"}
```

### 2. Configure Host Nginx Reverse Proxy

Example host-level Nginx config:

```nginx
server {
    listen 80;
    server_name sdat.werifum.ir;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:18080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 3. Enable HTTPS

With Certbot:

```bash
sudo certbot --nginx -d sdat.werifum.ir
```

After HTTPS is enabled, the host reverse proxy terminates TLS and forwards requests to `127.0.0.1:18080`.

### Alternative: Use The Bundled Nginx Directly

If the VPS has no host reverse proxy and port 80 is free:

```bash
make docker-up HOST_PORT=80
```

The bundled Docker Nginx uses:

```text
deployment/nginx/default.conf
```

It currently has:

```nginx
server_name sdat.werifum.ir;
proxy_pass http://web:8000;
```

For HTTPS in this direct mode, add a host reverse proxy or extend the compose stack with certificate management.

## Configuration Summary

### Local

```text
Command: uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
URL:     http://127.0.0.1:8000
DB:      app/data/sdat.db
```

### Docker Local

```text
Command: docker compose up --build -d
URL:     http://127.0.0.1:18080
DB:      ./app/data/sdat.db mounted into container
```

### VPS Behind Reverse Proxy

```text
App bind: 127.0.0.1:18080
Public:   https://sdat.werifum.ir
Proxy:    host Nginx/Caddy -> http://127.0.0.1:18080
DB:       ./app/data/sdat.db
```

## Python Module And CLI

The repository also includes a Python SDAT module.

Vector input:

```bash
python -m SDAT.cli vector --input data.txt --scale 6 --output si_vector.txt
```

Table input:

```bash
python -m SDAT.cli vector \
  --table \
  --input stations.csv \
  --value-col VALUE \
  --date-col DATE \
  --id-col ID \
  --id-value ST001 \
  --scale 6 \
  --output si_ST001.txt
```

Matrix input:

```bash
python -m SDAT.cli matrix --input prec.mat --var-name prec --scale 3 --output si_matrix.npy
```

Python API:

```python
from SDAT.core import sdat_from_vector, sdat_from_matrix
```

## Operational Notes

- Project names are unique.
- Run names are unique inside each project.
- Uploaded raw files are not stored on the server.
- Large gridded outputs may remain available only in the current browser session to protect SQLite and browser memory.
- The raster map uses a fixed color range of `-3` to `+3`.
- The station chart and raster map are independent controls: the chart shows `GRID_MEAN` for gridded runs, while the map can move through raster dates and scales.

## Troubleshooting

### Port 80 Is Already In Use

Use a different Docker host port:

```bash
make docker-up HOST_PORT=127.0.0.1:18080
```

Then proxy to `http://127.0.0.1:18080`.

### Pyodide Or NetCDF v4 Fails To Load

The browser must be able to download CDN assets. Check browser devtools/network and server CSP/proxy rules.

### No Raster Dates Or Wrong X Axis

Check that the NetCDF file includes a `time` variable and a CF-style `time.units` attribute.

### Reset The Local Database

Stop the app first, then remove:

```text
app/data/sdat.db
```

The database is recreated on startup.
