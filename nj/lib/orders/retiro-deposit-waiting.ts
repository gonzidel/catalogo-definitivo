import { isLocalPickupBoardOrder, type BoardScope } from "@/lib/orders/board-scope";
import { normalizeOrderItemStatus } from "@/lib/orders/domain";
import { getWaitingSourceKind } from "@/lib/orders/waiting-source";
import type { AdminOrder, AdminOrderItem, WarehouseIds } from "@/types/orders";

/** Ítem en espera Depósito (Retiro / zona deferred): pendiente confirmación del área. */
export function isRetiroDepositWaitingItem(
  item: Pick<
    AdminOrderItem,
    "status" | "warehouseLabel" | "order_item_stock_sources" | "deferred_stock_pending"
  >,
  order: Pick<AdminOrder, "transportName" | "local_deferred_pickup" | "customers" | "notes">,
  warehouseIds: WarehouseIds
): boolean {
  if (normalizeOrderItemStatus(item.status) !== "waiting") return false;
  if (!isLocalPickupBoardOrder(order)) return false;
  if (item.deferred_stock_pending === true) return true;
  return getWaitingSourceKind(item, warehouseIds) === "local";
}

export function orderHasRetiroDepositWaiting(
  order: AdminOrder,
  warehouseIds: WarehouseIds
): boolean {
  return (order.order_items || []).some((item) =>
    isRetiroDepositWaitingItem(item, order, warehouseIds)
  );
}

/** Ítem en espera Local (Pedidos / envío): visible también en Retiro → Espera. */
export function isPedidosLocalWaitingItem(
  item: Pick<
    AdminOrderItem,
    "status" | "warehouseLabel" | "order_item_stock_sources"
  >,
  order: Pick<AdminOrder, "transportName" | "local_deferred_pickup" | "customers" | "notes">,
  warehouseIds: WarehouseIds
): boolean {
  if (normalizeOrderItemStatus(item.status) !== "waiting") return false;
  if (isLocalPickupBoardOrder(order)) return false;
  return getWaitingSourceKind(item, warehouseIds) === "local";
}

export function orderHasPedidosLocalWaiting(
  order: AdminOrder,
  warehouseIds: WarehouseIds
): boolean {
  return (order.order_items || []).some((item) =>
    isPedidosLocalWaitingItem(item, order, warehouseIds)
  );
}

/** Morado Depósito (Retiro) vs verde Local (Pedidos) en columna Espera. */
export function getWaitingLocalVisualKind(
  order: AdminOrder,
  boardScope: BoardScope,
  warehouseIds: WarehouseIds
): "deposito" | "local" {
  if (boardScope === "local_pickup") {
    if (orderHasPedidosLocalWaiting(order, warehouseIds)) return "local";
    return "deposito";
  }
  if (orderHasRetiroDepositWaiting(order, warehouseIds)) return "deposito";
  return "local";
}
