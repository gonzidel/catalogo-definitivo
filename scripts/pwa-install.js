// scripts/pwa-install.js

// Evitar registrar SW en entorno local para desarrollo
const __LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

function __isLanIpv4(hostname) {
  // 192.168.x.x
  if (hostname.startsWith("192.168.")) return true;
  // 10.x.x.x
  if (hostname.startsWith("10.")) return true;

  // 172.16.x.x -> 172.31.x.x
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

// 1) Registrar service worker (solo fuera de localhost)
const SW_VERSION = "m260328";
let __swRefreshing = false;

if ("serviceWorker" in navigator && !__IS_LOCAL) {
  navigator.serviceWorker
    .register(`sw.js?v=${SW_VERSION}`)
    .then((registration) => {
      // Si hay un SW nuevo esperando, activarlo de inmediato.
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }

      // Cuando llega una nueva versión, forzar activación.
      registration.addEventListener("updatefound", () => {
        const newWorker = registration.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (
            newWorker.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            newWorker.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
    })
    .catch((err) => {
      console.warn("[PWA] No se pudo registrar SW:", err);
    });

  // Cuando el nuevo SW toma control, recargar una sola vez para levantar HTML/JS nuevos.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (__swRefreshing) return;
    __swRefreshing = true;
    window.location.reload();
  });
} else if ("serviceWorker" in navigator && __IS_LOCAL) {
  // En local, intentar desregistrar cualquier SW previo para evitar caché
  navigator.serviceWorker.getRegistrations?.().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
}

let deferredPrompt;

// Claves y pausas
const DISMISS_KEY = "pwa-install-dismissed";
const ACCEPT_KEY = "pwa-install-accepted";
const VISIT_KEY = "pwa-catalog-visit-count";
const PAUSE_MS = 48 * 60 * 60 * 1000; // 48 horas en ms

// Cada carga del catálogo cuenta como una visita (1ª = sin modal; 2ª en adelante = elegible)
const catalogVisitCount =
  parseInt(localStorage.getItem(VISIT_KEY) || "0", 10) + 1;
localStorage.setItem(VISIT_KEY, String(catalogVisitCount));

window.addEventListener("beforeinstallprompt", (e) => {
  if (__IS_LOCAL) return; // no mostrar prompt en local
  e.preventDefault();
  deferredPrompt = e;

  // Si ya aceptó antes, no mostramos nunca más
  if (localStorage.getItem(ACCEPT_KEY)) {
    return;
  }

  // Primera visita: no mostrar el modal (sigue suprimido el prompt nativo)
  if (catalogVisitCount < 2) {
    return;
  }

  // Compruebo la última vez que cerró el modal
  const lastDismiss = parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10);
  const now = Date.now();

  // Si no han pasado 48h, no muestro
  if (now - lastDismiss < PAUSE_MS) {
    return;
  }

  // Mostramos el modal tras 40 s
  setTimeout(() => {
    if (deferredPrompt && !__IS_LOCAL) {
      document.getElementById("install-modal").classList.remove("hidden");
    }
  }, 40000);
});

// Usuario acepta instalar
document
  .getElementById("install-accept")
  .addEventListener("click", async () => {
    document.getElementById("install-modal").classList.add("hidden");
    localStorage.setItem(ACCEPT_KEY, "true");
    gtag('event', 'pwa_instalada', {
  event_category: 'pwa',
  event_label: 'Instalación aceptada'
});

    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  });

// Usuario pospone para “otro momento”
document.getElementById("install-later").addEventListener("click", () => {
  document.getElementById("install-modal").classList.add("hidden");
  localStorage.setItem(DISMISS_KEY, Date.now().toString());
});
