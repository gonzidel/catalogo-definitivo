// client/dashboard.js - Dashboard del cliente
import { supabase } from "../scripts/supabase-client.js";
import { hasInitialProfileComplete } from "./auth-helper.js";

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
      console.log("📝 Usuario sin perfil completo");
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

    console.log("📊 Datos del cliente:");
    console.log("- customer:", customer);
    console.log("- customerError:", customerError);

    // Si no hay perfil completo, no bloquear dashboard.
    if (customerError && customerError.code !== "PGRST116") {
      console.log("📝 Error obteniendo perfil");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        redirecting: false,
      };
    }

    if (!customer) {
      console.log("📝 Sin perfil");
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

    console.log("📋 Campos del cliente:");
    console.log("- full_name:", customer.full_name);
    console.log("- phone:", customer.phone);
    console.log("- dni:", customer.dni);
    console.log("- province:", customer.province);
    console.log("- city:", customer.city);
    console.log("- hasAllInitialFields:", hasAllInitialFields);

    if (!hasAllInitialFields) {
      console.log("📝 Perfil inicial incompleto");
      return {
        hasSession: true,
        hasProfile: false,
        user: session.user,
        customer: customer,
        redirecting: false,
      };
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

// Inicializar cuando se carga la página
document.addEventListener("DOMContentLoaded", () => {
  initDashboard();
});

console.log("🔧 Script del dashboard cargado");
