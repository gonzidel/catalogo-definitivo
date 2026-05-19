/**
 * FYL Service Worker — producción (Safari / import() del bundle Supabase)
 *
 * - activate: borra TODOS los caches (evita respuestas HTML/rotas de SW legacy).
 * - fetch: solo intercepta GET/HEAD same-origin de rutas críticas; responde con
 *   fetch(..., { cache: "no-store" }) sin usar Cache API (network-only efectivo).
 * - No se precachea scripts/vendor/* ni /config.prod.js; no hay cache-first.
 * - El resto de requests no llama a respondWith (navegador decide; sin SW cache).
 *
 * SW_BUILD_TAG cambia en cada deploy (lo reescribe scripts/cache-bust-html.mjs)
 * para que Safari detecte byte-diff y reinstale el SW reemplazando legacy.
 */

const SW_BUILD_TAG = "m260518";

const CRITICAL_VENDOR_PREFIX = "/scripts/vendor/";
const CRITICAL_CONFIG = "/config.prod.js";

function isCriticalSameOriginRequest(url) {
  try {
    if (url.origin !== self.location.origin) return false;
    const p = url.pathname;
    if (p === CRITICAL_CONFIG) return true;
    if (p.startsWith(CRITICAL_VENDOR_PREFIX)) return true;
    return false;
  } catch {
    return false;
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(
          names.map((n) => caches.delete(n).catch(() => Promise.resolve()))
        );
      } catch (_) {
        /* best-effort */
      }
      try {
        await self.clients.claim();
      } catch (_) {
        /* best-effort */
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" && req.method !== "HEAD") return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!isCriticalSameOriginRequest(url)) return;
  event.respondWith(
    fetch(req, {
      cache: "no-store",
      redirect: "follow",
    })
  );
});

self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
