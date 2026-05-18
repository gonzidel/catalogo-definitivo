// Carga custom-banner.js solo cuando el banner curado NO está activo.
// FYL_CURATED_BANNER_V1 debe resolverse antes (inline en index.html / catalogo.html).

const loaderUrl = new URL(import.meta.url);
const cacheV = loaderUrl.searchParams.get("v");
const legacyUrl = cacheV
  ? `./custom-banner.js?v=${encodeURIComponent(cacheV)}`
  : "./custom-banner.js";

if (typeof window !== "undefined" && window.FYL_CURATED_BANNER_V1 !== true) {
  await import(legacyUrl);
}
