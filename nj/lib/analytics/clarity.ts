/** Proyecto de Microsoft Clarity creado específicamente para el deploy de test de NJ. */
export const NJ_TEST_CLARITY_PROJECT_ID = "yekz20nia8";

/**
 * Hosts donde se graba con el proyecto de test. Se decide por hostname y no por
 * VERCEL_ENV: el sitio de pruebas y el productivo pueden compartir entorno de Vercel.
 */
export const NJ_TEST_CLARITY_HOSTS: readonly string[] = ["nj-fyl-testing.vercel.app"];

/** Producción ya mide con otro proyecto de Clarity (catalogo1); nunca mezclar sesiones. */
const PRODUCTION_DOMAIN = "fylmoda.com.ar";

export function isNjTestClarityHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === PRODUCTION_DOMAIN || host.endsWith(`.${PRODUCTION_DOMAIN}`)) return false;
  return NJ_TEST_CLARITY_HOSTS.includes(host);
}
