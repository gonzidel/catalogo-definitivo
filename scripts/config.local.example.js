// scripts/config.local.js - Configuración local de Supabase
// Copia este archivo como config.local.js y configura tus claves

export const SUPABASE_URL = "https://dtfznewwvsadkorxwzft.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0ZnpuZXd3dnNhZGtvcnh3emZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1MTIyNzUsImV4cCI6MjA3NjA4ODI3NX0.vJguBGhezUKtJbRA6GUkBxH8IltfdbMiPKWX9vHTlOo";

// IMPORTANTE: Para scripts de importación masiva (import-customers.js)
// Necesitas la SERVICE_ROLE_KEY que tiene permisos de administrador
// Obténla en: Supabase Dashboard → Settings → API → service_role (secret)
// ⚠️ NUNCA compartas esta clave públicamente - tiene acceso completo a tu base de datos
export const SUPABASE_SERVICE_ROLE_KEY = ""; // Coloca aquí tu service_role key
export const USE_SUPABASE = true;

// La firma QZ usa JWT del usuario contra la Edge Function.
// No coloques QZ_SIGN_SECRET en archivos del navegador.
export const QZ_SIGN_SECRET = "";
// PostgREST — prueba Fase A (scripts/phase-a-verify-postgrest.mjs): variables en el shell, por ejemplo:
//   $env:SUPABASE_ANON_KEY="..."
//   $env:FYL_POSTGREST_ADMIN_ACCESS_TOKEN="eyJ..."    # access_token sesión admin
//   $env:FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN="eyJ..." # access_token usuario sin admin

export const USE_OPEN_SHEET_FALLBACK = false;

// Banner curado Fase 3 (QA/staging; no prod sin rollout):
// localStorage.setItem("FYL_CURATED_BANNER_V1", "1"); location.reload();
// o URL: ?curated_banner=1
// Consola: await fylAuditCuratedBanner()

// Configuración de WhatsApp
export const WHATSAPP_NUMBERS = {
  ani: "5493625172874",
  fati: "5493624866768",
  local: "5493624118637",
};

// Configuración del PWA
export const PWA_CONFIG = {
  name: "Catálogo FYL",
  short_name: "FYL",
  theme_color: "#CD844D",
  background_color: "#ffffff",
};
