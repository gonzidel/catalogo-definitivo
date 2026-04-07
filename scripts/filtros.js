window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("toggleFiltros");
  const menu = document.getElementById("filtroMenu");

  if (!btn || !menu) return;

  btn.addEventListener("click", () => {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });

  const observer = new MutationObserver(() => {
    construirMenuFiltros();
  });

  observer.observe(document.getElementById("catalogo"), {
    childList: true,
    subtree: true,
  });

  function construirMenuFiltros() {
    const productos = document.querySelectorAll(".producto");
    const filtrosSet = new Set();

    productos.forEach((prod) => {
      const f1 = prod.dataset.filtro1?.trim();
      const f2 = prod.dataset.filtro2?.trim();
      const f3 = prod.dataset.filtro3?.trim();
      [f1, f2, f3].forEach((f) => {
        if (f) filtrosSet.add(f);
      });
    });

    const filtros = Array.from(filtrosSet).sort();
    menu.innerHTML = "";

    filtros.forEach((filtro) => {
      const label = document.createElement("label");
      label.innerHTML = `
        <input type="checkbox" value="${filtro}" />
        <span>${filtro}</span>
      `;
      menu.appendChild(label);
    });

    // Evento para permitir solo una selección a la vez
    menu.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener("change", () => {
        // Desmarcar todos los demás
        menu.querySelectorAll('input[type="checkbox"]').forEach((i) => {
          if (i !== input) i.checked = false;
        });

        // Cerrar menú
        menu.style.display = "none";

        // Obtener filtro activo
        const filtroActivo = input.checked ? input.value : null;

        // Ocultar/mostrar banner dinámico: solo en index puro, sin filtros
        const bannerWrapper = document.getElementById("custom-banner-wrapper");
        if (bannerWrapper) {
          bannerWrapper.style.display = filtroActivo ? "none" : "";
        }

        productos.forEach((prod) => {
          const valores = [
            prod.dataset.filtro1,
            prod.dataset.filtro2,
            prod.dataset.filtro3,
          ].filter(Boolean);

          const visible = filtroActivo ? valores.includes(filtroActivo) : true;
          prod.style.display = visible ? "" : "none";
        });

        try {
          if (filtroActivo && window.fylAnalytics && window.fylAnalytics.isReady()) {
            window.fylAnalytics.setPageType("category");
            window.fylAnalytics.event("filter_apply", { filter_value: filtroActivo });
          }
        } catch (_e) {}
      });
    });
  }
});
