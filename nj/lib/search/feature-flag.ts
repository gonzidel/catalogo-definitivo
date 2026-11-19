/**
 * Bandera del buscador v2 (motor escalonado + UI premium).
 * Default ON en esta rama. Apagar con NEXT_PUBLIC_SEARCH_V2=0.
 */
export function isSearchV2Enabled(): boolean {
  const raw = process.env.NEXT_PUBLIC_SEARCH_V2;
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}
