// scripts/supabase-client.js
// Cliente único de Supabase para toda la aplicación
// IMPORTANTE: Este es el ÚNICO lugar donde se debe crear el cliente de Supabase

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USE_SUPABASE,
  configReady,
  fylConfigDiagnostics,
} from "./config.js";

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
  return fetch(input, base).finally(() => clearTimeout(timer));
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

/** Bundle ~400KB: en 3G/móvil real puede superar 8s; PC en Wi‑Fi no. */
const SUPABASE_LOCAL_IMPORT_MS = 35000;
/** Cada intento CDN (móvil lento / DNS). */
const SUPABASE_CDN_IMPORT_MS = 28000;

const SUPABASE_LOCAL_BUNDLE = new URL(
  "./vendor/supabase-js.bundle.js",
  import.meta.url
).href;

const SUPABASE_CDN_URLS = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.0/+esm",
  "https://unpkg.com/@supabase/supabase-js@2.39.0/dist/esm/index.js",
  "https://esm.sh/@supabase/supabase-js@2.39.0",
];

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

/** @returns {{ createClient: Function, source: string }} */
async function loadCreateClient() {
  let lastErr = null;

  console.info(`${LOG} Carga de @supabase/supabase-js: primero bundle local, luego CDN.`);

  try {
    console.info(`${LOG} Intento 1/local (${SUPABASE_LOCAL_IMPORT_MS}ms):`, SUPABASE_LOCAL_BUNDLE);
    const mod = await importWithTimeout(
      SUPABASE_LOCAL_BUNDLE,
      SUPABASE_LOCAL_IMPORT_MS
    );
    if (mod?.createClient) {
      console.info(`${LOG} OK: createClient desde bundle local (mismo origen).`);
      globalThis.markBootStage?.("supabase.runtime.loaded", { source: "local" });
      return { createClient: mod.createClient, source: "local" };
    }
    lastErr = new Error("Módulo local sin export createClient");
    const d = describeError(lastErr);
    console.warn(`${LOG} Local: ${d.name} — ${d.message}`);
  } catch (e) {
    lastErr = e;
    const d = describeError(e);
    console.warn(
      `${LOG} Falló bundle local → fallback CDN. Tipo: ${d.name} | ${d.message}`
    );
    globalThis.markBootStage?.("supabase.runtime.local_failed", {
      name: d.name,
      message: d.message,
    });
  }

  for (let i = 0; i < SUPABASE_CDN_URLS.length; i++) {
    const url = SUPABASE_CDN_URLS[i];
    try {
      console.info(
        `${LOG} Intento CDN ${i + 1}/${SUPABASE_CDN_URLS.length} (${SUPABASE_CDN_IMPORT_MS}ms):`,
        url
      );
      const mod = await importWithTimeout(url, SUPABASE_CDN_IMPORT_MS);
      if (mod?.createClient) {
        console.info(`${LOG} OK: createClient desde CDN (${i + 1}).`);
        const source = `cdn-${i + 1}`;
        globalThis.markBootStage?.("supabase.runtime.loaded", { source });
        return { createClient: mod.createClient, source };
      }
      lastErr = new Error(`CDN ${i + 1}: módulo sin createClient`);
      console.warn(`${LOG} CDN ${i + 1}: sin createClient en namespace`);
    } catch (e) {
      lastErr = e;
      const d = describeError(e);
      console.warn(
        `${LOG} CDN ${i + 1} falló. Tipo: ${d.name} | ${d.message}`
      );
      globalThis.markBootStage?.("supabase.runtime.cdn_failed", {
        index: i + 1,
        name: d.name,
        message: d.message,
      });
    }
  }

  const finalD = describeError(lastErr);
  globalThis.markBootStage?.("supabase.runtime.all_failed", {
    name: finalD.name,
    message: finalD.message,
  });
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
  console.info(`${LOG} Tras configReady:`, {
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
      console.log(`${LOG} Reutilizando instancia existente en window.supabase`);
      supabase = existingWindowClient;
      globalThis.markBootStage?.("supabase.client.reused", { from: "window" });
    } else if (canUseWindow && window.__FYL_SUPABASE_CLIENT_PROMISE__) {
      // Evita carreras cuando el módulo se carga más de una vez con distinto specifier (ej. ?v=...).
      supabase = await window.__FYL_SUPABASE_CLIENT_PROMISE__;
      globalThis.markBootStage?.("supabase.client.reused", { from: "window-promise" });
    } else {
      const createClientOnce = (async () => {
        try {
          console.log(`${LOG} Iniciando carga del runtime de Supabase…`);
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

          console.info(`${LOG} Cliente createClient() creado correctamente.`);
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
