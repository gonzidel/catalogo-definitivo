#!/usr/bin/env node
// gz-agent/server.js
// GZ: agente de impresión local (reemplazo de QZ Tray, sin certificados ni popups).
// Escucha solo en 127.0.0.1 y expone /status, /printers y /print.
const http = require("http");
const { listPrinters } = require("./printers");
const { sendRawToPrinter } = require("./raw-print");
const { imageToEscposRaster } = require("./escpos-image");
const { ensureAutostart, regDelete } = require("./autostart");
const { startTray } = require("./tray");

if (process.argv.includes("--uninstall-startup")) {
  regDelete()
    .then(() => console.log("[GZ] inicio automático desactivado"))
    .catch((e) => console.error("[GZ] error desactivando inicio automático:", e.message))
    .finally(() => process.exit(0));
  return;
}

// Empaquetado (.exe), Windows: al arrancar (doble clic o inicio de Windows)
// se relanza a sí mismo oculto (windowsHide, sin consola) y este proceso
// visible se cierra al toque — así no hace falta ningún .vbs ni acceso
// directo aparte, un solo archivo y listo.
if (process.pkg && process.platform === "win32" && !process.env.GZ_HIDDEN) {
  const { spawn } = require("child_process");
  // pkg inyecta un argv[1] sintético (la ruta interna del snapshot) que su
  // propio bootstrap necesita para resolver el módulo principal — sin
  // reenviarlo, el proceso hijo no puede arrancar.
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: Object.assign({}, process.env, { GZ_HIDDEN: "1" }),
  });
  child.unref();
  process.exit(0);
}

const PORT = parseInt(process.env.GZ_PORT, 10) || 8785;
const VERSION = "1.0.0";

function setCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error("Cuerpo de la petición demasiado grande"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function jobsToBuffer(jobs) {
  const parts = [];
  for (const job of jobs) {
    if (job == null) continue;
    if (typeof job === "string") {
      parts.push(Buffer.from(job, "latin1"));
      continue;
    }
    if (job.type === "raw" && job.format === "image") {
      const raster = await imageToEscposRaster(job.data, {
        widthDots: job.options && job.options.widthDots,
      });
      parts.push(raster);
      continue;
    }
    if (job.type === "raw") {
      parts.push(Buffer.from(String(job.data), "latin1"));
      continue;
    }
    throw new Error("Tipo de trabajo no soportado por GZ: " + JSON.stringify(job).slice(0, 200));
  }
  return Buffer.concat(parts);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch (e) {
    sendJson(res, 400, { ok: false, error: "URL inválida" });
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/status") {
      sendJson(res, 200, { ok: true, agent: "GZ", version: VERSION });
      return;
    }

    if (req.method === "GET" && url.pathname === "/printers") {
      const data = await listPrinters();
      sendJson(res, 200, data);
      return;
    }

    if (req.method === "POST" && url.pathname === "/print") {
      const bodyText = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "JSON inválido" });
        return;
      }
      const printer = payload && payload.printer;
      const jobs = payload && payload.jobs;
      if (!printer || !Array.isArray(jobs)) {
        sendJson(res, 400, { ok: false, error: "Faltan 'printer' o 'jobs'" });
        return;
      }
      const buffer = await jobsToBuffer(jobs);
      await sendRawToPrinter(printer, buffer);
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { ok: false, error: "No encontrado" });
  } catch (err) {
    console.error("[GZ] error:", err);
    sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GZ agent escuchando en http://127.0.0.1:${PORT}`);
  console.log("Dejá esta ventana abierta mientras uses la impresión desde el admin.");
  ensureAutostart();
  startTray(PORT);
});

process.on("SIGINT", () => process.exit(0));
