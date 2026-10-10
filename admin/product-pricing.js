// admin/product-pricing.js
// Costos de productos (cost, cost_is_estimated, price_percentage, logistic_amount):
// solo super_admin y solo por RPC. authenticated no tiene permiso de columna
// sobre esos campos (ARQ-05 Fase 1, migraciones 380/381).
import { supabase } from "../scripts/supabase-client.js?v=m260607";

/** Columnas de products legibles por cualquier admin (sin costos). */
export const PRODUCT_ADMIN_COLUMNS =
  "id, handle, name, description, status, category, supplier_id, created_at, updated_at, " +
  "last_published_at, publication_status, pack_size, nuevos_ingresos_highlight_at, season, " +
  "target_audience, width_cm, height_cm, length_cm, weight_kg";

const PRICING_RPC_MAX_IDS = 1000;

/**
 * @param {string[]} productIds
 * @returns {Promise<Map<string, {cost: number|null, cost_is_estimated: boolean, price_percentage: number|null, logistic_amount: number|null}>>}
 */
export async function fetchProductPricingMap(productIds) {
  const ids = [...new Set((productIds || []).filter(Boolean))];
  const pricingById = new Map();
  for (let i = 0; i < ids.length; i += PRICING_RPC_MAX_IDS) {
    const chunk = ids.slice(i, i + PRICING_RPC_MAX_IDS);
    const { data, error } = await supabase.rpc("rpc_admin_get_product_pricing", {
      p_product_ids: chunk,
    });
    if (error) throw error;
    for (const row of data || []) pricingById.set(row.product_id, row);
  }
  return pricingById;
}

/**
 * @param {string} productId
 * @param {{cost: number|null, costIsEstimated: boolean, pricePercentage: number|null, logisticAmount: number|null}} pricing
 */
export async function saveProductPricing(productId, pricing) {
  const { error } = await supabase.rpc("rpc_admin_set_product_pricing", {
    p_product_id: productId,
    p_cost: pricing.cost,
    p_cost_is_estimated: pricing.costIsEstimated,
    p_price_percentage: pricing.pricePercentage,
    p_logistic_amount: pricing.logisticAmount,
  });
  if (error) throw error;
}
