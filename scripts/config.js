import { FYL_VERSION } from "./fyl-version.js?v=m260527";

// scripts/config.js
// Valores por defecto (no sensibles). Para valores sensibles, copia
// `scripts/config.local.example.js` a `scripts/config.local.js` y completa los campos.

// SOLUCIÓN CORRECTA: Leer desde window si está disponible (config.prod.js en producción)
// Esto asegura que las credenciales estén disponibles en Firebase Hosting
// Función helper para limpiar valores de window (remover comillas adicionales)
function cleanWindowValue(value) {
  if (typeof value !== "string") return value;
  return value.trim().replace(/^["']|["']$/g, "");
}

/** Logs de arranque (config / Supabase). Activar: `window.FYL_DEBUG_CATALOG = true` o `?debug=catalog`. */
export function fylDevLog(...args) {
  if (
    typeof window !== "undefined" &&
    (window.FYL_DEBUG_CATALOG === true ||
      /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || ""))
  ) {
    console.log.apply(console, args);
  }
}

export function fylDevInfo(...args) {
  if (
    typeof window !== "undefined" &&
    (window.FYL_DEBUG_CATALOG === true ||
      /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || ""))
  ) {
    console.info.apply(console, args);
  }
}

/** No volcar la anon key completa en consola (móvil / capturas de pantalla). */
function maskAnonKeyForLog(key) {
  if (!key || typeof key !== "string") return "(vacío)";
  const t = key.trim();
  if (t.length < 24) return `(valor corto, ${t.length} chars)`;
  return `${t.slice(0, 14)}…${t.slice(-10)} (${t.length} chars)`;
}

let SUPABASE_URL =
  typeof window !== "undefined" && window.SUPABASE_URL
    ? cleanWindowValue(window.SUPABASE_URL)
    : "https://dtfznewwvsadkorxwzft.supabase.co";
let SUPABASE_ANON_KEY =
  typeof window !== "undefined" && window.SUPABASE_ANON_KEY
    ? cleanWindowValue(window.SUPABASE_ANON_KEY)
    : "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0ZnpuZXd3dnNhZGtvcnh3emZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1MTIyNzUsImV4cCI6MjA3NjA4ODI3NX0.vJguBGhezUKtJbRA6GUkBxH8IltfdbMiPKWX9vHTlOo";
// No exponer secretos de firma en el navegador. La firma QZ se autoriza con JWT
// contra la Edge Function y el secreto privado vive solo en Supabase.
let QZ_SIGN_SECRET = "";

// Configuración optimizada: Supabase habilitado con fallback a Google Sheets
let USE_SUPABASE = true; // HABILITADO: Usar Supabase como fuente principal
let USE_OPEN_SHEET_FALLBACK = true; // HABILITADO: Usar Google Sheets como fallback

/** Diagnóstico de arranque (mutable; rellenado al resolver configReady). */
export const fylConfigDiagnostics = {
  /** true = generate-config dejó marca; false = script no ejecutó o no existe archivo válido */
  configProdScriptMarker: null,
  configProdAt: null,
  /** Resultado de GET /config.prod.js cuando hace falta comprobar HTML vs JS */
  configProdFetchProbe: null,
  resolvedSupabaseUrl: "",
  resolvedAnonKeyMasked: "",
};

function isLocalHost() {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "";
}

/**
 * Si /config.prod.js no existe, Firebase Hosting puede devolver index.html (200) por rewrite **.
 * Eso rompe el <script src> con error de parseo y no deja marca __FYL_CONFIG_PROD_LOADED__.
 */
