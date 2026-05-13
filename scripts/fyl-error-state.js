/**
 * FYL error UX: fullscreen crítico, inline parcial, toast leve.
 * Singleton fullscreen, cooldown anti-spam, sin mensajes técnicos al usuario.
 */

export const FYL_ERROR_ILLUSTRATION_SRC = "/history/sin-conexion.png";

const COOLDOWN_MS = 2000;

/** Gravedad para upgrades durante cooldown (mayor = más crítico). */
const PRESET_RANK = {
  product: 1,
  api: 2,
  catalog: 3,
  unexpected: 4,
  offline: 5,
};

const PRESETS = {
  offline: {
    title: "Estás sin conexión",
    message:
      "Algunas funciones no están disponibles por ahora. Cuando vuelva internet vas a poder seguir comprando normalmente.",
    buttonLabel: "Intentar nuevamente",
  },
  api: {
    title: "Estamos teniendo un inconveniente",
    message:
      "Nuestro sistema no pudo responder correctamente. Intentá nuevamente en unos segundos.",
    buttonLabel: "Intentar nuevamente",
  },
  catalog: {
    title: "No pudimos cargar el catálogo",
    message:
      "Estamos teniendo un problema momentáneo. Intentá nuevamente en unos segundos.",
    buttonLabel: "Intentar nuevamente",
  },
  product: {
    title: "Producto no disponible",
    message: "Puede que haya sido eliminado o que ya no tenga stock.",
    buttonLabel: "Cerrar",
  },
  unexpected: {
    title: "Algo no salió como esperábamos",
    message: "Actualizá la página para volver a intentarlo.",
    buttonLabel: "Actualizar",
  },
};

let __fullscreenRoot = null;
let __fullscreenVisible = false;
let __fullscreenPresetKey = "";
let __fullscreenRank = 0;
let __lastFullscreenSig = "";
let __lastFullscreenAt = 0;

let __toastEl = null;
let __toastTimer = null;
let __lastToastSig = "";
let __lastToastAt = 0;

const __inlineLast = new Map();

let __savedFocus = null;
let __scrollLock = false;

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function normalizePreset(p) {
  const k = String(p || "").toLowerCase();
  return PRESETS[k] ? k : "";
}

function resolveCopy(opts) {
  const presetKey = normalizePreset(opts.preset);
  const base = presetKey ? PRESETS[presetKey] : null;
  return {
    presetKey: presetKey || "custom",
    title: opts.title != null ? String(opts.title) : base?.title || "",
    message: opts.message != null ? String(opts.message) : base?.message || "",
    buttonLabel:
      opts.buttonLabel != null
        ? String(opts.buttonLabel)
        : base?.buttonLabel || "Entendido",
  };
}

function fullscreenSignature(opts, copy) {
  return `fs:${copy.presetKey}:${copy.title}:${copy.message}:${copy.buttonLabel}`;
}

function toastSignature(opts, copy, tone) {
  return `toast:${tone}:${copy.presetKey}:${copy.title}:${copy.message}`;
}

function inlineSignature(container, copy) {
  const id = container && container.nodeType ? container : null;
  const key = id ? id.id || String(id.className || "") : "unknown";
  return `in:${key}:${copy.presetKey}:${copy.title}:${copy.message}`;
}

function rankForPreset(key) {
  return PRESET_RANK[key] || 0;
}

function shouldThrottleFullscreen(sig, presetKey) {
  const t = now();
  const rank = rankForPreset(presetKey);
  if (__fullscreenVisible && __fullscreenRoot) {
    if (sig === __lastFullscreenSig) return { throttle: true, upgrade: false };
    if (rank > __fullscreenRank) return { throttle: false, upgrade: true };
    return { throttle: true, upgrade: false };
  }
  if (t - __lastFullscreenAt < COOLDOWN_MS && sig === __lastFullscreenSig) {
    return { throttle: true, upgrade: rank > __fullscreenRank };
  }
  return { throttle: false, upgrade: false };
}

function shouldThrottleToast(sig) {
  const t = now();
  if (t - __lastToastAt < COOLDOWN_MS && sig === __lastToastSig) return true;
  return false;
}

function shouldThrottleInline(container, sig) {
  const t = now();
  const prev = __inlineLast.get(container);
  if (prev && t - prev.at < COOLDOWN_MS && prev.sig === sig) return true;
  return false;
}

function bindIllustration(img) {
  if (!img || img.nodeName !== "IMG") return;
  img.decoding = "async";
  img.loading = "lazy";
  img.alt = "";
  img.src = FYL_ERROR_ILLUSTRATION_SRC;
  img.classList.add("fyl-error-state__img");
  img.onerror = () => {
    img.onerror = null;
    img.style.display = "none";
    const wrap = img.closest(".fyl-error-state__image-wrap, .fyl-inline-error__image-wrap");
    if (wrap) wrap.classList.add("fyl-error-state__image-wrap--empty");
  };
}

