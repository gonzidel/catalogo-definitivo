// scripts/boot-telemetry.js — telemetría de arranque (móvil / Safari). Cargar antes de config.js.
// ?debug_boot=1 o localStorage.fyl_debug_boot=1 → panel visual + logs extra.

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
      maxHeight: "36vh",
      overflow: "auto",
      background: "rgba(15,15,18,.92)",
      color: "#e8e8ec",
      font: "11px/1.35 ui-monospace, monospace",
      zIndex: "2147483646",
      padding: "10px 10px 14px",
      pointerEvents: "none",
      boxSizing: "border-box",
      borderTop: "1px solid #444",
    });
    body.appendChild(panelEl);
  }

  const lines = fylBootState.stages.slice(-18).map((s) => {
    const d = s.detail != null ? ` ${JSON.stringify(s.detail)}` : "";
    return `${Math.round(s.dtMs)}ms ${s.name}${d}`;
  });
  const err = fylBootState.errors[fylBootState.errors.length - 1];
  const errLine = err
    ? `\n—\nERR ${err.kind}: ${err.message || ""}\n${err.name || ""}`
    : "";
  panelEl.textContent = `FYL boot (debug_boot)\n${lines.join("\n")}${errLine}`;
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

  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    pushGlobalError("unhandledrejection", {
      message: r?.message != null ? String(r.message) : String(r),
      name: r?.name,
      stack: r?.stack,
    });
  });
}

markBootStage("boot.telemetry.ready", { debug });
