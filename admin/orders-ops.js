// admin/orders-ops.js — operaciones de pedido sin DOM (PAU y otros módulos)

import { supabase as supabaseClient } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";
import { computeWarehouseQtySplitForOrderItem } from "./orders-domain.js";
import {
  createNewOrder,
  addItemsToExistingOrder,
  resolveQrCodeToOrderItem,
} from "./order-creator.js";

let supabase = supabaseClient;

const OPERATIONAL_ITEM_STATUSES = new Set(["reserved", "picked", "waiting", "missing"]);
const OPEN_ORDER_STATUSES = ["active", "closing_soon", "stock_pending"];

/** Nombres en `payment_methods` — mismos que al cerrar en orders.html */
export const ORDER_PAYMENT_METHOD = {
  CONTRA_REEMBOLSO: "Contra Reembolso",
  PAGADO: "Pagado",
};

export const PAU_ORDER_CHIP_LABELS = {
  active: "Pedido",
  picked: "Pedido",
  waiting: "Espera",
  closed: "Cerrado",
  cancelled: "Cancelado",
  sent: "Enviado",
  stock_pending: "Stock pend.",
};

function normStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isValidUUID(uuid) {
  if (typeof uuid !== "string" || !uuid) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
}

async function getSb() {
  if (supabase) return supabase;
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }
  const mod = await import("../scripts/supabase-client.js");
  supabase = mod.supabase || window.supabase;
  return supabase;
}

function orderHasOperationalItems(order) {
  const items = Array.isArray(order?.order_items) ? order.order_items : [];
  if (items.length === 0) return false;
  return items.some((item) => OPERATIONAL_ITEM_STATUSES.has(normStatus(item.status)));
}

/** Pedido abierto/operativo del cliente (no duplicar). */
export async function findActiveOrderForCustomer(customerId) {
  if (!isValidUUID(customerId)) return null;
  const sb = await getSb();
  if (!sb) throw new Error("Supabase no disponible");

  const { data, error } = await sb
    .from("orders")
    .select(`
      id,
      order_number,
      status,
      total_amount,
      created_at,
      notes,
      order_items (
        id,
        product_name,
        color,
        size,
        quantity,
        price_snapshot,
        status,
        variant_id
      )
    `)
    .eq("customer_id", customerId)
    .in("status", OPEN_ORDER_STATUSES)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const withItems = rows.find((o) => orderHasOperationalItems(o) || normStatus(o.status) === "active");
  if (withItems) return withItems;
  return rows[0] || null;
}

/** Chip corto para lista de clientas (último pedido relevante). */
export async function getOrderStatusChipForCustomers(customerIds) {
  const map = new Map();
  if (!customerIds?.length) return map;
  const sb = await getSb();
  if (!sb) return map;

  const { data, error } = await sb
    .from("orders")
    .select("id, customer_id, status, order_items(status)")
    .in("customer_id", customerIds)
    .order("created_at", { ascending: false });

  if (error || !Array.isArray(data)) return map;

  for (const cid of customerIds) {
    const orders = data.filter((o) => o.customer_id === cid);
    const active = orders.find(
      (o) =>
        OPEN_ORDER_STATUSES.includes(normStatus(o.status)) &&
        (orderHasOperationalItems(o) || normStatus(o.status) === "active")
    );
    if (active) {
      const hasWait = (active.order_items || []).some((i) => normStatus(i.status) === "waiting");
      const allPicked = (active.order_items || []).length > 0 &&
        (active.order_items || []).every((i) => ["picked", "waiting"].includes(normStatus(i.status)));
      let key = "active";
      if (hasWait) key = "waiting";
      else if (allPicked) key = "picked";
      map.set(cid, { label: PAU_ORDER_CHIP_LABELS[key] || "Pedido", tone: key === "waiting" ? "wait" : "active" });
      continue;
    }
    const latest = orders[0];
    if (!latest) continue;
    const st = normStatus(latest.status);
    if (PAU_ORDER_CHIP_LABELS[st]) {
      map.set(cid, {
        label: PAU_ORDER_CHIP_LABELS[st],
        tone: st === "closed" ? "closed" : st === "cancelled" ? "cancelled" : "muted",
      });
    }
  }
  return map;
}

/** Pedido vacío en régimen apartado (misma semántica que order-creator). */
export async function createApartadoOrder(customerId) {
  const existing = await findActiveOrderForCustomer(customerId);
  if (existing) return { order: existing, created: false };

  const result = await createNewOrder(customerId, [], 0, { pau_source: true });
  if (result?.reusedExisting) {
    const order = await findActiveOrderForCustomer(customerId);
    return { order, created: false };
  }
  return { order: result.order, created: true };
}

