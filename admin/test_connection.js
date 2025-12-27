// admin/test_connection.js - Script para probar la conexión y permisos
import { supabase } from "../scripts/supabase-client.js";

async function testConnection() {
  console.log("🔧 Iniciando prueba de conexión...");

  try {
    // 1. Verificar sesión
    const { data: sessionData, error: sessionError } =
      await supabase.auth.getSession();
    console.log(
      "🔧 Sesión:",
      sessionData?.session ? "✅ Activa" : "❌ Inactiva"
    );

    if (sessionError) {
      console.error("❌ Error de sesión:", sessionError);
      return false;
    }

    if (!sessionData?.session) {
      console.error("❌ No hay sesión activa");
      return false;
    }

    console.log("🔧 Usuario:", sessionData.session.user.email);

    // 2. Probar inserción simple en products
    console.log("🔧 Probando inserción en products...");
    const testProduct = {
      name: "Test Product",
      handle: "test-product-" + Date.now(),
      category: "Test",
      description: "Producto de prueba",
      status: "active",
    };

    const { data: insertData, error: insertError } = await supabase
      .from("products")
      .insert([testProduct])
      .select("id")
      .single();

    if (insertError) {
      console.error("❌ Error al insertar producto:", insertError);
      if (insertError.message.includes("row-level security")) {
        console.error("❌ PROBLEMA: RLS está bloqueando la inserción");
        console.log(
          "💡 SOLUCIÓN: Ejecuta el script SQL para corregir las políticas RLS"
        );
        return false;
      }
      return false;
    }

    console.log("✅ Producto insertado exitosamente:", insertData);

    // 3. Limpiar el producto de prueba
    console.log("🔧 Limpiando producto de prueba...");
    const { error: deleteError } = await supabase
      .from("products")
      .delete()
      .eq("id", insertData.id);

    if (deleteError) {
      console.warn(
        "⚠️ No se pudo eliminar el producto de prueba:",
        deleteError
      );
    } else {
      console.log("✅ Producto de prueba eliminado");
    }

    console.log("✅ Prueba de conexión exitosa");
    return true;
  } catch (error) {
    console.error("❌ Error en prueba de conexión:", error);
    return false;
  }
}

// Ejecutar prueba al cargar
document.addEventListener("DOMContentLoaded", async () => {
  const success = await testConnection();
  if (success) {
    console.log("🎉 ¡Conexión y permisos funcionando correctamente!");
  } else {
    console.log("🚨 Problemas de conexión o permisos detectados");
  }
});

// Exponer función globalmente
window.testConnection = testConnection;
