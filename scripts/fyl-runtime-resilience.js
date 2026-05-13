/**
 * Resiliencia runtime: kill switch remoto, recuperación Supabase/SW, logs de error.
 * Cargar después de boot-telemetry (via dynamic import) para encadenar window.onerror.
 */

import { FYL_VERSION } from "./fyl-version.js?v=m260514";
import { showFylErrorState } from "./fyl-error-state.js";

const SS_NUCLEAR = "__fyl_ss_nuclear_v2";
/** Compartido entre pestañas (misma origin) para no repetir kill switch en cada tab. */
const LS_FLAGS_REV = "__fyl_flags_applied_rev";

export function fylIsSupabaseClientOK(sb) {
  return !!(sb && typeof sb.from === "function");
}

/**
 * Solo borra Cache API. Preserva el Service Worker de producción
 * (network-only en /scripts/vendor/* y /config.prod.js), que es la única
 * defensa estable contra HTML stale en Safari iOS entre reloads.
 * Usado por el recovery automático (ensureCatalogSupabaseHealthy → nuclear).
 */
export async function fylClearCachesOnly() {
  try {
    if (typeof caches !== "undefined" && caches.keys) {
      const names = await caches.keys();
      await Promise.all(
        names.map((n) => caches.delete(n).catch(() => Promise.resolve()))
      );
    }
  } catch (_) {
    /* best-effort */
  }
}

/**
 * Hard reset: borra Cache API + unregister de TODOS los Service Workers.
 * SOLO para kill switch remoto (FORCE_RESET). No usar en recovery automático.
 */
export async function fylNuclearClearSwAndCaches() {
  await fylClearCachesOnly();
  try {
    if ("serviceWorker" in navigator && navigator.serviceWorker.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => Promise.resolve())));
    }
  } catch (_) {
    /* best-effort */
  }
}

function fylReadSession(key) {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function fylWriteSession(key, val) {
  try {
    if (typeof sessionStorage === "undefined") return false;
    sessionStorage.setItem(key, val);
    return true;
  } catch {
    return false;
  }
}

function fylReadLocalRev() {
  try {
    if (typeof localStorage === "undefined") return 0;
    const v = localStorage.getItem(LS_FLAGS_REV);
    return v ? Number(v) || 0 : 0;
  } catch {
    return 0;
  }
}

function fylWriteLocalRev(rev) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_FLAGS_REV, String(rev));
    }
  } catch (_) {}
}

/** Sin red no tiene sentido gastar el único nuclear ni reload: el bundle no va a mejorar. */
function fylIsNavigatorOnline() {
  try {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  } catch {
    return true;
  }
}

/**
 * @param {Record<string, unknown>} payload
 */
export function fylReportClientError(payload) {
  const base = {
    t: Date.now(),
    FYL_VERSION,
    href: typeof location !== "undefined" ? String(location.href).slice(0, 2000) : "",
    ua: typeof navigator !== "undefined" ? String(navigator.userAgent || "").slice(0, 512) : "",
    ...payload,
  };
  try {
    globalThis.markBootStage?.("client.error", base);
  } catch (_) {}

  let url = "";
  try {
    if (typeof window !== "undefined") {
      url = String(window.FYL_ERROR_LOG_URL || window.FYL_ERROR_LOG_ENDPOINT || "").trim();
    }
  } catch (_) {}
  if (!url || typeof fetch !== "function") return;

  let body;
  try {
    body = JSON.stringify(base);
  } catch {
    body = "{}";
  }
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    mode: "cors",
    credentials: "omit",
    keepalive: true,
    cache: "no-store",
  }).catch(() => {});
}

