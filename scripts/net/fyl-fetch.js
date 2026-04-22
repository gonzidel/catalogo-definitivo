/**
 * scripts/net/fyl-fetch.js
 *
 * Capa común de red para la web FYL.
 *
 * Principio central: error de red ≠ falta de sesión ≠ falta de permiso.
 * Cada tipo de error produce una clasificación canónica (FYL_ERROR_KIND) que
 * las pantallas usan para tomar decisiones de UX sin adivinar la causa.
 *
 * Compatibilidad:
 *  - No reemplaza supabase-client.js ni el fetch global.
 *  - supabase-client.js ya pone un tope de 55 s por request via fylFetchWithTimeout.
 *    wrapSupabase añade clasificación + retry encima de ese tope, no debajo.
 *  - RLS funciona igual: el servidor devuelve 403/PGRST116; classifyError lo
 *    categoriza como 'permission', nunca como 'auth' ni como 'network'.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *
 *   FYL_ERROR_KIND  Constantes de clasificación (object frozen).
 *   classifyError   Clasifica cualquier error en una de esas constantes.
 *   createAbortScope  AbortController con API mínima y log de causa.
 *   wrapSupabase    Envuelve una consulta Supabase; retorna { data, error, kind }.
 *   fylFetch        Envuelve fetch nativo; retorna { response, data, error, kind }.
 *
 * ── Migración incremental ─────────────────────────────────────────────────────
 *
 *   Paso 0 — solo clasificar, sin cambiar nada más:
 *
 *     const { data, error } = await supabase.from('orders').select('...');
 *     const kind = error ? classifyError(error) : null;
 *     if (kind === 'network') { mostrarBannerRed(); return; }   // sin redirect
 *     if (kind === 'auth')    { redirigirLogin();  return; }   // 401 confirmado
 *     if (error)              { mostrarError(error.message); return; }
 *
 *   Paso 1 — usar wrapSupabase (drop-in):
 *
 *     const { data, error, kind } = await wrapSupabase(
 *       supabase.from('orders').select('...'),   // promesa, sin retry
 *     );
 *
 *   Paso 2 — factory + retry (para read crítico):
 *
 *     const { data, error, kind } = await wrapSupabase(
 *       () => supabase.from('catalog_public_view').select('*'),
 *       { retries: 2, label: 'catalog.load' }
 *     );
 *
 *   Paso 3 — factory + retry + AbortScope (para pantallas con navegación):
 *
 *     const abortScope = createAbortScope();
 *     const { data, error, kind } = await wrapSupabase(
 *       () => supabase.from('orders').select('...').range(0, 49),
 *       { retries: 1, signal: abortScope.signal, label: 'orders.list' }
 *     );
 *     // Al navegar fuera:
 *     window.addEventListener('beforeunload', () => abortScope.abort('unload'));
 */

// ── Constantes de clasificación ───────────────────────────────────────────────

/**
 * Clasificación canónica de errores.
 *
 * @type {{ NETWORK: string, AUTH: string, PERMISSION: string, SERVER: string, UNKNOWN: string }}
 *
 * NETWORK    — Timeout, offline, AbortError, sin respuesta del servidor.
 *              → Mostrar banner no bloqueante; NO redirigir; reintentar es válido.
 *
 * AUTH       — 401, JWT expirado/inválido, sesión faltante (servidor confirmó).
 *              → Redirigir a login; limpiar caché de sesión.
 *
 * PERMISSION — 403, RLS rejection (servidor confirmó sin permiso).
 *              → Mostrar "sin acceso"; NO redirigir por defecto; RLS es el backstop.
 *
 * SERVER     — 5xx — error en la infraestructura.
 *              → Mostrar "error temporal, intentá más tarde"; reintentar conservador.
 *
 * UNKNOWN    — Todo lo demás (bugs, errores de código, respuestas inesperadas).
 *              → Loguear; mostrar mensaje genérico; no asumir nada sobre auth.
 */
export const FYL_ERROR_KIND = Object.freeze({
  NETWORK:    "network",
  AUTH:       "auth",
  PERMISSION: "permission",
  SERVER:     "server",
  UNKNOWN:    "unknown",
});

// ── Backoff ───────────────────────────────────────────────────────────────────

// Ventana de espera por intento: 600 ms, 1 500 ms, 3 000 ms + jitter ±20 %.
// El jitter evita thundering herd cuando varios módulos reintentan a la vez.
const _BACKOFF_BASE_MS = [600, 1500, 3000];

function _backoffMs(attempt) {
  const base = _BACKOFF_BASE_MS[Math.min(attempt, _BACKOFF_BASE_MS.length - 1)];
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(100, Math.round(base + jitter));
}

// ── classifyError ─────────────────────────────────────────────────────────────

