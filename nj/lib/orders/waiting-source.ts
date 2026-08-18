import { normalizeOrderItemStatus, orderHasMissingItem } from "@/lib/orders/domain";
import type { AdminOrder, AdminOrderItem, WarehouseIds } from "@/types/orders";

export type WaitingSourceKind = "fabrica" | "local";

export function itemUsesVentaPublicoSource(
  item: WaitingItemLike,
  warehouseIds: WarehouseIds
): boolean {
  const vId = warehouseIds.ventaPublico;
  if (!vId) return false;
  const src = item.order_item_stock_sources;
  if (!Array.isArray(src) || src.length === 0) return false;
  let vq = 0;
  let gq = 0;
  const gId = warehouseIds.general;
  for (const row of src) {
    const q = Number(row?.qty || 0) || 0;
    if (row?.warehouse_id === vId) vq += q;
    if (gId && row?.warehouse_id === gId) gq += q;
  }
  return vq > 0 && gq === 0;
}

type WaitingItemLike = {
  status?: string | null;
  warehouseLabel?: AdminOrderItem["warehouseLabel"];
  order_item_stock_sources?: AdminOrderItem["order_item_stock_sources"];
};

export function getWaitingSourceKind(
  item: WaitingItemLike,
  warehouseIds: WarehouseIds
): WaitingSourceKind | null {
  if (normalizeOrderItemStatus(item.status) !== "waiting") return null;
  if (item.warehouseLabel === "Local") return "local";
  if (item.warehouseLabel === "General") return "fabrica";
  if (itemUsesVentaPublicoSource(item, warehouseIds)) return "local";
  return "fabrica";
}

export function getCustomerFacingItemStatus(
  item: WaitingItemLike,
  warehouseIds: WarehouseIds
): string {
  const st = normalizeOrderItemStatus(item.status);
  if (st === "waiting") {
    // Espera de fábrica: se va a producir, es prácticamente un hecho -> se
    // muestra como "Confirmado" para no generar ansiedad de más.
    // Espera local: depende de que vuelva a entrar stock al depósito local,
    // todavía no está garantizado -> se muestra como "Reservado" (no
    // confirmado), igual que un ítem recién reservado por stock.
    const kind = getWaitingSourceKind(item, warehouseIds);
    return kind === "fabrica" ? "picked" : "reserved";
  }
  return st;
}

export function orderHasWaitingSource(
  order: AdminOrder,
  kind: WaitingSourceKind,
  warehouseIds: WarehouseIds
): boolean {
  return (order.order_items || []).some(
    (item) => getWaitingSourceKind(item, warehouseIds) === kind
  );
}

export function getWaitingColumnSortKey(
  order: AdminOrder,
  warehouseIds: WarehouseIds
): number {
  // Pedidos con algún producto "Falta" van al final de Espera: no hay nada para
  // conseguir en ese producto, así que no deben competir por atención con los
  // que sí tienen unidades genuinamente en camino (local/fábrica).
  const missingPenalty = orderHasMissingItem(order) ? 10 : 0;
  if (orderHasWaitingSource(order, "local", warehouseIds)) return missingPenalty + 0;
  if (orderHasWaitingSource(order, "fabrica", warehouseIds)) return missingPenalty + 1;
  return missingPenalty + 2;
}

