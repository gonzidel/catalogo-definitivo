/**
 * Wrapper GA4 para /nj. Reutiliza el measurement ID de scripts/analytics.js.
 * No envía page_view automático (el legado ya tiene su propio pageview).
 * Admin / dashboard no deben llamar estas funciones.
 */

export const FYL_GA_MEASUREMENT_ID = "G-2JDYZW1KD6";

type GtagFn = (...args: unknown[]) => void;

function gtagFn(): GtagFn | null {
  if (typeof window === "undefined") return null;
  const g = (window as Window & { gtag?: GtagFn }).gtag;
  return typeof g === "function" ? g : null;
}

function isLocalHost(): boolean {
  if (typeof location === "undefined") return false;
  const h = location.hostname || "";
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

function shouldWarn(): boolean {
  return process.env.NODE_ENV !== "production" || isLocalHost();
}

export function gaEvent(name: string, params?: Record<string, unknown>): void {
  if (!name) return;
  try {
    const g = gtagFn();
    if (!g) return;
    g("event", name, { app_area: "catalog", ...(params ?? {}) });
  } catch (err) {
    if (shouldWarn()) {
      console.warn("[fylAnalytics]", "gaEvent failed", err);
    }
  }
}

export function clipGaParam(value: string, max = 100): string {
  const t = String(value ?? "").trim();
  return t.length <= max ? t : t.slice(0, max);
}