/**
 * Clasifica cualquier error o status HTTP en un FYL_ERROR_KIND.
 *
 * Acepta:
 *  - Error JS (TypeError, DOMException AbortError, Error genérico)
 *  - Objeto de error de Supabase { message, status, code }
 *  - Error de Supabase Auth (AuthSessionMissingError, AuthApiError)
 *  - Status HTTP numérico suelto (segundo argumento)
 *
 * La clasificación es conservadora: solo devuelve 'auth' o 'permission' cuando
 * hay evidencia explícita del servidor (status / código PostgREST). Sin esa
 * evidencia retorna 'network' o 'unknown', nunca bloquea por asumir auth.
 *
 * @param {Error|Object|null} err
 * @param {number} [httpStatus]  Status HTTP si se conoce por separado.
 * @returns {string}  Una de las claves de FYL_ERROR_KIND.
 */
export function classifyError(err, httpStatus) {
  if (!err && !httpStatus) return FYL_ERROR_KIND.UNKNOWN;

  const name    = String(err?.name    ?? "");
  const message = String(err?.message ?? "");
  const code    = String(err?.code    ?? "");
  const status  = Number(
    err?.status ?? err?.statusCode ?? err?.status_code ?? httpStatus ?? 0
  );

  // ── Network (transitorios — no implican sesión ni permisos inválidos) ─────
  if (name === "AbortError") return FYL_ERROR_KIND.NETWORK;
  // TypeError de fetch: "Failed to fetch", "NetworkError", etc.
  if (name === "TypeError" && /fetch|network|failed|load/i.test(message)) {
    return FYL_ERROR_KIND.NETWORK;
  }
  // Timeout propio de fyl (message set por fylAwaitWithTimeout / _raceTimeout)
  if (/fyl_timeout/i.test(message)) return FYL_ERROR_KIND.NETWORK;
  // Sin respuesta (status 0 = CORS, offline, DNS failure)
  if (status === 0) return FYL_ERROR_KIND.NETWORK;

  // ── Auth (servidor confirmó sesión inválida o expirada) ───────────────────
  // Supabase Auth classes
  if (name === "AuthSessionMissingError") return FYL_ERROR_KIND.AUTH;
  if (name === "AuthApiError" && status === 401) return FYL_ERROR_KIND.AUTH;
  if (status === 401) return FYL_ERROR_KIND.AUTH;
  // PostgREST: JWT expirado / inválido
  if (code === "PGRST301") return FYL_ERROR_KIND.AUTH;  // JWT expired
  if (code === "PGRST302") return FYL_ERROR_KIND.AUTH;  // JWT invalid
  // Mensajes típicos de auth (solo cuando hay status HTTP para respaldarlo)
  if (status >= 400 && status < 500 &&
      /JWT|session missing|not authenticated|invalid token/i.test(message)) {
    return FYL_ERROR_KIND.AUTH;
  }

  // ── Permission (servidor confirmó falta de permisos / RLS) ───────────────
  if (status === 403) return FYL_ERROR_KIND.PERMISSION;
  // PGRST116: "The result contains 0 rows" — puede ser RLS silencioso en
  // consultas que deberían retornar exactamente 1 fila (.single() / .maybeSingle())
  if (code === "PGRST116") return FYL_ERROR_KIND.PERMISSION;
  if (/violates row.level security|insufficient_privilege|permission denied/i.test(message)) {
    return FYL_ERROR_KIND.PERMISSION;
  }

  // ── Server ────────────────────────────────────────────────────────────────
  if (status >= 500 && status < 600) return FYL_ERROR_KIND.SERVER;

  return FYL_ERROR_KIND.UNKNOWN;
}

// ── createAbortScope ──────────────────────────────────────────────────────────

/**
 * Crea un AbortScope: un AbortController con API mínima y log de causa.
 *
 * Usalo por pantalla o por operación de larga duración:
 *
 *   const abortScope = createAbortScope();
 *
 *   // Pasar a wrapSupabase / fylFetch:
 *   const result = await wrapSupabase(factory, { signal: abortScope.signal });
 *
 *   // Al navegar fuera o destruir el componente:
 *   window.addEventListener('beforeunload', () => abortScope.abort('unload'), { once: true });
 *
 *   // Integración con screen-scope (wiring manual):
 *   const screenScope = createScreenScope('admin-orders', {
 *     onReady() { abortScope.abort('screen_ready'); }  // liberar si ya no hay fetch en vuelo
 *   });
 *
 * @returns {{ signal: AbortSignal, abort: (reason?: string) => void, aborted: boolean }}
 */
export function createAbortScope() {
  const ctrl = new AbortController();
  return Object.freeze({
    get signal()  { return ctrl.signal; },
    get aborted() { return ctrl.signal.aborted; },
    /**
     * Aborta todos los requests asociados a este scope.
     * @param {string} [reason]  Causa (aparece en logs).
     */
    abort(reason) {
      if (!ctrl.signal.aborted) {
        ctrl.abort(reason ?? "scope_aborted");
      }
    },
  });
}