async function probeConfigProdJsResponse() {
  if (typeof window === "undefined" || typeof fetch !== "function") return null;
  const probeUrl = new URL("/config.prod.js", window.location.origin);
  probeUrl.searchParams.set("_fyl_probe", String(Date.now()));
  /** Evita colgar configReady en móvil si /config.prod.js devuelve index.html grande (rewrite Firebase). */
  function readBodyPrefixForProbe(response, maxChars) {
    return Promise.race([
      (async () => {
        const reader = response.body?.getReader?.();
        if (!reader) {
          const full = await response.text();
          return String(full).slice(0, maxChars);
        }
        const dec = new TextDecoder();
        let out = "";
        try {
          while (out.length < maxChars) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) out += dec.decode(value, { stream: true });
          }
        } finally {
          try {
            await reader.cancel();
          } catch (_e) {}
        }
        return out;
      })(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("fyl_probe_body_timeout")), 5000)
      ),
    ]);
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(probeUrl.href, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(t);
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    let text;
    try {
      text = await readBodyPrefixForProbe(r, 49152);
    } catch (e) {
      return {
        ok: false,
        errorName: e?.name || "Error",
        errorMessage: e?.message || String(e),
      };
    }
    const trimmed = text.trimStart();
    const looksLikeHtml =
      trimmed.startsWith("<!") ||
      trimmed.toLowerCase().startsWith("<html") ||
      /^\s*<\s*!doctype/i.test(trimmed);
    const looksLikeJs =
      !looksLikeHtml &&
      (trimmed.includes("window.SUPABASE_URL") ||
        trimmed.includes("__FYL_CONFIG_PROD_LOADED__"));
    return {
      ok: r.ok,
      status: r.status,
      contentType: ct,
      looksLikeHtml,
      looksLikeJs,
      bodyLength: text.length,
    };
  } catch (e) {
    return {
      ok: false,
      errorName: e?.name || "Error",
      errorMessage: e?.message || String(e),
    };
  }
}

