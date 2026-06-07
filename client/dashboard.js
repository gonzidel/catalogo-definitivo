// client/dashboard.js - Dashboard del cliente
import { fylDevLog } from "../scripts/config.js?v=m260607";
import { supabase } from "../scripts/supabase-client.js?v=m260607";
import { hasInitialProfileComplete } from "./auth-helper.js?v=m260607";

// Función para verificar autenticación y perfil
async function checkAuthAndProfile() {
  try {
    fylDevLog("🔍 Verificando autenticación y perfil...");

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
      fylDevLog("👤 No hay sesión activa");
      return { hasSession: false, hasProfile: false };
    }

    fylDevLog("✅ Sesión activa encontrada:", session.user.email);

    // Verificar si tiene perfil inicial completo (DNI, provincia, ciudad)
    const hasInitialProfile = await hasInitialProfileComplete();
    
    if (!hasInitialProfile) {
      fylDevLog("📝 Usuario sin perfil completo");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: false,
      };
    }

    // Verificar datos del cliente (con timeout)
    let customer = null;
    let customerError = null;

    try {
      const customerResult = await Promise.race([
        supabase
          .from("customers")
          .select("full_name, phone, address, dni, province, city, customer_number, qr_code")
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

    fylDevLog("📊 Datos del cliente:", { customer, customerError });

    // Si no hay perfil completo, no bloquear dashboard.
    if (customerError && customerError.code !== "PGRST116") {
      fylDevLog("📝 Error obteniendo perfil");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: false,
      };
    }

    if (!customer) {
      fylDevLog("📝 Sin perfil");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: false,
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

    fylDevLog("📋 Campos del cliente (resumen):", {
      hasAllInitialFields,
      hasName: !!customer.full_name,
      hasPhone: !!customer.phone,
    });

    if (!hasAllInitialFields) {
      fylDevLog("📝 Perfil inicial incompleto");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        customer: customer,
        redirecting: false,
      };
    }

    fylDevLog("✅ Usuario tiene perfil inicial completo");
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
    fylDevLog("👤 Mostrando información del usuario...");

    const userProfile = document.getElementById("user-profile");
    const userAvatar = document.getElementById("user-avatar");
    const userName = document.getElementById("user-name");

    // El header lo controla dashboard-instant.js; evitar que este script lo pise en recargas/entradas directas.
    if (userAvatar?.dataset?.identitySet === "true") return;

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

    fylDevLog("✅ Información del usuario mostrada");
  } catch (error) {
    console.error("❌ Error mostrando información del usuario:", error);
  }
}

// Función principal para inicializar el dashboard
// IMPORTANTE: No reemplazar .dashboard-content ni cargar carrito/pedidos aquí.
// El contenido lo pinta únicamente dashboard-instant.js (loadCart, loadOrders).
async function initDashboard() {
  fylDevLog("🏠 Inicializando dashboard...");

  // Ocultar loader inmediatamente
  const loader = document.getElementById("loader");
  if (loader) {
    loader.style.display = "none";
  }

  // NO llamar showBasicDashboard() — dashboard-instant.js es el único que controla el DOM.
  // NO cargar cart/orders desde aquí (loadCartItems usa cart_id = userId, incorrecto).
  if (window.__FYL_DASHBOARD_INSTANT_ACTIVE__ === true) {
    fylDevLog("ℹ️ dashboard.js omite checkAuthAndProfile: lo resuelve dashboard-instant.");
    return;
  }

  setTimeout(async () => {
    try {
      const authResult = await checkAuthAndProfile();

      if (authResult.redirecting) return;

      if (authResult.hasSession && authResult.hasProfile) {
        fylDevLog("✅ Usuario autenticado, actualizando header...");
        displayUserInfo(authResult.user, authResult.customer);
      }
      // Mensajes de no-sesión y errores los muestra dashboard-instant.js (withAuth fallback).
    } catch (error) {
      console.warn("⚠️ Error en checkAuthAndProfile:", error);
    }
  }, 100);

  fylDevLog("✅ Dashboard inicializado (solo auth/header; contenido por dashboard-instant)");
}

// showBasicDashboard / loadDataInBackground / loadCartItems / loadOrders eliminados como
// controladores del DOM: dashboard-instant.js es el único que pinta #cart-info y #orders-section.
// Mensajes de no-sesión/error los muestra dashboard-instant (withAuth fallback).

// Inicializar cuando se carga la página
document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
});

fylDevLog("🔧 Script del dashboard cargado");
