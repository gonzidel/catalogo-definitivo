/**
 * Clasificación compartida de errores cliente (Clarity / telemetría / overlay).
 * Sin dependencias; importable desde resiliencia y diagnóstico de recursos.
 */

export const FYL_ERROR_CLASS = Object.freeze({
  THIRD_PARTY: "third_party",
  META_WEBVIEW: "meta_webview",
  ASSET_HTML_INSTEAD_JS: "asset_html_instead_js",
  NETWORK_TRUNCATED: "network_truncated",
  FIRST_PARTY_EXCEPTION: "first_party_exception",
  BENIGN_THIRD_PARTY_EXEC: "benign_third_party_exec",
});

const VENDOR_HOST_RE =
  /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|facebook\.com|clarity\.ms/i;

const META_WEBVIEW_MSG_RE =
  /java object is gone|enableDidUserTypeOnKeyboardLogging|enableButtonsClickedMetadataLogging/i;

const EXTENSION_SOURCE_RE =
  /chrome-extension:|moz-extension:|safari-web-extension:|edgeextension:/i;

const KNOWN_THIRD_PARTY_SOURCE_RE =
  /fbevents\.js|connect\.facebook\.net|google-analytics|googletagmanager|clarity\.ms/i;

export function fylIsGenericScriptError(message) {
  const m = String(message || "");
  return m === "Script error." || m === "Script error";
}

export function fylIsMetaWebViewBridgeMessage(message) {
  return META_WEBVIEW_MSG_RE.test(String(message || ""));
}

export function fylIsKnownThirdPartySource(source) {
  return KNOWN_THIRD_PARTY_SOURCE_RE.test(String(source || ""));
}

export function fylIsExtensionSource(source) {
  return EXTENSION_SOURCE_RE.test(String(source || ""));
}

function fylHostFromUrl(url) {
  try {
    return new URL(url, typeof location !== "undefined" ? location.href : "https://local/").hostname;
  } catch {
    return "";
  }
}

function fylIsSameOriginUrl(url) {
  try {
    if (typeof location === "undefined") return false;
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * @param {{ message?: string, source?: string, url?: string }} input
 * @returns {string} FYL_ERROR_CLASS value
 */
export function fylClassifyClientError(input) {
  input = input || {};
  const message = String(input.message || "");
  const source = String(input.source || "");
  const url = String(input.url || source || "");
  const lower = message.toLowerCase();

  if (fylIsMetaWebViewBridgeMessage(message)) {
    return FYL_ERROR_CLASS.META_WEBVIEW;
  }

  if (fylIsGenericScriptError(message)) {
    return FYL_ERROR_CLASS.BENIGN_THIRD_PARTY_EXEC;
  }

  if (/unexpected end of input/i.test(message)) {
    if (url && fylIsSameOriginUrl(url)) return FYL_ERROR_CLASS.NETWORK_TRUNCATED;
    return FYL_ERROR_CLASS.NETWORK_TRUNCATED;
  }

  if (/unexpected token\s*['"]?</i.test(message) || /expected expression, got '<'/i.test(lower)) {
    return FYL_ERROR_CLASS.ASSET_HTML_INSTEAD_JS;
  }

  if (url) {
    const host = fylHostFromUrl(url);
    if (host && typeof location !== "undefined" && host !== location.hostname) {
      if (VENDOR_HOST_RE.test(host)) return FYL_ERROR_CLASS.THIRD_PARTY;
    }
    if (fylIsSameOriginUrl(url) && /\.(?:m?js|json)(\?|$)/i.test(url)) {
      if (/unexpected end of input/i.test(message) || /failed to fetch/i.test(lower)) {
        return FYL_ERROR_CLASS.NETWORK_TRUNCATED;
      }
    }
  }

  if (fylIsKnownThirdPartySource(source) || (url && VENDOR_HOST_RE.test(fylHostFromUrl(url)))) {
    return FYL_ERROR_CLASS.THIRD_PARTY;
  }

  if (fylIsExtensionSource(source)) {
    return FYL_ERROR_CLASS.BENIGN_THIRD_PARTY_EXEC;
  }

  return FYL_ERROR_CLASS.FIRST_PARTY_EXCEPTION;
}

/** Errores que no deben abrir overlay fullscreen ni alarmar KPI first-party. */
export function fylIsBenignErrorClass(errorClass) {
  return (
    errorClass === FYL_ERROR_CLASS.BENIGN_THIRD_PARTY_EXEC ||
    errorClass === FYL_ERROR_CLASS.THIRD_PARTY ||
    errorClass === FYL_ERROR_CLASS.META_WEBVIEW
  );
}
