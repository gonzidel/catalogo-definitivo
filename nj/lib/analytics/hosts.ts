const PRODUCTION_HOSTS = new Set(["www.fylmoda.com.ar", "fylmoda.com.ar"]);

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

export function isProductionHost(hostname: string): boolean {
  return PRODUCTION_HOSTS.has(normalizeHost(hostname));
}

/**
 * Medición productiva (Pixel, Clarity de catalogo1, page_view GA): solo cuando
 * nj sirve la raíz de www. Antes del cambio de host, www/nj llega por proxy
 * desde catalogo1 con el mismo hostname y no debe mezclarse.
 */
export function shouldUseProductionAnalytics(hostname: string, rolloutEnabled: boolean): boolean {
  return rolloutEnabled && isProductionHost(hostname);
}
