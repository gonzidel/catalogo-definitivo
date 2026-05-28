// Port mínimo de scripts/tag-normalize.js para Edge meta-feed (Deno).
// Mantener en sync con la lógica de canonicalTagKey / normalizeTagDisplay.

export function normalizeTagDisplay(tag: string | null | undefined): string {
  return String(tag ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeTagBasic(tag: string | null | undefined): string {
  let t = normalizeTagDisplay(tag).toLowerCase();
  try {
    t = t.normalize("NFD").replace(/\p{M}/gu, "");
  } catch {
    t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  return t;
}

/** Clave única: minúsculas, sin acentos, singular aproximado (bota/botas/BOTAS → bota). */
export function canonicalTagKey(tag: string | null | undefined): string {
  const t = normalizeTagBasic(tag);
  if (!t) return "";

  if (t.endsWith("es") && t.length > 4 && !t.endsWith("les") && !t.endsWith("nes")) {
    const stem = t.slice(0, -2);
    if (stem.length >= 3) return stem;
  }
  if (t.endsWith("s") && t.length > 3 && !t.endsWith("ss") && !t.endsWith("us")) {
    const stem = t.slice(0, -1);
    if (stem.length >= 3) return stem;
  }
  return t;
}

export function normalizeCommercialTag(tag: string | null | undefined): string {
  return canonicalTagKey(tag);
}
