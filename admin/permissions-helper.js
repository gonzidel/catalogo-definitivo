// admin/permissions-helper.js
// Utilidades para verificar permisos de administradores y colaboradores
import { supabase } from "../scripts/supabase-client.js";

let cachedUserPermissions = null;
let cachedIsSuperAdmin = null;
let cacheTimestamp = null;
const CACHE_DURATION = 60000; // 1 minuto

// Cache del objeto user (local, sin red). getSession() es siempre local.
let _cachedUser = null;
// Single-flight: si varias funciones piden el user al mismo tiempo, un solo fetch.
let _userFetchPromise = null;
// Single-flight para getUserPermissions
let _permissionsFetchPromise = null;

/**
 * Obtiene el user de la sesión local (getSession, sin roundtrip de red).
 * Idempotente: múltiples llamadas comparten la misma Promise si el fetch está en curso.
 * @internal
 */
async function _getSessionUser() {
  if (_cachedUser) return _cachedUser;
  if (_userFetchPromise) return _userFetchPromise;
  _userFetchPromise = supabase.auth.getSession().then(({ data }) => {
    _cachedUser = data?.session?.user ?? null;
    _userFetchPromise = null;
    return _cachedUser;
  }).catch(() => {
    _userFetchPromise = null;
    return null;
  });
  return _userFetchPromise;
}

/**
 * Limpia la caché de permisos
 */
export function clearPermissionsCache() {
  cachedUserPermissions = null;
  cachedIsSuperAdmin = null;
  cacheTimestamp = null;
  _cachedUser = null;
  _userFetchPromise = null;
  _permissionsFetchPromise = null;
}

/**
 * Verifica si el usuario actual es super_admin
 * @returns {Promise<boolean>}
 */
export async function isSuperAdmin() {
  try {
    if (cachedIsSuperAdmin !== null && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
      return cachedIsSuperAdmin;
    }

    // Usar session local (sin red) en lugar de getUser() (red)
    const user = await _getSessionUser();
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
    if (cachedUserPermissions && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
      return cachedUserPermissions;
    }
    // Single-flight: si ya hay una carga en progreso, esperar a la misma Promise
    if (_permissionsFetchPromise) return _permissionsFetchPromise;

    _permissionsFetchPromise = _doGetUserPermissions().finally(() => {
      _permissionsFetchPromise = null;
    });
    return _permissionsFetchPromise;
  } catch (error) {
    console.error("Error en getUserPermissions:", error);
    return {};
  }
}

async function _doGetUserPermissions() {
  try {
    // Usar session local (sin red)
    const user = await _getSessionUser();
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
        'stock-audit': { can_view: true, can_edit: false, can_delete: false },
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
        proveedores: { can_view: true, can_edit: true, can_delete: true },
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
    console.error("Error en _doGetUserPermissions:", error);
    return {};
  }
}

/**
 * Verifica si el usuario tiene un permiso específico.
 *
 * Fase 3: Usa getUserPermissions() (que ya tiene cache bulk + single-flight)
 * en lugar de llamar a getUser() + isSuperAdmin() + RPC has_permission por
 * separado. El primer checkPermission de la sesión hace 1-2 queries; los
 * siguientes son lookups O(1) en memoria.
 *
 * @param {string} permissionKey
 * @param {'view'|'edit'|'delete'} [action='view']
 * @returns {Promise<boolean>}
 */
export async function checkPermission(permissionKey, action = 'view') {
  try {
    const permissions = await getUserPermissions();
    const perm = permissions[permissionKey];
    if (!perm) return false;
    const key = `can_${action}`;
    return !!perm[key];
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
    const user = await _getSessionUser();
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
    const user = await _getSessionUser();
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

// Limpiar caché cuando el usuario cierra/abre sesión
if (supabase?.auth?.onAuthStateChange) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      clearPermissionsCache();
    }
  });
}

// Hacer disponible globalmente para que admin-auth.js pueda usarlo
if (typeof window !== 'undefined') {
  window.clearPermissionsCache = clearPermissionsCache;
}

