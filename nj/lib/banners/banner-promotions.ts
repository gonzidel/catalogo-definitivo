import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicCatalogClient } from "@/lib/supabase/public-catalog";
import { isOfferCampaignId } from "@/lib/banners/offer-campaign";
import {
  CATALOG_AVAILABLE_VIEW,
  CATALOG_SELECT,
  CATALOG_SOURCE,
  agruparProductos,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";

export type BannerPromotionPoster = {
  id: string;
  imageUrl: string;
  title: string;
  recencyMs: number;
};

/** Promociones visuales vigentes que tienen imagen. La vigencia la filtra la policy. */
export async function fetchBannerPromotionPosters(
  supabase: SupabaseClient
): Promise<BannerPromotionPoster[]> {
  const { data, error } = await supabase
    .from("banner_promotions")
    .select("id, title, image_url, updated_at")
    .not("image_url", "is", null)
    .order("updated_at", { ascending: false });
  if (error || !data) return [];

  const posters: BannerPromotionPoster[] = [];
  for (const row of data) {
    const imageUrl = String(row.image_url ?? "").trim();
    const id = String(row.id ?? "").trim();
    if (!imageUrl || !id) continue;
    const updated = Date.parse(String(row.updated_at ?? ""));
    posters.push({
      id,
      imageUrl,
      title: String(row.title ?? "").trim() || "Promoción",
      recencyMs: Number.isFinite(updated) ? updated : 0,
    });
  }
  return posters;
}

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
 * Productos de una promoción visual. null si el id no es un uuid.
 * Sin fila: venció, está inactiva o no existe.
 */
export async function fetchBannerPromotionProducts(
  promotionId: string
): Promise<{ title: string; products: GroupedProduct[] } | null> {
  const id = promotionId.trim();
  if (!isOfferCampaignId(id)) return null;

  const supabase = getPublicCatalogClient();
  const { data: promo } = await supabase
    .from("banner_promotions")
    .select("id, title")
    .eq("id", id)
    .maybeSingle();
  if (!promo) return { title: "Promoción", products: [] };

  const { data: promoItems } = await supabase
    .from("banner_promotion_items")
    .select("product_id, variant_id")
    .eq("banner_promotion_id", id);

  const productIds = new Set<string>();
  const variantIds: string[] = [];
  for (const item of promoItems ?? []) {
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
    title: String(promo.title ?? "").trim() || "Promoción",
    products: agruparProductos(rows),
  };
}
