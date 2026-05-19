// UX-002: listeners mínimos en el primer paint (antes de módulos diferidos).
(function fylHeaderEarlyInit() {
  if (typeof window === "undefined" || window.__fylHeaderEarlyInit) return;
  window.__fylHeaderEarlyInit = true;

  document.addEventListener(
    "click",
    (e) => {
      const waToggle = e.target?.closest?.("#wa-toggle");
      if (waToggle && waToggle.tagName === "BUTTON") {
        const menu = document.getElementById("wa-menu");
        if (menu) {
          e.preventDefault();
          menu.classList.toggle("open");
        }
      }

    },
    true
  );
})();