// Intentar cargar overrides locales (opcional) y exponer una promesa de readiness
const configReady = (async () => {
  const logPrefix = "[FYL config]";
  try {
    const local = isLocalHost();

    if (typeof window !== "undefined") {
      const marker = window.__FYL_CONFIG_PROD_LOADED__ === true;
      fylConfigDiagnostics.configProdScriptMarker = marker;
      fylConfigDiagnostics.configProdAt =
        typeof window.__FYL_CONFIG_PROD_AT__ === "string"
          ? window.__FYL_CONFIG_PROD_AT__
          : null;

      if (marker) {
        fylDevInfo(
          `${logPrefix} config.prod.js: script ejecutado OK (marca __FYL_CONFIG_PROD_LOADED__)`,
          fylConfigDiagnostics.configProdAt
            ? { generado: fylConfigDiagnostics.configProdAt }
            : {}
        );
      } else if (local) {
        fylDevInfo(
          `${logPrefix} config.prod.js: sin marca de carga (normal en local si no generaste config.prod.js en la raíz)`
        );
      } else {
        console.warn(
          `${logPrefix} config.prod.js: marca no detectada. Si el cat\u00e1logo funciona, ignorar este aviso.`
        );
        if (!local && typeof fetch === "function") {
          fylConfigDiagnostics.configProdFetchProbe = await probeConfigProdJsResponse();
          if (fylConfigDiagnostics.configProdFetchProbe?.looksLikeHtml) {
            console.error(`${logPrefix} /config.prod.js parece HTML, no JavaScript`);
            globalThis.markBootStage?.("config.prod.html_not_js", {
              ...fylConfigDiagnostics.configProdFetchProbe,
            });
          }
        }
      }
    }

    // Solo intentar cargar config.local.js si SUPABASE_ANON_KEY está vacío
    // En producción, config.js ya tiene las credenciales directamente
    // En local se permiten overrides no sensibles, manteniendo secretos fuera del navegador.
    if (local || !SUPABASE_ANON_KEY || SUPABASE_ANON_KEY === "") {
      try {
        const loc = await import("./config.local.js");
        if (loc) {
          if (typeof loc.SUPABASE_URL === "string" && loc.SUPABASE_URL)
            SUPABASE_URL = loc.SUPABASE_URL;
          if (typeof loc.SUPABASE_ANON_KEY === "string" && loc.SUPABASE_ANON_KEY)
            SUPABASE_ANON_KEY = loc.SUPABASE_ANON_KEY;
          if (typeof loc.USE_SUPABASE !== "undefined") USE_SUPABASE = loc.USE_SUPABASE;
          if (typeof loc.USE_OPEN_SHEET_FALLBACK !== "undefined")
            USE_OPEN_SHEET_FALLBACK = loc.USE_OPEN_SHEET_FALLBACK;
          fylDevLog(`${logPrefix} config.local.js: overrides aplicados`);
        }
      } catch (_e) {
        // Ignorar error si no existe config.local.js
      }
    } else {
      fylDevLog(
        `${logPrefix} credenciales: usando valores ya resueltos (window/config.js), sin importar config.local.js`
      );
    }

    fylConfigDiagnostics.resolvedSupabaseUrl = SUPABASE_URL || "";
    fylConfigDiagnostics.resolvedAnonKeyMasked = maskAnonKeyForLog(SUPABASE_ANON_KEY);

    fylDevInfo(`${logPrefix} Supabase listo para cliente:`, {
      SUPABASE_URL: fylConfigDiagnostics.resolvedSupabaseUrl || "(vacío)",
      SUPABASE_ANON_KEY: fylConfigDiagnostics.resolvedAnonKeyMasked,
      USE_SUPABASE,
      USE_OPEN_SHEET_FALLBACK,
    });

    globalThis.markBootStage?.("config.ready", {
      prodMarker: fylConfigDiagnostics.configProdScriptMarker,
      url: fylConfigDiagnostics.resolvedSupabaseUrl || "",
      anonMasked: fylConfigDiagnostics.resolvedAnonKeyMasked,
      prodHtmlHint:
        fylConfigDiagnostics.configProdFetchProbe &&
        !fylConfigDiagnostics.configProdFetchProbe.errorMessage
          ? fylConfigDiagnostics.configProdFetchProbe.looksLikeHtml === true
          : undefined,
      USE_SUPABASE,
    });
  } catch (err) {
    if (SUPABASE_ANON_KEY && SUPABASE_ANON_KEY !== "") {
      fylDevLog("✅ Usando credenciales de config.js (config.local.js no disponible)");
    } else {
      console.warn("⚠️ No se pudo cargar config.local.js y config.js no tiene credenciales");
    }
    console.error("[FYL config] Error en configReady:", err);
    globalThis.markBootStage?.("config.ready.error", {
      name: err?.name,
      message: err?.message ? String(err.message).slice(0, 200) : String(err),
    });
  }
})();

export {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  QZ_SIGN_SECRET,
  USE_SUPABASE,
  USE_OPEN_SHEET_FALLBACK,
  configReady,
};

/** Registro temprano del SW (antes de supabase-client) para rutas críticas network-only. */
(function fylRegisterProductionServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
  if (window.__FYL_SW_REGISTER_SCHEDULED__) return;
  window.__FYL_SW_REGISTER_SCHEDULED__ = true;
  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1" || h === "") return;
  queueMicrotask(() => {
    const swUrlObj = new URL("/sw.js", window.location.origin);
    swUrlObj.searchParams.set(
      "v",
      String(FYL_VERSION || "").trim() || String(Date.now())
    );
    const swUrl = swUrlObj.href;
    navigator.serviceWorker
      .register(swUrl, { scope: "/", updateViaCache: "none" })
      .then(() => {
        globalThis.markBootStage?.("sw.registered", { url: swUrl });
      })
      .catch((e) => {
        const msg = e && e.message ? String(e.message).slice(0, 200) : String(e);
        globalThis.markBootStage?.("sw.register_failed", { message: msg });
        import("./fyl-runtime-resilience.js?v=m260527")
          .then((m) =>
            m.fylReportClientError({ kind: "sw.register_failed", message: msg })
          )
          .catch(() => {});
      });
  });
})();
