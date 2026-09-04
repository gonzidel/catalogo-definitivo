// gz-agent/raw-print.js
// Envío de bytes RAW (ESC/POS, ZPL, TSPL) al spooler de Windows, ejecutando
// el helper nativo precompilado native/GZNative.exe (ver build-native.js).
// Nada de PowerShell ni Add-Type acá: eso recompilaba C# en cada impresión
// y era la causa del delay al apretar imprimir.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { resolveNativeExe, gzTempDir, SNAPSHOT_EXE } = require("./native-resolve");

async function sendRawToPrinter(printerName, buffer) {
  if (!fs.existsSync(SNAPSHOT_EXE)) {
    throw new Error(
      "Falta native/GZNative.exe. Corré `npm run native` (o `npm install`) en gz-agent/ para compilarlo."
    );
  }
  const nativeExe = await resolveNativeExe();

  return new Promise((resolve, reject) => {
    const dataPath = path.join(
      gzTempDir(),
      `job-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bin`
    );
    fs.writeFileSync(dataPath, buffer);

    execFile(
      nativeExe,
      ["print", printerName, dataPath],
      { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        fs.unlink(dataPath, () => {});
        if (err) {
          reject(
            new Error(
              (stderr || err.message || "").toString().trim() ||
                "Error enviando datos a la impresora"
            )
          );
          return;
        }
        resolve();
      }
    );
  });
}

module.exports = { sendRawToPrinter };
