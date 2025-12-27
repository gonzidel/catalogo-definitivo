// admin/permissions-helper.js
// Utilidades para verificar permisos de administradores y colaboradores
import { supabase } from "../scripts/supabase-client.js";

let cachedUserPermissions = null;
let cachedIsSuperAdmin = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60000; // 1 minuto

/**
 * Limpia la caché de permisos
 */
export function clearPermissionsCache() {
  cachedUserPermissions = null;
  cachedIsSuperAdmin = null;
  cacheTimestamp = null;
}

/**
 * Verifica si el usuario actual es super_admin
 * @returns {Promise<boolean>}
 */
export async function isSuperAdmin() {
  try {
    // Verificar caché
    if (cachedIsSuperAdmin !== null && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
      return cachedIsSuperAdmin;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      cachedIsSuperAdmin = false;
      return false;
    }

    const { data, error } = await supabase
      .rpc('is_super_admin', { check_user_id: user.id });

    if (error) {
      console.error("Error verificando super_admin:", error);
      return false;
    }

    cachedIsSuperAdmin = !!data;
    cacheTimestamp = Date.now();
    return cachedIsSuperAdmin;
  } catch (error) {
    console.error("Error en isSuperAdmin:", error);
    return false;
  }
}

/**
 * Obtiene todos los permisos del usuario actual
 * @returns {Promise<Object>} Objeto con permisos por clave
 */
export async function getUserPermissions() {
  try {
    // Verificar caché
    if (cachedUserPermissions && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
      return cachedUserPermissions;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      cachedUserPermissions = {};
      return {};
    }

    // Si es super_admin, retornar todos los permisos habilitados
    const superAdmin = await isSuperAdmin();
    if (superAdmin) {
      const allPermissions = {
        products: { can_view: true, can_edit: true, can_delete: true },
        'fyl-products': { can_view: true, can_edit: true, can_delete: true },
        stock: { can_view: true, can_edit: true, can_delete: true },
        orders: { can_view: true, can_edit: true, can_delete: true },
        'daily-sales': { can_view: true, can_edit: true, can_delete: true },
        statistics: { can_view: true, can_edit: true, can_delete: true },
        'closed-orders': { can_view: true, can_edit: true, can_delete: true },
        import: { can_view: true, can_edit: true, can_delete: true },
        export: { can_view: true, can_edit: true, can_delete: true },
        publications: { can_view: true, can_edit: true, can_delete: true },
        'move-stock': { can_view: true, can_edit: true, can_delete: true },
        'public-sales': { can_view: true, can_edit: true, can_delete: true },
        offers: { can_view: true, can_edit: true, can_delete: true },
        search: { can_view: true, can_edit: true, can_delete: true },
        labels: { can_view: true, can_edit: true, can_delete: true },
        customers: { can_view: true, can_edit: true, can_delete: true },
        'meta-feed': { can_view: true, can_edit: true, can_delete: true },
      };
      cachedUserPermissions = allPermissions;
      cacheTimestamp = Date.now();
      return allPermissions;
    }

    // Obtener permisos del colaborador
    const { data: adminData, error: adminError } = await supabase
      .from("admins")
      .select("id")
      .eq("user_id", user.id)
      .single();

    if (adminError || !adminData) {
      cachedUserPermissions = {};
      return {};
    }

    const { data: permissions, error: permError } = await supabase
      .from("admin_permissions")
      .select("permission_key, can_view, can_edit, can_delete")
      .eq("admin_id", adminData.id);

    if (permError) {
      console.error("Error obteniendo permisos:", permError);
      cachedUserPermissions = {};
      return {};
    }

    // Convertir array a objeto
    const permissionsObj = {};
    permissions?.forEach(perm => {
      permissionsObj[perm.permission_key] = {
        can_view: perm.can_view,
        can_edit: perm.can_edit,
        can_delete: perm.can_delete,
      };
    });

    cachedUserPermissions = permissionsObj;
    cacheTimestamp = Date.now();
    return permissionsObj;
  } catch (error) {
    console.error("Error en getUserPermissions:", error);
    return {};
  }
}

/**
 * Verifica si el usuario tiene un permiso específico
 * @param {string} permissionKey - Clave del permiso ('stock', 'import', 'export', 'orders', etc.)
 * @param {string} action - Acción requerida ('view', 'edit', 'delete')
 * @returns {Promise<boolean>}
 */
