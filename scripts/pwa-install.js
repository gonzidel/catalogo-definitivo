// scripts/pwa-install.js — Service worker + PWA install prompt (post-pedido, UX no invasiva)

// Service Worker: registro temprano en scripts/config.js (network-only para
// bundle Supabase y config.prod.js). Este archivo solo gestiona el prompt PWA.

const __LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

function __isLanIpv4(hostname) {
  if (hostname.startsWith("192.168.")) return true;
  if (hostname.startsWith("10.")) return true;
  if (hostname.startsWith("172.")) {
    const parts = hostname.split(".");
    if (parts.length !== 4) return false;
    const second = Number(parts[1]);
    if (!Number.isFinite(second)) return false;
    return second >= 16 && second <= 31;
  }
  return false;
}

const __IS_DEV_PORT =
  !!location.port && location.port !== "80" && location.port !== "443";

const __IS_LOCAL =
  __LOCAL_HOSTS.includes(location.hostname) ||
  (__isLanIpv4(location.hostname) && (__IS_DEV_PORT || true));

// --- localStorage (nuevo flujo post-pedido) ---
const LS_DISMISSED = "fyl_pwa_prompt_dismissed_order_cycle";
const LS_SHOWN = "fyl_pwa_prompt_shown_for_order";
const LS_LAST_SUCCESS = "fyl_last_success_order_number";
const LS_INSTALLED_ACK = "fyl_pwa_installed_ack";
/** Compatibilidad con versión anterior del catálogo */
const LEGACY_ACCEPT_KEY = "pwa-install-accepted";

let deferredPrompt = null;
let __pwaBeforeInstallHooked = false;
let __pwaModalBound = false;
let __pwaPostOrderTimer = null;
/** Evita programar dos veces el mismo pedido en la misma carga */
let __pwaScheduledOrderKey = null;
let __currentOrderKeyForModal = "";

function fylPwaPromptImageUrl() {
  const path = window.location.pathname || "";
  const base = path.includes("/client/") ? "../" : "";
  return `${base}assets/pwa/pwa-install-prompt.png`;
}

/**
 * Guarda el evento beforeinstallprompt (Chrome/Edge). Sin esto no hay instalación nativa.
 */
function captureDeferredInstallPrompt() {
  if (__pwaBeforeInstallHooked) return;
  __pwaBeforeInstallHooked = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    if (__IS_LOCAL) return;
    e.preventDefault();
    deferredPrompt = e;
  });
}

function isPwaInstalled() {
  try {
    const standalone =
      window.matchMedia &&
      window.matchMedia("(display-mode: standalone)").matches;
    const iosStandalone =
      typeof navigator !== "undefined" && navigator.standalone === true;
    return !!(standalone || iosStandalone);
  } catch (_e) {
    return false;
  }
}

function fylPwaUserDeclinedFurtherPrompts() {
  try {
    return (
      !!localStorage.getItem(LS_INSTALLED_ACK) ||
      !!localStorage.getItem(LEGACY_ACCEPT_KEY)
    );
  } catch (_e) {
    return false;
  }
}

/**
 * Al cerrar con éxito un pedido distinto, limpia el dismiss del ciclo anterior y guarda el último número.
 */
function resetPwaPromptCycleOnNewSuccessfulOrder(orderNumber) {
  const key = String(orderNumber || "").trim();
  if (!key) return;
  try {
    const dismissed = localStorage.getItem(LS_DISMISSED);
    if (dismissed && dismissed !== key) {
      localStorage.removeItem(LS_DISMISSED);
    }
    localStorage.setItem(LS_LAST_SUCCESS, key);
  } catch (_e) {}
}

function shouldShowPwaPromptAfterOrder(orderNumber) {
  const key = String(orderNumber || "").trim();
  if (!key) return false;
  if (__IS_LOCAL) return false;
  if (isPwaInstalled()) return false;
  if (fylPwaUserDeclinedFurtherPrompts()) return false;
  if (!deferredPrompt) return false;
  try {
    if (localStorage.getItem(LS_DISMISSED) === key) return false;
    if (localStorage.getItem(LS_SHOWN) === key) return false;
  } catch (_e) {
    return false;
  }
  return true;
}

function markPwaPromptDismissedForCycle(orderNumber) {
  const key = String(orderNumber || "").trim();
  if (!key) return;
  try {
    localStorage.setItem(LS_DISMISSED, key);
  } catch (_e) {}
}

function markPwaPromptShownForOrder(orderNumber) {
  const key = String(orderNumber || "").trim();
  if (!key) return;
  try {
    localStorage.setItem(LS_SHOWN, key);
  } catch (_e) {}
}

