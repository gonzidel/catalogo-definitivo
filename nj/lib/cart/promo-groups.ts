import { getSupabaseBrowserClient } from "@/lib/supabase/client";

export type PromoType = "2x1" | "2xMonto";

export interface ActivePromotion {
  promotion_id: string;
  promo_type: PromoType | string;
  fixed_amount: number | null;
  variant_ids: string[];
}

/** Ítem mínimo para agrupar (carrito u order_items). */
export interface PromoGroupableItem {
  /** Identidad de la línea origen (cart/order). Puede repetirse entre promo y ungrouped si hay remainder. */
  key: string;
  variant_id: string;
  product_name: string;
  color: string;
  size: string;
  qty: number;
  price_snapshot: number;
  imagen?: string;
}

export interface PromoGroup {
  promotionId: string;
  promoType: PromoType | string;
  /** Etiqueta corta: `2x1` o `2x$34.000` */
  promoLabel: string;
  groups: number;
  /** Solo unidades cubiertas por pares (siempre `groups * 2`). */
  totalQty: number;
  /** Monto a cobrar por los pares de esta promo (sin remainder). */
  promoPrice: number;
  items: PromoGroupableItem[];
}

export async function fetchActivePromotionsForVariants(
  variantIds: string[]
): Promise<ActivePromotion[]> {
  const unique = [...new Set(variantIds.filter(Boolean))];
  if (unique.length === 0) return [];

  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.rpc(
    "get_active_promotions_for_variants",
    { p_variant_ids: unique }
  );

  if (error) {
    console.warn("get_active_promotions_for_variants:", error.message);
    return [];
  }

  return (data ?? []).map((row: ActivePromotion) => ({
    promotion_id: String(row.promotion_id),
    promo_type: row.promo_type,
    fixed_amount:
      row.fixed_amount == null ? null : Number(row.fixed_amount),
    variant_ids: (row.variant_ids ?? []).map(String),
  }));
}

export function formatPromoLabel(
  promoType: string,
  fixedAmount: number | null | undefined
): string {
  if (promoType === "2x1") return "2x1";
  if (promoType === "2xMonto" && fixedAmount != null && Number(fixedAmount) > 0) {
    return `2x$${Number(fixedAmount).toLocaleString("es-AR")}`;
  }
  return "2x";
}

export function formatPromoTitle(groups: number, promoLabel: string): string {
  if (groups <= 1) return `promo ${promoLabel}`;
  return `${groups} promo ${promoLabel}`;
}

/**
 * Agrupa solo pares completos (2 unidades) dentro de cada promo.
 * Las unidades sobrantes (remainder) quedan en `ungrouped` como ítems normales,
 * aunque compartan la misma línea origen (se parte la cantidad).
 *
 * Orden de cobertura: el de `items` (primera aparición).
 */
export function buildPromoGroups(
  items: PromoGroupableItem[],
  promotions: ActivePromotion[]
): { groups: PromoGroup[]; ungrouped: PromoGroupableItem[] } {
  if (!items.length || !promotions.length) {
    return { groups: [], ungrouped: items };
  }

  // Pool mutable de cantidades aún no asignadas a una promo.
  const pool = new Map<string, PromoGroupableItem>();
  for (const item of items) {
    const prev = pool.get(item.key);
    if (prev) {
      pool.set(item.key, { ...prev, qty: prev.qty + item.qty });
    } else {
      pool.set(item.key, { ...item });
    }
  }

  // Orden estable de claves según aparición en `items`.
  const keyOrder: string[] = [];
  for (const item of items) {
    if (!keyOrder.includes(item.key)) keyOrder.push(item.key);
  }

  const groups: PromoGroup[] = [];
  const variantSetForPromo = (promo: ActivePromotion) =>
    new Set((promo.variant_ids ?? []).map(String));

  for (const promo of promotions) {
    const variants = variantSetForPromo(promo);
    const candidates = keyOrder
      .map((key) => pool.get(key))
      .filter((item): item is PromoGroupableItem => {
        if (!item || item.qty <= 0) return false;
        if (!item.variant_id || !variants.has(item.variant_id)) return false;
        return true;
      });

    if (candidates.length === 0) continue;

    const eligibleQty = candidates.reduce((a, item) => a + item.qty, 0);
    const pairGroups = Math.floor(eligibleQty / 2);
    if (pairGroups <= 0) continue;

    let toCover = pairGroups * 2;
    const coveredItems: PromoGroupableItem[] = [];
    let coveredQty = 0;
    let coveredPrice = 0;

    for (const cand of candidates) {
      if (toCover <= 0) break;
      const current = pool.get(cand.key);
      if (!current || current.qty <= 0) continue;

      const take = Math.min(current.qty, toCover);
      coveredItems.push({ ...current, qty: take });
      coveredQty += take;
      coveredPrice += take * current.price_snapshot;
      pool.set(cand.key, { ...current, qty: current.qty - take });
      toCover -= take;
    }

    if (coveredQty < 2) continue;

    const averagePrice = coveredQty > 0 ? coveredPrice / coveredQty : 0;
    let promoPrice = 0;

    if (promo.promo_type === "2x1") {
      // Por cada par se paga 1 unidad (al precio promedio de lo cubierto).
      promoPrice = pairGroups * averagePrice;
    } else if (
      promo.promo_type === "2xMonto" &&
      promo.fixed_amount != null &&
      Number(promo.fixed_amount) > 0
    ) {
      promoPrice = pairGroups * Number(promo.fixed_amount);
    } else {
      // Promo desconocida: devolver unidades al pool.
      for (const covered of coveredItems) {
        const current = pool.get(covered.key);
        if (!current) {
          pool.set(covered.key, { ...covered });
        } else {
          pool.set(covered.key, {
            ...current,
            qty: current.qty + covered.qty,
          });
        }
      }
      continue;
    }

    groups.push({
      promotionId: promo.promotion_id,
      promoType: promo.promo_type,
      promoLabel: formatPromoLabel(promo.promo_type, promo.fixed_amount),
      groups: pairGroups,
      totalQty: coveredQty,
      promoPrice: Math.max(0, Math.round(promoPrice)),
      items: coveredItems,
    });
  }

  const ungrouped: PromoGroupableItem[] = [];
  for (const key of keyOrder) {
    const item = pool.get(key);
    if (item && item.qty > 0) {
      ungrouped.push({ ...item });
    }
  }

  return { groups, ungrouped };
}

export function sumPromoAwareTotal(
  groups: PromoGroup[],
  ungrouped: PromoGroupableItem[]
): number {
  const promoSum = groups.reduce((a, g) => a + g.promoPrice, 0);
  const rest = ungrouped.reduce(
    (a, i) => a + i.qty * i.price_snapshot,
    0
  );
  return promoSum + rest;
}
