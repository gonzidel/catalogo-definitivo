// scripts/login-redirect-debug.js - Diagnóstico de redirección después del login
/**
 * Script para diagnosticar problemas de redirección después del login
 */

// Función de diagnóstico
async function diagnoseLoginRedirect() {
  try {
    console.log("🔍 Diagnóstico de redirección después del login...");

    // Verificar si Supabase está disponible
    if (!window.supabase) {
      console.error("❌ Supabase no está disponible");
      return;
    }

    // Verificar sesión actual
    const {
      data: { session },
      error: sessionError,
    } = await window.supabase.auth.getSession();
    if (sessionError) {
      console.error("❌ Error obteniendo sesión:", sessionError);
      return;
    }

    if (!session) {
      console.log("👤 No hay sesión activa");
      return;
    }

    console.log("✅ Sesión activa encontrada:", session.user.email);

    // Verificar datos del cliente
    const { data: customer, error: customerError } = await window.supabase
      .from("customers")
      .select("*")
      .eq("user_id", session.user.id)
      .single();

    if (customerError) {
      console.error("❌ Error obteniendo datos del cliente:", customerError);
      return;
    }

    if (!customer) {
      console.log("📝 No hay datos de cliente - debería ir a profile.html");
      return;
    }

    console.log("✅ Datos del cliente encontrados:", customer);

    // Verificar campos obligatorios
    const requiredFields = ["name", "phone", "address"];
    const missingFields = requiredFields.filter(
      (field) => !customer[field] || customer[field].trim() === ""
    );

    if (missingFields.length > 0) {
      console.log("📝 Campos faltantes:", missingFields);
      console.log("🔄 Debería ir a profile.html");
    } else {
      console.log("✅ Todos los campos están completos");
      console.log("🔄 Debería ir a dashboard.html");
    }
  } catch (error) {
    console.error("❌ Error en diagnóstico:", error);
  }
}

// Función para forzar redirección al dashboard
async function forceRedirectToDashboard() {
  try {
    console.log("🔄 Forzando redirección al dashboard...");
    window.location.href = "client/dashboard.html";
  } catch (error) {
    console.error("❌ Error forzando redirección:", error);
  }
}

// Función para forzar redirección al perfil
async function forceRedirectToProfile() {
  try {
    console.log("🔄 Forzando redirección al perfil...");
    window.location.href = "client/profile.html";
  } catch (error) {
    console.error("❌ Error forzando redirección:", error);
  }
}

// Exponer funciones globalmente
window.diagnoseLoginRedirect = diagnoseLoginRedirect;
window.forceRedirectToDashboard = forceRedirectToDashboard;
window.forceRedirectToProfile = forceRedirectToProfile;

// Ejecutar diagnóstico automáticamente
document.addEventListener("DOMContentLoaded", () => {
  console.log("🔍 Ejecutando diagnóstico de redirección...");
  diagnoseLoginRedirect();
});

console.log("🔍 Script de diagnóstico de redirección cargado");
console.log("💡 Usa window.diagnoseLoginRedirect() para diagnosticar");
console.log("💡 Usa window.forceRedirectToDashboard() para forzar dashboard");
console.log("💡 Usa window.forceRedirectToProfile() para forzar perfil");
