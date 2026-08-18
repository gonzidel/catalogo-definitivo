import type { AdminOrder, AdminOrderItem } from "@/types/orders";
import type { SupabaseClient } from "@supabase/supabase-js";

type PromoRow = {
  promo_type?: string | null;
  fixed_amount?: number | null;
  variant_ids?: string[] | null;
};

/**
 * Marca ítems del Kanban con `isOffer` cuando el producto tiene promo activa
 * (2x1 / 2xMonto) o oferta por color (`color_price_offers`). Misma fuente de
 * verdad que admin legacy (`get_active_promotions_for_variants` + ofertas),
 * pero en un solo batch para todos los pedidos cargados.
 */
export async function enrichOrderItemsWithOfferFlags(
  supabase: SupabaseClient | null,
  orders: AdminOrder[]
): Promise<AdminOrder[]> {
  if (!supabase || orders.length === 0) return orders;

  const variantIds = new Set<string>();
  for (const order of orders) {
    for (const item of order.order_items || []) {
      if (item.variant_id) variantIds.add(item.variant_id);
    }
  }
  if (variantIds.size === 0) return orders;

  const ids = Array.from(variantIds);
  const offerVariantIds = new Set<string>();

  const { data: promotionsData, error: promotionsError } = await supabase.rpc(
    "get_active_promotions_for_variants",
    { p_variant_ids: ids }
  );
  if (!promotionsError) {
    for (const promo of (promotionsData || []) as PromoRow[]) {
      for (const variantId of promo.variant_ids || []) {
        if (variantId) offerVariantIds.add(variantId);
      }
    }
  }

  const { data: variantsData } = await supabase
    .from("product_variants")
    .select("id, product_id, color")
    .in("id", ids);

  const variants = (variantsData || []) as {
    id: string;
    product_id: string | null;
    color: string | null;
  }[];

  const productIds = Array.from(
    new Set(variants.map((v) => v.product_id).filter((id): id is string => Boolean(id)))
  );

  if (productIds.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: offersData } = await supabase
      .from("color_price_offers")
      .select("product_id, color, offer_price")
      .in("product_id", productIds)
      .eq("status", "active")
      .lte("start_date", today)
      .gte("end_date", today);

    const offerKeys = new Set<string>();
    for (const offer of offersData || []) {
      const productId = String(offer.product_id || "");
      const color = String(offer.color || "").trim().toLowerCase();
      if (!productId || !color) continue;
      if (Number(offer.offer_price) <= 0) continue;
      offerKeys.add(`${productId}::${color}`);
    }

    for (const variant of variants) {
      if (!variant.product_id || !variant.color) continue;
      const key = `${variant.product_id}::${String(variant.color).trim().toLowerCase()}`;
      if (offerKeys.has(key)) offerVariantIds.add(variant.id);
    }
  }

  if (offerVariantIds.size === 0) {
    return orders.map((order) => ({
      ...order,
      order_items: (order.order_items || []).map((item) => ({ ...item, isOffer: false })),
    }));
  }

  return orders.map((order) => ({
    ...order,
    order_items: (order.order_items || []).map((item: AdminOrderItem) => ({
      ...item,
      isOffer: Boolean(item.variant_id && offerVariantIds.has(item.variant_id)),
    })),
  }));
}
