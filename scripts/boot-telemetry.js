// scripts/boot-telemetry.js — telemetría de arranque (móvil / Safari). Cargar antes de config.js.
// ?debug_boot=1 o localStorage.fyl_debug_boot=1 → panel visual + logs extra.

import "./fyl-error-state.js?v=m260607";

const LOG = "[FYL boot]";

function bootDebugEnabled() {
  try {
    if (typeof location === "undefined") return false;
    const qs = new URLSearchParams(location.search);
    if (qs.get("debug_boot") === "1") return true;
    if (typeof localStorage !== "undefined" && localStorage.getItem("fyl_debug_boot") === "1")
      return true;
  } catch (_) {}
  return false;
}

const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
const debug = bootDebugEnabled();

/** Estado expuesto para consola / soporte (sin secretos; detail lo acotan los callers). */
export const fylBootState = {
  t0,
  stages: [],
  errors: [],
  debug,
};

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function safeDetail(detail) {
  if (detail == null) return null;
  if (typeof detail !== "object") return detail;
  try {
    return JSON.parse(
      JSON.stringify(detail, (_k, v) => {
        if (typeof v === "string" && v.length > 160) return `${v.slice(0, 80)}…(${v.length} chars)`;
        return v;
      })
    );
  } catch {
    return "(detail no serializable)";
  }
}

let panelEl = null;

/** Devuelve los primeros N y los últimos M chars de una string, para no exponer secretos. */
function maskSecret(s, head, tail) {
  if (!s || typeof s !== "string") return "(vacío)";
  const t = s.trim();
  if (t.length <= head + tail) return `(${t.length} chars)`;
  return `${t.slice(0, head)}…${t.slice(-tail)} (${t.length}ch)`;
}

function buildEnvSnapshot() {
  if (typeof window === "undefined") return null;
  const swCtrl = navigator?.serviceWorker?.controller;
  let swState = "sin_soporte";
  if ("serviceWorker" in navigator) {
    swState = swCtrl ? swCtrl.state : "sin_controller";
  }
  return {
    ua: String(navigator.userAgent || "").slice(0, 100),
    hasSupabaseGlobal: typeof window.supabase !== "undefined" &&
      typeof window.supabase?.from === "function",
    hasSupabaseUrl: typeof window.SUPABASE_URL === "string" && !!window.SUPABASE_URL,
    supabaseUrlPrefix: typeof window.SUPABASE_URL === "string"
      ? window.SUPABASE_URL.slice(0, 30)
      : "(no definida)",
    hasSupabaseAnonKey: typeof window.SUPABASE_ANON_KEY === "string" &&
      !!window.SUPABASE_ANON_KEY,
    anonKeyMask: typeof window.SUPABASE_ANON_KEY === "string"
      ? maskSecret(window.SUPABASE_ANON_KEY, 12, 8)
      : "(no definida)",
    configProdLoaded: window.__FYL_CONFIG_PROD_LOADED__ === true,
    configProdAt: window.__FYL_CONFIG_PROD_AT__ || "(sin marca)",
    swState,
    swScope: swCtrl?.scriptURL
      ? swCtrl.scriptURL.replace(location.origin, "")
      : "(sin script)",
  };
}

