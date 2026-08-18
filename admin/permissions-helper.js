// admin/permissions-helper.js
// Utilidades para verificar permisos de administradores y colaboradores
import { supabase, supabaseReady } from "../scripts/supabase-client.js?v=m260607";

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

  _userFetchPromise = (async () => {
    await supabaseReady;
    if (!supabase?.auth?.getSession) return null;
    try {
      const { data } = await supabase.auth.getSession();
      _cachedUser = data?.session?.user ?? null;
      return _cachedUser;
    } catch {
      return null;
    } finally {
      _userFetchPromise = null;
    }
  })();

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
const IS_SUPER_ADMIN_TIMEOUT_MS = 5000;

async function _isSuperAdminFromAdminsTable(userId) {
  const { data, error } = await supabase
    .from("admins")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[permissions] fallback admins.role:", error.message);
    return false;
  }
  return data?.role === "super_admin";
}

export async function isSuperAdmin() {
  try {
    if (cachedIsSuperAdmin !== null && cacheTimestamp && Date.now() - cacheTimestamp < CACHE_DURATION) {
      return cachedIsSuperAdmin;
    }

    await supabaseReady;
    const user = await _getSessionUser();
    if (!user) {
      cachedIsSuperAdmin = false;
      cacheTimestamp = Date.now();
      return false;
    }

    let fromRpc = false;
    try {
      const rpcTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("is_super_admin_timeout")), IS_SUPER_ADMIN_TIMEOUT_MS)
      );
      const rpcCall = supabase.rpc("is_super_admin", { check_user_id: user.id });
      const { data, error } = await Promise.race([rpcCall, rpcTimeout]);
      if (!error && data) {
        fromRpc = true;
        cachedIsSuperAdmin = true;
        cacheTimestamp = Date.now();
        return true;
      }
      if (error) {
        console.warn("[permissions] is_super_admin RPC error:", error.message);
      }
    } catch (rpcErr) {
      console.warn("[permissions] is_super_admin timeout/error:", rpcErr.message);
    }

    if (!fromRpc) {
      const fromTable = await _isSuperAdminFromAdminsTable(user.id);
      if (fromTable) {
        console.log("[permissions] super_admin detectado por tabla admins (fallback RPC)");
        cachedIsSuperAdmin = true;
        cacheTimestamp = Date.now();
        return true;
      }
    }

    cachedIsSuperAdmin = false;
    cacheTimestamp = Date.now();
    return false;
  } catch (error) {
    console.warn("[permissions] isSuperAdmin:", error.message);
    cachedIsSuperAdmin = false;
    cacheTimestamp = Date.now();
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

const ALL_PERMISSIONS = {
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
  proveedores: { can_view: true, can_edit: true, can_delete: true },
  offers: { can_view: true, can_edit: true, can_delete: true },
  search: { can_view: true, can_edit: true, can_delete: true },
  labels: { can_view: true, can_edit: true, can_delete: true },
  customers: { can_view: true, can_edit: true, can_delete: true },
  'missing-images': { can_view: true, can_edit: true, can_delete: true },
  'complete-tags': { can_view: true, can_edit: true, can_delete: true },
  'incomplete-products': { can_view: true, can_edit: true, can_delete: true },
  'product-status': { can_view: true, can_edit: true, can_delete: true },
  'meta-feed': { can_view: true, can_edit: true, can_delete: true },
  'quick-actions': { can_view: true, can_edit: true, can_delete: true },
  holidays: { can_view: true, can_edit: true, can_delete: true },
};

async function _doGetUserPermissions() {
  try {
    await supabaseReady;
    if (!supabase) {
      cachedUserPermissions = {};
      return {};
    }

    const user = await _getSessionUser();
    if (!user) {
      cachedUserPermissions = {};
      return {};
    }

    // RPC is_super_admin (puede fallar en mobile con red lenta, usamos fallback)
    const superAdmin = await isSuperAdmin();
    if (superAdmin) {
      cachedUserPermissions = ALL_PERMISSIONS;
      cacheTimestamp = Date.now();
      return ALL_PERMISSIONS;
    }

    // Fallback: consultar tabla admins con role
    const { data: adminData, error: adminError } = await supabase
      .from("admins")
      .select("id, role")
      .eq("user_id", user.id)
      .single();

    if (adminError || !adminData) {
      cachedUserPermissions = {};
      return {};
    }

    // Si el rol en la tabla es super_admin, dar todos los permisos (RPC falló por red)
    if (adminData.role === 'super_admin') {
      console.log("[permissions] super_admin detectado por tabla (fallback RPC)");
      cachedUserPermissions = ALL_PERMISSIONS;
      cacheTimestamp = Date.now();
      return ALL_PERMISSIONS;
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
    await supabaseReady;
    if (!supabase) return false;

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
    await supabaseReady;
    if (!supabase) return null;

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
supabaseReady.then(() => {
  if (!supabase?.auth?.onAuthStateChange) return;
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      clearPermissionsCache();
    }
  });
});

// Hacer disponible globalmente para que admin-auth.js pueda usarlo
if (typeof window !== 'undefined') {
  window.clearPermissionsCache = clearPermissionsCache;
}