// ── wrapSupabase ──────────────────────────────────────────────────────────────

/**
 * Envuelve una consulta Supabase con clasificación de error, retry controlado
 * y soporte de AbortSignal.
 *
 * Retorna SIEMPRE { data, error, kind, aborted }:
 *  - data, error — misma estructura que devuelve Supabase (compatible al 100 %).
 *  - kind        — FYL_ERROR_KIND o null (si no hubo error).
 *  - aborted     — true si fue cancelado por AbortScope o timeout propio.
 *
 * Retry:
 *  - Solo para errores kind === 'network' (transitorios, idempotentes).
 *  - Solo si se pasó una factory (() => query), nunca con una Promise ya resuelta.
 *  - Backoff: 600 ms, 1 500 ms, 3 000 ms con jitter ±20 %.
 *
 * El timeout de 55 s de supabase-client.js sigue activo como backstop.
 * timeoutMs de esta función sirve para reducir ese tope en pantallas donde
 * querés un SLA más corto (ej: 8 s en mobile para auth crítica).
 *
 * @param {Function|PromiseLike} factoryOrPromise
 *   - Function: `() => supabase.from(...).select(...)` → permite retry.
 *   - PromiseLike: `supabase.from(...).select(...)` → no permite retry (single-shot).
 * @param {object}       [opts]
 * @param {number}       [opts.retries=0]     Reintentos adicionales (máx 3 útiles).
 * @param {number}       [opts.timeoutMs=0]   Tope en ms. 0 = usar solo el de supabase-client.
 * @param {AbortSignal}  [opts.signal]        Signal para cancelar desde fuera.
 * @param {string}       [opts.label='supabase'] Nombre para logs/telemetría.
 * @returns {Promise<{ data: any, error: any, kind: string|null, aborted: boolean, count: number|null }>}
 *   `count` es el valor que Supabase devuelve cuando se usa `{ count: 'exact' }` en select().
 */
export async function wrapSupabase(factoryOrPromise, opts = {}) {
  const {
    retries   = 0,
    timeoutMs = 0,
    signal,
    label     = "supabase",
  } = opts;

  const isFactory = typeof factoryOrPromise === "function";

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) return _supabaseAborted();

    try {
      const query = isFactory ? factoryOrPromise() : factoryOrPromise;

      // Si se pidió un timeout propio O hay un signal externo, competimos.
      const result = (signal || timeoutMs > 0)
        ? await _raceAbortAndTimeout(query, signal, timeoutMs, label)
        : await query;

      // _raceAbortAndTimeout devolvió el sentinel cuando se anuló.
      if (result === _ABORTED_SENTINEL) return _supabaseAborted();

      const { data = null, error = null, count = null } = result ?? {};

      if (!error) return { data, error: null, kind: null, aborted: false, count };

      const kind = classifyError(error);

      if (_shouldRetry(kind, isFactory, attempt, retries)) {
        await _sleepOrAbort(_backoffMs(attempt), signal);
        console.warn(`[fyl-fetch:${label}] retry ${attempt + 1}/${retries} (kind=${kind})`);
        continue;
      }

      return { data: null, error, kind, aborted: false };

    } catch (err) {
      if (err === _ABORTED_SENTINEL) return _supabaseAborted();

      const kind = classifyError(err);

      if (err?.name === "AbortError" || /fyl_timeout/.test(err?.message ?? "")) {
        return _supabaseAborted();
      }

      if (_shouldRetry(kind, isFactory, attempt, retries)) {
        await _sleepOrAbort(_backoffMs(attempt), signal);
        console.warn(`[fyl-fetch:${label}] retry ${attempt + 1}/${retries} (exception kind=${kind})`);
        continue;
      }

      return { data: null, error: err, kind, aborted: false };
    }
  }

  // Fallback defensivo (no debería alcanzarse con lógica correcta).
  return {
    data: null,
    error: new Error("fyl_max_retries_exceeded"),
    kind: FYL_ERROR_KIND.NETWORK,
    aborted: false,
  };
}

// ── fylFetch ──────────────────────────────────────────────────────────────────