function renderDebugPanel() {
  if (!debug || typeof document === "undefined") return;
  const body = document.body;
  if (!body) return;

  if (!panelEl) {
    panelEl = document.createElement("div");
    panelEl.id = "fyl-boot-debug-panel";
    panelEl.setAttribute("aria-live", "polite");
    Object.assign(panelEl.style, {
      position: "fixed",
      left: "0",
      right: "0",
      bottom: "0",
      maxHeight: "50vh",
      overflow: "auto",
      background: "rgba(15,15,18,.95)",
      color: "#e8e8ec",
      font: "11px/1.4 ui-monospace, monospace",
      zIndex: "2147483646",
      padding: "10px 10px 16px",
      pointerEvents: "none",
      boxSizing: "border-box",
      borderTop: "2px solid #CD844D",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
    });
    body.appendChild(panelEl);
  }

  // Sección de entorno (siempre arriba)
  const env = buildEnvSnapshot();
  let envBlock = "";
  if (env) {
    envBlock = [
      `UA: ${env.ua}`,
      `supabase global: ${env.hasSupabaseGlobal ? "✅" : "❌"}  ` +
        `SUPABASE_URL: ${env.hasSupabaseUrl ? "✅ " + env.supabaseUrlPrefix : "❌"}`,
      `SUPABASE_ANON_KEY: ${env.hasSupabaseAnonKey ? "✅ " + env.anonKeyMask : "❌"}`,
      `config.prod loaded: ${env.configProdLoaded ? "✅ " + env.configProdAt : "❌"}`,
      `SW: ${env.swState}  scope: ${env.swScope}`,
    ].join("\n");
  }

  // Etapas de boot (últimas 20)
  const lines = fylBootState.stages.slice(-20).map((s) => {
    const d = s.detail != null ? ` ${JSON.stringify(s.detail)}` : "";
    return `${Math.round(s.dtMs)}ms ${s.name}${d}`;
  });

  // Último error
  const err = fylBootState.errors[fylBootState.errors.length - 1];
  const errLine = err
    ? `\n— ERROR —\n${err.kind}: ${err.message || ""}\n${err.name || ""}`
    : "";

  panelEl.textContent =
    `FYL boot debug (?debug_boot=1)\n` +
    `${envBlock}\n—\n` +
    `${lines.join("\n")}${errLine}`;
}

/**
 * @param {string} name
 * @param {Record<string, unknown>|null} [detail]
 */
export function markBootStage(name, detail) {
  const dtMs = now() - t0;
  const entry = { t: now(), dtMs, name, detail: detail != null ? safeDetail(detail) : null };
  fylBootState.stages.push(entry);
  if (debug) {
    console.info(LOG, name, `${dtMs.toFixed(1)}ms`, entry.detail || "");
  }
  renderDebugPanel();
}

function pushGlobalError(kind, payload) {
  fylBootState.errors.push({ t: now(), kind, ...payload });
  console.error(LOG, kind, payload);
  renderDebugPanel();
}

if (typeof globalThis !== "undefined") {
  globalThis.markBootStage = markBootStage;
  globalThis.__FYL_BOOT__ = fylBootState;
}

if (typeof window !== "undefined") {
  const prevOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    pushGlobalError("window.onerror", {
      message: String(message),
      source: source || "",
      lineno,
      colno,
      name: error?.name,
      stack: error?.stack,
    });
    if (typeof prevOnError === "function") return prevOnError.apply(this, arguments);
    return false;
  };

}

markBootStage("boot.telemetry.ready", { debug });

import("./fyl-resource-error-diagnostics.js?v=m260607")
  .then((m) => m.installFylResourceErrorDiagnostics?.())
  .catch((e) => {
    markBootStage("resource_diag.init_failed", {
      message: String(e && e.message ? e.message : e),
    });
  });

import("./fyl-runtime-resilience.js?v=m260607")
  .then((m) => m.initFylRuntimeResilience())
  .catch((e) => {
    markBootStage("resilience.init_failed", { message: String(e && e.message ? e.message : e) });
  });

// Emitir snapshot de entorno apenas el DOM esté listo (da tiempo a que
// config.prod.js haya ejecutado y window.SUPABASE_URL esté definida).
if (typeof window !== "undefined") {
  function _emitEnvStage() {
    const env = buildEnvSnapshot();
    if (!env) return;
    markBootStage("boot.env.snapshot", env);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _emitEnvStage, { once: true });
  } else {
    // Ya pasó DOMContentLoaded (módulo ejecutándose tarde)
    _emitEnvStage();
  }
}
