/**
 * admin/auth-state.js
 *
 * Fuente única de verdad de auth + permisos admin para el panel.
 *
 * Problemas que resuelve (Fase 3):
 *  - Múltiples `getUser()` (red) por pantalla → sustituidos por `getSession()` (local)
 *  - N RPCs individuales de `has_permission` → sustituidos por una única carga bulk de permisos
 *  - Sin single-flight → dos llamadas simultáneas ya no disparan dos requests
 *  - Sin cache de usuario → objeto user cacheado en memoria hasta SIGNED_OUT
 *
 * Uso típico en cualquier módulo admin:
 *
 *   import { preloadAuthState, can, isAuthStateReady } from './auth-state.js';
 *
 *   // En initMiModulo(), SIEMPRE primero (can() es síncrono y lee el cache):
 *   await preloadAuthState();
 *   if (!isAuthStateReady()) { // degradar: permisos no resueltos
 *     return;
 *   }
 *
 *   const puedoVer   = can('orders', 'view');
 *   const puedoEditar = can('orders', 'edit');
 *   const puedoBorrar = can('orders', 'delete');
 *
 *   // Sin await preloadAuthState() / getAdminPermissions() antes, can() puede
 *   // devolver false aunque el usuario tenga permisos.
 *
 * Compatibilidad:
 *  - No reemplaza permissions-helper.js — delega en él.
 *  - No toca RLS ni backend.
 *  - Las funciones de permissions-helper exportadas siguen funcionando igual.
 *
 * ── Single-flight ──────────────────────────────────────────────────────────
 * Si dos partes del código llaman a getAdminPermissions() antes de que el
 * cache esté listo, ambas reciben la misma Promise y solo se hace una carga.
 */

import { supabase, supabaseReady } from "../scripts/supabase-client.js?v=m260607";
import { getUserPermissions, clearPermissionsCache } from "./permissions-helper.js?v=m260607";

// ── Cache de usuario ───────────────────────────────────────────────────────
// Guardamos el user del session (local, sin red). Se invalida en SIGNED_OUT.
let _cachedUser = null;

// Single-flight para la carga de usuario
let _userLoadPromise = null;

// ── Cache de permisos en memoria ───────────────────────────────────────────
// Una vez resueltos, los permisos viven aquí hasta invalidate() o SIGNED_OUT.
let _cachedPermissions = null;

// Single-flight para la carga de permisos
let _permissionsLoadPromise = null;

// Aviso único si can() se usa sin cache de permisos (orden de init incorrecto)
let _warnedCanBeforeReady = false;

// ── Exports ────────────────────────────────────────────────────────────────

/**
 * Retorna el usuario de la sesión local (sin roundtrip de red).
 * Usa getSession() → storage local, nunca /auth/v1/user.
 * Cacheado en módulo hasta invalidate() o cambio de sesión.
 *
 * @returns {Promise<import('@supabase/supabase-js').User|null>}
 */
export async function getSessionUser() {
  await supabaseReady;
  if (_cachedUser) return _cachedUser;
  if (_userLoadPromise) return _userLoadPromise;

  _userLoadPromise = supabase.auth.getSession().then(({ data }) => {
    _cachedUser = data?.session?.user ?? null;
    _userLoadPromise = null;
    return _cachedUser;
  }).catch((err) => {
    _userLoadPromise = null;
    console.warn("[auth-state] error en getSession:", err);
    return null;
  });

  return _userLoadPromise;
}

/**
 * Carga y cachea todos los permisos del usuario actual en una sola operación.
 * Las llamadas subsiguientes retornan el cache sin red.
 * Single-flight: si se llama varias veces antes de resolverse, solo hay un fetch.
 *
 * @returns {Promise<Record<string, {can_view: boolean, can_edit: boolean, can_delete: boolean}>>}
 */
const PERMISSIONS_TIMEOUT_MS = 12000;

