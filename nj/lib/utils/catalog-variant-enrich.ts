import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogImage, ColorDetail, GroupedProduct } from "@/types/catalog";
import { agruparProductos, CATALOG_SELECT, colorDetailHasImage } from "@/lib/utils/catalog";
import { colorDetailMatchesSizes } from "@/lib/utils/search";
import type { CatalogRow } from "@/types/catalog";
import { calculateRecommendedPrice } from "@/lib/products/pricing";
import {
  colorIsPurchasable,
  deriveHasAnyStock,
  productIsPurchasable,
} from "@/lib/stock/catalog-availability";

function normColor(c: string): string {
  return String(c ?? "").trim().toLowerCase();
}

export function productHasAnyStock(product: GroupedProduct): boolean {
  return productIsPurchasable(product);
}

export interface PickDisplayColorOptions {
  activeSizes?: string[];
  categoria?: string;
}

/** Color preferido para card/PDP: con imagen; si hay filtro de talle, prioriza variante que lo tenga. */
export function pickDisplayColorDetail(
  product: GroupedProduct,
  options?: PickDisplayColorOptions
): ColorDetail | null {
  const colors = (product.DetalleColor ?? []).filter(colorDetailHasImage);
  if (colors.length === 0) return null;

  const sizes = (options?.activeSizes ?? []).map((s) => s.trim()).filter(Boolean);
  const categoria = options?.categoria ?? "all";

  if (sizes.length > 0) {
    const matchesAllSizes = colors.filter((c) =>
      sizes.every((size) => colorDetailMatchesSizes(c, [size], categoria))
    );
    const matching =
      matchesAllSizes.length > 0
        ? matchesAllSizes
        : colors.filter((c) => colorDetailMatchesSizes(c, sizes, categoria));

    if (matching.length > 0) {
      return matching.find((c) => colorIsPurchasable(c)) ?? matching[0];
    }
  }

  return colors.find((c) => colorIsPurchasable(c)) ?? colors[0];
}

/** Quita variantes sin imagen propia; actualiza hero y flags de stock. */
export function stripColorsWithoutImages(product: GroupedProduct): GroupedProduct {
  const detalleColor = (product.DetalleColor ?? []).filter(colorDetailHasImage);
  const display = pickDisplayColorDetail({ ...product, DetalleColor: detalleColor });
  const hasAnyStock = deriveHasAnyStock(detalleColor, product.hasAnyStock);

  return {
    ...product,
    DetalleColor: detalleColor,
    hasAnyStock,
    VariantePrincipal: display?.images?.[0] ?? null,
  };
}

interface RawVariantRow {
  id: string;
  color: string | null;
  sku?: string | null;
  price?: number | string | null;
  products: { name: string } | { name: string }[] | null;
}

interface RawImageRow {
  variant_id: string;
  url: string | null;
  position: number | null;
}

interface RawColorRow {
  name: string;
  hex_color: string | null;
  display_number: number | null;
}

export interface VariantEnrichMeta {
  variantId: string;
  color: string;
  images: CatalogImage[];
  hex_color: string | null;
  ColorDisplayNumber: number | null;
  price?: number | null;
  sku?: string | null;
}

async function fetchVariantEnrichMap(
  supabase: SupabaseClient,
  articulos: string[]
): Promise<Map<string, VariantEnrichMeta[]>> {
  const unique = [...new Set(articulos.map((a) => a.trim()).filter(Boolean))];
  const result = new Map<string, VariantEnrichMeta[]>();
  if (unique.length === 0) return result;

  const chunkSize = 40;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);

    const { data: variants, error: vErr } = await supabase
      .from("product_variants")
      .select("id, color, sku, price, products!inner(name)")
      .eq("active", true)
      .in("products.name", chunk);

    if (vErr || !variants?.length) continue;

    const variantIds = variants.map((v) => v.id);
    const colorNames = [
      ...new Set(variants.map((v) => String(v.color ?? "").trim()).filter(Boolean)),
    ];

    const [imagesRes, colorsRes] = await Promise.all([
      supabase
        .from("variant_images")
        .select("variant_id, url, position")
        .in("variant_id", variantIds)
        .order("position"),
      colorNames.length
        ? supabase
            .from("colors")
            .select("name, hex_color, display_number")
            .in("name", colorNames)
        : Promise.resolve({ data: [] as RawColorRow[] }),
    ]);

    const imagesByVariant = new Map<string, RawImageRow[]>();
    for (const row of (imagesRes.data ?? []) as RawImageRow[]) {
      const list = imagesByVariant.get(row.variant_id) ?? [];
      list.push(row);
      imagesByVariant.set(row.variant_id, list);
    }

    const colorMeta = new Map<string, RawColorRow>();
    for (const c of (colorsRes.data ?? []) as RawColorRow[]) {
      colorMeta.set(normColor(c.name), c);
    }

    for (const v of variants as RawVariantRow[]) {
      const prod = v.products;
      const articulo = (Array.isArray(prod) ? prod[0]?.name : prod?.name) ?? "";
      if (!articulo) continue;

      const color = String(v.color ?? "Sin color").trim();
      const images = (imagesByVariant.get(v.id) ?? [])
        .map((img) => img.url)
        .filter(Boolean) as CatalogImage[];
      const cm = colorMeta.get(normColor(color));

      const meta: VariantEnrichMeta = {
        variantId: v.id,
        color,
        images,
        hex_color: cm?.hex_color ?? null,
        ColorDisplayNumber: cm?.display_number ?? null,
        price: v.price != null ? Number(v.price) : null,
        sku: v.sku ?? null,
      };

      const list = result.get(articulo) ?? [];
      list.push(meta);
      result.set(articulo, list);
    }
  }

  return result;
}

