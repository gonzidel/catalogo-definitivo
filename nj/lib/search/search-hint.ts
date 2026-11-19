const STORAGE_KEY = "fyl_search_hint_v2";

/** Una vez cada 3 días, y solo dentro de los 9 días desde la primera vez. */
const GAP_MS = 3 * 24 * 60 * 60 * 1000;
const WINDOW_MS = 9 * 24 * 60 * 60 * 1000;

const LAUNCH_DISMISS_KEY = "fyl-nj-launch-onboarding-dismissed-v1";
const LAUNCH_VIEW_COUNT_KEY = "fyl-nj-launch-onboarding-view-count-v1";
const LAUNCH_MAX_AUTO_VIEWS = 3;

type HintSchedule = {
  firstAt: number;
  lastShownAt: number;
};

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

function readSchedule(): HintSchedule | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<HintSchedule>;
    if (typeof data.firstAt !== "number" || typeof data.lastShownAt !== "number") return null;
    if (!Number.isFinite(data.firstAt) || !Number.isFinite(data.lastShownAt)) return null;
    return { firstAt: data.firstAt, lastShownAt: data.lastShownAt };
  } catch {
    return null;
  }
}

/**
 * El aviso sale la primera vez, otra vez recién a los 3 días, y deja de
 * existir 9 días después de esa primera vez.
 */
export function canShowSearchHint(): boolean {
  if (typeof window === "undefined") return false;
  const schedule = readSchedule();
  if (!schedule) return true;
  const now = Date.now();
  if (now - schedule.firstAt >= WINDOW_MS) return false;
  if (now - schedule.lastShownAt < GAP_MS) return false;
  return true;
}

/** Anota que el aviso se mostró. La primera vez arranca la ventana de 9 días. */
export function markSearchHintShown(): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const schedule = readSchedule();
  const next: HintSchedule = schedule
    ? { firstAt: schedule.firstAt, lastShownAt: now }
    : { firstAt: now, lastShownAt: now };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}