export async function checkPermission(permissionKey, action = 'view') {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return false;
    }

    // Super admins tienen todos los permisos
    if (await isSuperAdmin()) {
      return true;
    }

    // Verificar permiso usando RPC
    const { data, error } = await supabase
      .rpc('has_permission', {
        check_user_id: user.id,
        permission_key: permissionKey,
        action: action
      });

    if (error) {
      console.error("Error verificando permiso:", error);
      return false;
    }

    return !!data;
  } catch (error) {
    console.error("Error en checkPermission:", error);
    return false;
  }
}

/**
 * Verifica múltiples permisos a la vez
 * @param {Array<{key: string, action: string}>} permissions - Array de objetos {key, action}
 * @returns {Promise<Object>} Objeto con resultados por permiso
 */
export async function checkMultiplePermissions(permissions) {
  const results = {};
  for (const perm of permissions) {
    results[perm.key] = await checkPermission(perm.key, perm.action || 'view');
  }
  return results;
}

/**
 * Verifica si el usuario actual es admin (super_admin o collaborator)
 * @returns {Promise<boolean>}
 */
export async function isAdmin() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      console.log("isAdmin: No hay usuario autenticado");
      return false;
    }

    // Usar maybeSingle() en lugar de single() para evitar errores si no existe
    const { data, error } = await supabase
      .from("admins")
      .select("id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Error en isAdmin al consultar admins:", error);
      return false;
    }

    if (!data) {
      console.log(`isAdmin: Usuario ${user.email} no está en la tabla admins`);
      return false;
    }

    console.log(`isAdmin: Usuario ${user.email} es admin con rol ${data.role}`);
    return true; // Si está en la tabla, es admin (super_admin o collaborator)
  } catch (error) {
    console.error("Error en isAdmin:", error);
    return false;
  }
}

/**
 * Obtiene el rol del usuario actual
 * @returns {Promise<string|null>} 'super_admin', 'collaborator', o null
 */
export async function getUserRole() {
  try {
    if (await isSuperAdmin()) {
      return 'super_admin';
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return null;
    }

    const { data, error } = await supabase
      .from("admins")
      .select("role")
      .eq("user_id", user.id)
      .single();

    if (error || !data) {
      return null;
    }

    return data.role;
  } catch (error) {
    console.error("Error en getUserRole:", error);
    return null;
  }
}

/**
 * Requiere que el usuario sea admin, redirige si no lo es
 * @param {string} redirectUrl - URL a la que redirigir si no es admin
 * @returns {Promise<boolean>} true si es admin, false si no
 */
export async function requireAdminAuth(redirectUrl = './index.html') {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert("Debes iniciar sesión para acceder a esta página.");
      window.location.href = redirectUrl;
      return false;
    }

    const isUserAdmin = await isAdmin();
    if (!isUserAdmin) {
      alert("No tienes autorización para acceder al panel de administración. Solo los administradores autorizados pueden acceder.");
      window.location.href = redirectUrl;
      return false;
    }

    return true;
  } catch (error) {
    console.error("Error en requireAdminAuth:", error);
    alert("Error al verificar autorización. Por favor, intenta de nuevo.");
    window.location.href = redirectUrl;
    return false;
  }
}

/**
 * Requiere que el usuario tenga un permiso específico, redirige si no lo tiene
 * @param {string} permissionKey - Clave del permiso
 * @param {string} action - Acción requerida
 * @param {string} redirectUrl - URL a la que redirigir si no tiene permiso
 */
export async function requirePermission(permissionKey, action = 'view', redirectUrl = './index.html') {
  const hasPermission = await checkPermission(permissionKey, action);
  if (!hasPermission) {
    alert(`No tienes permiso para ${action} ${permissionKey}.`);
    window.location.href = redirectUrl;
    return false;
  }
  return true;
}

// Limpiar caché cuando el usuario cierra sesión
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    clearPermissionsCache();
  } else if (event === 'SIGNED_IN') {
    // Limpiar caché cuando se inicia sesión para asegurar datos frescos
    clearPermissionsCache();
  }
});

// Hacer disponible globalmente para que admin-auth.js pueda usarlo
if (typeof window !== 'undefined') {
  window.clearPermissionsCache = clearPermissionsCache;
}

