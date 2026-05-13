// scripts/supabase-client.js
// Cliente único de Supabase para toda la aplicación.
//
// Boot crítico simplificado (Safari iOS real):
//   - El bundle vendor se carga como <script defer src="scripts/vendor/supabase-js.bundle.min.js?v=m260514">
//     y expone window.fylSupabase.createClient (IIFE same-origin).
//   - Este módulo solo lee ese global. Sin dynamic import, sin CDN fallback,
//     sin top-level await encadenado a redes externas.
//   - Único TLA: `await configReady` (IIFE local trivial).

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USE_SUPABASE,
  configReady,
  fylConfigDiagnostics,
  fylDevLog,
  fylDevInfo,
} from "./config.js";
import { FYL_VERSION } from "./fyl-version.js?v=m260514";
import { fylReportClientError } from "./fyl-runtime-resilience.js?v=m260514";

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
      try {
        if (!res.ok) {
          const url = typeof input === "string" ? input : input?.url;
          const isRpc = typeof url === "string" && url.includes("/rest/v1/rpc/");
          if (isRpc) {
            const bodyText = await res.clone().text();
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
        // best-effort logging
      }
      return res;
    })
    .finally(() => clearTimeout(timer));
}

function describeError(e) {
  if (e == null) return { name: "Unknown", message: String(e) };
  const name = e?.name && typeof e.name === "string" ? e.name : "Error";
  const message =
    e?.message != null && String(e.message) !== ""
      ? String(e.message)
      : String(e);
  return { name, message };
}

/**
 * Acceso síncrono a createClient desde el bundle IIFE same-origin.
 * El <script defer src="scripts/vendor/supabase-js.bundle.min.js?v=m260514"> debe
 * haber ejecutado antes de cualquier <script type="module">; el atributo defer
 * garantiza ese orden.
 */
function getCreateClient() {
  if (typeof window === "undefined") {
    throw new Error("supabase_no_window");
  }
  const ns = window.fylSupabase;
  if (!ns || typeof ns.createClient !== "function") {
    throw new Error("supabase_vendor_missing");
  }
  return ns.createClient;
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

// Config local (overrides) ya está cargada al resolverse configReady.
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
    globalThis.markBootStage?.("supabase.client.skipped", {
      reason: "missing_url_or_anon",
    });
  } else {
    const canUseWindow = typeof window !== "undefined";
    const existingWindowClient =
      canUseWindow && window.supabase && typeof window.supabase.from === "function"
        ? window.supabase
        : null;

    if (existingWindowClient) {
      // Reutilizá la instancia ya creada (e.g. cuando este módulo se evalúa más
      // de una vez por specifier con/sin ?v=).
      fylDevLog(`${LOG} Reutilizando instancia existente en window.supabase`);
      supabase = existingWindowClient;
      globalThis.markBootStage?.("supabase.client.reused", { from: "window" });
    } else {
      try {
        globalThis.markBootStage?.("supabase.runtime.bundle_url", {
          version: FYL_VERSION,
          source: "vendor-iife",
        });
        const createClient = getCreateClient();
        const created = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: buildSupabaseAuthOptions(),
          global: { fetch: fylFetchWithTimeout },
        });

        if (!created || typeof created.from !== "function") {
          throw new Error("createClient devolvió un objeto inválido");
        }

        supabase = created;
        if (canUseWindow) {
          window.supabaseClient = created;
          window.supabase = created;
        }
        fylDevInfo(`${LOG} Cliente createClient() creado correctamente.`);
        globalThis.markBootStage?.("supabase.client.ready", { source: "vendor-iife" });
      } catch (error) {
        const d = describeError(error);
        console.error(`${LOG} ERROR al crear cliente:`, d.name, d.message);
        if (error?.stack) console.error(`${LOG} Stack:`, error.stack);
        globalThis.markBootStage?.("supabase.client.failed", {
          name: d.name,
          message: d.message,
        });
        try {
          fylReportClientError({
            kind: "supabase.client.failed",
            name: d.name,
            message: d.message,
          });
        } catch (_) {}
        supabase = null;
      }
    }
  }
} else {
  globalThis.markBootStage?.("supabase.client.skipped", { reason: "USE_SUPABASE_false" });
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
