// bulk-optimize.js
const cloudinary = require("cloudinary").v2;

// 1) Configura tus credenciales aquí:
cloudinary.config({
  cloud_name: "dnuedzuzm",
  api_key: "534995522718558",
  api_secret: "MlwnbgzHwA48yNvA1Rtcqb9eeHk",
});

async function optimizeAll() {
  let nextCursor;
  do {
    // 2) Cambia 'YOUR_PREFIX/' si tienes una carpeta, o quítalo si no
    const res = await cloudinary.api.resources({
      type: "upload",
      prefix: "YOUR_PREFIX/", // p.ej. 'catalogo/'
      max_results: 100,
      next_cursor: nextCursor,
    });

    // 3) Para cada imagen, crea eager transform con compresión y resize
    await Promise.all(
      res.resources.map((r) =>
        cloudinary.uploader.explicit(r.public_id, {
          type: "upload",
          eager: [
            {
              fetch_format: "auto", // WebP/AVIF automático
              quality: "auto:good", // compresión adaptativa
              width: 1600, // ancho máximo
              crop: "limit",
            },
          ],
        })
      )
    );

    nextCursor = res.next_cursor;
  } while (nextCursor);

  console.log("✅ Optimización completa en Cloudinary");
}

optimizeAll().catch((err) => {
  console.error("❌ Error durante la optimización:", err);
});
