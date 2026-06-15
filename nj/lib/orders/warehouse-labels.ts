import { normalizeSize } from "@/lib/utils/size-normalizer";
import type { AdminOrder, AdminOrderItem, WarehouseIds, WarehouseLabel } from "@/types/orders";
import type { SupabaseClient } from "@supabase/supabase-js";

export function fillWarehouseMapFromSources(
  items: AdminOrderItem[],
  map: Map<string, WarehouseLabel>,
  warehouseIds: WarehouseIds
): void {
  const g = warehouseIds.general;
  const v = warehouseIds.ventaPublico;
  if (!g || !v) return;
  for (const item of items || []) {
    const src = item.order_item_stock_sources;
    if (!Array.isArray(src) || src.length === 0) continue;
    if (src.length === 1) {
      const wid = src[0].warehouse_id;
      if (wid === g) map.set(item.id, "General");
      else if (wid === v) map.set(item.id, "Local");
    } else {
      map.set(item.id, "Mixto");
    }
  }
}

function inferWarehouseFromStockRows(
  stockGeneral: number,
  stockVenta: number,
  quantity: number
): WarehouseLabel {
  const q = Math.max(0, Number(quantity) || 0);
  if (q <= 0) return null;
  let qtyFromVenta = 0;
  let qtyFromGeneral = 0;
  if (stockVenta > 0) {
    qtyFromVenta = Math.min(q, stockVenta);
    const remaining = q - qtyFromVenta;
    if (remaining > 0 && stockGeneral > 0) {
      qtyFromGeneral = Math.min(remaining, stockGeneral);
    }
  } else if (stockGeneral > 0) {
    qtyFromGeneral = Math.min(q, stockGeneral);
  }
  if (qtyFromVenta > 0 && qtyFromGeneral > 0) return "Mixto";
  if (qtyFromVenta > 0) return "Local";
  if (qtyFromGeneral > 0) return "General";
  return null;
}

export async function batchResolveReservedWarehouseLabels(
  supabase: SupabaseClient,
  items: AdminOrderItem[],
  warehouseIds: WarehouseIds,
  existingMap: Map<string, WarehouseLabel>
): Promise<Map<string, WarehouseLabel>> {
  const map = new Map(existingMap);
  const g = warehouseIds.general;
  const v = warehouseIds.ventaPublico;
  if (!g || !v) return map;

  const pending = (items || []).filter(
    (item) =>
      String(item.status || "").trim().toLowerCase() === "reserved" &&
      item.variant_id &&
      !map.has(item.id)
  );
  if (pending.length === 0) return map;

  const variantIds = [...new Set(pending.map((i) => i.variant_id!).filter(Boolean))];
  const { data: stockRows } = await supabase
    .from("variant_size_warehouse_stock")
    .select("variant_id, size, warehouse_id, stock_qty")
    .in("variant_id", variantIds)
    .in("warehouse_id", [g, v]);

  const stockIndex = new Map<string, { general: number; venta: number }>();
  for (const row of stockRows || []) {
    const sizeKey = normalizeSize(row.size);
    const key = `${row.variant_id}|${sizeKey}`;
    const entry = stockIndex.get(key) ?? { general: 0, venta: 0 };
    if (row.warehouse_id === g) entry.general = row.stock_qty || 0;
    if (row.warehouse_id === v) entry.venta = row.stock_qty || 0;
    stockIndex.set(key, entry);
  }

  for (const item of pending) {
    const sizeKey = normalizeSize(item.size);
    const key = `${item.variant_id}|${sizeKey}`;
    const stocks = stockIndex.get(key) ?? { general: 0, venta: 0 };
    const label = inferWarehouseFromStockRows(stocks.general, stocks.venta, item.quantity);
    if (label) map.set(item.id, label);
  }

  return map;
}

export async function enrichOrderItemsWithWarehouseLabels(
  supabase: SupabaseClient | null,
  orders: AdminOrder[],
  warehouseIds: WarehouseIds
): Promise<AdminOrder[]> {
  const allItems: AdminOrderItem[] = [];
  for (const order of orders) {
    for (const item of order.order_items || []) {
      allItems.push(item);
    }
  }

  const map = new Map<string, WarehouseLabel>();
  fillWarehouseMapFromSources(allItems, map, warehouseIds);

  let finalMap = map;
  if (supabase) {
    finalMap = await batchResolveReservedWarehouseLabels(
      supabase,
      allItems,
      warehouseIds,
      map
    );
  }

  return orders.map((order) => ({
    ...order,
    order_items: (order.order_items || []).map((item) => ({
      ...item,
      warehouseLabel: finalMap.get(item.id) ?? item.warehouseLabel ?? null,
    })),
  }));
}
