// admin/qz-printing.js
// Módulo compartido: única fuente de carga, firma y conexión QZ Tray
import { SUPABASE_URL } from "../scripts/config.js";
import { supabase } from "../scripts/supabase-client.js";

const QZ_CERT_URL = "/certs/qz-site.crt";
const QZ_TRAY_SCRIPT_SRC = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js";

let qzLibraryReadyPromise = null;
let qzSecurityConfigured = false;
let qzConnectChain = Promise.resolve();
/** Contador temporal para validación operativa (doble connect / cola). */
let qzConnectRunnerInvocations = 0;

/** Observabilidad runtime: monkey-patch fetch (qz-sign) + API QZ. No altera lógica de setup/connect. */
let qzRuntimeTraceInstalled = false;

function qzTraceSnapshot() {
  return {
    timestamp: new Date().toISOString(),
    websocketActive:
      typeof qz !== "undefined" && qz && qz.websocket && qz.websocket.isActive() === true,
    signatureConfigured: qzSecurityConfigured,
    certRoute: QZ_CERT_URL,
  };
}

function qzTraceLine(action, extra) {
  const row = Object.assign({ action }, qzTraceSnapshot(), extra || {});
  console.log("[QZ TRACE]", row);
}

function tracePromise(action, p) {
  return Promise.resolve(p).then(
    (v) => {
      qzTraceLine(action, { promise: "resolved" });
      return v;
    },
    (e) => {
      qzTraceLine(action, {
        promise: "rejected",
        errorMessage: e && e.message ? e.message : String(e),
      });
      throw e;
    }
  );
}

/**
 * Instala una sola vez: intercepta fetch hacia qz-sign y métodos qz.* listados.
 * Debe ejecutarse cuando `qz` ya está definido.
 */
function installQzRuntimeTrace() {
  if (qzRuntimeTraceInstalled) return;
  if (typeof qz === "undefined" || !qz) return;
  qzRuntimeTraceInstalled = true;

  if (typeof window !== "undefined" && !window.__QZ_TRACE_FETCH_WRAPPED) {
    window.__QZ_TRACE_FETCH_WRAPPED = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === "string" ? input : input && input.url ? String(input.url) : "";
      const isQzSign = url.indexOf("/functions/v1/qz-sign") !== -1;
      if (isQzSign) {
        const body = init && init.body;
        const bodyInfo =
          typeof body === "string"
            ? { toSignLength: body.length }
            : body != null
              ? { bodyKind: typeof body }
              : { body: "missing" };
        qzTraceLine("sign_fetch_request", Object.assign({ signRequestSent: true }, bodyInfo));
      }
      let res;
      try {
        res = await origFetch(input, init);
      } catch (err) {
        if (isQzSign) {
          qzTraceLine("sign_fetch_throw", {
            signRequestFailed: true,
            errorMessage: err && err.message ? err.message : String(err),
          });
        }
        throw err;
      }
      if (isQzSign) {
        const st = res.status;
        let text = "";
        try {
          text = (await res.clone().text()) || "";
        } catch (readErr) {
          qzTraceLine("sign_response_body_read_failed", {
            responseStatus: st,
            errorMessage: readErr && readErr.message,
          });
        }
        const trim = text.trim();
        const b64ish = /^[A-Za-z0-9+/=\s]+$/.test(trim) && trim.length > 20;
        qzTraceLine("sign_fetch_response", {
          responseStatus: st,
          responseTextLength: text.length,
          responseEmpty: text.length === 0,
          responseLooksHtml:
            trim.startsWith("<!") || trim.toLowerCase().startsWith("<html"),
          responseLooksJson: trim.startsWith("{") || trim.startsWith("["),
          responseLooksBase64Signature: b64ish,
          signRequestSuccess: res.ok && text.length > 0 && !trim.startsWith("<"),
          signRequestFailed: !res.ok || text.length === 0,
        });
      }
      return res;
    };
  }

  try {
    if (
      qz.websocket &&
      typeof qz.websocket.connect === "function" &&
      !qz.websocket.__qzTraceWrappedConnect
    ) {
      const orig = qz.websocket.connect.bind(qz.websocket);
      qz.websocket.__qzTraceWrappedConnect = true;
      qz.websocket.connect = function () {
        qzTraceLine("api_websocket_connect");
        return tracePromise("api_websocket_connect", orig.apply(qz.websocket, arguments));
      };
    }
  } catch (e) {
    qzTraceLine("wrap_websocket_connect_skip", { message: e.message });
  }

  try {
    if (qz.printers && typeof qz.printers.find === "function" && !qz.printers.__qzTraceWrappedFind) {
      const orig = qz.printers.find.bind(qz.printers);
      qz.printers.__qzTraceWrappedFind = true;
      qz.printers.find = function () {
        qzTraceLine("api_printers_find", { args: Array.prototype.slice.call(arguments) });
        return tracePromise("api_printers_find", orig.apply(qz.printers, arguments));
      };
    }
  } catch (e) {
    qzTraceLine("wrap_printers_find_skip", { message: e.message });
  }

  try {
    if (
      qz.printers &&
      typeof qz.printers.getDefault === "function" &&
      !qz.printers.__qzTraceWrappedGetDefault
    ) {
      const orig = qz.printers.getDefault.bind(qz.printers);
      qz.printers.__qzTraceWrappedGetDefault = true;
      qz.printers.getDefault = function () {
        qzTraceLine("api_printers_getDefault");
        return tracePromise("api_printers_getDefault", orig.apply(qz.printers, arguments));
      };
    }
  } catch (e) {
    qzTraceLine("wrap_printers_getDefault_skip", { message: e.message });
  }

  try {
    if (qz.configs && typeof qz.configs.create === "function" && !qz.configs.__qzTraceWrappedCreate) {
      const orig = qz.configs.create.bind(qz.configs);
      qz.configs.__qzTraceWrappedCreate = true;
      qz.configs.create = function () {
        qzTraceLine("api_configs_create", { argCount: arguments.length });
        try {
          const cfg = orig.apply(qz.configs, arguments);
          qzTraceLine("api_configs_create_done", { promise: "sync" });
          return cfg;
        } catch (e) {
          qzTraceLine("api_configs_create", {
            promise: "rejected",
            errorMessage: e && e.message,
          });
          throw e;
        }
      };
    }
  } catch (e) {
    qzTraceLine("wrap_configs_create_skip", { message: e.message });
  }

  try {
    if (typeof qz.print === "function" && !qz.__qzTraceWrappedPrint) {
      const orig = qz.print.bind(qz);
      qz.__qzTraceWrappedPrint = true;
      qz.print = function () {
        qzTraceLine("api_print", { argCount: arguments.length });
        return tracePromise("api_print", orig.apply(qz, arguments));
      };
    }
  } catch (e) {
    qzTraceLine("wrap_print_skip", { message: e.message });
  }

  qzTraceLine("runtime_trace_installed");
}

