// scripts/image-manager.js

export async function downloadImage(btn) {
  const card = btn.closest(".card");
  const src = card.querySelector(".main-image").src;

  // Tracking
  if (typeof gtag === "function") {
    gtag("event", "descarga_imagen", {
      event_category: "interaccion",
      event_label: src,
    });
  }

  // Renombrar extensión a .jpg
  const filename = src
    .split("/")
    .pop()
    .split("?")[0]
    .replace(/\.\w+$/, ".jpg");

  try {
    // 1. Cargar imagen con CORS
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    // 2. Dibujar en canvas
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    // 3. Convertir a JPEG y descargar
    canvas.toBlob(
      (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      "image/jpeg",
      0.92
    );
  } catch (err) {
    console.warn("Canvas fallback failed, usando <a download> directo:", err);
    // Fallback directo: cambiamos el download a `.jpg`
    const a = document.createElement("a");
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// Manejo de recarga automática
let ultimaVista = Date.now();

export function initAutoReload() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const ahora = Date.now();
      const minutosAusente = (ahora - ultimaVista) / 60000;

      if (minutosAusente >= 10) {
        location.reload();
      }
      ultimaVista = ahora;
    } else {
      ultimaVista = Date.now();
    }
  });
}
