import { getPublicCatalogClient } from "@/lib/supabase/public-catalog";
import { isOfferCampaignId } from "@/lib/banners/offer-campaign";
import { promoPosterTitle } from "@/lib/banners/promo-posters";
import {
  CATALOG_AVAILABLE_VIEW,
  CATALOG_SELECT,
  CATALOG_SOURCE,
  agruparProductos,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";

async function loadRowsByArticle(source: string, articles: string[]): Promise<CatalogRow[]> {
  if (articles.length === 0) return [];
  const { data, error } = await getPublicCatalogClient()
    .from(source)
    .select(CATALOG_SELECT)
    .in("Articulo", articles)
    .limit(1000);
  if (error || !data) return [];
  return data as unknown as CatalogRow[];
}

/**
 * Productos de una promo 2x. null si el id no es un uuid.
 * Sin fila: venció o no existe; la página muestra vacío, no el catálogo entero.
 */
export async function fetchPromoProducts(
  promoId: string
): Promise<{ title: string; products: GroupedProduct[] } | null> {
  const id = promoId.trim();
  if (!isOfferCampaignId(id)) return null;

  const supabase = getPublicCatalogClient();
  const { data: promo } = await supabase
    .from("promotions")
    .select("id, promo_type, fixed_amount")
    .eq("id", id)
    .maybeSingle();
  if (!promo) return { title: "Promoción", products: [] };

  const { data: items } = await supabase
    .from("promotion_items")
    .select("product_id, variant_id")
    .eq("promotion_id", id);

  const productIds = new Set<string>();
  const variantIds: string[] = [];
  for (const item of items ?? []) {
    if (item.product_id) productIds.add(String(item.product_id));
    if (item.variant_id) variantIds.push(String(item.variant_id));
  }
  if (variantIds.length > 0) {
    const { data: variants } = await supabase
      .from("product_variants")
      .select("product_id")
      .in("id", variantIds);
    for (const variant of variants ?? []) {
      if (variant.product_id) productIds.add(String(variant.product_id));
    }
  }

  const ids = [...productIds];
  let articles: string[] = [];
  if (ids.length > 0) {
    const { data: products } = await supabase
      .from("products")
      .select("name, handle")
      .in("id", ids);
    articles = [
      ...new Set(
        (products ?? []).flatMap((product) =>
          [product.name, product.handle]
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
        )
      ),
    ];
  }

  let rows = await loadRowsByArticle(CATALOG_SOURCE, articles);
  if (rows.length === 0) rows = await loadRowsByArticle(CATALOG_AVAILABLE_VIEW, articles);

  return {
    title: promoPosterTitle(promo.promo_type, promo.fixed_amount),
    products: agruparProductos(rows),
  };
}