function loadQZInternal() {
  console.log("[QZ] loading library");

  return (async () => {
    if (typeof qz !== "undefined" && qz && qz.websocket) {
      installQzRuntimeTrace();
      return;
    }

    let scriptEl = document.querySelector('script[src*="qz-tray"]');
    if (!scriptEl) {
      scriptEl = document.createElement("script");
      scriptEl.src = QZ_TRAY_SCRIPT_SRC;
      scriptEl.async = true;
      document.head.appendChild(scriptEl);
      await new Promise((resolve, reject) => {
        scriptEl.onload = () => resolve();
        scriptEl.onerror = () => reject(new Error("QZ script load error"));
      });
    } else {
      await new Promise((resolve, reject) => {
        if (typeof qz !== "undefined" && qz && qz.websocket) {
          resolve();
          return;
        }
        scriptEl.addEventListener("load", () => resolve(), { once: true });
        scriptEl.addEventListener("error", () => reject(new Error("QZ script load error")), {
          once: true,
        });
        setTimeout(resolve, 0);
      });
    }

    const deadline = Date.now() + 15000;
    while (typeof qz === "undefined" || !qz || !qz.websocket) {
      if (Date.now() > deadline) {
        throw new Error("QZ Tray no está disponible");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    installQzRuntimeTrace();
  })();
}

/**
 * Carga la librería qz-tray si hace falta y espera a que exista qz.websocket.
 */
export function loadQZ() {
  if (typeof qz !== "undefined" && qz && qz.websocket) {
    installQzRuntimeTrace();
    return Promise.resolve();
  }
  if (!qzLibraryReadyPromise) {
    qzLibraryReadyPromise = loadQZInternal().catch((err) => {
      qzLibraryReadyPromise = null;
      console.log("[QZ STATE] library load failed", err && err.message ? err.message : err);
      throw err;
    });
  }
  return qzLibraryReadyPromise;
}

/** Alias legado (ventas públicas / otras pantallas). */
export const loadQZTray = loadQZ;

async function qzConnectRunner() {
  qzConnectRunnerInvocations += 1;
  console.log("[QZ STATE] connect runner invocation", qzConnectRunnerInvocations);

  await loadQZ();
  if (typeof qz === "undefined" || !qz || !qz.websocket) {
    throw new Error("QZ Tray no está disponible");
  }

  if (qz.websocket.isActive()) {
    console.log("[QZ STATE] websocket active");
    console.log("[QZ] websocket already active");
    return;
  }

  console.log("[QZ STATE] websocket closed");

  const signatureConfigured = await setupQZSignature();
  if (!signatureConfigured) {
    console.warn("[QZ] setup signature incomplete");
    console.log("[QZ STATE] setup incomplete (signature not ready)");
  }

  if (qz.websocket.isActive()) {
    console.log("[QZ STATE] websocket active");
    console.log("[QZ] websocket already active");
    return;
  }

  console.log("[QZ STATE] reconnect requested");
  console.log("[QZ] websocket connecting");
  try {
    await qz.websocket.connect();
    console.log("[QZ STATE] websocket active");
    console.log("[QZ] websocket connected");
  } catch (error) {
    console.log("[QZ STATE] websocket connect failed", error && error.message ? error.message : error);
    if (error.message && error.message.includes("Connection blocked")) {
      const origin = typeof location !== "undefined" ? location.origin : "este sitio";
      const improved = new Error(
        "No se pudo conectar con QZ Tray (sitio bloqueado). Permití " + origin + " en Site Manager de QZ Tray."
      );
      improved.stack = error.stack;
      throw improved;
    }
    throw error;
  }
}

/**
 * Serializa conexiones: loadQZ -> setup (una vez) -> connect.
 * Un intento fallido no bloquea los siguientes (.catch vacío entre pasos).
 */
export function qzConnect() {
  console.log("[QZ STATE] qzConnect queued");
  qzConnectChain = qzConnectChain.catch(() => {}).then(() => qzConnectRunner());
  return qzConnectChain;
}

export async function setupQZSignature() {
  await loadQZ();

  if (typeof qz === "undefined" || !qz || !qz.security) {
    console.warn("[QZ] security API missing");
    return false;
  }

  if (qzSecurityConfigured) {
    console.log("[QZ STATE] setup skipped");
    console.log("[QZ STATE] signature already configured");
    console.log("[QZ] signature promise ready");
    return true;
  }

  console.log("[QZ] setup signature start");

  try {
    const certResponse = await fetch(QZ_CERT_URL, { cache: "no-store" });
    if (!certResponse.ok) {
      throw new Error("cert HTTP " + certResponse.status);
    }
    const contentType = certResponse.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      throw new Error("cert response is HTML");
    }
    const certText = await certResponse.text();
    if (
      !certText ||
      certText.trim().startsWith("<!DOCTYPE") ||
      certText.trim().startsWith("<html")
    ) {
      throw new Error("cert body looks like HTML");
    }

    console.log("[QZ] certificate loaded");

    qz.security.setCertificatePromise((resolve, reject) => {
      const match = certText.match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
      );
      if (match) {
        resolve(match[0]);
      } else {
        reject(new Error("cert PEM block not found"));
      }
    });

    qz.security.setSignatureAlgorithm("SHA512");

    qz.security.setSignaturePromise(async (toSign) => {
      if (!toSign || typeof toSign !== "string") {
        throw new Error("toSign inválido o vacío");
      }

      if (!supabase || !supabase.auth) {
        throw new Error("Cliente Supabase no disponible para firmar con QZ");
      }

      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token || "";
      if (sessionError || !accessToken) {
        throw new Error("Sesión Supabase requerida para firmar con QZ");
      }

      console.log("[QZ] sign request sent");

      let res;
      try {
        res = await fetch(`${SUPABASE_URL}/functions/v1/qz-sign`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "text/plain;charset=utf-8",
          },
          body: toSign,
        });
      } catch (netErr) {
        const msg = netErr && netErr.message ? netErr.message : String(netErr);
        const isCors =
          /Failed to fetch|NetworkError|CORS|Load failed|network/i.test(msg);
        console.log("[QZ] sign request failed", msg);
        console.log("[QZ STATE] sign network error", isCors ? "possible CORS or offline" : msg);
        throw netErr;
      }

      if (!res.ok) {
        const errorText = await res.text();
        console.log("[QZ] sign request failed", "HTTP " + res.status);
        if (res.status === 401) {
          console.log("[QZ STATE] sign HTTP 401 unauthorized");
        } else {
          console.log("[QZ STATE] sign HTTP error", res.status);
        }
        throw new Error(`Error en firma: ${res.status} - ${errorText}`);
      }

      const signature = (await res.text()).trim();
      console.log("[QZ] sign request success");
      return signature;
    });

    qzSecurityConfigured = true;
    console.log("[QZ] signature promise ready");
    return true;
  } catch (error) {
    console.log("[QZ] setup failed", error && error.message ? error.message : error);
    return false;
  }
}

