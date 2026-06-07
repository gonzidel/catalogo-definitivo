// scripts/filtros.js — menú de filtros por tags (sin MutationObserver; rebuild explícito)

function construirMenuFiltros() {
  const menu = document.getElementById("filtroMenu");
  if (!menu) return;

  const productos = document.querySelectorAll(".producto");
  const filtrosSet = new Set();

  productos.forEach((prod) => {
    const f1 = prod.dataset.filtro1 ? prod.dataset.filtro1.trim() : "";
    const f2 = prod.dataset.filtro2 ? prod.dataset.filtro2.trim() : "";
    const f3 = prod.dataset.filtro3 ? prod.dataset.filtro3.trim() : "";
    [f1, f2, f3].forEach((f) => {
      if (f) filtrosSet.add(f);
    });
  });

  const filtros = Array.from(filtrosSet).sort();
  menu.innerHTML = "";

  filtros.forEach((filtro) => {
    const label = document.createElement("label");
    label.innerHTML = `
        <input type="checkbox" value="${filtro.replace(/"/g, "&quot;")}" />
        <span>${filtro}</span>
      `;
    menu.appendChild(label);
  });
}

function aplicarFiltroTag(filtroActivo) {
  const productos = document.querySelectorAll(".producto");
  const bannerSlot = document.getElementById("home-custom-banner-slot");
  const legacyWrapper = document.getElementById("custom-banner-wrapper");

  if (bannerSlot) {
    bannerSlot.hidden = !!filtroActivo;
    bannerSlot.setAttribute("aria-hidden", filtroActivo ? "true" : "false");
  }
  if (legacyWrapper) {
    legacyWrapper.style.display = filtroActivo ? "none" : "";
  }

  productos.forEach((prod) => {
    const valores = [prod.dataset.filtro1, prod.dataset.filtro2, prod.dataset.filtro3].filter(Boolean);
    const visible = filtroActivo ? valores.includes(filtroActivo) : true;
    prod.style.display = visible ? "" : "none";
  });
}

window.construirMenuFiltros = construirMenuFiltros;

window.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("toggleFiltros");
  const menu = document.getElementById("filtroMenu");

  if (!btn || !menu) return;

  btn.addEventListener("click", () => {
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });

  menu.addEventListener("change", (e) => {
    const input = e.target;
    if (!input || input.type !== "checkbox") return;

    menu.querySelectorAll('input[type="checkbox"]').forEach((i) => {
      if (i !== input) i.checked = false;
    });

    menu.style.display = "none";
    const filtroActivo = input.checked ? input.value : null;
    aplicarFiltroTag(filtroActivo);

    try {
      if (filtroActivo && window.fylAnalytics && window.fylAnalytics.isReady()) {
        window.fylAnalytics.setPageType("category");
        window.fylAnalytics.event("filter_apply", { filter_value: filtroActivo });
      }
    } catch (_e) {}
  });

  construirMenuFiltros();
});