/**
 * Reparto general/venta por ítem — misma regla que resolveQrCodeToOrderItem / order-creator.
 * El split debe cumplir qty_from_general + qty_from_venta === quantity para rpc_apply_order_stock_deduction.
 */
export async function enrichDraftItemsWithStock(items) {
  await loadWarehouses();
  const sb = await getSb();
  const out = [];
  for (const item of items) {
    if (item.is_special_extra) {
      out.push(item);
      continue;
    }
    const variantId = item.variant_id;
    const size = normalizeSize(item.size);
    if (!variantId || !size) {
      out.push(item);
      continue;
    }
    const q = Number(item.quantity) || 1;
    const existingSplit =
      (Number(item.qty_from_general) || 0) + (Number(item.qty_from_venta) || 0);
    if (existingSplit === q) {
      out.push({ ...item, size });
      continue;
    }

    let stockGeneral = 0;
    let stockVenta = 0;
    if (warehousesCache.general && warehousesCache.ventaPublico) {
      const { data: rows } = await sb
        .from("variant_size_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", variantId)
        .eq("size", size)
        .in("warehouse_id", [warehousesCache.general, warehousesCache.ventaPublico]);
      (rows || []).forEach((r) => {
        if (r.warehouse_id === warehousesCache.general) stockGeneral = r.stock_qty || 0;
        if (r.warehouse_id === warehousesCache.ventaPublico) stockVenta = r.stock_qty || 0;
      });
    }
    const split = computeWarehouseQtySplitForOrderItem(q, stockGeneral, stockVenta);
    const hasStock = split.qty_from_general + split.qty_from_venta >= q;
    out.push({
      ...item,
      size,
      qty_from_general: split.qty_from_general,
      qty_from_venta: split.qty_from_venta,
      status: hasStock ? item.status || "picked" : "missing",
      admin_confirmed_missing: !hasStock,
    });
  }
  return out;
}

export async function addItemsToOrder(orderId, items) {
  if (!items?.length) {
    return { success: true, skipped: true };
  }
  const enriched = await enrichDraftItemsWithStock(items);
  await addItemsToExistingOrder(orderId, enriched, null, {});
  const refreshed = await fetchOrderById(orderId);
  return { success: true, order: refreshed };
}

