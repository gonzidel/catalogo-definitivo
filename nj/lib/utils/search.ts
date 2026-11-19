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
import {
  normalizeProductFields,
  rankSearchProducts,
  scoreProductSearch,
  splitTagField,
} from "@/lib/search/search-score";
import { cascadeSearch, type CascadeResult } from "@/lib/search/cascade";
import {
  extractSizeIntent,
  productHasAnySize,
} from "@/lib/search/size-intent";
import { buildSearchIndex } from "@/lib/search/search-index";
import {
  EMPTY_SEARCH_DICTIONARY,
  type SearchDictionary,
} from "@/lib/search/types";
import { productIsPurchasable } from "@/lib/stock/catalog-availability";

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
export type { CascadeResult, CascadeMode } from "@/lib/search/cascade";

function rankForCascade(
  products: GroupedProduct[],
  query: string,
  dict: SearchDictionary,
  profileTermsByArticulo?: Map<string, string[]>
) {
  const resolved = resolveSearchQuery(query, dict);
  if (resolved.resolvedTokens.filter((t) => t.length >= 2).length === 0) {
    return [];
  }
  return rankSearchProducts(products, resolved, dict, profileTermsByArticulo);
}

// ─── Main search function ─────────────────────────────────────────────────────

export function searchProductsDetailed(
  products: GroupedProduct[],
  term: string,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY,
  profileTermsByArticulo?: Map<string, string[]>
): CascadeResult {
  if (!term || term.trim().length < 2) {
    return {
      hits: [],
      mode: "empty",
      dropped: [],
      suggestions: [],
      effectiveQuery: term,
    };
  }

  const sizeIntent = extractSizeIntent(term);
  let pool = products;
  if (sizeIntent.sizes.length > 0) {
    pool = products.filter((p) => productHasAnySize(p, sizeIntent.sizes));
  }

  // Solo talle: devolver pool filtrado por talle (orden por recencia via rank vacío → slice)
  if (sizeIntent.sizeOnly) {
    const hits = pool.map((product) => ({
      product,
      breakdown: {
        score: 0,
        matches: [],
        bonuses: [],
        tieStock: product.hasAnyStock === true ? 1 : 0,
        tieRecency: 0,
      },
    }));
    hits.sort((a, b) => b.breakdown.tieStock - a.breakdown.tieStock);
    return {
      hits,
      mode: hits.length ? "exact" : "empty",
      dropped: [],
      suggestions: [],
      effectiveQuery: term,
    };
  }

  const queryForText =
    sizeIntent.contentTokens.length > 0
      ? sizeIntent.contentTokens.join(" ")
      : term;

  // Warm index (autocomplete / futuras fases)
  buildSearchIndex(pool);

  return cascadeSearch(pool, queryForText, dict, (prods, q, d) =>
    rankForCascade(prods, q, d, profileTermsByArticulo)
  );
}

export function searchProducts(
  products: GroupedProduct[],
  term: string,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY,
  profileTermsByArticulo?: Map<string, string[]>
): GroupedProduct[] {
  if (!term || term.trim().length < 2) return products;
  const detailed = searchProductsDetailed(products, term, dict, profileTermsByArticulo);
  if (detailed.hits.length === 0 && detailed.mode === "empty") {
    // Compat: queries que no resuelven tokens (muy cortas post-stopword) → catálogo
    const resolved = resolveSearchQuery(term, dict);
    if (resolved.resolvedTokens.filter((t) => t.length >= 2).length === 0) {
      return products;
    }
  }
  return detailed.hits.map((h) => h.product);
}

// ─── Autocomplete suggestions ─────────────────────────────────────────────────

export interface SearchSuggestion {
  type: "product" | "tag" | "categoria" | "combo";
  label: string;
  query: string;
  /**
   * Solo navegación directa:
   * - product → PDP `/producto/{Articulo}`
   * - categoria → `/{slug}` si existe en CATEGORIAS_MAP
   * Tags y categorías sin ruta NUNCA llevan href: el SearchBar hace `?q=`.
   */
  href?: string;
  /** Miniatura / precio para autocomplete premium (opcionales). */
  thumb?: string | null;
  price?: string | number | null;
  count?: number;
  subtitle?: string;
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

  const index = buildSearchIndex(products);

  for (const p of products) {
    const art = (p.Articulo ?? "").trim();
    const desc = (p.Descripcion ?? "").trim();
    const displayLabel = desc || art;
    const artScore = Math.max(
      scoreLabel(art),
      scoreLabel(displayLabel),
      scoreNormalized(normalizeText(art)),
      scoreNormalized(normalizeText(desc))
    );
    if (art && artScore > 0 && !seen.has(`art:${art.toLowerCase()}`)) {
      seen.add(`art:${art.toLowerCase()}`);
      const thumb =
        typeof p.VariantePrincipal === "string"
          ? p.VariantePrincipal
          : p.VariantePrincipal && typeof p.VariantePrincipal === "object"
            ? p.VariantePrincipal.secure_url || p.VariantePrincipal.url || null
            : null;
      candidates.push({
        s: {
          type: "product",
          label: displayLabel,
          query: art,
          href: `/producto/${encodeURIComponent(art)}`,
          thumb,
          price: p.Precio,
          subtitle: desc && art !== desc ? art : undefined,
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
        count: index.typeCounts.get(kw.displayLabel),
      },
      score: 75,
    });
  }

  // Combinaciones frecuentes tipo+color (sandalia negra)
  for (const [combo, count] of index.comboCounts) {
    if (count < 2) continue;
    const cs = scoreNormalized(combo);
    if (cs <= 0) continue;
    const key = `combo:${combo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      s: {
        type: "combo",
        label: combo,
        query: combo,
        count,
      },
      score: cs + Math.min(count, 20),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  // Tags y categorías que buscan solo entran si confirmarlas encuentra
  // al menos un producto comprable. Un tag vacío no ocupa un cupo.
  const purchasable = products.flatMap((product) => {
    if (!productIsPurchasable(product)) return [];
    return [{ product, fields: normalizeProductFields(product) }];
  });
  const hitByQuery = new Map<string, boolean>();

  function hasPurchasableHit(query: string): boolean {
    const key = normalizeText(query);
    const cached = hitByQuery.get(key);
    if (cached !== undefined) return cached;
    const resolved = resolveSearchQuery(query, dict);
    const ok =
      resolved.resolvedTokens.some((token) => token.length >= 2) &&
      purchasable.some(({ product, fields }) =>
        scoreProductSearch(product, resolved, fields, dict)
      );
    hitByQuery.set(key, ok);
    return ok;
  }

  function keepSuggestion(s: SearchSuggestion): boolean {
    if (s.type === "product") return true;
    if (s.type === "categoria" && s.href) return true;
    if (s.type === "tag" || s.type === "categoria" || s.type === "combo") {
      return hasPurchasableHit(s.query);
    }
    const _exhaustive: never = s.type;
    return _exhaustive;
  }

  for (const { s } of candidates) {
    if (suggestions.length >= limit) break;
    if (!keepSuggestion(s)) continue;
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
