/**
 * Tags Clarity de entorno (clásico, sin modules). Cargar tras el stub de Clarity en head.
 */
(function (w) {
  "use strict";

  function metaWebview() {
    var ua = (w.navigator && w.navigator.userAgent) || "";
    return /FBAN|FBAV|Instagram|IABMV/i.test(ua);
  }

  function browserFamily() {
    var ua = (w.navigator && w.navigator.userAgent) || "";
    if (/FBAN|FBAV/i.test(ua)) return "facebook_iab";
    if (/Instagram/i.test(ua)) return "instagram_iab";
    if (/Safari/i.test(ua) && !/Chrome|CriOS|FxiOS/i.test(ua)) return "safari";
    if (/Chrome|CriOS/i.test(ua)) return "chromium";
    return "other";
  }

  function entrypoint() {
    var p = (w.location && w.location.pathname) || "";
    if (p.indexOf("catalogo") >= 0) return "catalogo";
    if (p === "/" || p === "" || /index\.html$/i.test(p)) return "index";
    return "other";
  }

  function appVersion() {
    try {
      var meta = w.document && w.document.querySelector('meta[name="app-version"]');
      var v = meta && meta.getAttribute && meta.getAttribute("content");
      return v && String(v).trim() ? String(v).trim() : "unknown";
    } catch (_e) {
      return "unknown";
    }
  }

  function push() {
    var fn = w.clarity;
    if (typeof fn !== "function") return;
    fn("set", "app_version", appVersion());
    fn("set", "in_meta_webview", metaWebview() ? "1" : "0");
    fn("set", "app_entrypoint", entrypoint());
    fn("set", "browser_family", browserFamily());
  }

  w.__FYL_pushClarityEnvTags = push;
  push();
  w.addEventListener("fyl-catalog-boot-done", push, { once: true });
})(typeof window !== "undefined" ? window : globalThis);
