// scripts/pwa-install.js

// Evitar registrar SW en entorno local para desarrollo
const __LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"]; 
const __IS_LOCAL = __LOCAL_HOSTS.includes(location.hostname);

// 1) Registrar service worker (solo fuera de localhost)
if ("serviceWorker" in navigator && !__IS_LOCAL) {
  navigator.serviceWorker.register("sw.js");
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
const PAUSE_MS = 48 * 60 * 60 * 1000; // 48 horas en ms

window.addEventListener("beforeinstallprompt", (e) => {
  if (__IS_LOCAL) return; // no mostrar prompt en local
  e.preventDefault();
  deferredPrompt = e;

  // Si ya aceptó antes, no mostramos nunca más
  if (localStorage.getItem(ACCEPT_KEY)) {
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
