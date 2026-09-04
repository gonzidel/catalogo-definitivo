// gz-agent/native-resolve.js
// Empaquetado con pkg, __dirname vive en el snapshot virtual: se puede LEER
// un asset de ahí (fs.readFileSync) pero no ejecutarlo directo con execFile.
// Copia GZNative.exe a disco real una sola vez (arranque del proceso) antes
// de que raw-print.js/printers.js lo necesiten.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const SNAPSHOT_EXE = path.join(__dirname, "native", "GZNative.exe");

function gzTempDir() {
  const dir = path.join(os.tmpdir(), "gz-agent");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let resolvedPromise = null;
function resolveNativeExe() {
  if (!process.pkg) return Promise.resolve(SNAPSHOT_EXE);
  if (resolvedPromise) return resolvedPromise;

  resolvedPromise = (async () => {
    const outPath = path.join(gzTempDir(), "GZNative.exe");
    const src = fs.readFileSync(SNAPSHOT_EXE);
    const isNew = !fs.existsSync(outPath) || !Buffer.from(fs.readFileSync(outPath)).equals(src);
    if (isNew) {
      fs.writeFileSync(outPath, src);
    }
    if (isNew) {
      // Un .exe recién escrito a disco suele pasar por el antivirus (Windows
      // Defender) la primera vez que se ejecuta — eso agregaba varios
      // segundos al primer click de imprimir/listar impresoras del día. Se
      // "gasta" ese costo acá, en el arranque, con una corrida de prueba que
      // no le importa a nadie el resultado.
      await new Promise((resolve) => {
        execFile(outPath, ["list"], { windowsHide: true, timeout: 15000 }, () => resolve());
      });
    }
    return outPath;
  })();
  return resolvedPromise;
}

// Se dispara apenas arranca el proceso (no en el primer uso real), para que
// ese costo de una sola vez pase mientras el agente recién prendió.
resolveNativeExe().catch(() => {});

module.exports = { resolveNativeExe, gzTempDir, SNAPSHOT_EXE };
