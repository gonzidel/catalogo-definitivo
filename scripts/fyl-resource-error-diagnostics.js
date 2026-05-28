/**
 * Errores de carga SCRIPT/LINK (capture). Registra URL y clasificación sin overlay.
 */

import { fylReportClientError } from "./fyl-runtime-resilience.js?v=m260527";
import { fylClassifyClientError } from "./fyl-error-classify.js?v=m260527";
import {
  fylDetectMetaInAppBrowser,
  fylBrowserFamily,
  fylAppEntrypoint,
  fylReadAppVersionFromMeta,
} from "./fyl-env-tags.js?v=m260527";

function fylPushClarityDiagnosticTags(errorClass) {
  try {
    if (typeof window.__FYL_pushClarityEnvTags === "function") {
      window.__FYL_pushClarityEnvTags();
    }
    if (typeof clarity === "function" && errorClass) {
      clarity("set", "error_class", String(errorClass).slice(0, 64));
    }
  } catch (_) {}
}

/**
 * @param {Record<string, unknown>} payload
 */
function fylReportResourceDiagnostic(payload) {
  fylReportClientError(payload);
  try {
    globalThis.markBootStage?.("client.resource_error", payload);
  } catch (_) {}
  if (payload.error_class) {
    fylPushClarityDiagnosticTags(payload.error_class);
  }
}

export function installFylResourceErrorDiagnostics() {
  if (typeof window === "undefined" || window.__FYL_RESOURCE_DIAG__) return;
  window.__FYL_RESOURCE_DIAG__ = true;

  window.addEventListener(
    "error",
    (event) => {
      const t = event.target;
      const tag = t && t.tagName;
      if (tag !== "SCRIPT" && tag !== "LINK") return;

      const url = tag === "SCRIPT" ? t.src || t.getAttribute?.("src") : t.href || t.getAttribute?.("href");
      if (!url) return;

      const message = String(event.message || "");
      const errorClass = fylClassifyClientError({ message, url });

      fylReportResourceDiagnostic({
        kind: "resource.load",
        error_class: errorClass,
        tag,
        url: String(url).slice(0, 2000),
        message: message.slice(0, 500),
        in_meta_webview: fylDetectMetaInAppBrowser(),
        browser_family: fylBrowserFamily(),
        app_entrypoint: fylAppEntrypoint(),
        app_version: fylReadAppVersionFromMeta(),
      });
    },
    true
  );
}
