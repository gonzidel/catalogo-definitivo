import type { SupabaseClient } from "@supabase/supabase-js";
import { CATALOG_SOURCE, CATALOG_SELECT, agruparProductos } from "@/lib/utils/catalog";
import {
  enrichGroupedProductsWithVariants,
  stripColorsWithoutImages,
} from "@/lib/utils/catalog-variant-enrich";
import { neutralizePdpStockFlags } from "@/lib/pdp/neutralize-stock";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";

export type PdpProductBase = {
  /** Producto público con imágenes; hasStock neutralizado. */
  product: GroupedProduct;
  /** Color sugerido al resolver SKU de variante (no el de ?color=). */
  skuResolvedColor?: string;
};

export function normalizePdpSkuKey(sku: string): string {
  return sku.trim();
}

/**
 * Resuelve SKU → articulo/color sin cookies (variant_sizes / product_variants).
 */
async function resolveSkuWithClient(
  supabase: SupabaseClient,
  sku: string
): Promise<{ articulo: string; color: string } | null> {
  const key = sku.trim();
  if (!key) return null;

  const { data: sizeData } = await supabase
    .from("variant_sizes")
    .select("variant_id, size")
    .eq("sku", key)
    .limit(1)
    .maybeSingle();

  let variantId: string | null = (sizeData as { variant_id?: string } | null)?.variant_id ?? null;

  if (!variantId) {
    const { data: variantData } = await supabase
      .from("product_variants")
      .select("id")
      .eq("sku", key)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    variantId = (variantData as { id?: string } | null)?.id ?? null;
  }

  if (!variantId) return null;

  const { data: variantFull } = await supabase
    .from("product_variants")
    .select("color, products!inner(name)")
    .eq("id", variantId)
    .limit(1)
    .maybeSingle();

  if (!variantFull) return null;

  const articulo =
    (variantFull as { products?: { name?: string } | { name?: string }[] }).products;
  const name = Array.isArray(articulo) ? articulo[0]?.name : articulo?.name;
  const color = (variantFull as { color?: string }).color ?? "";
  if (!name) return null;
  return { articulo: String(name).trim(), color };
}

/** Status de catálogo público por URL (fuera del snapshot). No incluye draft/archived. */
const PDP_PUBLIC_PRODUCT_STATUSES = ["active", "pending_stock"] as const;

/** Columnas públicas de `products` para fallbacks; nunca costos internos. */
export const PUBLIC_PRODUCT_FALLBACK_SELECT = "name, description, category, status";

/**
 * Fallback público: producto en `products` fuera del snapshot
 * (RMAT, pending_stock, agotados publicados). Sin stock sellable.
 * El precio sale solo de `product_variants.price` (enrich por color).
 */
export async function stubFromProductsTable(
  supabase: SupabaseClient,
  articulo: string
): Promise<GroupedProduct | null> {
  const { data: row } = await supabase
    .from("products")
    .select(PUBLIC_PRODUCT_FALLBACK_SELECT)
    .eq("name", articulo.trim())
    .in("status", [...PDP_PUBLIC_PRODUCT_STATUSES])
    .maybeSingle();

  if (!row) return null;

  return {
    Articulo: String(row.name ?? articulo).trim(),
    Descripcion: String(row.description ?? ""),
    Precio: "",
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "",
    Categoria: String(row.category ?? ""),
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    DetalleColor: [],
    hasAnyStock: undefined,
  };
}

async function finalizePdpBase(
  supabase: SupabaseClient,
  base: GroupedProduct,
  skuResolvedColor?: string
): Promise<PdpProductBase | null> {
  const [enriched] = await enrichGroupedProductsWithVariants(supabase, [base]);
  if (!enriched) return null;

  const stripped = stripColorsWithoutImages(enriched);
  if (stripped.DetalleColor.length === 0) return null;

  return {
    product: neutralizePdpStockFlags(stripped),
    skuResolvedColor,
  };
}

/**
 * Carga base del PDP (catálogo + fallback products + enrich imágenes).
 * Sin stock sellable. Reutilizable en SSR (anon) y cliente (browser).
 */
export async function loadPdpProductBase(
  supabase: SupabaseClient,
  sku: string
): Promise<PdpProductBase | null> {
  const key = normalizePdpSkuKey(sku);
  if (!key) return null;

  let skuResolvedColor: string | undefined;
  let articuloKey = key;

  let { data: rows, error } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .eq("Articulo", articuloKey)
    .limit(50);

  if (error || !rows?.length) {
    const resolved = await resolveSkuWithClient(supabase, key);
    if (resolved) {
      articuloKey = resolved.articulo;
      skuResolvedColor = resolved.color || undefined;
      const second = await supabase
        .from(CATALOG_SOURCE)
        .select(CATALOG_SELECT)
        .eq("Articulo", articuloKey)
        .limit(50);
      rows = second.data;
      error = second.error;
    }
  }

  if (!error && rows?.length) {
    const grouped = agruparProductos(rows as unknown as CatalogRow[]);
    const base = grouped[0];
    if (base) return finalizePdpBase(supabase, base, skuResolvedColor);
  }

  // Fuera del snapshot: products activos (RMAT / pending_stock).
  const stub = await stubFromProductsTable(supabase, articuloKey);
  if (!stub) return null;
  return finalizePdpBase(supabase, stub, skuResolvedColor);
}
