// scripts/config.js
// Valores por defecto (no sensibles). Para valores sensibles, copia
// `scripts/config.local.example.js` a `scripts/config.local.js` y completa los campos.

let SUPABASE_URL = "https://dtfznewwvsadkorxwzft.supabase.co"; // Project URL (puedes sobreescribir en config.local.js)

// No incluir claves sensibles en archivos rastreados. Usa `scripts/config.local.js`.
let SUPABASE_ANON_KEY = ""; // coloca aquí tu anon key en scripts/config.local.js (no rastreado)

// Configuración optimizada: Supabase habilitado con fallback a Google Sheets
let USE_SUPABASE = true; // HABILITADO: Usar Supabase como fuente principal
let USE_OPEN_SHEET_FALLBACK = true; // HABILITADO: Usar Google Sheets como fallback

// Intentar cargar overrides locales (opcional) y exponer una promesa de readiness
const configReady = (async () => {
  try {
    const local = await import("./config.local.js");
    if (local) {
      if (typeof local.SUPABASE_URL === "string")
        SUPABASE_URL = local.SUPABASE_URL;
      if (typeof local.SUPABASE_ANON_KEY === "string")
        SUPABASE_ANON_KEY = local.SUPABASE_ANON_KEY;
      if (typeof local.USE_SUPABASE !== "undefined")
        USE_SUPABASE = local.USE_SUPABASE;
      if (typeof local.USE_OPEN_SHEET_FALLBACK !== "undefined")
        USE_OPEN_SHEET_FALLBACK = local.USE_OPEN_SHEET_FALLBACK;
      console.log("config.local.js loaded: overrides applied");
    }
  } catch (err) {
    // No hacer nada si no existe
  }
})();

export {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USE_SUPABASE,
  USE_OPEN_SHEET_FALLBACK,
  configReady,
};
