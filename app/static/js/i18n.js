(() => {
  const dict = {
    en: {
      create_project: "Create Project",
      project_name: "Project Name",
      project_desc: "Description",
      save: "Save",
      landing_title: "Standardized Drought Analysis Dashboard",
      landing_desc: "Client-side SDAT computation for station and gridded datasets (CSV/TXT, NetCDF), with minimal server load.",
      upload_data: "Upload Data",
      scales: "Scales (months)",
      run_calc: "Run Calculation",
      map: "Map",
      results: "Results",
      history: "Project History"
    },
    fa: {
      create_project: "ایجاد پروژه",
      project_name: "نام پروژه",
      project_desc: "توضیحات",
      save: "ذخیره",
      landing_title: "داشبورد تحلیل استاندارد خشکسالی",
      landing_desc: "محاسبه SDAT در سمت کلاینت برای داده‌های ایستگاهی و ماتریسی با حداقل فشار روی سرور.",
      upload_data: "بارگذاری داده",
      scales: "گام زمانی (ماه)",
      run_calc: "اجرای محاسبه",
      map: "نقشه",
      results: "نتایج",
      history: "تاریخچه پروژه"
    }
  };

  function applyLang(lang) {
    document.documentElement.lang = lang;
    const isFa = lang === "fa";
    document.documentElement.dir = isFa ? "rtl" : "ltr";
    document.body.classList.toggle("rtl-layout", isFa);
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (dict[lang] && dict[lang][key]) el.textContent = dict[lang][key];
    });
    localStorage.setItem("sdat_lang", lang);
    const en = document.getElementById("langEn");
    const fa = document.getElementById("langFa");
    if (en) {
      en.classList.toggle("btn-primary", lang === "en");
      en.classList.toggle("btn-outline-secondary", lang !== "en");
      en.classList.remove("btn-outline-primary");
    }
    if (fa) {
      fa.classList.toggle("btn-primary", lang === "fa");
      fa.classList.toggle("btn-outline-secondary", lang !== "fa");
      fa.classList.remove("btn-outline-primary");
    }
  }

  const startLang = localStorage.getItem("sdat_lang") || "en";
  applyLang(startLang);

  const langEn = document.getElementById("langEn");
  const langFa = document.getElementById("langFa");
  if (langEn) langEn.addEventListener("click", () => applyLang("en"));
  if (langFa) langFa.addEventListener("click", () => applyLang("fa"));

})();
