// scripts/supabase-client.js
// Cliente único de Supabase para toda la aplicación
// IMPORTANTE: Este es el ÚNICO lugar donde se debe crear el cliente de Supabase

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USE_SUPABASE,
  configReady,
  fylConfigDiagnostics,
  fylDevLog,
  fylDevInfo,
} from "./config.js";
import { FYL_VERSION } from "./fyl-version.js";
import { fylReportClientError } from "./fyl-runtime-resilience.js";

let supabase = null;

const LOG = "[FYL supabase]";

/** Tope para cada request HTTP de PostgREST/Auth (evita colgados eternos en 4G). */
const FYL_SUPABASE_FETCH_MS = 55000;

function fylFetchWithTimeout(input, init) {
  const base = init && typeof init === "object" ? { ...init } : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FYL_SUPABASE_FETCH_MS);
  const incoming = base.signal;
  if (incoming) {
    if (incoming.aborted) ctrl.abort();
    else incoming.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  base.signal = ctrl.signal;
  return fetch(input, base)
    .then(async (res) => {
      // Cuando PostgREST devuelve 4xx/5xx a veces supabase-js solo muestra "Bad Request".
      // Logueamos el body real (sin consumir el stream del response original).
      try {
        if (!res.ok) {
          const url = typeof input === "string" ? input : input?.url;
          const isRpc = typeof url === "string" && url.includes("/rest/v1/rpc/");
          if (isRpc) {
            const bodyText = await res.clone().text();
            // Si es el caso esperado "ya está anulada", no lo mostramos como error ruidoso.
            try {
              const parsed = bodyText ? JSON.parse(bodyText) : null;
              const code = parsed?.code;
              const msg = String(parsed?.message || "");
              if (
                code === "P0001" &&
                /ya\s+est[aá]\s+anulad/i.test(msg)
              ) {
                fylDevInfo(`${LOG} RPC HTTP ${res.status} (venta ya anulada)`, {
                  url,
                  body: parsed,
                });
              } else {
                console.error(`${LOG} RPC HTTP ${res.status} ${res.statusText}`, {
                  url,
                  body: parsed ?? bodyText,
                });
              }
            } catch {
              console.error(`${LOG} RPC HTTP ${res.status} ${res.statusText}`, {
                url,
                body: bodyText,
              });
            }
          }
        }
      } catch {
        // no-op: logging best-effort
      }
      return res;
    })
    .finally(() => clearTimeout(timer));
}

