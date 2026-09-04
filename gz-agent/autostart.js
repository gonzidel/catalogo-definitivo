// gz-agent/autostart.js
// Registra GZ Agent para iniciar con Windows (HKCU Run key, no requiere admin).
// Solo actúa cuando corre como .exe empaquetado (process.pkg) — en desarrollo
// (`node server.js`) no se autoregistra "node.exe" como programa de inicio.
//
// Apunta directo al .exe: es el propio gz-agent.exe (ver server.js) el que
// se relanza oculto apenas arranca, así que no hace falta ningún lanzador
// .vbs ni acceso directo aparte.
const { execFile } = require("child_process");

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const VALUE_NAME = "GZAgent";

function regQuery() {
  return new Promise((resolve) => {
    execFile("reg.exe", ["query", RUN_KEY, "/v", VALUE_NAME], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const match = stdout.match(/REG_SZ\s+(.+)\r?$/m);
      resolve(match ? match[1].trim() : null);
    });
  });
}

function regSet(exePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "reg.exe",
      ["add", RUN_KEY, "/v", VALUE_NAME, "/t", "REG_SZ", "/d", `"${exePath}"`, "/f"],
      (err) => {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

function regDelete() {
  return new Promise((resolve, reject) => {
    execFile("reg.exe", ["delete", RUN_KEY, "/v", VALUE_NAME, "/f"], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function ensureAutostart() {
  if (!process.pkg) return; // solo cuando corre empaquetado
  try {
    const exePath = process.execPath;
    const current = await regQuery();
    if (current !== exePath) {
      await regSet(exePath);
      console.log("[GZ] registrado para iniciar con Windows:", exePath);
    }
  } catch (e) {
    console.warn("[GZ] no se pudo registrar el inicio automático:", e.message);
  }
}

module.exports = { ensureAutostart, regDelete };
