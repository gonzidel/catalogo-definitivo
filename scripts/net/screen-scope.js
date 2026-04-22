/**
 * scripts/net/screen-scope.js
 *
 * Mecanismo común para liberar overlays y emitir eventos de "pantalla usable"
 * de forma idempotente, desacoplada del ciclo de vida completo de la carga.
 *
 * Principios:
 *  - "Pantalla usable" != "init completo": markFirstPaint se llama cuando el
 *    usuario ya puede operar; markReady cuando todo terminó.
 *  - Idempotente: múltiples llamadas a markFirstPaint/markReady son no-op.
 *  - Observabilidad: emite CustomEvents en window (screen:first-paint,
 *    screen:ready) y llama a markBootStage si existe.
 *  - shouldRun: guard opcional para inhibir el callback onFirstPaint en paths
 *    específicos (ej: navegaciones internas del catálogo donde el overlay se
 *    gestiona por otro mecanismo). El flag y los eventos sí se emiten siempre.
 *
 * ── Uso básico ──────────────────────────────────────────────────────────────
 *
 *   import { createScreenScope } from '../scripts/net/screen-scope.js';
 *
 *   const scope = createScreenScope('admin-orders', {
 *     onFirstPaint({ reason }) { hideMySpinner(); },
 *     onReady({ reason })      { setupRealtime(); },
 *   });
 *
 *   // Cuando la UI ya es usable (primer chunk de datos en pantalla):
 *   scope.markFirstPaint('first_chunk_rendered');
 *
 *   // Cuando la carga completa terminó (realtime, contadores, etc.):
 *   scope.markReady('realtime_ready');
 *
 *   // Si la pantalla se destruye antes de estar lista:
 *   scope.dispose();
 *
 * ── Eventos emitidos ─────────────────────────────────────────────────────────
 *
 *   window.addEventListener('screen:first-paint', ({ detail }) => {
 *     // detail = { screen: 'admin-orders', reason: 'first_chunk_rendered' }
 *   });
 *
 *   window.addEventListener('screen:ready', ({ detail }) => {
 *     // detail = { screen: 'admin-orders', reason: 'realtime_ready' }
 *   });
 *
 * ── Integración en nuevas pantallas ──────────────────────────────────────────
 *
 *   1. Importar createScreenScope.
 *   2. Crear el scope al inicio del módulo con el nombre de pantalla.
 *   3. Llamar markFirstPaint() en el punto exacto donde la UI ya es operable
 *      (después del primer render real, no al final del init completo).
 *   4. Llamar markReady() cuando todo el trabajo secundario terminó.
 *   5. Llamar dispose() si la pantalla se destruye/navega fuera.
 */

/**
 * @typedef {Object} ScreenScopeOptions
 * @property {function({reason: string, screen: string}): void} [onFirstPaint]
 *   Callback ejecutado una sola vez al marcar el primer paint usable.
 *   Aquí va el ocultamiento del overlay/loader específico de la pantalla.
 * @property {function({reason: string, screen: string}): void} [onReady]
 *   Callback opcional ejecutado cuando la pantalla está completamente lista.
 *   Safety net: si el overlay sigue visible aquí, es el último punto para cerrarlo.
 * @property {function(): boolean} [shouldRun]
 *   Guard adicional: si retorna false, el callback onFirstPaint no corre, pero
 *   el flag firstPaintDone y los eventos sí se emiten. Útil para navegaciones
 *   internas donde el overlay ya tiene otro responsable.
 */

/**
 * Crea un scope de pantalla para gestionar el estado "usable" vs "carga total".
 *
 * @param {string} screenName  Identificador único (ej: 'catalog', 'admin-orders').
 * @param {ScreenScopeOptions} [options]
 * @returns {{ markFirstPaint: Function, markReady: Function, dispose: Function }}
 */
export function createScreenScope(screenName, options = {}) {
  if (!screenName || typeof screenName !== "string") {
    throw new Error("[screen-scope] screenName es requerido y debe ser string.");
  }

  const { onFirstPaint, onReady, shouldRun } = options;

  let firstPaintDone = false;
  let readyDone = false;
  let disposed = false;

  /**
   * Marca el primer paint usable de la pantalla.
   *
   * - Idempotente: la primera llamada ejecuta el callback y emite el evento;
   *   las siguientes son no-op.
   * - Si shouldRun() retorna false, el callback onFirstPaint no corre (el
   *   overlay lo gestiona otro mecanismo), pero el flag y los eventos sí.
   *
   * @param {string} [reason]  Causa del primer paint (se incluye en el evento).
   */
  function markFirstPaint(reason) {
    if (firstPaintDone || disposed) return;
    firstPaintDone = true;

    const doCallback =
      typeof shouldRun !== "function" || shouldRun();

    if (doCallback && typeof onFirstPaint === "function") {
      try {
        onFirstPaint({ reason: reason ?? "first_paint", screen: screenName });
      } catch (e) {
        console.warn(`[screen-scope:${screenName}] onFirstPaint error:`, e);
      }
    }

    _dispatch("screen:first-paint", reason ?? "first_paint");
    globalThis.markBootStage?.(`${screenName}.first_paint`, {
      reason: reason ?? "first_paint",
    });
  }

  /**
   * Marca la pantalla como completamente lista (post-primer-paint).
   *
   * - Garantiza que markFirstPaint fue llamado antes (implícitamente si no).
   * - onReady corre siempre (no respeta shouldRun); es el safety net final.
   * - Idempotente.
   *
   * @param {string} [reason]
   */
  function markReady(reason) {
    if (readyDone || disposed) return;
    readyDone = true;

    // Garantizar que first paint ocurrió (safety: edge cases donde cargarCategoria
    // no llegó al punto usable antes del finally de inicializarCatalogo, etc.)
    if (!firstPaintDone) markFirstPaint("implicit_from_ready");

    if (typeof onReady === "function") {
      try {
        onReady({ reason: reason ?? "ready", screen: screenName });
      } catch (e) {
        console.warn(`[screen-scope:${screenName}] onReady error:`, e);
      }
    }

    _dispatch("screen:ready", reason ?? "ready");
    globalThis.markBootStage?.(`${screenName}.ready`, {
      reason: reason ?? "ready",
    });
  }

  /**
   * Libera el scope. Las llamadas posteriores a markFirstPaint/markReady son no-op.
   * Útil para cancelar si la pantalla se destruye antes de estar lista.
   */
  function dispose() {
    disposed = true;
  }

  /** Emite un CustomEvent en window; silencia errores (entornos sin window). */
  function _dispatch(eventName, reason) {
    try {
      window.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: false,
          detail: { screen: screenName, reason },
        })
      );
    } catch (_) {
      /* no-op: SSR / entorno de test sin window */
    }
  }

  return Object.freeze({ markFirstPaint, markReady, dispose });
}
