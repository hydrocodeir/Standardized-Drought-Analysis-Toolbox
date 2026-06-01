(() => {
  const PAGE_SIZE = 20;
  let page = 1;

  function refreshProjects() {
    const cards = [...document.querySelectorAll("#projectList .project-mini-card")];
    const totalPages = Math.max(1, Math.ceil(cards.length / PAGE_SIZE));
    page = Math.max(1, Math.min(page, totalPages));
    const start = (page - 1) * PAGE_SIZE;
    cards.forEach((c, i) => {
      c.style.display = i >= start && i < start + PAGE_SIZE ? "" : "none";
    });
    const info = document.getElementById("projectsPageInfo");
    if (info) info.textContent = `Page ${page} / ${totalPages}`;
    const prev = document.getElementById("projectsPrevBtn");
    const next = document.getElementById("projectsNextBtn");
    if (prev) prev.disabled = page <= 1;
    if (next) next.disabled = page >= totalPages;
  }

  document.getElementById("projectsPrevBtn")?.addEventListener("click", () => {
    page -= 1;
    refreshProjects();
  });

  document.getElementById("projectsNextBtn")?.addEventListener("click", () => {
    page += 1;
    refreshProjects();
  });

  const onboardingEl = document.getElementById("onboardingModal");
  const carouselEl = document.getElementById("onboardingCarousel");
  const prevBtn = document.getElementById("onboardingPrev");
  const nextBtn = document.getElementById("onboardingNext");
  const doneBtn = document.getElementById("onboardingDone");
  const seenKey = "sdat_onboarding_seen";

  function setOnboardingSeen() {
    window.localStorage.setItem(seenKey, "1");
  }

  function updateOnboardingButtons(index) {
    if (!prevBtn || !nextBtn || !doneBtn) return;
    prevBtn.disabled = index <= 0;
    nextBtn.classList.toggle("d-none", index >= 2);
    doneBtn.classList.toggle("d-none", index < 2);
  }

  if (onboardingEl && carouselEl && window.bootstrap) {
    const modal = new bootstrap.Modal(onboardingEl);
    const carousel = new bootstrap.Carousel(carouselEl, { interval: false, ride: false, wrap: false });
    updateOnboardingButtons(0);

    if (window.localStorage.getItem(seenKey) !== "1") {
      window.setTimeout(() => modal.show(), 450);
    }

    prevBtn?.addEventListener("click", () => carousel.prev());
    nextBtn?.addEventListener("click", () => carousel.next());
    onboardingEl.querySelectorAll(".onboarding-dismiss").forEach((btn) => {
      btn.addEventListener("click", setOnboardingSeen);
    });
    onboardingEl.addEventListener("hidden.bs.modal", setOnboardingSeen);
    carouselEl.addEventListener("slid.bs.carousel", (event) => {
      updateOnboardingButtons(event.to);
    });
  }

  refreshProjects();
})();
