/**
 * Detección de entorno (WebView Meta, familia de browser, entrypoint).
 * Usado por diagnóstico de recursos; tags Clarity tempranos vía fyl-clarity-env-tags.js.
 */

export function fylDetectMetaInAppBrowser() {
  if (typeof navigator === "undefined") return false;
  return /FBAN|FBAV|Instagram|IABMV/i.test(navigator.userAgent || "");
}

export function fylBrowserFamily() {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  if (/FBAN|FBAV/i.test(ua)) return "facebook_iab";
  if (/Instagram/i.test(ua)) return "instagram_iab";
  if (/Safari/i.test(ua) && !/Chrome|CriOS|FxiOS/i.test(ua)) return "safari";
  if (/Chrome|CriOS/i.test(ua)) return "chromium";
  return "other";
}

export function fylAppEntrypoint() {
  if (typeof location === "undefined") return "other";
  const p = location.pathname || "";
  if (p.includes("catalogo")) return "catalogo";
  if (p.endsWith("index.html") || p === "/" || p === "") return "index";
  return "other";
}

export function fylReadAppVersionFromMeta() {
  try {
    if (typeof document === "undefined") return "unknown";
    const meta = document.querySelector('meta[name="app-version"]');
    const v = meta?.getAttribute?.("content");
    return v && String(v).trim() ? String(v).trim() : "unknown";
  } catch {
    return "unknown";
  }
}