export async function getAdminPermissions() {
  if (_cachedPermissions) return _cachedPermissions;
  if (_permissionsLoadPromise) return _permissionsLoadPromise;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("permissions_timeout")), PERMISSIONS_TIMEOUT_MS)
  );

  _permissionsLoadPromise = Promise.race([getUserPermissions(), timeoutPromise])
    .then((perms) => {
      _cachedPermissions = perms ?? {};
      _permissionsLoadPromise = null;
      return _cachedPermissions;
    }).catch((err) => {
      _permissionsLoadPromise = null;
      console.warn("[auth-state] error/timeout cargando permisos:", err.message);
      _cachedPermissions = {};
      return _cachedPermissions;
    });

  return _permissionsLoadPromise;
}

/**
 * Verifica de forma síncrona un permiso en el cache ya cargado.
 * Requiere haber llamado await getAdminPermissions() antes.
 * Si el cache no está disponible, retorna false de forma segura.
 *
 * @param {string} permissionKey  Ej: 'orders', 'stock', 'customers'
 * @param {'view'|'edit'|'delete'} [action='view']
 * @returns {boolean}
 */
export function can(permissionKey, action = "view") {
  if (_cachedPermissions == null) {
    if (!_warnedCanBeforeReady) {
      _warnedCanBeforeReady = true;
      console.warn(
        "[auth-state] can() se llamó antes de cargar permisos. Hacé await preloadAuthState() o getAdminPermissions() primero; si no, los resultados no son fiables."
      );
    }
    return false;
  }
  const perm = _cachedPermissions[permissionKey];
  if (!perm) return false;
  const key = `can_${action}`;
  return !!perm[key];
}

/**
 * @returns {boolean} true si ya se resolvió getAdminPermissions() (éxito o error con snapshot vacío)
 */
export function isAuthStateReady() {
  return _cachedPermissions != null;
}

/**
 * Verifica de forma síncrona si el cache tiene al menos un módulo con permisos.
 * Requiere haber completado getAdminPermissions() o preloadAuthState() antes.
 *
 * @returns {boolean}
 */
export function isAdminUser() {
  if (!isAuthStateReady()) return false;
  return Object.keys(_cachedPermissions).length > 0;
}

/**
 * Invalida todos los caches de este módulo.
 * Se llama automáticamente en cambios de sesión; también disponible manualmente.
 */
export function invalidate() {
  _cachedUser = null;
  _cachedPermissions = null;
  _userLoadPromise = null;
  _permissionsLoadPromise = null;
  _warnedCanBeforeReady = false;
  clearPermissionsCache(); // limpiar también el cache de permissions-helper
}

/**
 * Carga usuario + permisos en una sola llamada, de forma paralela donde es
 * posible. Útil al inicio de un módulo admin para precalentar ambos caches.
 *
 * @returns {Promise<{ user: User|null, permissions: object }>}
 */
export async function preloadAuthState() {
  const [user, permissions] = await Promise.all([
    getSessionUser(),
    getAdminPermissions(),
  ]);
  return { user, permissions };
}

/**
 * Invalida caches y vuelve a cargar sesión + permisos. Útil para “refrescar permisos”
 * sin recargar la página (misma sesión) o para recuperar estado tras un fallo.
 */
export async function refreshAuthState() {
  invalidate();
  return preloadAuthState();
}

// ── Sesión: invalidación en logout, cambio de usuario, refresh de token ───
// Usar invalidate() para alinear con permissions-helper (clearPermissionsCache) y
// no dejar _cached* huérfanos frente a permisos viejos.
const AUTH_INVALIDATION_EVENTS = new Set([
  "SIGNED_OUT",
  "SIGNED_IN",
  "USER_UPDATED",
]);

supabaseReady.then(() => {
  if (!supabase) return;
  supabase.auth.onAuthStateChange((event) => {
    if (AUTH_INVALIDATION_EVENTS.has(event)) {
      invalidate();
    }
  });
});

if (typeof window !== "undefined") {
  window.invalidateFylAuthState = invalidate;
  window.refreshFylAuthState = refreshAuthState;
}