function mergeColorFromMeta(existing: ColorDetail, meta: VariantEnrichMeta): ColorDetail {
  const images =
    meta.images.length > 0
      ? meta.images
      : existing.images?.length
        ? existing.images
        : [];

  return {
    ...existing,
    hex_color: existing.hex_color ?? meta.hex_color,
    ColorDisplayNumber: existing.ColorDisplayNumber ?? meta.ColorDisplayNumber,
    images,
    variant_id: existing.variant_id ?? meta.variantId,
    sku: existing.sku ?? meta.sku ?? null,
    Precio:
      existing.Precio != null && existing.Precio !== ""
        ? existing.Precio
        : (meta.price ?? existing.Precio),
    // No pisar la señal sellable del snapshot con variant_sizes.
    hasStock: existing.hasStock,
  };
}

function colorDetailFromMeta(meta: VariantEnrichMeta): ColorDetail {
  return {
    color: meta.color,
    hex_color: meta.hex_color,
    ColorDisplayNumber: meta.ColorDisplayNumber,
    talles: [],
    images: meta.images,
    Precio: meta.price ?? "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    variant_id: meta.variantId,
    sku: meta.sku ?? null,
    // Color que no está en snapshot/vista = no hay talle sellable publicado.
    hasStock: false,
  };
}

export function applyVariantEnrichToProduct(
  product: GroupedProduct,
  metas: VariantEnrichMeta[]
): GroupedProduct {
  if (!metas.length) return product;

  const byColor = new Map<string, ColorDetail>();
  for (const dc of product.DetalleColor ?? []) {
    byColor.set(normColor(dc.color), { ...dc });
  }

  for (const meta of metas) {
    const key = normColor(meta.color);
    const existing = byColor.get(key);
    if (existing) {
      const merged = mergeColorFromMeta(existing, meta);
      if (colorDetailHasImage(merged)) {
        byColor.set(key, merged);
      } else {
        byColor.delete(key);
      }
    } else if (meta.images.length > 0) {
      byColor.set(key, colorDetailFromMeta(meta));
    }
  }

  const detalleColor = [...byColor.values()]
    .filter(colorDetailHasImage)
    .sort((a, b) => {
    const na = a.ColorDisplayNumber;
    const nb = b.ColorDisplayNumber;
    if (na !== null && nb !== null) return na - nb;
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return a.color.localeCompare(b.color);
  });

  const hasAnyStock =
    product.hasAnyStock === false
      ? false
      : deriveHasAnyStock(detalleColor, product.hasAnyStock);
  const display = pickDisplayColorDetail({ ...product, DetalleColor: detalleColor });

  return stripColorsWithoutImages({
    ...product,
    DetalleColor: detalleColor,
    hasAnyStock,
    VariantePrincipal: display?.images?.[0] ?? product.VariantePrincipal,
  });
}

export async function enrichGroupedProductsWithVariants(
  supabase: SupabaseClient,
  products: GroupedProduct[]
): Promise<GroupedProduct[]> {
  if (products.length === 0) return [];
  const map = await fetchVariantEnrichMap(
    supabase,
    products.map((p) => p.Articulo)
  );
  return products.map((p) =>
    applyVariantEnrichToProduct(p, map.get(p.Articulo.trim()) ?? [])
  );
}

/** Productos activos por nombre que no están en el snapshot (p. ej. sin stock). */
export async function searchProductsIncludingOutOfStock(
  supabase: SupabaseClient,
  term: string,
  excludeArticulos: Set<string>
): Promise<GroupedProduct[]> {
  const q = term.trim();
  if (q.length < 2) return [];

  const { data: matches, error } = await supabase
    .from("products")
    .select("name, description, category, cost, price_percentage, logistic_amount")
    .eq("status", "active")
    .or(`name.ilike.%${q}%,description.ilike.%${q}%`)
    .limit(40);

  if (error || !matches?.length) return [];

  const articulos = matches
    .map((m) => String(m.name ?? "").trim())
    .filter((a) => a && !excludeArticulos.has(a));

  if (articulos.length === 0) return [];

  const { data: snapRows } = await supabase
    .from("catalog_public_snapshot")
    .select(CATALOG_SELECT)
    .in("Articulo", articulos)
    .limit(500);

  const groupedFromSnap = agruparProductos((snapRows ?? []) as unknown as CatalogRow[]);
  const snapByArt = new Map(groupedFromSnap.map((p) => [p.Articulo, p]));

  const built: GroupedProduct[] = [];
  for (const m of matches) {
    const art = String(m.name ?? "").trim();
    if (!art || excludeArticulos.has(art)) continue;

    const fromSnap = snapByArt.get(art);
    if (fromSnap) {
      built.push(fromSnap);
      continue;
    }

    const precio = calculateRecommendedPrice(
      Number(m.cost ?? 0),
      Number(m.price_percentage ?? 0),
      Number(m.logistic_amount ?? 0)
    );

    built.push({
      Articulo: art,
      Descripcion: String(m.description ?? ""),
      Precio: precio || "",
      VariantePrincipal: null,
      Oferta: "",
      FechaIngreso: "",
      FechaPublicacion: "",
      Categoria: String(m.category ?? ""),
      Filtro1: "",
      Filtro2: "",
      Filtro3: "",
      DetallesSimilitud: "",
      OfertaActiva: false,
      PrecioOferta: "",
      PromoActiva: "",
      DetalleColor: [],
      hasAnyStock: false,
    });
  }

  return enrichGroupedProductsWithVariants(supabase, built);
}

export function colorHasStock(
  product: GroupedProduct,
  color: string
): boolean {
  const dc = product.DetalleColor?.find(
    (d) => normColor(d.color) === normColor(color)
  );
  return colorIsPurchasable(dc);
}
