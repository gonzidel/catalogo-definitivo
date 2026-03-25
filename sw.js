// Mismo sufijo que ?v= en index2/index.html (buscar m250324) para pruebas rápidas en móvil / PWA.
// index/index2: network-first (abajo). Scripts críticos de boot: siempre red (sin cache-first).
const CACHE_NAME = "fyl-catalog-m250324";

const urlsToCache = [
  "/",
  "/index.html",
  "/index2.html",
  "/client/dashboard.html",
  "/styles.css",
  "/scripts/whatsapp.js",
  "/scripts/scroll.js",
  "/scripts/search-manager.js",
  "/scripts/filtros.js",
  "/logo.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/whatsapp.svg",
  "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap",
];

/** Rutas que no deben servirse desde cache (deploy parcial / JS crítico). */
function mustFetchFromNetwork(pathname) {
  if (pathname === "/config.prod.js") return true;
  const critical = new Set([
    "/scripts/config.js",
    "/scripts/config.local.js",
    "/scripts/supabase-client.js",
    "/scripts/main-supabase.js",
    "/scripts/boot-telemetry.js",
    "/scripts/vendor/supabase-js.bundle.js",
  ]);
  return critical.has(pathname);
}

// Instalación del service worker
self.addEventListener("install", (event) => {
  console.log("Service Worker instalando...", CACHE_NAME);
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("Cache abierto");
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log("Service Worker instalado");
        return self.skipWaiting();
      })
      .catch((err) => {
        console.warn("SW install: precache parcial o fallo:", err);
        return self.skipWaiting();
      })
  );
});

// Activación del service worker
self.addEventListener("activate", (event) => {
  console.log("Service Worker activando...");
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log("Eliminando cache viejo:", cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log("Service Worker activado");
        return self.clients.claim();
      })
  );
});

// Interceptar peticiones
self.addEventListener("fetch", (event) => {
  const requestUrl = event.request.url;

  if (
    requestUrl.startsWith("chrome-extension://") ||
    requestUrl.startsWith("moz-extension://") ||
    requestUrl.startsWith("safari-extension://") ||
    requestUrl.startsWith("ms-browser-extension://")
  ) {
    return;
  }

  if (requestUrl.includes("opensheet.elk.sh")) {
    return;
  }

  if (requestUrl.includes("cloudinary.com")) {
    return;
  }

  let pathname = "";
  try {
    pathname = new URL(requestUrl).pathname;
  } catch (_) {
    pathname = "";
  }

  if (mustFetchFromNetwork(pathname) || requestUrl.includes("/scripts/config.local.js")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (requestUrl.includes("/admin/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  const url = new URL(requestUrl);
  const isDoc = event.request.destination === "document";
  const isIndex =
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/index2.html" ||
    url.pathname === "/client/dashboard.html";
  if (isDoc && isIndex) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(
    caches
      .match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }

        if (
          requestUrl.startsWith("chrome-extension://") ||
          requestUrl.startsWith("moz-extension://") ||
          requestUrl.startsWith("safari-extension://") ||
          requestUrl.startsWith("ms-browser-extension://")
        ) {
          return fetch(event.request);
        }

        return fetch(event.request).then((response) => {
          if (!response || response.status !== 200 || response.type !== "basic") {
            return response;
          }

          if (
            requestUrl.startsWith("chrome-extension://") ||
            requestUrl.startsWith("moz-extension://") ||
            requestUrl.startsWith("safari-extension://") ||
            requestUrl.startsWith("ms-browser-extension://")
          ) {
            return response;
          }

          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            try {
              cache.put(event.request, responseToCache);
            } catch (error) {
              console.warn("No se pudo cachear la petición:", error);
            }
          });

          return response;
        });
      })
      .catch(() => {
        if (event.request.destination === "document") {
          return caches.match("/index.html") || caches.match("/");
        }
      })
  );
});