export async function fetchOrderById(orderId) {
  const sb = await getSb();
  const { data, error } = await sb
    .from("orders")
    .select(`
      id,
      order_number,
      status,
      total_amount,
      customer_id,
      order_items (
        id,
        product_name,
        color,
        size,
        quantity,
        price_snapshot,
        status
      )
    `)
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function loadPaymentMethods() {
  const sb = await getSb();
  const { data, error } = await sb
    .from("payment_methods")
    .select("id, name")
    .order("name", { ascending: true });
  if (error) return [];
  return data || [];
}

/** Cierre a cerrados — mismo RPC que orders.js */
export async function closeOrder(orderId, paymentMethod) {
  if (!paymentMethod) {
    throw new Error("Seleccioná un método de pago.");
  }
  const sb = await getSb();
  const { error } = await sb.rpc("rpc_close_order", {
    p_order_id: orderId,
    p_payment_method: paymentMethod,
  });
  if (error) throw error;
  return fetchOrderById(orderId);
}

/** Copia clienta y pedido a venta al público — mismo RPC que orders.js `sendOrderToLocal`. */
export async function sendOrderToLocal(orderId) {
  if (!isValidUUID(orderId)) {
    throw new Error("Pedido inválido");
  }
  const sb = await getSb();
  const { data, error } = await sb.rpc("rpc_send_order_to_local", {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data;
}

/** Quitar ítem del pedido y devolver stock (mismo RPC que `orders.js` → `deleteOrderItemImmediate`). */
export async function removeOrderItemRestoreStock(orderItemId) {
  if (!isValidUUID(orderItemId)) {
    throw new Error("Ítem inválido");
  }
  const sb = await getSb();
  if (!sb) throw new Error("Supabase no disponible");

  const { data, error } = await sb.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: orderItemId,
  });
  if (error) throw error;
  if (!data || data.ok !== true) {
    throw new Error("No se pudo quitar el producto del pedido");
  }
  return data;
}

export { resolveQrCodeToOrderItem };

let warehousesCache = { general: null, ventaPublico: null };

async function loadWarehouses() {
  if (warehousesCache.general && warehousesCache.ventaPublico) return warehousesCache;
  const sb = await getSb();
  const { data } = await sb.from("warehouses").select("id, code");
  (data || []).forEach((w) => {
    if (w.code === "general") warehousesCache.general = w.id;
    if (w.code === "venta-publico") warehousesCache.ventaPublico = w.id;
  });
  return warehousesCache;
}

/** Productos agrupados para picker manual PAU (nombre → colores → talles). */
export async function searchProductsGroupedByPrefix(prefix) {
  const term = String(prefix || "").trim();
  if (term.length < 2) return [];
  const sb = await getSb();
  const lower = term.toLowerCase();
  const escaped = term.replace(/[%_]/g, "");

  const { data: products, error } = await sb
    .from("products")
    .select(`
      id,
      name,
      product_variants (
        id,
        color,
        price,
        sku,
        active
      )
    `)
    .ilike("name", `${escaped}%`)
    .in("status", ["active", "pending_stock", "draft"])
    .limit(12);

  if (error) throw error;

  const grouped = [];
  for (const product of products || []) {
    const nameMatches = String(product.name || "").toLowerCase().startsWith(lower);
    const variants = [];

    for (const v of product.product_variants || []) {
      if (!v?.id) continue;

      const { data: sizesData } = await sb
        .from("variant_sizes")
        .select("size, sku")
        .eq("variant_id", v.id);

      let sizes = (sizesData || [])
        .map((s) => ({ size: normalizeSize(s.size), sku: s.sku }))
        .filter((s) => s.size);

      const variantSkuMatch = String(v.sku || "").toLowerCase().startsWith(lower);
      const matchingSizes = sizes.filter((s) =>
        String(s.sku || "").toLowerCase().startsWith(lower)
      );

      if (!nameMatches && !variantSkuMatch && matchingSizes.length === 0) continue;

      if (!nameMatches && !variantSkuMatch) {
        sizes = matchingSizes;
      }

      if (!sizes.length) continue;

      variants.push({
        variant_id: v.id,
        color: v.color || "—",
        price_snapshot: v.price,
        sizes,
      });
    }

    if (variants.length > 0) {
      grouped.push({
        product_id: product.id,
        product_name: product.name,
        variants,
      });
    }
  }

  return grouped;
}

/** Búsqueda manual por prefijo de nombre (no contains en medio). */
export async function searchProductsByPrefix(prefix) {
  const term = String(prefix || "").trim();
  if (term.length < 2) return [];
  const sb = await getSb();
  await loadWarehouses();

  const { data: products, error } = await sb
    .from("products")
    .select(`
      id,
      name,
      product_variants (
        id,
        color,
        price,
        active
      )
    `)
    .ilike("name", `${term.replace(/[%_]/g, "")}%`)
    .in("status", ["active", "pending_stock", "draft"])
    .limit(15);

  if (error) throw error;

  const results = [];
  for (const product of products || []) {
    for (const v of product.product_variants || []) {
      if (!v?.id) continue;
      const { data: sizesData } = await sb
        .from("variant_sizes")
        .select("size, sku")
        .eq("variant_id", v.id);

      const sizes = (sizesData || []).map((s) => ({
        size: normalizeSize(s.size),
        sku: s.sku,
      })).filter((s) => s.size);

      const skuPrefix = sizes.some((s) => String(s.sku || "").toLowerCase().startsWith(term.toLowerCase()));
      const nameMatches = String(product.name || "").toLowerCase().startsWith(term.toLowerCase());
      if (!nameMatches && !skuPrefix) continue;

      for (const s of sizes.length ? sizes : [{ size: null, sku: null }]) {
        if (s.sku && !String(s.sku).toLowerCase().startsWith(term.toLowerCase()) && !nameMatches) continue;
        results.push({
          product_name: product.name,
          color: v.color,
          size: s.size,
          sku: s.sku,
          price_snapshot: v.price,
          variant_id: v.id,
          quantity: 1,
          status: "picked",
        });
      }
    }
  }

  return results.slice(0, 40);
}

/** Fusiona ítems iguales en draft (variante + talle + estado). */
export function mergeDraftItem(draft, item) {
  const key = `${item.variant_id}|${normalizeSize(item.size)}|${item.status}`;
  const idx = draft.findIndex(
    (d) =>
      d.variant_id === item.variant_id &&
      normalizeSize(d.size) === normalizeSize(item.size) &&
      d.status === item.status
  );
  if (idx >= 0) {
    draft[idx].quantity += item.quantity || 1;
    delete draft[idx].qty_from_general;
    delete draft[idx].qty_from_venta;
    return draft;
  }
  draft.push({ ...item, quantity: item.quantity || 1 });
  return draft;
}
