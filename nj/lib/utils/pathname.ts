/**
 * `usePathname()` de Next.js debería devolver siempre la ruta SIN el
 * `basePath` ("/nj"), pero en este proyecto se observó que en algunos
 * renders (primer paint antes de hidratar, ciertas navegaciones duras)
 * devuelve la ruta CON el prefijo incluido. Si esto no se normaliza,
 * claves derivadas del pathname (sessionStorage, comparaciones de ruta)
 * pueden no coincidir entre el guardado y la lectura, rompiendo en
 * silencio features que dependen de esa clave (ver CatalogShell).
 */
export function normalizePathname(pathname: string): string {
  if (pathname === "/nj") return "/";
  if (pathname.startsWith("/nj/")) return pathname.slice(3);
  return pathname;
}