function ensureFullscreenRoot() {
  if (__fullscreenRoot && document.body.contains(__fullscreenRoot)) return __fullscreenRoot;
  const el = document.createElement("div");
  el.id = "fyl-error-state-root";
  el.className = "fyl-error-state";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = `
    <div class="fyl-error-state__backdrop" aria-hidden="true"></div>
    <div class="fyl-error-state__panel">
      <div class="fyl-error-state__image-wrap">
        <img alt="" />
      </div>
      <h2 class="fyl-error-state__title"></h2>
      <p class="fyl-error-state__message"></p>
      <button type="button" class="fyl-error-state__btn fyl-error-state__btn--primary"></button>
    </div>
  `;
  document.body.appendChild(el);
  bindIllustration(el.querySelector("img"));
  __fullscreenRoot = el;
  return el;
}

function applyScrollLock(lock) {
  if (typeof document === "undefined" || !document.body) return;
  if (lock && !__scrollLock) {
    document.body.dataset.fylErrPrevOverflow = document.body.style.overflow || "";
    document.body.style.overflow = "hidden";
    __scrollLock = true;
  } else if (!lock && __scrollLock) {
    document.body.style.overflow = document.body.dataset.fylErrPrevOverflow || "";
    try {
      delete document.body.dataset.fylErrPrevOverflow;
    } catch (_) {}
    __scrollLock = false;
  }
}

/**
 * HEAD fetch liviano; falla → sin conexión real para UX.
 */