async function fylFetchRuntimeFlags() {
  if (typeof location === "undefined") return null;
  let base = "";
  try {
    base = String(
      (typeof window !== "undefined" && window.FYL_RUNTIME_FLAGS_URL) ||
        `${location.origin}/fyl-flags.json`
    ).trim();
  } catch {
    return null;
  }
  if (!base) return null;
  try {
    const u = new URL(base, location.href);
    u.searchParams.set("_", String(Date.now()));
    const r = await fetch(u.href, { cache: "no-store", credentials: "omit" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fylMaybeApplyKillSwitch(flags) {
  if (!flags || typeof flags !== "object") return;
  const rev = Number(flags.rev) || 0;
  const last = fylReadLocalRev();
  if (rev <= last) return;
  if (flags.FORCE_RESET !== true) {
    fylWriteLocalRev(rev);
    return;
  }
  if (!fylIsNavigatorOnline()) {
    globalThis.markBootStage?.("resilience.kill_switch_skipped_offline", { rev });
    return;
  }
  fylWriteLocalRev(rev);
  fylReportClientError({ kind: "kill_switch", message: "FORCE_RESET", rev });
  await fylNuclearClearSwAndCaches();
  globalThis.markBootStage?.("resilience.kill_switch", { rev });
  location.reload();
  await new Promise(() => {});
}

async function fylTryNuclearSessionRecovery(reason) {
  if (!fylIsNavigatorOnline()) {
    fylReportClientError({
      kind: "resilience.recovery_skipped_offline",
      message: String(reason || ""),
    });
    globalThis.markBootStage?.("resilience.nuclear_skipped_offline", { reason });
    return false;
  }
  if (fylReadSession(SS_NUCLEAR)) return false;
  if (!fylWriteSession(SS_NUCLEAR, "1")) return false;
  fylReportClientError({ kind: "resilience.nuclear", message: String(reason || "") });
  // SOFT clear: preserva el SW de producción para que el reload se sirva con network-only.
  await fylClearCachesOnly();
  globalThis.markBootStage?.("resilience.nuclear_reload", { reason });
  location.reload();
  await new Promise(() => {});
}

/**
 * Si el cliente Supabase importado está roto: una recuperación por sesión (SW+caches+reload).
 * @param {() => unknown} getSupabase
 * @returns {Promise<boolean>}
 */
export async function ensureCatalogSupabaseHealthy(getSupabase) {
  const read = () => (typeof getSupabase === "function" ? getSupabase() : getSupabase);
  if (fylIsSupabaseClientOK(read())) return true;
  globalThis.markBootStage?.("resilience.supabase_broken", { FYL_VERSION });
  await fylTryNuclearSessionRecovery("supabase_no_client");
  return fylIsSupabaseClientOK(read());
}

let __fylFlagsTimer = null;

/**
 * Fallos que no deben tapar el catálogo con fullscreen "unexpected"
 * (View Transitions, cancelaciones, extensiones, mensajes de libs inyectadas).
 */
function fylNormalizeFailureReason(reason) {
  if (reason == null) return { name: "", message: "" };
  if (typeof reason === "string") return { name: "", message: reason };
  try {
    const name = reason.name != null ? String(reason.name) : "";
    const message = reason.message != null ? String(reason.message) : String(reason);
    return { name, message };
  } catch (_) {
    return { name: "", message: String(reason) };
  }
}

function fylIsBenignForUnexpectedOverlay(reason) {
  const { name, message } = fylNormalizeFailureReason(reason);
  const lower = message.toLowerCase();

  if (name === "AbortError") return true;
  if (name === "NotAllowedError") return true;
  if (/\baborterror\b/i.test(message)) return true;
  if (lower.includes("transition was skipped")) return true;
  if (lower.includes("skiptransition")) return true;
  // View Transitions API: TimeoutError cuando el callback de DOM update tarda demasiado,
  // y AbortError cuando una transición es interrumpida por otra (toques rápidos del usuario).
  // Son errores esperados de la propia API, no fallos del catálogo.
  if (lower.includes("transition was aborted")) return true;
  if (lower.includes("timeout in dom update")) return true;
  if (name === "TimeoutError" && lower.includes("transition")) return true;
  if (lower.includes("resizeobserver loop")) return true;
  if (lower.includes("non-error promise rejection")) return true;
  if (lower.includes("go.apollo.dev")) return true;
  if (lower.includes("apollo client")) return true;

  return false;
}

function fylWindowOnerrorBenign(message, source) {
  const m = String(message || "");
  const s = String(source || "");
  if (m === "Script error." || m === "Script error") return true;
  if (/chrome-extension:|moz-extension:|safari-web-extension:|edgeextension:/i.test(s)) return true;
  return false;
}

function fylMaybeShowUnexpected(reason) {
  try {
    if (
      typeof window !== "undefined" &&
      typeof window.__FYL_isExpectedAuthError === "function" &&
      window.__FYL_isExpectedAuthError(reason)
    ) {
      return;
    }
  } catch (_) {}
  if (fylIsBenignForUnexpectedOverlay(reason)) return;
  try {
    showFylErrorState({
      preset: "unexpected",
      retry: () => {
        location.reload();
      },
    });
  } catch (_) {}
}

function fylInstallGlobalHandlers() {
  if (typeof window === "undefined") return;

  try {
    window.FYL_VERSION = FYL_VERSION;
  } catch (_) {}

  const prevOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    fylReportClientError({
      kind: "window.onerror",
      message: String(message),
      source: String(source || ""),
      lineno,
      colno,
      stack: error && error.stack ? String(error.stack).slice(0, 4000) : "",
    });
    if (!fylWindowOnerrorBenign(message, source)) {
      fylMaybeShowUnexpected(error || { message: String(message) });
    }
    if (typeof prevOnError === "function") {
      return prevOnError.apply(this, arguments);
    }
    return false;
  };

  window.addEventListener(
    "unhandledrejection",
    (ev) => {
      const r = ev.reason;
      try {
        if (globalThis.__FYL_BOOT__ && Array.isArray(globalThis.__FYL_BOOT__.errors)) {
          globalThis.__FYL_BOOT__.errors.push({
            t: typeof performance !== "undefined" ? performance.now() : Date.now(),
            kind: "unhandledrejection",
            message: r && r.message != null ? String(r.message) : String(r),
            name: r && r.name,
            stack: r && r.stack,
          });
        }
      } catch (_) {}
      fylReportClientError({
        kind: "unhandledrejection",
        message: r && r.message != null ? String(r.message) : String(r),
        stack: r && r.stack ? String(r.stack).slice(0, 4000) : "",
      });
      fylMaybeShowUnexpected(r);
    },
    { capture: true }
  );
}

export async function initFylRuntimeResilience() {
  if (typeof window === "undefined") return;
  if (window.__FYL_RESILIENCE_INIT__) return;
  window.__FYL_RESILIENCE_INIT__ = true;

  fylInstallGlobalHandlers();

  try {
    const flags = await fylFetchRuntimeFlags();
    await fylMaybeApplyKillSwitch(flags);
  } catch (_) {
    /* no-op */
  }

  if (__fylFlagsTimer) clearInterval(__fylFlagsTimer);
  const pollFlags = async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const flags = await fylFetchRuntimeFlags();
      await fylMaybeApplyKillSwitch(flags);
    } catch (_) {
      /* no-op */
    }
  };
  __fylFlagsTimer = setInterval(pollFlags, 120000);
  if (typeof document !== "undefined") {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden) pollFlags();
      },
      { passive: true }
    );
  }
}