function ensurePwaInstallModalInDom() {
  let root = document.getElementById("fyl-pwa-install-modal");
  if (root) return root;

  root = document.createElement("div");
  root.id = "fyl-pwa-install-modal";
  root.className = "pwa-install-modal hidden";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "fyl-pwa-install-title");
  root.innerHTML = `
    <div class="pwa-install-modal__backdrop" data-pwa-install-dismiss="backdrop"></div>
    <div class="pwa-install-modal__panel">
      <button type="button" class="pwa-install-modal__close" data-pwa-install-dismiss="close" aria-label="Cerrar">×</button>
      <div class="pwa-install-modal__image-wrap">
        <img class="pwa-install-modal__image" src="" alt="" width="280" height="158" loading="lazy" decoding="async" />
      </div>
      <h2 id="fyl-pwa-install-title" class="pwa-install-modal__title">Instalá el catálogo</h2>
      <p class="pwa-install-modal__text">Entrá en un toque y hacé pedidos más rápido.</p>
      <div class="pwa-install-modal__actions">
        <button type="button" class="pwa-install-modal__btn pwa-install-modal__btn--primary" id="fyl-pwa-install-confirm">Instalar ahora</button>
        <button type="button" class="pwa-install-modal__btn pwa-install-modal__btn--secondary" id="fyl-pwa-install-later">Más tarde</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const img = root.querySelector(".pwa-install-modal__image");
  if (img) {
    img.src = fylPwaPromptImageUrl();
    img.alt = "Catálogo FYL en el celular, un toque para abrir";
  }

  return root;
}

/** Misma UX y persistencia que «Más tarde»: overlay, × y botón secundario comparten esta ruta. */
function dismissPwaInstallAsPostponed() {
  closePwaInstallModal();
  markPwaPromptDismissedForCycle(__currentOrderKeyForModal);
  try {
    if (window.fylAnalytics && window.fylAnalytics.isReady()) {
      window.fylAnalytics.event("pwa_prompt_dismiss", {});
    }
  } catch (_e) {}
}

function bindPwaInstallModalOnce() {
  if (__pwaModalBound) return;
  const root = ensurePwaInstallModalInDom();

  root.addEventListener("click", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element)) return;
    const dismiss = t.closest("[data-pwa-install-dismiss]");
    if (dismiss) {
      dismissPwaInstallAsPostponed();
    }
  });

  const later = root.querySelector("#fyl-pwa-install-later");
  if (later) {
    later.addEventListener("click", () => dismissPwaInstallAsPostponed());
  }

  const confirmBtn = root.querySelector("#fyl-pwa-install-confirm");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      handlePwaInstallConfirm();
    });
  }

  __pwaModalBound = true;
}

function showPwaInstallModal() {
  if (!deferredPrompt) return;
  bindPwaInstallModalOnce();
  const root = ensurePwaInstallModalInDom();
  root.classList.remove("hidden");
  document.body.classList.add("pwa-install-modal-open");
  // Solo después de mostrar: si el usuario recarga antes, no queda «shown» y no bloquea reintentos del mismo pedido.
  if (__currentOrderKeyForModal) {
    markPwaPromptShownForOrder(__currentOrderKeyForModal);
  }
}

function closePwaInstallModal() {
  const root = document.getElementById("fyl-pwa-install-modal");
  if (root) root.classList.add("hidden");
  document.body.classList.remove("pwa-install-modal-open");
}

async function handlePwaInstallConfirm() {
  if (!deferredPrompt) {
    closePwaInstallModal();
    return;
  }
  try {
    if (window.fylAnalytics && window.fylAnalytics.isReady()) {
      window.fylAnalytics.event("pwa_prompt_accept", {});
    }
  } catch (_e) {}

  try {
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice && choice.outcome === "accepted") {
      try {
        localStorage.setItem(LS_INSTALLED_ACK, "1");
        localStorage.setItem(LEGACY_ACCEPT_KEY, "true");
      } catch (_e) {}
    }
  } catch (_e) {
    /* ignore */
  }

  deferredPrompt = null;
  closePwaInstallModal();
}

/**
 * Tras el mensaje de éxito del pedido: espera 2s y evalúa si abre el modal (una vez por pedido).
 */
function schedulePwaPromptAfterSuccessfulOrder(orderNumber) {
  const key = String(orderNumber || "").trim();
  if (!key) return;

  resetPwaPromptCycleOnNewSuccessfulOrder(key);

  if (__pwaScheduledOrderKey === key && __pwaPostOrderTimer != null) {
    return;
  }
  __pwaScheduledOrderKey = key;

  clearTimeout(__pwaPostOrderTimer);
  __pwaPostOrderTimer = setTimeout(() => {
    __pwaPostOrderTimer = null;
    __pwaScheduledOrderKey = null;

    if (!shouldShowPwaPromptAfterOrder(key)) return;

    __currentOrderKeyForModal = key;
    showPwaInstallModal();
  }, 2000);
}

captureDeferredInstallPrompt();

window.addEventListener("appinstalled", () => {
  try {
    localStorage.setItem(LS_INSTALLED_ACK, "1");
  } catch (_e) {}
  deferredPrompt = null;
  closePwaInstallModal();
});

// API pública (nombres pedidos + alias corto para el dashboard)
window.captureDeferredInstallPrompt = captureDeferredInstallPrompt;
window.isPwaInstalled = isPwaInstalled;
window.shouldShowPwaPromptAfterOrder = shouldShowPwaPromptAfterOrder;
window.markPwaPromptDismissedForCycle = markPwaPromptDismissedForCycle;
window.resetPwaPromptCycleOnNewSuccessfulOrder = resetPwaPromptCycleOnNewSuccessfulOrder;
window.showPwaInstallModal = showPwaInstallModal;
window.closePwaInstallModal = closePwaInstallModal;
window.handlePwaInstallConfirm = handlePwaInstallConfirm;
window.schedulePwaPromptAfterSuccessfulOrder = schedulePwaPromptAfterSuccessfulOrder;