/**
 * Impresora Zebra GK420t si existe; si no, impresora por defecto.
 * @param {{ forceRaw?: boolean }} [options]
 */
export async function qzGetPrinterConfig(options) {
  let printerName;
  try {
    const printers = await qz.printers.find("GK420t");
    if (printers && printers.length > 0) {
      printerName = printers[0];
    } else {
      printerName = await qz.printers.getDefault();
    }
  } catch (e) {
    printerName = await qz.printers.getDefault();
  }

  const forceRaw = options && options.forceRaw;
  const config = forceRaw
    ? qz.configs.create(printerName, { forceRaw: true })
    : qz.configs.create(printerName);
  return config;
}

/** Solo impresora por defecto (tickets / ESC-POS). */
export async function qzGetPrinterConfigDefault() {
  const printerName = await qz.printers.getDefault();
  return qz.configs.create(printerName);
}

// ============================================================================
// Generación de ZPL
// ============================================================================

export function cleanZplText(v) {
  if (!v) return "";
  let s = v.toString();
  s = s.replace(/[\^~\\]/g, " ");
  s = s
    .replace(/[áÁ]/g, "a")
    .replace(/[éÉ]/g, "e")
    .replace(/[íÍ]/g, "i")
    .replace(/[óÓ]/g, "o")
    .replace(/[úÚ]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N");
  return s;
}

export function buildZplForSingleLabel(sku, productName, color, size, qrData) {
  const sSku = cleanZplText(sku);
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  const nameShort = sName.slice(0, 20);
  const colorSizeShort = (sColor + " " + sSize).trim().slice(0, 20);

  return (
    `^XA
^PW648
^LL160
^LH0,0

^FO24,20^BQN,2,4
^FDLA,${sQr}^FS

^FO120,30^A0N,18,18^FD${sSku}^FS
^FO120,64^A0N,48,44^FD${nameShort}^FS
^FO120,104^A0N,40,36^FD${colorSizeShort}^FS

^XZ`
  ).trim();
}

export function buildZplForDoubleLabel(sku, productName, color, size, qrData) {
  const sSku = cleanZplText(sku);
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  const nameShort = sName.slice(0, 20);
  const colorSizeShort = (sColor + " " + sSize).trim().slice(0, 20);

  return (
    `^XA
^PW648
^LL160
^LH0,0

^FX ----- ETIQUETA IZQUIERDA -----
^FO24,20^BQN,2,4
^FDLA,${sQr}^FS

^FO120,30^A0N,18,18^FD${sSku}^FS
^FO120,64^A0N,48,44^FD${nameShort}^FS
^FO120,104^A0N,40,36^FD${colorSizeShort}^FS

^FX ----- ETIQUETA DERECHA -----
^FO360,20^BQN,2,4
^FDLA,${sQr}^FS

^FO456,30^A0N,18,18^FD${sSku}^FS
^FO456,64^A0N,48,44^FD${nameShort}^FS
^FO456,104^A0N,40,36^FD${colorSizeShort}^FS

^XZ`
  ).trim();
}

// ============================================================================
// Impresión de etiquetas
// ============================================================================

export async function printProductLabelsZebra(sku, productName, color, size, copies, qrDataOverride) {
  copies = parseInt(copies, 10);
  if (!copies || copies < 1) {
    console.warn("Cantidad de copias inválida:", copies);
    return;
  }

  const qrData = qrDataOverride || sku;

  try {
    await qzConnect();
    const cfg = await qzGetPrinterConfig();

    const jobs = [];

    const totalLabels = copies;
    const pairs = Math.floor(totalLabels / 2);
    const remainder = totalLabels % 2;

    const zplDouble = buildZplForDoubleLabel(sku, productName, color, size, qrData);

    for (let i = 0; i < pairs; i++) {
      jobs.push({
        type: "raw",
        format: "command",
        data: zplDouble,
      });
    }

    if (remainder === 1) {
      const zplSingle = buildZplForSingleLabel(sku, productName, color, size, qrData);
      jobs.push({
        type: "raw",
        format: "command",
        data: zplSingle,
      });
    }

    if (jobs.length > 0) {
      console.log("[QZ] print requested");
      await qz.print(cfg, jobs);
      console.log("[QZ] print jobs sent", copies);
    }
  } catch (err) {
    console.error("Error imprimiendo etiquetas Zebra:", err);

    let errorMessage = "No se pudo imprimir la etiqueta en la Zebra.";

    if (err.message && err.message.includes("certificate")) {
      errorMessage +=
        "\n\nError de certificado/firma. Verifica que la Edge Function qz-sign esté desplegada y funcionando.";
    } else if (err.message && err.message.includes("Connection blocked")) {
      errorMessage += "\n\nConexión bloqueada. Verifica que QZ Tray esté instalado y ejecutándose.";
    } else if (err.message && err.message.includes("No session token")) {
      errorMessage += "\n\nDebes estar autenticado para imprimir.";
    } else {
      errorMessage +=
        "\n\nVerifica que:\n- QZ Tray esté instalado y ejecutándose\n- La impresora esté conectada\n- Tengas sesión activa";
    }

    alert(errorMessage);
  }
}
