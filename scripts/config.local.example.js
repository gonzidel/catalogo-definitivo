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
export const USE_OPEN_SHEET_FALLBACK = false;

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