/**
 * Envuelve fetch nativo con clasificación de error, timeout y retry.
 *
 * Para requests HTTP que no pasan por supabase-js: webhooks, APIs externas,
 * endpoints propios, llamadas a n8n, etc.
 *
 * Retorna { response, data, error, kind, aborted }:
 *  - response — Response nativa (null si hubo error de red).
 *  - data     — JSON parseado (null si la respuesta no es JSON o hubo error).
 *  - error    — Error (null si ok).
 *  - kind     — FYL_ERROR_KIND o null.
 *  - aborted  — true si fue cancelado.
 *
 * @param {string|URL}   url
 * @param {object}       [opts]
 * @param {number}       [opts.timeoutMs=30000]   Timeout en ms. 0 = sin timeout.
 * @param {number}       [opts.retries=0]          Reintentos (solo network errors).
 * @param {AbortSignal}  [opts.signal]             Signal externo.
 * @param {string}       [opts.label='fetch']       Para logs.
 * @param {*}            [opts.*]                  El resto pasa directo a fetch().
 * @returns {Promise<{ response: Response|null, data: any, error: Error|null, kind: string|null, aborted: boolean }>}
 */
export async function fylFetch(url, opts = {}) {
  const {
    timeoutMs = 30000,
    retries   = 0,
    signal: externalSignal,
    label     = "fetch",
    ...fetchOptions
  } = opts;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) return _fetchAborted();

    const ctrl  = new AbortController();
    let timerId = null;

    // Timer interno para timeout propio.
    if (timeoutMs > 0) {
      timerId = setTimeout(
        () => ctrl.abort(new Error(`fyl_timeout:${label}`)),
        timeoutMs
      );
    }
    // Propagar cancelación del signal externo al controller interno.
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timerId);
        return _fetchAborted();
      }
      externalSignal.addEventListener(
        "abort",
        () => ctrl.abort(externalSignal.reason),
        { once: true }
      );
    }

    try {
      const response = await fetch(url, { ...fetchOptions, signal: ctrl.signal });
      clearTimeout(timerId);

      if (!response.ok) {
        const kind = classifyError(null, response.status);
        const err  = Object.assign(new Error(`HTTP ${response.status}`), {
          status: response.status,
        });

        if (_shouldRetry(kind, true, attempt, retries)) {
          await _sleepOrAbort(_backoffMs(attempt), externalSignal);
          console.warn(`[fyl-fetch:${label}] retry ${attempt + 1}/${retries} (HTTP ${response.status})`);
          continue;
        }
        return { response, data: null, error: err, kind, aborted: false };
      }

      let data = null;
      try { data = await response.json(); } catch (_) { /* respuesta sin JSON */ }
      return { response, data, error: null, kind: null, aborted: false };

    } catch (err) {
      clearTimeout(timerId);

      if (err?.name === "AbortError") return _fetchAborted();

      const kind = classifyError(err);

      if (_shouldRetry(kind, true, attempt, retries)) {
        console.warn(`[fyl-fetch:${label}] retry ${attempt + 1}/${retries} (kind=${kind})`);
        await _sleepOrAbort(_backoffMs(attempt), externalSignal);
        continue;
      }
      return { response: null, data: null, error: err, kind, aborted: false };
    }
  }

  return _fetchAborted();
}

// ── Helpers privados ──────────────────────────────────────────────────────────

const _ABORTED_SENTINEL = Symbol("fyl_aborted");

function _supabaseAborted() {
  return { data: null, error: null, kind: FYL_ERROR_KIND.NETWORK, aborted: true, count: null };
}

function _fetchAborted() {
  return { response: null, data: null, error: null, kind: FYL_ERROR_KIND.NETWORK, aborted: true };
}

function _shouldRetry(kind, isFactory, attempt, retries) {
  // Solo network errors son potencialmente transitorios.
  // Solo si hay factory (promesa reutilizable) y quedan intentos.
  return (
    (kind === FYL_ERROR_KIND.NETWORK || kind === FYL_ERROR_KIND.SERVER) &&
    isFactory &&
    attempt < retries
  );
}

/**
 * Compite la promesa contra AbortSignal y timeout opcional.
 * Retorna el resultado de la promesa o el sentinel _ABORTED_SENTINEL.
 * No lanza AbortError; devuelve el sentinel para que el caller decida.
 */
async function _raceAbortAndTimeout(promise, signal, timeoutMs, label) {
  const racers = [promise];

  if (signal) {
    racers.push(
      new Promise((resolve) => {
        if (signal.aborted) { resolve(_ABORTED_SENTINEL); return; }
        signal.addEventListener(
          "abort",
          () => resolve(_ABORTED_SENTINEL),
          { once: true }
        );
      })
    );
  }

  if (timeoutMs > 0) {
    racers.push(
      new Promise((resolve) => {
        setTimeout(() => resolve(_ABORTED_SENTINEL), timeoutMs);
      })
    );
  }

  return Promise.race(racers);
}

/**
 * sleep con cancelación por AbortSignal.
 * Si el signal se aborta durante el backoff, resuelve inmediatamente
 * (sin lanzar). El siguiente intento del loop verifica signal.aborted y sale.
 */
function _sleepOrAbort(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        "abort",
        () => { clearTimeout(t); resolve(); },
        { once: true }
      );
    }
  });
}