export async function hasRealConnection(timeoutMs = 4500) {
  if (typeof fetch !== "function") return false;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t =
    ctrl &&
    setTimeout(() => {
      try {
        ctrl.abort();
      } catch (_) {}
    }, timeoutMs);
  try {
    await fetch("/favicon.ico", {
      method: "HEAD",
      cache: "no-store",
      credentials: "same-origin",
      signal: ctrl ? ctrl.signal : undefined,
    });
    return true;
  } catch (_) {
    return false;
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * navigator.onLine + hasRealConnection (debounce caller recomendado).
 */
export async function isFylOfflineDeepCheck() {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  } catch (_) {}
  const ok = await hasRealConnection();
  return !ok;
}

let __onlineDebounceTimer = null;
let __lastOnlineState = typeof navigator !== "undefined" ? navigator.onLine !== false : true;

/**
 * Escucha online/offline con debounce corto (iOS/Safari).
 * @param {(offline: boolean) => void} cb
 */
export function watchFylConnectivity(cb, debounceMs = 350) {
  if (typeof window === "undefined" || typeof cb !== "function") return () => {};
  const fire = () => {
    try {
      cb(!__lastOnlineState);
    } catch (_) {}
  };
  const schedule = () => {
    if (__onlineDebounceTimer) clearTimeout(__onlineDebounceTimer);
    __onlineDebounceTimer = setTimeout(async () => {
      __onlineDebounceTimer = null;
      try {
        __lastOnlineState =
          typeof navigator !== "undefined" ? navigator.onLine !== false : true;
      } catch (_) {
        __lastOnlineState = true;
      }
      const deepOff = await isFylOfflineDeepCheck();
      cb(deepOff);
    }, debounceMs);
  };
  window.addEventListener("online", schedule, { passive: true });
  window.addEventListener("offline", schedule, { passive: true });
  return () => {
    window.removeEventListener("online", schedule);
    window.removeEventListener("offline", schedule);
    if (__onlineDebounceTimer) clearTimeout(__onlineDebounceTimer);
  };
}

/**
 * Fullscreen crítico: singleton, actualiza contenido si ya abierto.
 * @param {{ preset?: string, title?: string, message?: string, buttonLabel?: string, retry?: () => void }} opts
 */
export function showFylErrorState(opts = {}) {
  if (typeof document === "undefined" || !document.body) return false;
  const copy = resolveCopy(opts);
  const sig = fullscreenSignature(opts, copy);
  const { throttle, upgrade } = shouldThrottleFullscreen(sig, copy.presetKey);
  if (throttle && !upgrade) return false;

  const root = ensureFullscreenRoot();
  const titleEl = root.querySelector(".fyl-error-state__title");
  const msgEl = root.querySelector(".fyl-error-state__message");
  const btn = root.querySelector(".fyl-error-state__btn--primary");

  titleEl.textContent = copy.title;
  msgEl.textContent = copy.message;
  btn.textContent = copy.buttonLabel;
  btn.onclick = null;
  btn.onclick = () => {
    try {
      if (typeof opts.retry === "function") opts.retry();
      else hideFylErrorState();
    } catch (_) {
      hideFylErrorState();
    }
  };

  __lastFullscreenSig = sig;
  __lastFullscreenAt = now();
  __fullscreenPresetKey = copy.presetKey;
  __fullscreenRank = rankForPreset(normalizePreset(opts.preset) || copy.presetKey);

  root.classList.remove("fyl-error-state--leave");
  root.classList.add("fyl-error-state--visible");
  __fullscreenVisible = true;
  applyScrollLock(true);

  try {
    __savedFocus = document.activeElement;
    btn.focus({ preventScroll: true });
  } catch (_) {}

  return true;
}

export function hideFylErrorState() {
  if (!__fullscreenRoot || !__fullscreenVisible) {
    applyScrollLock(false);
    return;
  }
  const root = __fullscreenRoot;
  root.classList.add("fyl-error-state--leave");
  root.classList.remove("fyl-error-state--visible");
  __fullscreenVisible = false;
  __fullscreenRank = 0;
  applyScrollLock(false);

  window.setTimeout(() => {
    root.classList.remove("fyl-error-state--leave");
  }, 320);

  try {
    if (__savedFocus && typeof __savedFocus.focus === "function") __savedFocus.focus({ preventScroll: true });
  } catch (_) {}
  __savedFocus = null;
}

export function isFylFullscreenErrorVisible() {
  return !!__fullscreenVisible;
}

/**
 * Inline: card dentro de container; no scroll lock.
 */
export function renderFylInlineError(container, opts = {}) {
  if (!container || !container.appendChild) return false;
  const copy = resolveCopy(opts);
  const sig = inlineSignature(container, copy);
  if (shouldThrottleInline(container, sig)) return false;
  __inlineLast.set(container, { sig, at: now() });

  container.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "fyl-inline-error";
  wrap.innerHTML = `
    <div class="fyl-inline-error__card">
      <div class="fyl-inline-error__image-wrap">
        <img alt="" />
      </div>
      <h3 class="fyl-inline-error__title"></h3>
      <p class="fyl-inline-error__message"></p>
      <div class="fyl-inline-error__actions"></div>
    </div>
  `;
  wrap.querySelector(".fyl-inline-error__title").textContent = copy.title;
  wrap.querySelector(".fyl-inline-error__message").textContent = copy.message;
  const actions = wrap.querySelector(".fyl-inline-error__actions");
  bindIllustration(wrap.querySelector("img"));

  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "fyl-inline-error__btn fyl-inline-error__btn--primary";
  primary.textContent = copy.buttonLabel;
  primary.onclick = () => {
    try {
      if (typeof opts.retry === "function") opts.retry();
    } catch (_) {}
  };
  actions.appendChild(primary);

  if (typeof opts.onSecondary === "function" && opts.secondaryLabel) {
    const sec = document.createElement("button");
    sec.type = "button";
    sec.className = "fyl-inline-error__btn fyl-inline-error__btn--ghost";
    sec.textContent = String(opts.secondaryLabel);
    sec.onclick = () => {
      try {
        opts.onSecondary();
      } catch (_) {}
    };
    actions.appendChild(sec);
  }

  container.appendChild(wrap);
  return true;
}

function ensureToastHost() {
  if (__toastEl && document.body.contains(__toastEl)) return __toastEl;
  const el = document.createElement("div");
  el.id = "fyl-toast-error-host";
  el.className = "fyl-toast-error-host";
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  __toastEl = el;
  return el;
}

/**
 * Toast leve; dedupe por cooldown.
 * @param {{ preset?: string, title?: string, message?: string, buttonLabel?: string, durationMs?: number, tone?: 'error'|'neutral' }} opts — `tone: 'neutral'` para confirmaciones sin aspecto de error.
 */
export function showFylToastError(opts = {}) {
  if (typeof document === "undefined" || !document.body) return false;
  const copy = resolveCopy(opts);
  const tone = opts.tone === "neutral" ? "neutral" : "error";
  const sig = toastSignature(opts, copy, tone);
  if (shouldThrottleToast(sig)) return false;
  __lastToastSig = sig;
  __lastToastAt = now();

  const host = ensureToastHost();
  host.replaceChildren();
  const t = document.createElement("div");
  t.className =
    "fyl-toast-error fyl-toast-error--show" +
    (tone === "neutral" ? " fyl-toast-error--neutral" : "");
  t.innerHTML = `<p class="fyl-toast-error__text"></p>`;
  const line = copy.title
    ? `${copy.title}${copy.message ? " — " + copy.message : ""}`
    : copy.message || copy.buttonLabel;
  t.querySelector(".fyl-toast-error__text").textContent = line;
  host.appendChild(t);

  if (__toastTimer) clearTimeout(__toastTimer);
  __toastTimer = setTimeout(() => {
    t.classList.remove("fyl-toast-error--show");
    t.classList.add("fyl-toast-error--leave");
    setTimeout(() => {
      t.remove();
      __toastTimer = null;
    }, 280);
  }, opts.durationMs && opts.durationMs > 0 ? opts.durationMs : 3200);

  return true;
}

/** Utilidad catálogo: offline profundo antes de decidir fullscreen PDP vs api inline */
export async function fylResolveOfflineForUx() {
  return isFylOfflineDeepCheck();
}

if (typeof window !== "undefined") {
  window.showFylErrorState = showFylErrorState;
  window.hideFylErrorState = hideFylErrorState;
  window.renderFylInlineError = renderFylInlineError;
  window.showFylToastError = showFylToastError;
  window.hasRealConnection = hasRealConnection;
  window.isFylOfflineDeepCheck = isFylOfflineDeepCheck;
  window.watchFylConnectivity = watchFylConnectivity;
}
