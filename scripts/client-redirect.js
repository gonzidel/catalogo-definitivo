// scripts/client-redirect.js - Redirección inteligente del área de clientes
/**
 * Maneja la redirección inteligente del botón "Área de Clientes"
 */

// Verificar si el usuario tiene perfil completo
async function hasCompleteProfile() {
  try {
    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible");
      return false;
    }

    // Verificar autenticación
    const {
      data: { user },
    } = await window.supabase.auth.getUser();
    if (!user) {
      console.log("👤 Usuario no autenticado");
      return false;
    }

    // Verificar si existe perfil de cliente
    const { data: customer, error } = await window.supabase
      .from("customers")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (error || !customer) {
      console.log("📝 Perfil de cliente no encontrado");
      return false;
    }

    // Verificar campos obligatorios
    const requiredFields = ["name", "phone", "address"];
    const hasAllFields = requiredFields.every(
      (field) => customer[field] && customer[field].trim() !== ""
    );

    console.log("✅ Perfil completo:", hasAllFields);
    return hasAllFields;
  } catch (error) {
    console.error("❌ Error verificando perfil:", error);
    return false;
  }
}

// Redirección inteligente
async function redirectToClientArea() {
  try {
    console.log("🔗 Redirigiendo al área de clientes...");

    // Verificar autenticación
    if (!window.supabase) {
      console.warn("⚠️ Supabase no disponible, redirigiendo a login");
      window.location.href = "client/login.html";
      return;
    }

    const {
      data: { user },
    } = await window.supabase.auth.getUser();
    if (!user) {
      console.log("👤 Usuario no autenticado, redirigiendo a login");
      window.location.href = "client/login.html";
      return;
    }

    // Verificar si tiene perfil completo
    const hasProfile = await hasCompleteProfile();

    if (hasProfile) {
      console.log("✅ Perfil completo, redirigiendo a dashboard");
      window.location.href = "client/dashboard.html";
    } else {
      console.log("📝 Perfil incompleto, redirigiendo a perfil");
      window.location.href = "client/profile.html";
    }
  } catch (error) {
    console.error("❌ Error en redirección:", error);
    // Fallback: ir a login
    window.location.href = "client/login.html";
  }
}

// Función de fallback para compatibilidad
function redirectToClientAreaFallback() {
  console.log("🔧 Usando función de fallback");
  window.location.href = "client/login.html";
}

// Configurar botón del área de clientes
function setupClientAreaButton() {
  try {
    const clientButton = document.querySelector(".cliente-link");
    if (clientButton) {
      // Remover onclick existente
      clientButton.removeAttribute("onclick");

      // Agregar event listener
      clientButton.addEventListener("click", (e) => {
        e.preventDefault();
        redirectToClientArea();
      });

      console.log("✅ Botón del área de clientes configurado");
    }
  } catch (error) {
    console.error("❌ Error configurando botón:", error);
  }
}

// Inicializar redirección
function initClientRedirect() {
  try {
    console.log("🔗 Inicializando redirección de clientes...");

    // Configurar botón
    setupClientAreaButton();

    // Exponer funciones globalmente
    window.redirectToClientArea = redirectToClientArea;
    window.redirectToClientAreaFallback = redirectToClientAreaFallback;

    console.log("✅ Redirección de clientes inicializada");
  } catch (error) {
    console.error("❌ Error inicializando redirección:", error);
  }
}

// Ejecutar cuando se carga la página
document.addEventListener("DOMContentLoaded", initClientRedirect);

// También ejecutar si la página ya está cargada
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initClientRedirect);
} else {
  initClientRedirect();
}

export { redirectToClientArea, hasCompleteProfile };
