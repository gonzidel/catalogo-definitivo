import type { GroupedProduct } from "@/types/catalog";
import { expandCombinedSizes } from "@/lib/utils/size-filter-catalog";
import {
  expandRopaSelectionToKeys,
  productTalleMatchesRopaKeys,
  ROPA_PAIR_LABELS,
} from "@/lib/utils/size-filter-ropa";
import { normalizeSize } from "@/lib/utils/size-normalizer";

// ─── Normalization (same as original: NFD + lowercase + no accents) ───────────

export function normalizeText(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // strip accent marks
}

// ─── Levenshtein distance ─────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
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

// ─── Token matching with tolerance (same as original) ────────────────────────

/**
 * Does a query token match a haystack token?
 * - Exact or prefix: always match
 * - Levenshtein dist 1 if either token >= 5 chars
 * - Levenshtein dist 2 if either token >= 8 chars
 */
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

// ─── Haystack builder ────────────────────────────────────────────────────────

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
  const normedArticulo  = normalizeText(product.Articulo ?? "");
  const normedDesc      = normalizeText(product.Descripcion ?? "");
  const normedFiltro1   = normalizeText(product.Filtro1 ?? "");
  const normedFiltro2   = normalizeText(product.Filtro2 ?? "");
  const normedFiltro3   = normalizeText(product.Filtro3 ?? "");
  const normedCategoria = normalizeText(product.Categoria ?? "");
  const colors          = (product.DetalleColor ?? []).map((d) => normalizeText(d.color));
  const tags            = (product.CommercialTags ?? []).map(normalizeText);

  const haystack = [
    normedArticulo, normedDesc, normedFiltro1, normedFiltro2, normedFiltro3,
    normedCategoria, ...colors, ...tags,
  ].filter(Boolean).join(" ");

  return {
    product,
    haystack,
    haystackTokens: haystack.split(/\s+/).filter(Boolean),
    normedArticulo, normedDesc, normedFiltro1, normedFiltro2, normedFiltro3, normedCategoria,
  };
}

// ─── Scoring (aligned with original's computeRelevanceScore) ─────────────────

function computeScore(entry: SearchEntry, queryTokens: string[]): number {
  const { haystack, haystackTokens, normedArticulo, normedDesc,
          normedFiltro1, normedFiltro2, normedFiltro3, normedCategoria } = entry;

  // ALL query tokens must match something (AND logic)
  const allMatch = queryTokens.every((qt) =>
    haystackTokens.some((ht) => tokenMatches(ht, qt))
  );
  if (!allMatch) return 0;

  let score = 0;
  const fullQuery = queryTokens.join(" ");

  // Nombre/Articulo — highest priority
  if (normedArticulo === fullQuery)              score += 1000;
  else if (normedArticulo.includes(fullQuery))   score += 200;
  else if (queryTokens.every((qt) => normedArticulo.includes(qt))) score += 150;

  // Descripcion
  if (normedDesc.includes(fullQuery))            score += 100;

  // Filtros
  if (normedFiltro1.includes(fullQuery) || normedFiltro2.includes(fullQuery)) score += 80;
  if (normedFiltro3.includes(fullQuery))         score += 60;

  // Categoría
  if (normedCategoria.includes(fullQuery))       score += 40;

  // Haystack fallback
  if (haystack.includes(fullQuery))             score += 20;

  // Token-level prefix bonus
  for (const qt of queryTokens) {
    if (haystackTokens.some((ht) => ht.startsWith(qt))) score += 15;
  }

  return score;
}

// ─── Main search function ─────────────────────────────────────────────────────

export function searchProducts(
  products: GroupedProduct[],
  term: string
): GroupedProduct[] {
  if (!term || term.trim().length < 2) return products;

  const queryTokens = normalizeText(term.trim())
    .split(/\s+/)
    .filter((t) => t.length >= 2);

  if (queryTokens.length === 0) return products;

  const entries = products.map(buildHaystack);

  const scored = entries
    .map((entry) => ({ entry, score: computeScore(entry, queryTokens) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.map(({ entry }) => entry.product);
}

// ─── Autocomplete suggestions ─────────────────────────────────────────────────

export interface SearchSuggestion {
  type: "product" | "tag" | "categoria";
  label: string;
  query: string;
}

export function buildSuggestions(
  products: GroupedProduct[],
  term: string,
  limit = 8
): SearchSuggestion[] {
  if (!term || term.trim().length < 2) return [];

  const norm = normalizeText(term.trim());
  const queryTokens = norm.split(/\s+/).filter((t) => t.length >= 2);
  const seen = new Set<string>();
  const suggestions: SearchSuggestion[] = [];

  // Helper: score a label for relevance
  function scoreLabel(label: string): number {
    const n = normalizeText(label);
    if (n === norm) return 100;
    if (n.startsWith(norm)) return 80;
    if (n.includes(norm)) return 60;
    if (queryTokens.every((qt) => n.split(/\s+/).some((ht) => tokenMatches(ht, qt)))) return 40;
    return 0;
  }

  // Collect candidates from all products
  const candidates: Array<{ s: SearchSuggestion; score: number }> = [];

  for (const p of products) {
    // Product name
    const artScore = scoreLabel(p.Articulo ?? "");
    if (artScore > 0 && !seen.has(p.Articulo)) {
      seen.add(p.Articulo);
      candidates.push({ s: { type: "product", label: p.Articulo, query: p.Articulo }, score: artScore + 50 });
    }

    // Tags (Filtro1/2/3)
    for (const tag of [p.Filtro1, p.Filtro2, p.Filtro3].filter(Boolean) as string[]) {
      if (seen.has(tag)) continue;
      const ts = scoreLabel(tag);
      if (ts > 0) {
        seen.add(tag);
        candidates.push({ s: { type: "tag", label: tag, query: tag }, score: ts });
      }
    }

    // Categoría
    if (p.Categoria && !seen.has(`cat:${p.Categoria}`)) {
      const cs = scoreLabel(p.Categoria);
      if (cs > 0) {
        seen.add(`cat:${p.Categoria}`);
        candidates.push({ s: { type: "categoria", label: p.Categoria, query: p.Categoria }, score: cs - 10 });
      }
    }
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
