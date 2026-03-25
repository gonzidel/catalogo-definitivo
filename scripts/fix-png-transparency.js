// Convierte fondo negro a transparente en PNG usando sharp
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inputPath = path.join(__dirname, '../assets/icono-carrito-x4.png');
const outputPath = path.join(__dirname, '../assets/icono-carrito-x4-fixed.png');

const threshold = 45;

const image = sharp(inputPath);
const { data, info } = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;
for (let i = 0; i < data.length; i += channels) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  if (r < threshold && g < threshold && b < threshold) {
    data[i + 3] = 0;
  }
}

await sharp(data, { raw: { width, height, channels } })
  .png()
  .toFile(outputPath);

fs.renameSync(outputPath, inputPath);
console.log('Fondo negro convertido a transparente:', inputPath);
