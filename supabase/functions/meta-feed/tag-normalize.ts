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

/** Raíz FYL (Calzado/Ropa/Otros): evita que "Otros" → "otro" por singularización. */
export function normalizeRootCategoryKey(categoryRaw: string | null | undefined): string {
  const basic = normalizeTagBasic(categoryRaw);
  if (basic === "calzado" || basic === "calzados") return "calzado";
  if (basic === "ropa") return "ropa";
  if (basic === "otros" || basic === "otro") return "otros";
  return canonicalTagKey(categoryRaw);
}

const TAG_STOPWORDS = new Set([
  "el", "la", "los", "las", "de", "del", "para", "en", "y", "o",
  "con", "por", "un", "una", "al", "es", "son",
]);

const COMMERCIAL_TAG_SPLIT = /[,;|]+/;

/** Divide DetallesSimilitud / Filtro3 en tags individuales. */
export function splitCommercialTags(
  raw: string | string[] | null | undefined,
  { silent = true }: { silent?: boolean } = {},
): { tags: string[] } {
  const original = Array.isArray(raw)
    ? raw.map((t) => String(t ?? "").trim()).filter(Boolean).join(", ")
    : String(raw ?? "").trim();

  if (!original) return { tags: [] };

  const seen = new Set<string>();
  const tags: string[] = [];

  for (let piece of original.split(COMMERCIAL_TAG_SPLIT)) {
    piece = normalizeTagDisplay(piece);
    if (!piece || piece.length < 2) continue;
    const basic = normalizeTagBasic(piece);
    if (TAG_STOPWORDS.has(basic)) continue;
    const key = normalizeCommercialTag(piece);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tags.push(piece);
  }

  if (!silent && tags.length === 0 && original) {
    // noop — evitar log ruidoso en Edge
  }

  return { tags };
}
