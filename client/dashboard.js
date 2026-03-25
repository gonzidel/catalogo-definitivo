// client/dashboard.js - Dashboard del cliente
import { supabase } from "../scripts/supabase-client.js";
import { hasRegisteredPasskeys, registerPasskey, checkPasskeySupport } from "../scripts/passkeys.js";
import { hasInitialProfileComplete } from "./auth-helper.js";
import { maybeShowProfileOnboardingModal } from "../scripts/profile-onboarding-modal.js";

/** @returns {Promise<boolean>} true solo si el usuario guardó desde el modal (viene recarga) */
async function showProfileOnboardingIfNeeded() {
  return await maybeShowProfileOnboardingModal({
    onComplete: () => window.location.reload(),
  });
}

// Función para verificar autenticación y perfil
async function checkAuthAndProfile() {
  try {
    console.log("🔍 Verificando autenticación y perfil...");

    // Verificar sesión
    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      console.error("❌ Error obteniendo sesión:", sessionError);
      return {
        hasSession: false,
        hasProfile: false,
        error: sessionError.message,
      };
    }

    if (!session) {
      console.log("👤 No hay sesión activa");
      return { hasSession: false, hasProfile: false };
    }

    console.log("✅ Sesión activa encontrada:", session.user.email);

    // Verificar si tiene perfil inicial completo (DNI, provincia, ciudad)
    const hasInitialProfile = await hasInitialProfileComplete();
    
    if (!hasInitialProfile) {
      console.log("📝 Usuario sin perfil completo: modal de datos");
      const saved = await showProfileOnboardingIfNeeded();
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: saved === true,
      };
    }

    // Verificar datos del cliente (con timeout)
    let customer = null;
    let customerError = null;

    try {
      const customerResult = await Promise.race([
        supabase
          .from("customers")
          .select("full_name, phone, address, dni, province, city, customer_number")
          .eq("id", session.user.id)
          .single(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        ),
      ]);

      customer = customerResult.data;
      customerError = customerResult.error;
    } catch (timeoutError) {
      console.warn(
        "⚠️ Timeout obteniendo datos del cliente, continuando sin perfil"
      );
      customerError = { message: "Timeout" };
    }

    console.log("📊 Datos del cliente:");
    console.log("- customer:", customer);
    console.log("- customerError:", customerError);

    // Si no hay perfil, redirigir a complete-profile
    if (customerError && customerError.code !== "PGRST116") {
      console.log("📝 Error obteniendo perfil, modal de datos");
      const saved = await showProfileOnboardingIfNeeded();
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: saved === true,
      };
    }

    if (!customer) {
      console.log("📝 Sin perfil, modal de datos");
      const saved = await showProfileOnboardingIfNeeded();
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: saved === true,
      };
    }

    // Verificar campos obligatorios iniciales
    const hasAllInitialFields =
      customer.full_name && 
      customer.phone && 
      customer.dni && 
      customer.province && 
      customer.city &&
      customer.address &&
      String(customer.address).trim() !== "";

    console.log("📋 Campos del cliente:");
    console.log("- full_name:", customer.full_name);
    console.log("- phone:", customer.phone);
    console.log("- dni:", customer.dni);
    console.log("- province:", customer.province);
    console.log("- city:", customer.city);
    console.log("- hasAllInitialFields:", hasAllInitialFields);

    if (!hasAllInitialFields) {
      console.log("📝 Perfil inicial incompleto, modal de datos");
      const saved = await showProfileOnboardingIfNeeded();
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        customer: customer,
        redirecting: saved === true,
      };
    }

    // Verificar si el cliente es de Resistencia-Chaco
    const isResistenciaChaco = 
      customer.city && 
      customer.province && 
      customer.city.toLowerCase().trim() === "resistencia" &&
      customer.province.toLowerCase().trim() === "chaco";

    if (isResistenciaChaco) {
      console.log("📍 Cliente de Resistencia-Chaco detectado, redirigiendo a customer.html");
      
      // Obtener customer_number (puede que necesite generarse)
      let customerNumber = customer.customer_number;
      
      if (!customerNumber) {
        // Si no tiene customer_number, intentar obtenerlo o generarlo
        console.log("⚠️ Cliente no tiene customer_number, intentando obtenerlo...");
        const { data: updatedCustomer, error: updateError } = await supabase
          .from("customers")
          .select("customer_number")
          .eq("id", session.user.id)
          .single();
        
        if (!updateError && updatedCustomer?.customer_number) {
          customerNumber = updatedCustomer.customer_number;
        } else {
          // Si aún no tiene, esperar un momento y reintentar (el trigger debería generarlo)
          console.log("⏳ Esperando generación de customer_number...");
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const { data: retryCustomer } = await supabase
            .from("customers")
            .select("customer_number")
            .eq("id", session.user.id)
            .single();
          
          if (retryCustomer?.customer_number) {
            customerNumber = retryCustomer.customer_number;
          }
        }
      }
      
      if (customerNumber) {
        console.log("✅ Redirigiendo a customer.html con código:", customerNumber);
        window.location.replace(`../customer.html?code=${encodeURIComponent(customerNumber)}`);
        return {
          hasSession: true,
          hasProfile: true,
          user: session.user,
          customer: customer,
          redirecting: true,
        };
      } else {
        console.error("❌ No se pudo obtener customer_number para cliente de Resistencia-Chaco");
        // Continuar al dashboard normal como fallback
      }
    }

    console.log("✅ Usuario tiene perfil inicial completo");
    return {
      hasSession: true,
      hasProfile: true,
      user: session.user,
      customer: customer,
    };
  } catch (error) {
    console.error("❌ Error verificando autenticación y perfil:", error);
    return { hasSession: false, hasProfile: false, error: error.message };
  }
}

