// bulk-optimize.js
// Requiere un archivo .env con CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Copia .env.example como .env y completa los valores
require("dotenv").config();
const cloudinary = require("cloudinary").v2;

// Credenciales desde variables de entorno (nunca hardcodeadas)
const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error("❌ Faltan variables de entorno de Cloudinary. Crea un archivo .env basado en .env.example");
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
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
