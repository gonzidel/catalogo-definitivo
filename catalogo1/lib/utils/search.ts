import type { GroupedProduct, ColorDetail } from "@/types/catalog";
import { categoriaToNavigableSlug } from "@/lib/utils/catalog";
import { expandCombinedSizes } from "@/lib/utils/size-filter-catalog";
import {
  expandRopaSelectionToKeys,
  productTalleMatchesRopaKeys,
  ROPA_PAIR_LABELS,
} from "@/lib/utils/size-filter-ropa";
import { normalizeSize } from "@/lib/utils/size-normalizer";
import { getCanonicalLabel } from "@/lib/search/dictionary";
import { normalizeText } from "@/lib/search/normalize";
import { resolveSearchQuery } from "@/lib/search/search-resolver";
import { tokenMatches } from "@/lib/search/match-quality";
import { rankSearchProducts, splitTagField } from "@/lib/search/search-score";
import {
  EMPTY_SEARCH_DICTIONARY,
  type SearchDictionary,
} from "@/lib/search/types";

export { normalizeText } from "@/lib/search/normalize";
export { classifyTokenMatch, tokenMatches } from "@/lib/search/match-quality";
export {
  scoreProductSearch,
  rankSearchProducts,
} from "@/lib/search/search-score";
export type {
  SearchScoreBreakdown,
  TokenMatchExplain,
  SearchBonusExplain,
} from "@/lib/search/search-score";

// ─── Main search function ─────────────────────────────────────────────────────

export function searchProducts(
  products: GroupedProduct[],
  term: string,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): GroupedProduct[] {
  if (!term || term.trim().length < 2) return products;

  const resolved = resolveSearchQuery(term, dict);
  if (resolved.resolvedTokens.filter((t) => t.length >= 2).length === 0) {
    return products;
  }

  return rankSearchProducts(products, resolved, dict).map((hit) => hit.product);
}

// ─── Autocomplete suggestions ─────────────────────────────────────────────────

export interface SearchSuggestion {
  type: "product" | "tag" | "categoria";
  label: string;
  query: string;
  /**
   * Solo navegación directa:
   * - product → PDP `/producto/{Articulo}`
   * - categoria → `/{slug}` si existe en CATEGORIAS_MAP
   * Tags y categorías sin ruta NUNCA llevan href: el SearchBar hace `?q=`.
   */
  href?: string;
}

export function buildSuggestions(
  products: GroupedProduct[],
  term: string,
  limit = 8,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): SearchSuggestion[] {
  if (!term || term.trim().length < 2) return [];

  const resolved = resolveSearchQuery(term, dict);
  const rawNorm = resolved.normalizedQuery;
  const resolvedNorm = resolved.resolvedQuery;
  const queryTokens = [
    ...resolved.originalTokens,
    ...resolved.resolvedTokens,
  ].filter((t) => t.length >= 2);
  const seen = new Set<string>();
  const suggestions: SearchSuggestion[] = [];

  function scoreNormalized(n: string): number {
    if (!n) return 0;
    if (n === rawNorm || n === resolvedNorm) return 100;
    if (n.startsWith(rawNorm) || (resolvedNorm && n.startsWith(resolvedNorm))) return 80;
    if (n.includes(rawNorm) || (resolvedNorm && n.includes(resolvedNorm))) return 60;
    if (
      queryTokens.length > 0 &&
      queryTokens.every((qt) => n.split(/\s+/).some((ht) => tokenMatches(ht, qt)))
    ) {
      return 40;
    }
    return 0;
  }

  function scoreLabel(label: string): number {
    return scoreNormalized(normalizeText(label));
  }

  function resolveVocab(label: string): { canonical: string; display: string } {
    const n = normalizeText(label);
    const alias = dict.byAlias.get(n);
    const canonical = alias?.canonical ?? n;
    return {
      canonical,
      display: getCanonicalLabel(dict, canonical, label),
    };
  }

  const candidates: Array<{ s: SearchSuggestion; score: number }> = [];

  for (const p of products) {
    const art = (p.Articulo ?? "").trim();
    const artScore = Math.max(scoreLabel(art), scoreNormalized(normalizeText(art)));
    if (art && artScore > 0 && !seen.has(`art:${art.toLowerCase()}`)) {
      seen.add(`art:${art.toLowerCase()}`);
      candidates.push({
        s: {
          type: "product",
          label: art,
          query: art,
          href: `/producto/${encodeURIComponent(art)}`,
        },
        score: artScore + 50,
      });
    }

    for (const field of [p.Filtro1, p.Filtro2, p.Filtro3].filter(Boolean) as string[]) {
      for (const tag of splitTagField(field)) {
        const vocab = resolveVocab(tag);
        const key = `tag:${vocab.canonical}`;
        if (seen.has(key)) continue;
        const ts = Math.max(
          scoreLabel(tag),
          scoreLabel(vocab.display),
          scoreNormalized(vocab.canonical)
        );
        if (ts > 0) {
          seen.add(key);
          candidates.push({
            s: {
              type: "tag",
              label: vocab.display,
              query: vocab.display,
            },
            score: ts,
          });
        }
      }
    }

    const cat = (p.Categoria ?? "").trim();
    if (cat && !seen.has(`cat:${cat.toLowerCase()}`)) {
      const cs = scoreLabel(cat);
      if (cs > 0) {
        seen.add(`cat:${cat.toLowerCase()}`);
        const catSlug = categoriaToNavigableSlug(cat);
        candidates.push({
          s: {
            type: "categoria",
            label: cat,
            query: cat,
            ...(catSlug ? { href: `/${catSlug}` } : {}),
          },
          score: cs - 10,
        });
      }
    }
  }

  for (const token of resolved.resolvedTokens) {
    const kw = dict.byCanonical.get(token);
    if (!kw) continue;
    const key = `tag:${kw.canonical}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      s: {
        type: "tag",
        label: kw.displayLabel,
        query: kw.displayLabel,
      },
      score: 75,
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  for (const { s } of candidates) {
    if (suggestions.length >= limit) break;
    suggestions.push(s);
  }

  return suggestions;
}

// ─── Size filter ─────────────────────────────────────────────────────────────

function talleMatchesSelection(
  talle: string,
  selected: string[],
  categoria: string
): boolean {
  const cat = categoria.trim().toLowerCase();
  const parts = expandCombinedSizes([talle]);

  if (cat === "ropa") {
    const keys = expandRopaSelectionToKeys(selected);
    return parts.some((p) => productTalleMatchesRopaKeys(p, keys));
  }

  const selectedNorm = new Set(
    selected.flatMap((s) => {
      const t = String(s).trim();
      if (ROPA_PAIR_LABELS.has(t)) return expandCombinedSizes([t]);
      return [normalizeSize(t) || t.trim().toUpperCase()];
    })
  );

  return parts.some((p) => {
    const n = normalizeSize(p) || p.trim().toUpperCase();
    return selectedNorm.has(n);
  });
}

export function colorDetailMatchesSizes(
  dc: ColorDetail,
  sizes: string[],
  categoria = "all"
): boolean {
  if (!sizes.length) return false;
  return (dc.talles ?? []).some((t) => talleMatchesSelection(t, sizes, categoria));
}

export function filterBySizes(
  products: GroupedProduct[],
  sizes: string[],
  categoria = "all"
): GroupedProduct[] {
  if (!sizes || sizes.length === 0) return products;
  return products.filter((p) =>
    (p.DetalleColor ?? []).some((dc) =>
      dc.talles.some((t) => talleMatchesSelection(t, sizes, categoria))
    )
  );
}
