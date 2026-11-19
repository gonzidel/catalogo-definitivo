/**
 * Búsqueda escalonada:
 * 1) todas las palabras (AND)
 * 2) descarta tokens desconocidos del vocabulario del catálogo
 * 3) sugiere tipo/categoría más cercano
 */
import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";
import { stemEsToken } from "@/lib/search/stem-es";
import type { GroupedProduct } from "@/types/catalog";
import type { SearchDictionary } from "@/lib/search/types";
import type { ScoredSearchHit } from "@/lib/search/search-score";

export type CascadeMode = "exact" | "relaxed" | "suggest" | "empty";

export interface CascadeResult {
  hits: ScoredSearchHit[];
  mode: CascadeMode;
  /** Tokens descartados en modo relaxed. */
  dropped: string[];
  /** Sugerencias textuales (tipo / categoría) cuando no hay hits. */
  suggestions: string[];
  /** Query efectiva usada para rankear. */
  effectiveQuery: string;
}

export type RankFn = (
  products: GroupedProduct[],
  query: string,
  dict: SearchDictionary
) => ScoredSearchHit[];

/**
 * Vocabulario del catálogo: tokens de tags + diccionario + stems.
 * Usado para saber qué palabra "no existe" y se puede dropear.
 */
export function buildCatalogVocabulary(
  products: GroupedProduct[],
  dict: SearchDictionary
): Set<string> {
  const vocab = new Set<string>();
  for (const [alias] of dict.byAlias) {
    for (const t of tokenizeNormalized(alias)) {
      vocab.add(t);
      vocab.add(stemEsToken(t));
    }
  }
  for (const p of products) {
    for (const field of [p.Filtro1, p.Filtro2, p.Filtro3, p.Categoria, p.Descripcion]) {
      const n = normalizeText(field ?? "");
      for (const t of tokenizeNormalized(n)) {
        if (t.length < 2) continue;
        vocab.add(t);
        vocab.add(stemEsToken(t));
      }
    }
  }
  return vocab;
}

export function cascadeSearch(
  products: GroupedProduct[],
  rawQuery: string,
  dict: SearchDictionary,
  rank: RankFn,
  vocab?: Set<string>
): CascadeResult {
  const q = rawQuery.trim();
  if (q.length < 2) {
    return { hits: [], mode: "empty", dropped: [], suggestions: [], effectiveQuery: q };
  }

  const level1 = rank(products, q, dict);
  if (level1.length > 0) {
    return {
      hits: level1,
      mode: "exact",
      dropped: [],
      suggestions: [],
      effectiveQuery: q,
    };
  }

  const catalogVocab = vocab ?? buildCatalogVocabulary(products, dict);
  const tokens = tokenizeNormalized(normalizeText(q));
  const known: string[] = [];
  const unknown: string[] = [];
  for (const t of tokens) {
    if (t.length < 2) continue;
    const stem = stemEsToken(t);
    if (catalogVocab.has(t) || catalogVocab.has(stem) || dict.byAlias.has(t) || dict.byAlias.has(stem)) {
      known.push(t);
    } else {
      unknown.push(t);
    }
  }

  if (known.length > 0 && unknown.length > 0) {
    const relaxedQ = known.join(" ");
    const level2 = rank(products, relaxedQ, dict);
    if (level2.length > 0) {
      return {
        hits: level2,
        mode: "relaxed",
        dropped: unknown,
        suggestions: [],
        effectiveQuery: relaxedQ,
      };
    }
  }

  const suggestions = suggestFromVocab(tokens, catalogVocab, dict, products);
  return {
    hits: [],
    mode: suggestions.length ? "suggest" : "empty",
    dropped: unknown,
    suggestions,
    effectiveQuery: q,
  };
}

function suggestFromVocab(
  tokens: string[],
  vocab: Set<string>,
  dict: SearchDictionary,
  products: GroupedProduct[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const t of tokens) {
    if (t.length < 3) continue;
    // keywords del diccionario por prefix
    for (const [canonical, kw] of dict.byCanonical) {
      if (canonical.startsWith(t) || stemEsToken(canonical) === stemEsToken(t)) {
        if (!seen.has(kw.displayLabel)) {
          seen.add(kw.displayLabel);
          out.push(kw.displayLabel);
        }
      }
    }
    // tipos frecuentes del catálogo (Filtro1)
    const counts = new Map<string, number>();
    for (const p of products) {
      const f1 = (p.Filtro1 ?? "").trim();
      if (!f1) continue;
      const n = normalizeText(f1);
      if (n.startsWith(t) || stemEsToken(n) === stemEsToken(t) || n.includes(t)) {
        counts.set(f1, (counts.get(f1) ?? 0) + 1);
      }
    }
    for (const [label] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      if (!seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
  }

  // Si no hay nada, top tipos del catálogo
  if (out.length === 0) {
    const counts = new Map<string, number>();
    for (const p of products) {
      const f1 = (p.Filtro1 ?? "").trim();
      if (f1) counts.set(f1, (counts.get(f1) ?? 0) + 1);
    }
    for (const [label] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      out.push(label);
    }
  }

  return out.slice(0, 6);
}
