// scripts/supabase-client.js
// Cliente único de Supabase para toda la aplicación
// IMPORTANTE: Este es el ÚNICO lugar donde se debe crear el cliente de Supabase

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  USE_SUPABASE,
  configReady,
} from "./config.js";

let supabase = null;

// Esperar a que config.local.js (si existe) se cargue antes de inicializar Supabase
await configReady;

if (USE_SUPABASE) {
  // Verificar configuración antes de crear el cliente
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("❌ ERROR: SUPABASE_URL o SUPABASE_ANON_KEY no están configurados");
    console.error("   Verifica que config.local.js tenga los valores correctos");
    console.error("   SUPABASE_URL:", SUPABASE_URL ? "✅ Configurado" : "❌ Faltante");
    console.error("   SUPABASE_ANON_KEY:", SUPABASE_ANON_KEY ? "✅ Configurado" : "❌ Faltante");
  } else {
    // Verificar si ya existe una instancia global para evitar crear múltiples
    if (typeof window !== "undefined" && window.supabase && typeof window.supabase.from === 'function') {
      console.log("♻️ Reutilizando instancia existente de Supabase");
      supabase = window.supabase;
    } else {
      try {
        // Crear nueva instancia solo si no existe
        console.log("🔄 Cargando módulo de Supabase...");
        
        // Intentar múltiples fuentes del CDN para mayor compatibilidad
        let supabaseModule = null;
        let createClient = null;
        
        // Opción 1: jsdelivr con versión específica
        try {
          supabaseModule = await import(
            "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.39.0/+esm"
          );
          if (supabaseModule && supabaseModule.createClient) {
            createClient = supabaseModule.createClient;
            console.log("✅ Módulo cargado desde jsdelivr (v2.39.0)");
          }
        } catch (e1) {
          console.warn("⚠️ Falló jsdelivr v2.39.0, intentando unpkg...", e1.message);
          
          // Opción 2: unpkg
          try {
            supabaseModule = await import(
              "https://unpkg.com/@supabase/supabase-js@2.39.0/dist/esm/index.js"
            );
            if (supabaseModule && supabaseModule.createClient) {
              createClient = supabaseModule.createClient;
              console.log("✅ Módulo cargado desde unpkg (v2.39.0)");
            }
          } catch (e2) {
            console.warn("⚠️ Falló unpkg, intentando esm.sh...", e2.message);
            
            // Opción 3: esm.sh
            try {
              supabaseModule = await import(
                "https://esm.sh/@supabase/supabase-js@2.39.0"
              );
              if (supabaseModule && supabaseModule.createClient) {
                createClient = supabaseModule.createClient;
                console.log("✅ Módulo cargado desde esm.sh (v2.39.0)");
              }
            } catch (e3) {
              throw new Error(`No se pudo cargar el módulo de Supabase desde ningún CDN. Último error: ${e3.message}`);
            }
          }
        }
        
        if (!createClient) {
          throw new Error("El módulo de Supabase no exporta createClient");
        }
        
        // Usar la misma storageKey para evitar múltiples instancias de GoTrueClient
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            storageKey: 'sb-dtfznewwvsadkorxwzft-auth-token',
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true
          }
        });
        
        if (!supabase) {
          throw new Error("createClient devolvió null o undefined");
        }
        
        console.log("✅ Cliente de Supabase creado (instancia única)");
      } catch (error) {
        console.error("❌ ERROR al crear cliente de Supabase:", error);
        console.error("   Detalles:", error.message);
        console.error("   Stack:", error.stack);
        supabase = null;
      }
    }
  }
}

// Exponer globalmente ANTES de exportar para que otros scripts puedan usarlo
if (typeof window !== "undefined") {
  window.supabaseClient = supabase;
  window.supabase = supabase;
}

// Verificar que supabase se creó correctamente antes de exportar
if (!supabase && USE_SUPABASE) {
  console.error("❌ CRÍTICO: Cliente de Supabase no se pudo crear");
  console.error("   La aplicación puede no funcionar correctamente");
  console.error("   Verifica:");
  console.error("   1. Que config.local.js existe y tiene SUPABASE_ANON_KEY");
  console.error("   2. Que tienes conexión a internet");
  console.error("   3. Que la URL de Supabase es correcta");
}

export { supabase };
