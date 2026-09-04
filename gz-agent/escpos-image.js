// gz-agent/escpos-image.js
// Convierte una imagen (URL o base64) al comando raster ESC/POS "GS v 0",
// que es lo que QZ Tray hacía server-side para los jobs {format:"image"}.
const Jimp = require("jimp");

const DEFAULT_WIDTH_DOTS = 384; // ancho típico impresoras térmicas 80mm a 203dpi/2

async function fetchImageBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("No se pudo descargar imagen: HTTP " + res.status);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function imageToEscposRaster(source, opts) {
  opts = opts || {};
  const widthDots = opts.widthDots || DEFAULT_WIDTH_DOTS;

  let buffer;
  if (typeof source === "string" && /^https?:\/\//i.test(source)) {
    buffer = await fetchImageBuffer(source);
  } else if (typeof source === "string") {
    buffer = Buffer.from(source, "base64");
  } else {
    buffer = source;
  }

  const image = await Jimp.read(buffer);
  image.grayscale();
  if (image.bitmap.width !== widthDots) {
    image.resize(widthDots, Jimp.AUTO);
  }
  image.threshold({ max: 128 });

  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const bytesPerRow = Math.ceil(width / 8);

  const raster = Buffer.alloc(bytesPerRow * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = image.getPixelIndex(x, y);
      const gray = image.bitmap.data[idx];
      const isBlack = gray < 128;
      if (isBlack) {
        const byteIndex = y * bytesPerRow + (x >> 3);
        const bit = 7 - (x % 8);
        raster[byteIndex] |= 1 << bit;
      }
    }
  }

  const xL = bytesPerRow & 0xff;
  const xH = (bytesPerRow >> 8) & 0xff;
  const yL = height & 0xff;
  const yH = (height >> 8) & 0xff;

  // GS v 0 m xL xH yL yH d1...dk
  const header = Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
  return Buffer.concat([header, raster]);
}

module.exports = { imageToEscposRaster };
