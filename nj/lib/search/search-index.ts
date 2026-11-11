/**
 * Índice de búsqueda precalculado por set de artículos.
 * Alimenta ranking y autocompletado sin depender de window.__fylProducts.
 */
import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";
import { stemEsToken, stemVariants } from "@/lib/search/stem-es";
import { colorToFamilies } from "@/lib/search/color-families";
import { compactSku, splitTagField } from "@/lib/search/search-score";
import type { GroupedProduct } from "@/types/catalog";
import type { SearchDictionary } from "@/lib/search/types";
import type { SearchProfilePublic } from "@/lib/search/search-profiles-types";

export interface IndexedProduct {
  product: GroupedProduct;
  articulo: string[];
  articuloCompact: string;
  nombre: string[];
  nombreText: string;
  descripcion: string[];
  filtro1: string[];
  filtro2: string[];
  filtro3: string[];
  colorFamilies: string[];
  categoria: string[];
  details: string[];
  /** Términos del perfil IA aprobado (peso intermedio). */
  profileTerms: string[];
  sizes: string[];
  recency: number;
  hasStock: boolean;
  thumb: string | null;
}

export interface SearchIndex {
  key: string;
  items: IndexedProduct[];
  /** token → conteo de productos (para sugerencias). */
  tokenCounts: Map<string, number>;
  /** label de tipo (Filtro1) → conteo. */
  typeCounts: Map<string, number>;
  /** combinaciones frecuentes "tipo color". */
  comboCounts: Map<string, number>;
}

const cache = new Map<string, SearchIndex>();

function articulosKey(products: GroupedProduct[]): string {
  return products.map((p) => p.Articulo).join("|");
}

function tokensOf(raw: string): string[] {
  return tokenizeNormalized(normalizeText(raw)).filter((t) => t.length >= 2);
}

function tokensFromTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of splitTagField(raw)) {
    const norm = normalizeText(part);
    if (norm.length >= 2) out.push(norm);
    for (const t of tokenizeNormalized(norm)) {
      if (t.length >= 2) out.push(t);
    }
  }
  return expandStems(out);
}

function expandStems(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    for (const v of stemVariants(t)) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function parseRecency(publicacion?: string, ingreso?: string): number {
  const raw = String(publicacion || ingreso || "").trim();
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function firstThumb(p: GroupedProduct): string | null {
  const img = p.VariantePrincipal ?? p.DetalleColor?.[0]?.images?.[0] ?? null;
  if (!img) return null;
  if (typeof img === "string") return img;
  return img.secure_url || img.url || null;
}

export function buildSearchIndex(
  products: GroupedProduct[],
  profiles?: Map<string, SearchProfilePublic> | null
): SearchIndex {
  const key = articulosKey(products);
  const cached = cache.get(key);
  if (cached && !profiles) return cached;

  const items: IndexedProduct[] = [];
  const tokenCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  const comboCounts = new Map<string, number>();

  const bump = (map: Map<string, number>, k: string) => {
    if (!k) return;
    map.set(k, (map.get(k) ?? 0) + 1);
  };

  for (const product of products) {
    const articuloNorm = normalizeText(product.Articulo ?? "");
    const articuloCompact = compactSku(product.Articulo ?? "");
    const descNorm = normalizeText(product.Descripcion ?? "");
    const descTokens = tokenizeNormalized(descNorm).filter((t) => t.length >= 2);
    const treatAsTitle = descTokens.length <= 6;
    const nombre = expandStems(treatAsTitle ? descTokens : descTokens.slice(0, 3));
    const descripcion = expandStems(treatAsTitle ? [] : descTokens.slice(3));

    const colorFamilies = Array.from(
      new Set(
        (product.DetalleColor ?? [])
          .flatMap((d) => colorToFamilies(d.color ?? ""))
          .filter(Boolean)
      )
    );

    const sizes = Array.from(
      new Set(
        (product.DetalleColor ?? []).flatMap((d) =>
          (d.talles ?? []).flatMap((t) =>
            String(t)
              .split(/[,;/]+/)
              .map((x) => x.trim())
              .filter(Boolean)
          )
        )
      )
    );

    const profile = profiles?.get(product.Articulo);
    const profileTerms = expandStems(
      (profile?.search_terms ?? [])
        .concat(profile?.style_terms ?? [])
        .concat(profile?.occasion_terms ?? [])
        .concat(profile?.color_families ?? [])
        .map((t) => normalizeText(t))
        .filter((t) => t.length >= 2)
    );

    const filtro1 = tokensFromTags(product.Filtro1 ?? "");
    const indexed: IndexedProduct = {
      product,
      articulo: [articuloNorm, articuloCompact].filter(Boolean),
      articuloCompact,
      nombre,
      nombreText: descNorm,
      descripcion,
      filtro1,
      filtro2: tokensFromTags(product.Filtro2 ?? ""),
      filtro3: tokensFromTags(product.Filtro3 ?? ""),
      colorFamilies,
      categoria: expandStems(tokensOf(product.Categoria ?? "")),
      details: tokensFromTags(product.DetallesSimilitud ?? ""),
      profileTerms,
      sizes,
      recency: parseRecency(product.FechaPublicacion, product.FechaIngreso),
      hasStock: product.hasAnyStock === true,
      thumb: firstThumb(product),
    };
    items.push(indexed);

    const typeLabel = (product.Filtro1 ?? "").trim();
    if (typeLabel) bump(typeCounts, typeLabel);

    const allTokens = new Set([
      ...filtro1,
      ...indexed.filtro2,
      ...indexed.nombre,
      ...colorFamilies,
      ...profileTerms,
    ]);
    for (const t of allTokens) bump(tokenCounts, t);

    for (const fam of colorFamilies) {
      if (typeLabel) bump(comboCounts, `${normalizeText(typeLabel)} ${fam}`);
    }
  }

  const index: SearchIndex = { key, items, tokenCounts, typeCounts, comboCounts };
  if (!profiles) cache.set(key, index);
  // Limitar cache
  if (cache.size > 8) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return index;
}

export function bustSearchIndexCache(): void {
  cache.clear();
}

export function getCachedSearchIndex(key: string): SearchIndex | undefined {
  return cache.get(key);
}

/** Expose products globally for SearchBar (compat + índice). */
export function publishCatalogForSearch(products: GroupedProduct[]): void {
  if (typeof window === "undefined") return;
  const bag = window as Window & {
    __fylProducts?: GroupedProduct[];
    __fylSearchIndexKey?: string;
  };
  bag.__fylProducts = products;
  bag.__fylSearchIndexKey = articulosKey(products);
  buildSearchIndex(products);
}

export function getCatalogProductsFromWindow(): GroupedProduct[] {
  if (typeof window === "undefined") return [];
  const bag = window as Window & { __fylProducts?: GroupedProduct[] };
  return bag.__fylProducts ?? [];
}

export function getSearchIndexFromWindow(
  dict?: SearchDictionary
): SearchIndex | null {
  const products = getCatalogProductsFromWindow();
  if (!products.length) return null;
  return buildSearchIndex(products);
}

// re-export stem helper used by score
export { stemEsToken };
