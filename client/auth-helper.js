// client/auth-helper.js - Ayuda para autenticación y perfil

function fylDevLog(...args) {
  if (
    typeof window !== "undefined" &&
    (window.FYL_DEBUG_CATALOG === true ||
      /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || ""))
  ) {
    console.log.apply(console, args);
  }
}

// Verificar si el usuario tiene perfil completo (incluyendo datos iniciales)
async function hasCompleteProfile() {
  try {
    const supabase = window.supabase || window.supabaseClient;
    if (!supabase) {
      console.warn("⚠️ Supabase no disponible");
      return false;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      fylDevLog("👤 Usuario no autenticado");
      return false;
    }

    const { data: customer, error } = await supabase
      .from("customers")
      .select("*")
      .eq("id", user.id)
      .single();

    if (error || !customer) {
      fylDevLog("📝 Perfil de cliente no encontrado");
      return false;
    }

    // Verificar campos iniciales requeridos: full_name, phone, dni, province, city
    const initialRequiredFields = ["full_name", "phone", "dni", "province", "city", "address"];
    const hasInitialFields = initialRequiredFields.every(
      (field) => customer[field] && String(customer[field]).trim() !== ""
    );

    // Verificar también address para perfil completo (opcional pero recomendado)
    const hasAddress = customer.address && customer.address.trim() !== "";

    fylDevLog("✅ Perfil inicial completo:", hasInitialFields);
    fylDevLog("✅ Tiene dirección:", hasAddress);
    
    return hasInitialFields;
  } catch (error) {
    console.error("❌ Error verificando perfil:", error);
    return false;
  }
}

// Verificar si el usuario tiene perfil inicial completo (solo datos básicos)
async function hasInitialProfileComplete() {
  try {
    const supabase = window.supabase || window.supabaseClient;
    if (!supabase) {
      console.warn("⚠️ Supabase no disponible");
      return false;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      fylDevLog("👤 Usuario no autenticado");
      return false;
    }

    const { data: customer, error } = await supabase
      .from("customers")
      .select("full_name, phone, dni, province, city, address")
      .eq("id", user.id)
      .single();

    if (error || !customer) {
      fylDevLog("📝 Perfil de cliente no encontrado");
      return false;
    }

    const requiredFields = ["full_name", "phone", "dni", "province", "city", "address"];
    const hasAllFields = requiredFields.every(
      (field) => customer[field] && String(customer[field]).trim() !== ""
    );

    fylDevLog("✅ Perfil inicial completo:", hasAllFields);
    return hasAllFields;
  } catch (error) {
    console.error("❌ Error verificando perfil inicial:", error);
    return false;
  }
}

// Requerir autenticación
async function requireAuth() {
  try {
    const supabase = window.supabase || window.supabaseClient;
    if (!supabase) {
      console.error("Supabase no disponible");
      return null;
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      fylDevLog("Usuario no autenticado");
      return null;
    }

    const { data: customer, error: customerError } = await supabase
      .from("customers")
      .select("*")
      .eq("id", user.id)
      .single();

    if (customerError || !customer) {
      fylDevLog("Perfil de cliente no encontrado");
      return null;
    }

    return { user, customer };
  } catch (error) {
    console.error("❌ Error en autenticación:", error);
    return null;
  }
}

// Obtener datos del usuario autenticado
async function getAuthData() {
  try {
    const authData = await requireAuth();
    return authData;
  } catch (error) {
    console.error("❌ Error obteniendo datos de autenticación:", error);
    return null;
  }
}

// Verificar si el usuario está autenticado
async function isAuthenticated() {
  try {
    const supabase = window.supabase || window.supabaseClient;
    if (!supabase) {
      return false;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    return !!user;
  } catch (error) {
    console.error("❌ Error verificando autenticación:", error);
    return false;
  }
}

// Exponer funciones globalmente
window.hasCompleteProfile = hasCompleteProfile;
window.hasInitialProfileComplete = hasInitialProfileComplete;
window.requireAuth = requireAuth;
window.getAuthData = getAuthData;
window.isAuthenticated = isAuthenticated;

export { hasCompleteProfile, hasInitialProfileComplete, requireAuth, getAuthData, isAuthenticated };
