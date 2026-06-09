import { createSupabaseServerClient } from "./server";
import {
  CATALOG_SOURCE,
  CATALOG_SELECT,
  agruparProductos,
  intercalarProductos,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";
import type { PromotionalBannerData, CuratedBannerConfig } from "@/types/banners";

const PAGE_SIZE = 14;
const BOOT_ROWS = 120;

// ─── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchRawRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  options: {
    categoria?: string;
    tags?: string[];
    offset?: number;
    limit?: number;
  } = {}
): Promise<CatalogRow[]> {
  const { categoria = "all", tags = [], offset = 0, limit = BOOT_ROWS } = options;

  try {
    let query = supabase.from(CATALOG_SOURCE).select(CATALOG_SELECT);

    if (categoria !== "all" && categoria !== "Novedades" && categoria !== "Ofertas") {
      if (categoria === "Lenceria") {
        query = query.eq("Categoria", "Otros").ilike("Filtro1", "lenceria");
      } else if (categoria === "Marroquineria") {
        query = query.eq("Categoria", "Otros").ilike("Filtro1", "marroquineria");
      } else {
        query = query.eq("Categoria", categoria);
      }
    }

    if (categoria === "Ofertas") {
      query = (query as any).eq("OfertaActiva", true);
    }

    if (tags.length > 0) {
      const tagFilters = tags
        .map((t) => `Filtro1.ilike.%${t}%,Filtro2.ilike.%${t}%,Filtro3.ilike.%${t}%`)
        .join(",");
      query = query.or(tagFilters);
    }

    query = query
      .order("FechaPublicacion", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    // 3-second SSR timeout — browser client takes over on failure
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const { data, error } = await (query as any).abortSignal(controller.signal);
    clearTimeout(timer);
    if (error) {
      console.warn("[queries] fetchRawRows (SSR):", error.message);
      return [];
    }
    return (data as unknown as CatalogRow[]) ?? [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[queries] fetchRawRows (SSR) network error:", msg);
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch grouped products for the catalog home (ISR).
 * Returns first PAGE_SIZE products, grouped and intercalated for "all".
 */
export async function getCatalogPage(
  categoria = "all",
  page = 1
): Promise<{ products: GroupedProduct[]; hasMore: boolean }> {
  try {
    const supabase = await createSupabaseServerClient();
    const offset = (page - 1) * PAGE_SIZE;

    if (categoria === "all" && page === 1) {
      const rows = await fetchRawRows(supabase, { categoria: "all", limit: BOOT_ROWS });
      const grouped = agruparProductos(rows);
      const sorted = intercalarProductos(grouped);
      return {
        products: sorted.slice(0, PAGE_SIZE),
        hasMore: sorted.length > PAGE_SIZE,
      };
    }

    const rows = await fetchRawRows(supabase, {
      categoria,
      offset,
      limit: PAGE_SIZE + 1,
    });
    const grouped = agruparProductos(rows);
    const hasMore = grouped.length > PAGE_SIZE;
    return { products: grouped.slice(0, PAGE_SIZE), hasMore };
  } catch {
    return { products: [], hasMore: false };
  }
}

/**
 * Fetch ALL grouped products for a category (for search + filters).
 * Used by the API route for client-side SWR pagination.
 */
export async function getAllCatalogProducts(
  categoria = "all",
  tags: string[] = []
): Promise<GroupedProduct[]> {
  const supabase = await createSupabaseServerClient();

  // Paginate raw rows to get everything
  let allRows: CatalogRow[] = [];
  let offset = 0;
  const batchSize = 500;

  while (true) {
    const rows = await fetchRawRows(supabase, {
      categoria,
      tags,
      offset,
      limit: batchSize,
    });
    allRows = allRows.concat(rows);
    if (rows.length < batchSize) break;
    offset += batchSize;
  }

  const grouped = agruparProductos(allRows);
  if (categoria === "all" && tags.length === 0) {
    return intercalarProductos(grouped);
  }
  return grouped.sort((a, b) =>
    (b.FechaPublicacion ?? "") > (a.FechaPublicacion ?? "") ? 1 : -1
  );
}

/**
 * Fetch a product by Articulo code (for PDP).
 */
export async function getProductByArticulo(
  articulo: string
): Promise<GroupedProduct | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from(CATALOG_SOURCE)
      .select(CATALOG_SELECT)
      .eq("Articulo", articulo.trim())
      .limit(50);

    if (error || !data || data.length === 0) return null;
    const grouped = agruparProductos(data as unknown as CatalogRow[]);
    return grouped[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve SKU → Articulo by querying variant_sizes + product_variants.
 * Returns { articulo, color } or null if not found.
 */
export async function resolveSkuToArticulo(
  sku: string
): Promise<{ articulo: string; color: string; talle: string } | null> {
  const supabase = await createSupabaseServerClient();

  // 1. Look up SKU in variant_sizes
  const { data: sizeData } = await supabase
    .from("variant_sizes")
    .select("variant_id, size")
    .eq("sku", sku.trim())
    .limit(1)
    .maybeSingle();

  let variantId: string | null = null;
  let talle = "";

  if (sizeData?.variant_id) {
    variantId = sizeData.variant_id;
    talle = String(sizeData.size ?? "");
  } else {
    // 2. Try SKU in product_variants (base SKU without talle)
    const { data: variantData } = await supabase
      .from("product_variants")
      .select("id, color")
      .eq("sku", sku.trim())
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    if (!variantData?.id) return null;
    variantId = variantData.id;
  }

  if (!variantId) return null;

  // 3. Get product name (= Articulo) from product_variants → products
  const { data: variantFull } = await supabase
    .from("product_variants")
    .select("color, products!inner(name)")
    .eq("id", variantId)
    .limit(1)
    .maybeSingle();

  if (!variantFull) return null;

  const articulo = (variantFull as any).products?.name ?? "";
  const color = (variantFull as any).color ?? "";

  if (!articulo) return null;
  return { articulo, color, talle };
}

/**
 * Get variant sizes for all variants of an Articulo (for PDP stock display).
 */
export async function getVariantSizesForArticulo(
  articulo: string
): Promise<
  Array<{
    variantId: string;
    color: string;
    sku: string;
    sizes: Array<{ size: string; sku: string; stock_qty: number }>;
  }>
> {
  const supabase = await createSupabaseServerClient();

  // Get all variants for this product
  const { data: variants } = await supabase
    .from("product_variants")
    .select("id, color, sku, products!inner(name)")
    .eq("active", true)
    .filter("products.name", "eq", articulo)
    .limit(50);

  if (!variants || variants.length === 0) return [];

  const results = await Promise.all(
    variants.map(async (v: any) => {
      const { data: sizes } = await supabase
        .from("variant_sizes")
        .select("size, sku, stock_qty")
        .eq("variant_id", v.id)
        .order("size");

      return {
        variantId: v.id,
        color: v.color ?? "",
        sku: v.sku ?? "",
        sizes: (sizes ?? []).map((s: any) => ({
          size: String(s.size ?? ""),
          sku: s.sku ?? "",
          stock_qty: Number(s.stock_qty ?? 0),
        })),
      };
    })
  );

  return results;
}

// ─── Banner queries ────────────────────────────────────────────────────────────

function withTimeout<T>(
  queryBuilder: unknown,
  ms = 3000
): Promise<{ data: T | null; error: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return (queryBuilder as any)
    .abortSignal(controller.signal)
    .then((res: { data: T | null; error: unknown }) => {
      clearTimeout(timer);
      return res;
    })
    .catch((err: unknown) => {
      clearTimeout(timer);
      return { data: null, error: err };
    });
}

export async function getPromotionalBanner(): Promise<PromotionalBannerData | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const query = supabase
      .from("promotional_banners")
      .select("*")
      .eq("enabled", true)
      .order("order", { ascending: true })
      .limit(1)
      .maybeSingle();
    const { data, error } = await withTimeout<PromotionalBannerData>(query);
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getCuratedBanners(): Promise<CuratedBannerConfig[]> {
  try {
    const supabase = await createSupabaseServerClient();
    const query = supabase
      .from("custom_product_banners")
      .select("id, title, slug, description, enabled, sort_order, tag_value")
      .eq("enabled", true)
      .order("sort_order", { ascending: true })
      .limit(10);
    const { data, error } = await withTimeout<CuratedBannerConfig[]>(query);
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

export async function getCuratedBannerProducts(
  tagValue: string
): Promise<GroupedProduct[]> {
  try {
    const supabase = await createSupabaseServerClient();
    const tag = tagValue.trim().toLowerCase();
    if (!tag) return [];
    const query = supabase
      .from(CATALOG_SOURCE)
      .select(CATALOG_SELECT)
      .or(
        `Filtro1.ilike.%${tag}%,Filtro2.ilike.%${tag}%,Filtro3.ilike.%${tag}%`
      )
      .order("FechaPublicacion", { ascending: false, nullsFirst: false })
      .limit(60);
    const { data, error } = await withTimeout<CatalogRow[]>(query);
    if (error || !data) return [];
    return agruparProductos(data as unknown as CatalogRow[]);
  } catch {
    return [];
  }
}
