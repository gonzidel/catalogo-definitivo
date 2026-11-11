/**
 * Detecta intención de talle en la query.
 * `38`, `talle 38`, `t38`, `numero 38` → filtro de talle (no SKU prefix).
 */
import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";

export interface SizeIntent {
  /** Tokens de la query que NO son talles (para el AND textual). */
  contentTokens: string[];
  /** Talles detectados (normalizados como string, p.ej. "38"). */
  sizes: string[];
  /** true si la query era solo talles (sin contenido). */
  sizeOnly: boolean;
}

const SIZE_PREFIXES = new Set(["talle", "talles", "numero", "numeros", "nro", "nr"]);

function looksLikeSizeToken(token: string): string | null {
  if (!token) return null;
  // t38 / n38
  const pref = token.match(/^[tn](\d{1,2}(?:\/\d{1,2})?)$/i);
  if (pref) return pref[1];
  // 35/36, 38, 40
  if (/^\d{1,2}(?:\/\d{1,2})?$/.test(token)) return token;
  // XS S M L XL 2XL Unico
  if (/^(xs|s|m|l|xl|2xl|3xl|unico)$/i.test(token)) return token.toUpperCase() === "UNICO" ? "Unico" : token.toUpperCase();
  return null;
}

export function extractSizeIntent(rawQuery: string): SizeIntent {
  const raw = String(rawQuery ?? "");
  const normalized = normalizeText(raw);
  const tokens = tokenizeNormalized(normalized);
  // PANT-2 / ART_10: el guión une letras y dígitos → SKU, no talle.
  if (/[A-Za-z][-_/]+\d|\d[-_/]+[A-Za-z]/.test(raw)) {
    return {
      contentTokens: tokens,
      sizes: [],
      sizeOnly: false,
    };
  }
  const sizes: string[] = [];
  const content: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (SIZE_PREFIXES.has(t)) {
      const next = tokens[i + 1];
      const size = next ? looksLikeSizeToken(next) : null;
      if (size) {
        sizes.push(size);
        i += 1;
        continue;
      }
      // "talle" solo → no es contenido útil
      continue;
    }
    const size = looksLikeSizeToken(t);
    if (size) {
      sizes.push(size);
      continue;
    }
    content.push(t);
  }

  return {
    contentTokens: content,
    sizes: unique(sizes),
    sizeOnly: content.length === 0 && sizes.length > 0,
  };
}

/**
 * SKU prefix de números cortos (1–2 dígitos) causa falsos amigos (38 → 380).
 * Solo permitir prefix SKU si el query compacto tiene ≥3 caracteres o no es puramente numérico corto.
 */
export function allowSkuPrefix(queryToken: string): boolean {
  const t = String(queryToken ?? "").replace(/\s+/g, "");
  if (!t) return false;
  if (/^\d{1,2}$/.test(t)) return false;
  return true;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function productHasAnySize(
  product: { DetalleColor?: Array<{ talles?: string[] }> },
  sizes: string[]
): boolean {
  if (!sizes.length) return true;
  const wanted = new Set(sizes.map((s) => s.toLowerCase()));
  for (const dc of product.DetalleColor ?? []) {
    for (const t of dc.talles ?? []) {
      const parts = String(t)
        .split(/[,;/]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      if (parts.some((p) => wanted.has(p))) return true;
    }
  }
  return false;
}
