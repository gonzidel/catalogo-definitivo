import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildPromoGroups,
  formatPromoLabel,
  type PromoGroupableItem,
} from "@/lib/cart/promo-groups";
import {
  isCancelledOrderItem,
  isMissingOrderItem,
  isReturnOrderItem,
} from "@/lib/orders/domain";
import type { AdminOrderItem } from "@/types/orders";

const TIMEZONE_BUENOS_AIRES = "America/Argentina/Buenos_Aires";

/** Promo 2x1/2xMonto con su vigencia (fechas `YYYY-MM-DD`, inclusive). */
export interface OrderPromoDefinition {
  promotion_id: string;
  promo_type: string;
  fixed_amount: number | null;
  start_date: string;
  end_date: string;
  variant_ids: string[];
}

/** Línea del pedido evaluable para promos; `loaded_on` = día (AR) en que se cargó. */
export interface OrderPromoPricedItem {
  id: string;
  variant_id: string;
  quantity: number;
  price_snapshot: number;
  loaded_on: string;
}

export interface OrderPromoLine {
  promotion_id: string;
  /** Mismo texto que la caja de public-sales: `1 oferta 2x$28.000`. */
  label: string;
  groups: number;
  amount: number;
}

export interface OrderPromoPricing {
  lines: OrderPromoLine[];
  /** Unidades de cada order_item cubiertas por un par (se cobran a $0). */
  coveredQtyByItemId: Record<string, number>;
  /** Precio de lista de las unidades cubiertas menos lo cobrado por las promos. */
  discount: number;
}

export const EMPTY_ORDER_PROMO_PRICING: OrderPromoPricing = {
  lines: [],
  coveredQtyByItemId: {},
  discount: 0,
};

export function toBuenosAiresDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: TIMEZONE_BUENOS_AIRES });
}

function isPromoEligibleOrderItem(item: AdminOrderItem): boolean {
  if (!item.variant_id) return false;
  if (item.is_special_extra) return false;
  if (isCancelledOrderItem(item) || isMissingOrderItem(item)) return false;
  if (isReturnOrderItem(item)) return false;
  return (Number(item.price_snapshot) || 0) > 0 && (Number(item.quantity) || 0) > 0;
}

/**
 * Pares completos por promo; el sobrante paga precio normal. Cada unidad solo
 * entra en una promo vigente el día en que se cargó al pedido (si la promo
 * terminó después, el par conserva el descuento).
 */
export function computeOrderPromoPricing(
  items: OrderPromoPricedItem[],
  promos: OrderPromoDefinition[]
): OrderPromoPricing {
  if (!items.length || !promos.length) return EMPTY_ORDER_PROMO_PRICING;

  const remaining = new Map(items.map((item) => [item.id, item.quantity]));
  const coveredQtyByItemId: Record<string, number> = {};
  const lines: OrderPromoLine[] = [];
  let discount = 0;

  const ordered = [...promos].sort(
    (a, b) =>
      a.start_date.localeCompare(b.start_date) ||
      a.promotion_id.localeCompare(b.promotion_id)
  );

  for (const promo of ordered) {
    const variants = new Set(promo.variant_ids);
    const candidates: PromoGroupableItem[] = items
      .filter(
        (item) =>
          variants.has(item.variant_id) &&
          item.loaded_on >= promo.start_date &&
          item.loaded_on <= promo.end_date &&
          (remaining.get(item.id) ?? 0) > 0
      )
      .map((item) => ({
        key: item.id,
        variant_id: item.variant_id,
        product_name: "",
        color: "",
        size: "",
        qty: remaining.get(item.id) ?? 0,
        price_snapshot: item.price_snapshot,
      }));

    const { groups } = buildPromoGroups(candidates, [
      {
        promotion_id: promo.promotion_id,
        promo_type: promo.promo_type,
        fixed_amount: promo.fixed_amount,
        variant_ids: promo.variant_ids,
      },
    ]);
    const group = groups[0];
    if (!group) continue;

    let listPrice = 0;
    for (const covered of group.items) {
      remaining.set(covered.key, (remaining.get(covered.key) ?? 0) - covered.qty);
      coveredQtyByItemId[covered.key] = (coveredQtyByItemId[covered.key] ?? 0) + covered.qty;
      listPrice += covered.qty * covered.price_snapshot;
    }

    const label = formatPromoLabel(promo.promo_type, promo.fixed_amount);
    lines.push({
      promotion_id: promo.promotion_id,
      label: `${group.groups} oferta${group.groups === 1 ? "" : "s"} ${label}`,
      groups: group.groups,
      amount: group.promoPrice,
    });
    discount += listPrice - group.promoPrice;
  }

  if (!lines.length) return EMPTY_ORDER_PROMO_PRICING;
  return { lines, coveredQtyByItemId, discount: Math.max(0, Math.round(discount)) };
}