/** Primer nombre para el saludo corto del header (B2B / operativo). */
function getFirstNameForGreeting(displayName) {
  const s = String(displayName || "").trim();
  if (!s) return "Usuario";
  return s.split(/\s+/)[0] || "Usuario";
}

// Función para mostrar información del usuario
function displayUserInfo(user, customer) {
  try {
    console.log("👤 Mostrando información del usuario...");

    const userProfile = document.getElementById("user-profile");
    const userAvatar = document.getElementById("user-avatar");
    const userName = document.getElementById("user-name");

    if (userProfile) {
      userProfile.style.display = "flex";
    }

    if (userAvatar) {
      const displayName =
        customer?.full_name ||
        user.user_metadata?.full_name ||
        user.email?.split("@")[0] ||
        "Usuario";
      const primaryAvatarUrl =
        user.avatar_url || user.user_metadata?.avatar_url || user.user_metadata?.picture;
      const fallbackAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(
        displayName
      )}&background=CD844D&color=fff&size=96`;
      userAvatar.onerror = () => {
        userAvatar.onerror = null;
        userAvatar.src = fallbackAvatarUrl;
      };
      userAvatar.src = primaryAvatarUrl || fallbackAvatarUrl;
      userAvatar.style.display = "block";
    }

    if (userName && customer) {
      const raw = customer.full_name || user.email || "";
      userName.textContent = getFirstNameForGreeting(raw);
    }

    console.log("✅ Información del usuario mostrada");
  } catch (error) {
    console.error("❌ Error mostrando información del usuario:", error);
  }
}

// Función principal para inicializar el dashboard
// IMPORTANTE: No reemplazar .dashboard-content ni cargar carrito/pedidos aquí.
// El contenido lo pinta únicamente dashboard-instant.js (loadCart, loadOrders).
async function initDashboard() {
  console.log("🏠 Inicializando dashboard...");

  // Ocultar loader inmediatamente
  const loader = document.getElementById("loader");
  if (loader) {
    loader.style.display = "none";
  }

  // NO llamar showBasicDashboard() — dashboard-instant.js es el único que controla el DOM.
  // NO cargar cart/orders desde aquí (loadCartItems usa cart_id = userId, incorrecto).

  setTimeout(async () => {
    try {
      const authResult = await checkAuthAndProfile();

      if (authResult.redirecting) return;

      if (authResult.hasSession && authResult.hasProfile) {
        console.log("✅ Usuario autenticado, actualizando header...");
        displayUserInfo(authResult.user, authResult.customer);
      }
      // Mensajes de no-sesión y errores los muestra dashboard-instant.js (withAuth fallback).
    } catch (error) {
      console.warn("⚠️ Error en checkAuthAndProfile:", error);
    }
  }, 100);

  console.log("✅ Dashboard inicializado (solo auth/header; contenido por dashboard-instant)");
}

// showBasicDashboard / loadDataInBackground / loadCartItems / loadOrders eliminados como
// controladores del DOM: dashboard-instant.js es el único que pinta #cart-info y #orders-section.
// Mensajes de no-sesión/error los muestra dashboard-instant (withAuth fallback).

// Función para verificar y mostrar modal de passkey
async function checkAndShowPasskeyModal() {
  try {
    // Verificar soporte WebAuthn
    if (!checkPasskeySupport()) {
      return; // No mostrar modal si no hay soporte
    }

    // Verificar si ya eligió "omitir" recientemente
    const dismissedAt = localStorage.getItem("passkeys_prompt_dismissed_at");
    if (dismissedAt) {
      const dismissedDate = new Date(dismissedAt);
      const daysSinceDismissed = (Date.now() - dismissedDate.getTime()) / (1000 * 60 * 60 * 24);
      
      // No mostrar si pasaron menos de 7 días
      if (daysSinceDismissed < 7) {
        console.log("Modal de passkey omitido recientemente");
        return;
      }
    }

    // Obtener sesión
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      return; // No hay sesión
    }

    // Verificar si ya tiene passkey registrada
    const hasPasskey = await hasRegisteredPasskeys(session.user.id);
    if (hasPasskey) {
      return; // Ya tiene passkey, no mostrar modal
    }

    // Mostrar modal
    const passkeyModal = document.getElementById("passkey-modal");
    if (passkeyModal) {
      passkeyModal.style.display = "flex";
    }
  } catch (error) {
    console.error("Error verificando passkey:", error);
  }
}

// Función para cerrar modal de passkey
function closePasskeyModal() {
  const passkeyModal = document.getElementById("passkey-modal");
  if (passkeyModal) {
    passkeyModal.style.display = "none";
  }
}

// Función para activar passkey
async function activatePasskey() {
  const activateBtn = document.getElementById("activate-passkey-btn");
  const skipBtn = document.getElementById("skip-passkey-btn");
  const msgDiv = document.getElementById("passkey-modal-msg");

  if (!activateBtn || !msgDiv) return;

  activateBtn.disabled = true;
  activateBtn.textContent = "Registrando...";
  skipBtn.disabled = true;
  msgDiv.style.display = "none";
  msgDiv.className = "";

  try {
    await registerPasskey();
    
    // Éxito
    msgDiv.textContent = "✅ Acceso biométrico activado correctamente";
    msgDiv.className = "msg success";
    msgDiv.style.display = "block";
    
    // Cerrar modal después de 2 segundos
    setTimeout(() => {
      closePasskeyModal();
    }, 2000);
  } catch (error) {
    console.error("Error registrando passkey:", error);
    msgDiv.textContent = error.message || "Error al activar acceso biométrico";
    msgDiv.className = "msg error";
    msgDiv.style.display = "block";
    
    activateBtn.disabled = false;
    activateBtn.textContent = "🔐 Activar Acceso Biométrico";
    skipBtn.disabled = false;
  }
}

// Función para omitir passkey
function skipPasskey() {
  // Guardar timestamp en localStorage
  localStorage.setItem("passkeys_prompt_dismissed_at", new Date().toISOString());
  closePasskeyModal();
}

// Configurar event listeners para modal de passkey
function setupPasskeyModal() {
  const passkeyModal = document.getElementById("passkey-modal");
  const passkeyModalClose = document.getElementById("passkey-modal-close");
  const activateBtn = document.getElementById("activate-passkey-btn");
  const skipBtn = document.getElementById("skip-passkey-btn");

  if (passkeyModalClose) {
    passkeyModalClose.addEventListener("click", closePasskeyModal);
  }

  if (activateBtn) {
    activateBtn.addEventListener("click", activatePasskey);
  }

  if (skipBtn) {
    skipBtn.addEventListener("click", skipPasskey);
  }

  // Cerrar al hacer click fuera del modal
  if (passkeyModal) {
    passkeyModal.addEventListener("click", (e) => {
      if (e.target === passkeyModal) {
        closePasskeyModal();
      }
    });
  }
}

// Inicializar cuando se carga la página
document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
  setupPasskeyModal();
  
  // Verificar y mostrar modal de passkey después de un delay
  setTimeout(() => {
    checkAndShowPasskeyModal();
  }, 1000);
});

console.log("🔧 Script del dashboard cargado");
