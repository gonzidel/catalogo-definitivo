// Carga curated-banner.js solo cuando FYL_CURATED_BANNER_V1 está activo.
// FYL_CURATED_BANNER_V1 debe resolverse antes (inline en index.html / catalogo.html).

const loaderUrl = new URL(import.meta.url);
const cacheV = loaderUrl.searchParams.get("v");
const curatedUrl = cacheV
  ? `./curated-banner.js?v=${encodeURIComponent(cacheV)}`
  : "./curated-banner.js";

function fylShouldLoadCuratedBannerModule() {
  if (typeof window === "undefined") return false;
  return window.FYL_CURATED_BANNER_V1 === true;
}

let __loadPromise = null;

/**
 * @returns {Promise<boolean>} true si el módulo quedó disponible en window
 */
export function ensureCuratedBannerModule() {
  if (!fylShouldLoadCuratedBannerModule()) {
    return Promise.resolve(false);
  }
  if (__loadPromise) return __loadPromise;
  __loadPromise = import(curatedUrl)
    .then(() => true)
    .catch((err) => {
      console.error("[fyl-curated-banner-loader]", err);
      __loadPromise = null;
      return false;
    });
  return __loadPromise;
}

if (typeof window !== "undefined") {
  window.ensureCuratedBannerModule = ensureCuratedBannerModule;
  if (fylShouldLoadCuratedBannerModule()) {
    window.__fylCuratedBannerReady = ensureCuratedBannerModule();
  } else {
    window.__fylCuratedBannerReady = Promise.resolve(false);
  }
}
