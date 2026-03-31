// scripts/como-comprar.js - Router hash para #/como-comprar, #/coleccion/fyl-originals y lógica Cómo comprar

let prevHash = "";
let __routeRetryCount = 0;
const ROUTE_RETRY_MAX = 8;
const ROUTE_RETRY_MS = 100;

/** Router: togglea #catalog-view / #howto-page y maneja ruta de colección FYL.
 *  #/coleccion/fyl-originals: vista compartible con header compacto, sin card redundante.
 *  Deep link: funciona al cargar directamente con el hash.
 */
async function applyHashRoute() {
  try {
  const catalogView = document.getElementById("catalog-view");
  const howtoPage = document.getElementById("howto-page");
  const aboutPage = document.getElementById("about-fyl-page");
  const waPopup = document.getElementById("wa-popup");
  const collectionHeader = document.getElementById("collection-header");
  const hash = location.hash || "#/";
  const isComoComprar = hash === "#/como-comprar";
  const isQuienesSomos = hash === "#/quienes-somos";
  const isCollectionFYL = hash === "#/coleccion/fyl-originals";
  const wasCollectionFYL = prevHash === "#/coleccion/fyl-originals";

  if (!catalogView || !howtoPage || !aboutPage) return;

  if (isComoComprar) {
    catalogView.classList.add("is-hidden");
    howtoPage.classList.remove("is-hidden");
    aboutPage.classList.add("is-hidden");
    waPopup?.classList.add("is-hidden");
    if (collectionHeader) {
      collectionHeader.classList.add("is-hidden");
      collectionHeader.style.display = "none";
    }
    window.scrollTo(0, 0);
  } else if (isQuienesSomos) {
    catalogView.classList.add("is-hidden");
    howtoPage.classList.add("is-hidden");
    aboutPage.classList.remove("is-hidden");
    waPopup?.classList.add("is-hidden");
    if (collectionHeader) {
      collectionHeader.classList.add("is-hidden");
      collectionHeader.style.display = "none";
    }
    window.scrollTo(0, 0);
  } else if (isCollectionFYL) {
    if (window.__FYL_BOOT_SUPPRESS_ROUTE) {
      return;
    }
    catalogView.classList.remove("is-hidden");
    howtoPage.classList.add("is-hidden");
    aboutPage.classList.add("is-hidden");
    waPopup?.classList.remove("is-hidden");
    if (collectionHeader) {
      collectionHeader.classList.remove("is-hidden");
      collectionHeader.style.display = "";
      collectionHeader.setAttribute("aria-hidden", "false");
    }
    // Ocultar TODOS los banners editables (Nuevos ingresos, Preparate/custom, etc.)
    if (typeof window.hidePromotionalBanner === "function") {
      window.hidePromotionalBanner();
    }
    if (typeof window.hideCustomBanner === "function") {
      window.hideCustomBanner();
    }
    if (typeof window.filterBySupplierFYL === "function") {
      __routeRetryCount = 0;
      await window.filterBySupplierFYL({ forCollectionView: true });
    } else if (__routeRetryCount < ROUTE_RETRY_MAX) {
      scheduleRouteRetry();
    }
    window.scrollTo(0, 0);
  } else {
    catalogView.classList.remove("is-hidden");
    howtoPage.classList.add("is-hidden");
    aboutPage.classList.add("is-hidden");
    waPopup?.classList.remove("is-hidden");
    if (collectionHeader) {
      collectionHeader.classList.add("is-hidden");
      collectionHeader.style.display = "none";
      collectionHeader.setAttribute("aria-hidden", "true");
    }
    if (wasCollectionFYL && typeof window.cargarCategoria === "function") {
      window.cargarCategoria("all");
    }
    window.scrollTo(0, 0);
    if (typeof window.syncInfoBannerVisibility === "function") {
      window.syncInfoBannerVisibility();
    }
  }

  prevHash = hash;
  } catch (e) {
    console.warn("applyHashRoute:", e);
  }
}

function scheduleRouteRetry() {
  __routeRetryCount++;
  setTimeout(applyHashRoute, ROUTE_RETRY_MS);
}

function initComoComprarRouter() {
  applyHashRoute();
  window.addEventListener("hashchange", () => {
    __routeRetryCount = 0;
    applyHashRoute();
  });
  window.addEventListener("load", applyHashRoute);
}

function runRouterOnReady() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyHashRoute);
  } else {
    applyHashRoute();
  }
}

/** Anchors internos (#howto-steps, etc.): preventDefault para no cambiar el hash.
 *  Evita conflicto con el router. Solo scroll interno. */
function initInternalAnchors() {
  const root = document.getElementById("howto-page");
  if (!root) return;

  root.querySelectorAll('a[href^="#howto-"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const id = a.getAttribute("href").slice(1);
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

/** data-action="go-home": volver al catálogo sin recargar. */
function initGoHomeHandlers() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[data-action="go-home"]');
    if (!a) return;
    e.preventDefault();
    location.hash = "#/";
  });
}

/** FAQ acordeón (vanilla, accesible). */
function initFAQ() {
  const root = document.getElementById("howto-page");
  if (!root) return;

  root.querySelectorAll(".faq-q").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".faq-item");
      const answer = item?.querySelector(".faq-a");
      const icon = item?.querySelector(".faq-icon");
      if (!answer || !icon) return;

      const expanded = btn.getAttribute("aria-expanded") === "true";

      root.querySelectorAll('.faq-q[aria-expanded="true"]').forEach((openBtn) => {
        if (openBtn !== btn) {
          openBtn.setAttribute("aria-expanded", "false");
          const openItem = openBtn.closest(".faq-item");
          const openAns = openItem?.querySelector(".faq-a");
          const openIcon = openItem?.querySelector(".faq-icon");
          if (openAns) openAns.hidden = true;
          if (openIcon) openIcon.textContent = "+";
        }
      });

      btn.setAttribute("aria-expanded", String(!expanded));
      answer.hidden = expanded;
      icon.textContent = expanded ? "+" : "–";
    });
  });
}

function init() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      initComoComprarRouter();
      initInternalAnchors();
      initGoHomeHandlers();
      initFAQ();
      runRouterOnReady();
    });
  } else {
    initComoComprarRouter();
    initInternalAnchors();
    initGoHomeHandlers();
    initFAQ();
    runRouterOnReady();
  }
}

init();

window.applyHashRoute = applyHashRoute;
