// gz-agent/printers.js
// Descubrimiento de impresoras instaladas en Windows, vía el helper nativo
// native/GZNative.exe (antes: PowerShell + WMI — lento y abría una ventana
// de consola visible en cada consulta).
const fs = require("fs");
const { execFile } = require("child_process");
const { resolveNativeExe, SNAPSHOT_EXE } = require("./native-resolve");

async function listPrinters() {
  if (!fs.existsSync(SNAPSHOT_EXE)) {
    throw new Error(
      "Falta native/GZNative.exe. Corré `npm run native` (o `npm install`) en gz-agent/ para compilarlo."
    );
  }
  const nativeExe = await resolveNativeExe();

  const out = await new Promise((resolve, reject) => {
    execFile(
      nativeExe,
      ["list"],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || "").toString().trim() || "Error listando impresoras"));
          return;
        }
        resolve(stdout.toString());
      }
    );
  });

  const trimmed = out.trim();
  if (!trimmed) return { printers: [], default: null };
  const parsed = JSON.parse(trimmed);
  let printers = parsed.printers;
  if (!Array.isArray(printers)) printers = printers ? [printers] : [];
  return { printers, default: parsed.default || null };
}

module.exports = { listPrinters };
