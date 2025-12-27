// Incrementar la versión del cache cuando se actualicen assets para forzar reload en clientes
const CACHE_NAME = "fyl-catalog-v2";
const urlsToCache = [
  "/",
  "/index.html",
  "/styles.css",
  "/scripts/main.js",
  "/scripts/whatsapp.js",
  "/scripts/scroll.js",
  "/scripts/pwa.js",
  "/scripts/search-manager.js",
  "/scripts/filtros.js",
  "/logo.png",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
  "/icons/whatsapp.svg",
  "https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap",
];

// Instalación del service worker
self.addEventListener("install", (event) => {
  console.log("Service Worker instalando...");
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
  // No cachear peticiones a Google Sheets (datos dinámicos)
  if (event.request.url.includes("opensheet.elk.sh")) {
    return;
  }

  // No cachear peticiones a Cloudinary (imágenes dinámicas)
  if (event.request.url.includes("cloudinary.com")) {
    return;
  }

  event.respondWith(
    caches
      .match(event.request)
      .then((response) => {
        // Si está en cache, devolverlo
        if (response) {
          return response;
        }

        // Si no está en cache, hacer la petición
        return fetch(event.request).then((response) => {
          // Solo cachear respuestas exitosas
          if (
            !response ||
            response.status !== 200 ||
            response.type !== "basic"
          ) {
            return response;
          }

          // Clonar la respuesta para cachearla
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });

          return response;
        });
      })
      .catch(() => {
        // Si falla la petición y es una página, mostrar página offline
        if (event.request.destination === "document") {
          return caches.match("/index.html");
        }
      })
  );
});
