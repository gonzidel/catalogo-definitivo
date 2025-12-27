// admin/diagnostic.js - Script de diagnóstico para problemas de RLS
import { supabase } from "../scripts/supabase-client.js";

async function runDiagnostic() {
  console.log("🔧 Iniciando diagnóstico de RLS...");

  try {
    // 1. Verificar sesión
    const { data: sessionData, error: sessionError } =
      await supabase.auth.getSession();
    console.log(
      "🔧 Estado de sesión:",
      sessionData?.session ? "✅ Activa" : "❌ Inactiva"
    );
    console.log(
      "🔧 Usuario:",
      sessionData?.session?.user?.email || "No autenticado"
    );

    if (sessionError) {
      console.error("❌ Error de sesión:", sessionError);
      return;
    }

    if (!sessionData?.session) {
      console.error("❌ No hay sesión activa. Debes iniciar sesión primero.");
      return;
    }

    // 2. Verificar permisos en la tabla products
    console.log("🔧 Verificando permisos en tabla products...");
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, name")
      .limit(1);

    if (productsError) {
      console.error("❌ Error al acceder a products:", productsError);
      if (productsError.message.includes("row-level security")) {
        console.error(
          "❌ PROBLEMA: RLS está bloqueando el acceso a la tabla products"
        );
        console.log(
          "💡 SOLUCIÓN: Necesitas configurar las políticas RLS en Supabase"
        );
      }
    } else {
      console.log("✅ Acceso a products OK");
    }

    // 3. Verificar permisos en product_variants
    console.log("🔧 Verificando permisos en tabla product_variants...");
    const { data: variants, error: variantsError } = await supabase
      .from("product_variants")
      .select("id, sku")
      .limit(1);

    if (variantsError) {
      console.error("❌ Error al acceder a product_variants:", variantsError);
    } else {
      console.log("✅ Acceso a product_variants OK");
    }

    // 4. Verificar permisos en colors
    console.log("🔧 Verificando permisos en tabla colors...");
    const { data: colors, error: colorsError } = await supabase
      .from("colors")
      .select("id, name")
      .limit(1);

    if (colorsError) {
      console.error("❌ Error al acceder a colors:", colorsError);
    } else {
      console.log("✅ Acceso a colors OK");
    }

    // 5. Verificar permisos en tags
    console.log("🔧 Verificando permisos en tabla tags...");
    const { data: tags, error: tagsError } = await supabase
      .from("tags")
      .select("id, name")
      .limit(1);

    if (tagsError) {
      console.error("❌ Error al acceder a tags:", tagsError);
    } else {
      console.log("✅ Acceso a tags OK");
    }

    console.log("🔧 Diagnóstico completado");
  } catch (error) {
    console.error("❌ Error en diagnóstico:", error);
  }
}

// Ejecutar diagnóstico al cargar
document.addEventListener("DOMContentLoaded", runDiagnostic);

// Exponer función globalmente
window.runDiagnostic = runDiagnostic;
