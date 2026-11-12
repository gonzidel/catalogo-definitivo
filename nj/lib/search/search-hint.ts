const STORAGE_KEY = "fyl_search_hint_v1";

const LAUNCH_DISMISS_KEY = "fyl-nj-launch-onboarding-dismissed-v1";
const LAUNCH_VIEW_COUNT_KEY = "fyl-nj-launch-onboarding-view-count-v1";
const LAUNCH_MAX_AUTO_VIEWS = 3;

/**
 * Las historias de novedades (HomeLaunchOnboarding) se abren solas ~1.2s
 * despues de entrar. El aviso del buscador no puede taparlas.
 */
export function launchStoriesMayOpen(): boolean {
  if (typeof window === "undefined") return false;
  if (document.documentElement.getAttribute("data-exp") === "catalog") return false;
  try {
    if (new URLSearchParams(window.location.search).get("novedades") === "1") return true;
    if (window.localStorage.getItem(LAUNCH_DISMISS_KEY) === "1") return false;
    const views = Number(window.localStorage.getItem(LAUNCH_VIEW_COUNT_KEY) ?? "0");
    return !(Number.isFinite(views) && views >= LAUNCH_MAX_AUTO_VIEWS);
  } catch {
    return true;
  }
}

/**
 * Aviso chico de "buscador mejorado" debajo de la barra de busqueda.
 * Se oculta para siempre apenas el cliente lo cierra o hace una
 * busqueda real (ya descubrio que funciona).
 */
export function isSearchHintDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function dismissSearchHint(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}