async function fetchItemLoadedDates(
  supabase: SupabaseClient,
  itemIds: string[]
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from("order_items")
    .select("id, created_at")
    .in("id", itemIds);
  if (error) throw new Error(`No se pudieron cargar las fechas de los productos: ${error.message}`);
  const out = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.created_at) out.set(String(row.id), toBuenosAiresDate(String(row.created_at)));
  }
  return out;
}

async function fetchPromotionsForVariants(
  supabase: SupabaseClient,
  variantIds: string[]
): Promise<OrderPromoDefinition[]> {
  const { data: variantRows, error: variantsError } = await supabase
    .from("product_variants")
    .select("id, product_id")
    .in("id", variantIds);
  if (variantsError) {
    throw new Error(`No se pudieron cargar las promociones: ${variantsError.message}`);
  }

  const productIdByVariant = new Map<string, string>();
  for (const row of variantRows ?? []) {
    if (row.product_id) productIdByVariant.set(String(row.id), String(row.product_id));
  }
  const productIds = [...new Set(productIdByVariant.values())];
  const orFilters = [`variant_id.in.(${variantIds.join(",")})`];
  if (productIds.length) orFilters.push(`product_id.in.(${productIds.join(",")})`);

  const { data: piRows, error: piError } = await supabase
    .from("promotion_items")
    .select("promotion_id, product_id, variant_id")
    .or(orFilters.join(","));
  if (piError) throw new Error(`No se pudieron cargar las promociones: ${piError.message}`);
  if (!piRows?.length) return [];

  const promotionIds = [...new Set(piRows.map((row) => String(row.promotion_id)))];
  const { data: promos, error: promosError } = await supabase
    .from("promotions")
    .select("id, promo_type, fixed_amount, start_date, end_date")
    .in("id", promotionIds)
    .eq("status", "active");
  if (promosError) throw new Error(`No se pudieron cargar las promociones: ${promosError.message}`);

  return (promos ?? []).map((promo) => {
    const ids = new Set<string>();
    for (const pi of piRows) {
      if (String(pi.promotion_id) !== String(promo.id)) continue;
      if (pi.variant_id && variantIds.includes(String(pi.variant_id))) {
        ids.add(String(pi.variant_id));
      } else if (pi.product_id) {
        for (const variantId of variantIds) {
          if (productIdByVariant.get(variantId) === String(pi.product_id)) ids.add(variantId);
        }
      }
    }
    return {
      promotion_id: String(promo.id),
      promo_type: String(promo.promo_type),
      fixed_amount: promo.fixed_amount == null ? null : Number(promo.fixed_amount),
      start_date: String(promo.start_date),
      end_date: String(promo.end_date),
      variant_ids: [...ids],
    };
  });
}

/** Promos 2x de las líneas cobrables del pedido. Lanza si no puede consultarlas. */
export async function loadOrderPromoPricing(
  supabase: SupabaseClient,
  orderItems: AdminOrderItem[]
): Promise<OrderPromoPricing> {
  const eligible = orderItems.filter(isPromoEligibleOrderItem);
  if (!eligible.length) return EMPTY_ORDER_PROMO_PRICING;

  const variantIds = [...new Set(eligible.map((item) => String(item.variant_id)))];
  const promos = await fetchPromotionsForVariants(supabase, variantIds);
  if (!promos.length) return EMPTY_ORDER_PROMO_PRICING;

  const loadedOn = await fetchItemLoadedDates(
    supabase,
    eligible.map((item) => item.id)
  );

  const priced: OrderPromoPricedItem[] = [];
  for (const item of eligible) {
    const day = loadedOn.get(item.id);
    if (!day) continue;
    priced.push({
      id: item.id,
      variant_id: String(item.variant_id),
      quantity: Number(item.quantity) || 0,
      price_snapshot: Number(item.price_snapshot) || 0,
      loaded_on: day,
    });
  }
  return computeOrderPromoPricing(priced, promos);
}
