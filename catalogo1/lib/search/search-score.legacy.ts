/**
 * Scoring de Fase 2 (pre-ranking). Solo para comparar antes/después.
 * No usar en runtime.
 */
import type { GroupedProduct } from "@/types/catalog";
import { normalizeText } from "@/lib/search/normalize";
import { resolveSearchQuery } from "@/lib/search/search-resolver";
import { EMPTY_SEARCH_DICTIONARY, type SearchDictionary } from "@/lib/search/types";

function levenshtein(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[la][lb];
}

function tokenMatches(haystackToken: string, queryToken: string): boolean {
  if (haystackToken === queryToken) return true;
  if (haystackToken.startsWith(queryToken)) return true;
  if (haystackToken.includes(queryToken)) return true;
  const len = Math.max(haystackToken.length, queryToken.length);
  const dist = levenshtein(haystackToken, queryToken);
  if (dist <= 1 && len >= 5) return true;
  if (dist <= 2 && len >= 8) return true;
  return false;
}

function splitTagField(raw: string): string[] {
  return String(raw ?? "")
    .split(/[,;|/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

interface SearchEntry {
  product: GroupedProduct;
  haystack: string;
  haystackTokens: string[];
  normedArticulo: string;
  normedDesc: string;
  normedFiltro1: string;
  normedFiltro2: string;
  normedFiltro3: string;
  normedCategoria: string;
}

function buildHaystack(product: GroupedProduct): SearchEntry {
  const normedArticulo = normalizeText(product.Articulo ?? "");
  const normedDesc = normalizeText(product.Descripcion ?? "");
  const normedFiltro1 = normalizeText(product.Filtro1 ?? "");
  const normedFiltro2 = normalizeText(product.Filtro2 ?? "");
  const normedFiltro3 = normalizeText(product.Filtro3 ?? "");
  const normedCategoria = normalizeText(product.Categoria ?? "");
  const colors = (product.DetalleColor ?? []).map((d) => normalizeText(d.color));
  const tags = (product.CommercialTags ?? []).map(normalizeText);
  const details = splitTagField(product.DetallesSimilitud ?? "").map(normalizeText);
  const filtroTokens = [product.Filtro1, product.Filtro2, product.Filtro3]
    .flatMap((f) => splitTagField(f ?? ""))
    .map(normalizeText);

  const haystack = [
    normedArticulo,
    normedDesc,
    normedFiltro1,
    normedFiltro2,
    normedFiltro3,
    normedCategoria,
    ...colors,
    ...tags,
    ...filtroTokens,
    ...details,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    product,
    haystack,
    haystackTokens: haystack.split(/[\s,;|/]+/).filter(Boolean),
    normedArticulo,
    normedDesc,
    normedFiltro1,
    normedFiltro2,
    normedFiltro3,
    normedCategoria,
  };
}

function computeScore(entry: SearchEntry, queryTokens: string[]): number {
  const {
    haystack,
    haystackTokens,
    normedArticulo,
    normedDesc,
    normedFiltro1,
    normedFiltro2,
    normedFiltro3,
    normedCategoria,
  } = entry;

  const allMatch = queryTokens.every((qt) =>
    haystackTokens.some((ht) => tokenMatches(ht, qt))
  );
  if (!allMatch) return 0;

  let score = 0;
  const fullQuery = queryTokens.join(" ");

  if (normedArticulo === fullQuery) score += 1000;
  else if (normedArticulo.includes(fullQuery)) score += 200;
  else if (queryTokens.every((qt) => normedArticulo.includes(qt))) score += 150;

  if (normedDesc.includes(fullQuery)) score += 100;

  if (normedFiltro1.includes(fullQuery) || normedFiltro2.includes(fullQuery)) {
    score += 80;
  }
  if (normedFiltro3.includes(fullQuery)) score += 60;
  if (normedCategoria.includes(fullQuery)) score += 40;
  if (haystack.includes(fullQuery)) score += 20;

  for (const qt of queryTokens) {
    if (haystackTokens.some((ht) => ht.startsWith(qt))) score += 15;
  }

  return score;
}

export function searchProductsLegacy(
  products: GroupedProduct[],
  term: string,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): GroupedProduct[] {
  if (!term || term.trim().length < 2) return products;

  const resolved = resolveSearchQuery(term, dict);
  const queryTokens = resolved.resolvedTokens.filter((t) => t.length >= 2);
  if (queryTokens.length === 0) return products;

  return products
    .map(buildHaystack)
    .map((entry) => ({ entry, score: computeScore(entry, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry.product);
}
