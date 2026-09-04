/**
 * Normalización compartida del buscador.
 * Guiones / slashes se tratan como espacio: `pantu-bota` → `pantu bota`
 * (luego un alias de frase puede resolver a `pantubota`).
 */
export function normalizeText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeNormalized(normalized: string): string[] {
  return normalized.split(/\s+/).filter((t) => t.length > 0);
}