/** Evita que import() quede colgado indefinidamente (móvil / redes lentas). */
function importWithTimeout(moduleUrl, ms) {
  return Promise.race([
    import(moduleUrl),
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout ${ms}ms al cargar módulo`));
      }, ms);
    }),
  ]);
}

/** Sesión: una recarga si el bundle llegó como HTML (SW/hosting). */
const FYL_BUNDLE_HTML_RECOVER_KEY = "__fyl_bundle_html_recover_v1";

function fylAppendUrlQueryParam(absUrl, key, value) {
  try {
    const u = new URL(absUrl);
    u.searchParams.set(key, String(value));
    return u.href;
  } catch {
    const join = absUrl.includes("?") ? "&" : "?";
    return `${absUrl}${join}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
  }
}

/** HEAD best-effort (algunos hosts no soportan HEAD en estáticos). */
async function fylBundleHeadLooksLikeHtml(absUrl) {
  try {
    const r = await fetch(absUrl, { method: "HEAD", cache: "no-store", redirect: "follow" });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (/text\/html/i.test(ct)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * GET Range + no-store: detecta HTML sin ejecutar import() del cuerpo corrupto.
 */
async function fylBundleFetchAppearsHtml(absUrl) {
  try {
    const r = await fetch(absUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      headers: { Range: "bytes=0-2047" },
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (/text\/html/i.test(ct)) return true;
    if (!r.ok) return false;
    const ab = await r.arrayBuffer();
    const u8 = new Uint8Array(ab);
    const n = Math.min(u8.length, 256);
    let ascii = "";
    for (let i = 0; i < n; i++) ascii += String.fromCharCode(u8[i]);
    const t = ascii.trimStart();
    return t.startsWith("<!") || t.toLowerCase().startsWith("<html");
  } catch {
    return false;
  }
}

/** @returns {boolean} true si disparó reload (detener await en esta pestaña). */
function fylScheduleReloadOnceAfterHtmlBundle() {
  try {
    if (typeof sessionStorage === "undefined") return false;
    if (sessionStorage.getItem(FYL_BUNDLE_HTML_RECOVER_KEY)) return false;
    sessionStorage.setItem(FYL_BUNDLE_HTML_RECOVER_KEY, "1");
    globalThis.markBootStage?.("supabase.runtime.html_recover_reload", {});
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

function fylClearBundleHtmlRecoverFlag() {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(FYL_BUNDLE_HTML_RECOVER_KEY);
    }
  } catch (_) {}
}

/** Bundle ~400KB: en 3G/móvil real con señal débil puede superar 35s; 60s da margen. */
const SUPABASE_LOCAL_IMPORT_MS = 60000;
/** Cada intento CDN (móvil lento / DNS). */
const SUPABASE_CDN_IMPORT_MS = 28000;

const SUPABASE_LOCAL_BUNDLE =
  new URL("./vendor/supabase-js.bundle.min.js", import.meta.url).href +
  "?v=" +
  FYL_VERSION;

const SUPABASE_CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.0/+esm",
  "https://unpkg.com/@supabase/supabase-js@2.39.0/dist/esm/index.js",
  "https://esm.sh/@supabase/supabase-js@2.39.0",
];

async function tryImportSupabaseModule(absUrl) {
  const mod = await importWithTimeout(absUrl, SUPABASE_LOCAL_IMPORT_MS);
  if (mod && typeof mod.createClient === "function") return mod;
  return null;
}

function describeError(e) {
  if (e == null) return { name: "Unknown", message: String(e) };
  const name = e?.name && typeof e.name === "string" ? e.name : "Error";
  const message =
    e?.message != null && String(e.message) !== ""
      ? String(e.message)
      : String(e);
  return {
    name,
    message,
    isTimeout: /timeout/i.test(message),
  };
}

/**
 * Verifica HTTP status y Content-Type del bundle local via fetch HEAD.
 * Solo actúa cuando debug_boot=1 está activo para no añadir latencia en producción.
 * Corre en paralelo con el import() — no bloquea la carga.
 *
 * Distingue tres escenarios problemáticos de Safari:
 *   - Firebase sirviendo HTML por rewrite ** (sw_cache_suspect / bundle_missing)
 *   - MIME type incorrecto que Safari rechaza para import()
 *   - Bundle inaccesible (404 / red)
 */
async function probeBundleForDebug(url) {
  if (!globalThis.__FYL_BOOT__?.debug) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, { method: "HEAD", cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    const ct = r.headers.get("content-type") || "(sin header)";
    const looksLikeHtml = /text\/html/i.test(ct);
    const validMime = /application\/javascript|text\/javascript/i.test(ct);
    const probe = {
      status: r.status,
      contentType: ct,
      looksLikeHtml,
      validMime,
    };
    globalThis.markBootStage?.("supabase.bundle.probe", probe);
    if (looksLikeHtml) {
      console.error(
        `${LOG} [sw_cache_suspect] Bundle URL devuelve HTML (status=${r.status}). ` +
        `Firebase puede estar sirviendo el rewrite **. El bundle no está deployado o ` +
        `el SW viejo está interceptando la request. URL: ${url}`
      );
    } else if (!r.ok) {
      console.error(`${LOG} Bundle URL HTTP ${r.status}. El archivo puede no estar deployado.`);
    } else if (!validMime) {
      console.warn(
        `${LOG} MIME inesperado para el bundle: "${ct}". ` +
        `Safari requiere application/javascript o text/javascript para import() de módulos.`
      );
    } else {
      fylDevInfo(`${LOG} Bundle probe OK: status=${r.status} type="${ct}"`);
    }
    return probe;
  } catch (e) {
    const d = describeError(e);
    globalThis.markBootStage?.("supabase.bundle.probe_failed", { name: d.name, message: d.message });
    return null;
  }
}

/** @returns {{ createClient: Function, source: string }} */
async function loadCreateClient() {
  let lastErr = null;

  fylDevInfo(`${LOG} Carga de @supabase/supabase-js: primero bundle local, luego CDN.`);
  fylDevInfo(`${LOG} Bundle local URL:`, SUPABASE_LOCAL_BUNDLE);

  globalThis.markBootStage?.("supabase.runtime.bundle_url", {
    url: SUPABASE_LOCAL_BUNDLE,
    version: FYL_VERSION,
  });

  const _probeP = probeBundleForDebug(SUPABASE_LOCAL_BUNDLE);
  void _probeP;

  const t0local =
    typeof performance !== "undefined" ? performance.now() : Date.now();

  try {
    if (await fylBundleHeadLooksLikeHtml(SUPABASE_LOCAL_BUNDLE)) {
      fylDevInfo(`${LOG} HEAD del bundle sugiere text/html; se continúa con import y validación.`);
      globalThis.markBootStage?.("supabase.runtime.local_head_html_hint", {});
    }
  } catch {
    /* no-op */
  }

  let localUrl = SUPABASE_LOCAL_BUNDLE;
  let mod = null;

  try {
    fylDevInfo(`${LOG} Intento 1/local (${SUPABASE_LOCAL_IMPORT_MS}ms):`, localUrl);
    mod = await tryImportSupabaseModule(localUrl);
  } catch (e) {
    lastErr = e;
  }

  if (!mod) {
    if (!lastErr) {
      lastErr = new Error("supabase_local_import_failed: sin createClient en módulo");
    }
    const htmlish = await fylBundleFetchAppearsHtml(SUPABASE_LOCAL_BUNDLE);
    if (htmlish) {
      globalThis.markBootStage?.("supabase.runtime.local_body_html", {
        url: SUPABASE_LOCAL_BUNDLE,
      });
      console.error(
        `${LOG} El bundle local responde como HTML (SW/hosting). Recuperación controlada.`
      );
      if (fylScheduleReloadOnceAfterHtmlBundle()) {
        await new Promise(() => {});
      }
      localUrl = fylAppendUrlQueryParam(SUPABASE_LOCAL_BUNDLE, "_fylcb", Date.now());
      try {
        fylDevInfo(`${LOG} Reintento local tras HTML (cache-bust):`, localUrl);
        mod = await tryImportSupabaseModule(localUrl);
      } catch (e2) {
        lastErr = e2;
      }
    } else {
      localUrl = fylAppendUrlQueryParam(SUPABASE_LOCAL_BUNDLE, "_fylcb", Date.now());
      try {
        fylDevInfo(`${LOG} Reintento local con cache-bust:`, localUrl);
        mod = await tryImportSupabaseModule(localUrl);
      } catch (e2) {
        lastErr = e2;
      }
    }
  }

  if (mod?.createClient) {
    const elapsedMs = Math.round(
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0local
    );
    fylClearBundleHtmlRecoverFlag();
    fylDevInfo(`${LOG} OK: createClient desde bundle local en ${elapsedMs}ms.`);
    globalThis.markBootStage?.("supabase.runtime.loaded", {
      source: "local",
      elapsedMs,
    });
    return { createClient: mod.createClient, source: "local" };
  }

  const d0 = describeError(lastErr);
  const kind0 = d0.isTimeout ? "supabase_local_timeout" : "supabase_local_import_failed";
  const elapsedMs0 = Math.round(
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0local
  );
  console.warn(
    `${LOG} [${kind0}] Falló bundle local → fallback CDN. ` +
      `Tipo: ${d0.name} | ${d0.message} | elapsed: ${elapsedMs0}ms`
  );
  globalThis.markBootStage?.("supabase.runtime.local_failed", {
    kind: kind0,
    name: d0.name,
    message: d0.message,
    elapsedMs: elapsedMs0,
  });

  for (let i = 0; i < SUPABASE_CDN_URLS.length; i++) {
    const url = SUPABASE_CDN_URLS[i];
    const t0cdn = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      fylDevInfo(
        `${LOG} Intento CDN ${i + 1}/${SUPABASE_CDN_URLS.length} (${SUPABASE_CDN_IMPORT_MS}ms):`,
        url
      );
      const mod = await importWithTimeout(url, SUPABASE_CDN_IMPORT_MS);
      if (mod?.createClient) {
        const elapsedMs = Math.round(
          (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0cdn
        );
        fylDevInfo(`${LOG} OK: createClient desde CDN ${i + 1} en ${elapsedMs}ms.`);
        const source = `cdn-${i + 1}`;
        globalThis.markBootStage?.("supabase.runtime.loaded", { source, elapsedMs });
        return { createClient: mod.createClient, source };
      }
      lastErr = new Error(`supabase_cdn_failed: CDN ${i + 1} sin createClient`);
      console.warn(`${LOG} CDN ${i + 1}: sin createClient en namespace`);
      globalThis.markBootStage?.("supabase.runtime.cdn_failed", {
        kind: "supabase_cdn_failed",
        index: i + 1,
        url,
        message: "sin createClient",
      });
    } catch (e) {
      lastErr = e;
      const d = describeError(e);
      const kind = d.isTimeout ? "supabase_cdn_timeout" : "supabase_cdn_failed";
      const elapsedMs = Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0cdn
      );
      console.warn(
        `${LOG} [${kind}] CDN ${i + 1} falló. ` +
        `Tipo: ${d.name} | ${d.message} | elapsed: ${elapsedMs}ms`
      );
      globalThis.markBootStage?.("supabase.runtime.cdn_failed", {
        kind,
        index: i + 1,
        url,
        name: d.name,
        message: d.message,
        elapsedMs,
      });
    }
  }

  const finalD = describeError(lastErr);
  globalThis.markBootStage?.("supabase.runtime.all_failed", {
    kind: "create_client_failed",
    name: finalD.name,
    message: finalD.message,
  });
  try {
    fylReportClientError({
      kind: "supabase.runtime.all_failed",
      name: finalD.name,
      message: finalD.message,
    });
  } catch (_) {}
  throw new Error(
    `No se pudo cargar @supabase/supabase-js (local ni CDN). Último: ${finalD.name}: ${finalD.message}`
  );
}

/** Safari modo privado / cuota / restricciones: sin esto createClient puede tirar y dejar supabase null. */
function buildSupabaseAuthOptions() {
  const storageKey = "sb-dtfznewwvsadkorxwzft-auth-token";
  const common = {
    storageKey,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  };
  if (typeof window === "undefined") return common;
  try {
    const k = "__fyl_ls_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return common;
  } catch (_e) {
    const mem = new Map();
    console.warn(
      `${LOG} localStorage no disponible; auth en memoria (esta pestaña). El catálogo público sigue funcionando.`
    );
    return {
      ...common,
      storage: {
        getItem: (key) => (mem.has(String(key)) ? mem.get(String(key)) : null),
        setItem: (key, value) => {
          mem.set(String(key), String(value));
        },
        removeItem: (key) => {
          mem.delete(String(key));
        },
      },
    };
  }
}

// Esperar a que config.local.js (si existe) se cargue antes de inicializar Supabase
await configReady;

if (typeof window !== "undefined") {
  fylDevInfo(`${LOG} Tras configReady:`, {
    configProdScriptMarker: fylConfigDiagnostics.configProdScriptMarker,
    SUPABASE_URL: fylConfigDiagnostics.resolvedSupabaseUrl || "(vacío)",
    SUPABASE_ANON_KEY: fylConfigDiagnostics.resolvedAnonKeyMasked,
    USE_SUPABASE,
  });
}

if (USE_SUPABASE) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error(`${LOG} SUPABASE_URL o SUPABASE_ANON_KEY no configurados`);
    console.error("   SUPABASE_URL:", SUPABASE_URL ? "✅" : "❌");
    console.error(
      "   SUPABASE_ANON_KEY:",
      SUPABASE_ANON_KEY ? "✅ (longitud " + SUPABASE_ANON_KEY.length + ")" : "❌"
    );
  } else {
    const canUseWindow = typeof window !== "undefined";
    const existingWindowClient =
      canUseWindow && window.supabase && typeof window.supabase.from === "function"
        ? window.supabase
        : null;

    if (existingWindowClient) {
      fylDevLog(`${LOG} Reutilizando instancia existente en window.supabase`);
      supabase = existingWindowClient;
      globalThis.markBootStage?.("supabase.client.reused", { from: "window" });
    } else if (canUseWindow && window.__FYL_SUPABASE_CLIENT_PROMISE__) {
      // Evita carreras cuando el módulo se carga más de una vez con distinto specifier (ej. ?v=...).
      supabase = await window.__FYL_SUPABASE_CLIENT_PROMISE__;
      globalThis.markBootStage?.("supabase.client.reused", { from: "window-promise" });
    } else {
      const createClientOnce = (async () => {
        try {
          fylDevLog(`${LOG} Iniciando carga del runtime de Supabase…`);
          const { createClient, source } = await loadCreateClient();

          const created = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: buildSupabaseAuthOptions(),
            global: { fetch: fylFetchWithTimeout },
          });

          if (!created) {
            throw new Error("createClient devolvió null o undefined");
          }

          if (canUseWindow) {
            window.supabaseClient = created;
            window.supabase = created;
          }

          fylDevInfo(`${LOG} Cliente createClient() creado correctamente.`);
          globalThis.markBootStage?.("supabase.client.ready", { source });
          return created;
        } catch (error) {
          const d = describeError(error);
          console.error(`${LOG} ERROR al crear cliente:`, d.name, d.message);
          if (error?.stack) console.error(`${LOG} Stack:`, error.stack);
          globalThis.markBootStage?.("supabase.client.failed", {
            name: d.name,
            message: d.message,
          });
          return null;
        }
      })();

      if (canUseWindow) {
        window.__FYL_SUPABASE_CLIENT_PROMISE__ = createClientOnce;
      }

      supabase = await createClientOnce;
    }
  }
} else {
  globalThis.markBootStage?.("supabase.client.skipped", { reason: "USE_SUPABASE_false" });
}

if (USE_SUPABASE && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
  globalThis.markBootStage?.("supabase.client.skipped", {
    reason: "missing_url_or_anon",
  });
}

if (typeof window !== "undefined") {
  window.supabaseClient = supabase;
  window.supabase = supabase;
}

if (!supabase && USE_SUPABASE) {
  console.error(`${LOG} CRÍTICO: cliente no disponible`);
  console.error("   Revisá logs [FYL config] y [FYL supabase] arriba.");
}

export { supabase };
