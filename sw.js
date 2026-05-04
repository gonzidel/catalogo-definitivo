// =============================================================================
// TOMBSTONE SERVICE WORKER — PHASE A (bug iPhone/Safari "no_client")
// =============================================================================
// Estado: TEMPORAL. Este SW reemplaza al anterior únicamente para:
//   1. Tomar control de cualquier cliente ya controlado por un SW viejo.
//   2. Borrar todos los caches generados por versiones anteriores.
//   3. Desregistrarse a sí mismo (self.registration.unregister).
//   4. Recargar las pestañas abiertas UNA sola vez para cortar el SW viejo.
//
// Motivo: tras la migración del dominio fylmoda.com.ar a un nuevo proyecto
// Firebase, iPhones/Safari que tenían registrado el SW anterior mostraban
// pantalla "No se pudo iniciar el catálogo" con código `no_client`, porque el
// SW viejo interceptaba /scripts/vendor/supabase-js.bundle.min.js y
// /config.prod.js con lógica de caché previa a `mustFetchFromNetwork`.
//
// Plan de rollback (Phase B, tras 3-7 días):
//   - Restaurar este archivo al contenido anterior (git revert del commit de
//     Phase A) o re-copiar desde el historial.
//   - Bumpear SW_VERSION en scripts/pwa-install.js (por ejemplo m260420 →
//     m260421) para forzar update limpio.
//   - Re-habilitar el bloque de `navigator.serviceWorker.register(...)` en
//     scripts/pwa-install.js.
//
// Mientras dure la Phase A: no hay cache offline del catálogo. Es aceptable,
// la app es online-first y el banner de PWA install prompt sigue funcionando
// por el evento beforeinstallprompt (Chrome/Edge). Instalaciones ya existentes
// sobreviven; el SW viejo se retira sin tirar la app instalada.
// =============================================================================

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(
          names.map((n) => {
            try {
              return caches.delete(n);
            } catch (_) {
              return Promise.resolve();
            }
          })
        );
      } catch (_) {
        // best-effort: si caches API no responde, seguimos con unregister
      }

      try {
        await self.registration.unregister();
      } catch (_) {
        // best-effort: aunque falle el unregister, la página no quedará peor
      }

      try {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const client of clients) {
          try {
            // Recarga exactamente una vez para que la pestaña se reabra sin SW.
            // El tombstone ya está en estado `redundant` tras unregister().
            client.navigate(client.url);
          } catch (_) {
            // clients.navigate puede fallar en cross-origin popups; lo ignoramos.
          }
        }
      } catch (_) {
        // best-effort
      }
    })()
  );
});

// Fetch sin intercepción: todas las requests van a red directo. Safari iOS
// deja de ver respuestas stale del SW anterior apenas este tombstone se activa.
self.addEventListener("fetch", () => {
  // no-op intencional
});

// Permitir SKIP_WAITING desde la página por compatibilidad con pwa-install.js
// histórico; el install handler ya llama skipWaiting(), este es un seguro extra.
self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
