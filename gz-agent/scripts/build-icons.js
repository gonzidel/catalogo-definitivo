#!/usr/bin/env node
// gz-agent/scripts/build-icons.js
// Convierte los PNG fuente (assets/Principal.png, assets/Mini.png) a .ico
// para el icono del .exe y el icono de la bandeja del sistema.
const fs = require("fs");
const path = require("path");
const pngToIco = require("png-to-ico").default;

const ASSETS_DIR = path.join(__dirname, "..", "assets");

async function build(sourcePng, outIco) {
  const src = path.join(ASSETS_DIR, sourcePng);
  const out = path.join(ASSETS_DIR, outIco);
  if (!fs.existsSync(src)) {
    throw new Error(`No existe ${src}`);
  }
  const buf = await pngToIco(src);
  fs.writeFileSync(out, buf);
  console.log(`✓ ${outIco} generado desde ${sourcePng}`);
}

async function main() {
  await build("Principal.png", "icon.ico");
  await build("Mini.png", "tray-icon.ico");
}

main().catch((err) => {
  console.error("Error generando iconos:", err.message);
  process.exit(1);
});
