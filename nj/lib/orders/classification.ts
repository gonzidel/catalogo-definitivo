import {
  isManualMissingOrderItem,
  isPickedManualConfirmed,
} from "@/lib/orders/domain";
import type { AdminOrder, KanbanColumnId } from "@/types/orders";

const STATUS = {
  ACTIVE: "active",
  PICKED: "picked",
  CLOSED: "closed",
  SENT: "sent",
  WAITING: "waiting",
  CANCELLED: "cancelled",
  STOCK_PENDING: "stock_pending",
  DEVOLUCION: "devolución",
  DEVOLUCION_ALT: "devolucion",
} as const;

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

function hasAllItemsPicked(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  const items = order.order_items;
  const totalItems = items.length;
  const pickedItems = items.filter((item) => {
    const st = norm(item.status);
    return (
      st === "picked" ||
      st === "waiting" ||
      isManualMissingOrderItem(item) ||
      isPickedManualConfirmed(item)
    );
  }).length;
  return pickedItems === totalItems && totalItems > 0;
}

function hasReservedItems(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  return order.order_items.some((item) => norm(item.status) === "reserved");
}

function hasItemsNeedingAttention(order: AdminOrder): boolean {
  if (!order.order_items || order.order_items.length === 0) return false;
  return order.order_items.some(
    (item) =>
      (item.status === "reserved" || item.status === "missing") &&
      !isManualMissingOrderItem(item) &&
      !isPickedManualConfirmed(item)
  );
}

function hasWaitingItems(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  return order.order_items.some((item) => norm(item.status) === "waiting");
}

function hasOnlyWaitingItems(order: AdminOrder): boolean {
  if (!order.order_items || order.order_items.length === 0) return false;
  return order.order_items.every((item) => norm(item.status) === "waiting");
}

function hasOrderPassedCustomerEditWindow(order: AdminOrder): boolean {
  if (!order) return false;
  const nowMs = Date.now();
  const dismantleAtMs = order?.dismantle_at ? new Date(order.dismantle_at).getTime() : NaN;
  if (Number.isFinite(dismantleAtMs)) return nowMs >= dismantleAtMs;
  const createdAtMs = order.created_at ? new Date(order.created_at).getTime() : NaN;
  if (!Number.isFinite(createdAtMs)) return false;
  const daysElapsed = (nowMs - createdAtMs) / (1000 * 60 * 60 * 24);
  return daysElapsed >= 7;
}

function hasOperationalItems(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) return false;
  const operational = new Set(["reserved", "picked", "waiting", "missing"]);
  return order.order_items.some((item) => operational.has(norm(item.status)));
}

export function isExpiredPendingAdminDisassembly(order: AdminOrder): boolean {
  if (!order) return false;
  const status = norm(order.status);
  if (
    status === "sent" ||
    status === "cancelled" ||
    status === STATUS.DEVOLUCION ||
    status === STATUS.DEVOLUCION_ALT
  ) {
    return false;
  }
  return hasOrderPassedCustomerEditWindow(order) && hasOperationalItems(order);
}

function matchesActiveTab(order: AdminOrder): boolean {
  const statusNorm = norm(order.status);
  if (
    statusNorm === STATUS.CLOSED ||
    statusNorm === STATUS.SENT ||
    statusNorm === STATUS.DEVOLUCION ||
    statusNorm === STATUS.DEVOLUCION_ALT
  ) {
    return false;
  }
  if (isExpiredPendingAdminDisassembly(order)) return false;
  if (statusNorm === STATUS.ACTIVE) {
    if (!hasOperationalItems(order)) return false;
    if (hasOnlyWaitingItems(order)) return false;
    if (hasAllItemsPicked(order) && !hasWaitingItems(order)) return false;
    return true;
  }
  if (!hasReservedItems(order) && !hasItemsNeedingAttention(order)) return false;
  if (hasAllItemsPicked(order) && !hasWaitingItems(order)) return false;
  return true;
}

function matchesWaitingTab(order: AdminOrder): boolean {
  if (
    order.status === STATUS.CLOSED ||
    order.status === STATUS.SENT ||
    order.status === STATUS.DEVOLUCION
  ) {
    return false;
  }
  if (!hasWaitingItems(order)) return false;
  if (matchesActiveTab(order)) return false;
  return true;
}

function matchesPickedTab(order: AdminOrder): boolean {
  if (
    order.status === STATUS.CLOSED ||
    order.status === STATUS.SENT ||
    order.status === STATUS.DEVOLUCION
  ) {
    return false;
  }
  if (isExpiredPendingAdminDisassembly(order)) return false;
  if (hasWaitingItems(order)) return false;
  if (!hasAllItemsPicked(order)) return false;
  if (hasReservedItems(order)) return false;
  return true;
}

function matchesClosedTab(order: AdminOrder): boolean {
  return norm(order.status) === STATUS.CLOSED;
}

function matchesCancelledTab(order: AdminOrder): boolean {
  const hasCancelledItems = (order.order_items || []).some(
    (item) => norm(item.status) === "cancelled"
  );
  return hasCancelledItems;
}

function matchesStockPendingTab(order: AdminOrder): boolean {
  return norm(order.status) === STATUS.STOCK_PENDING;
}

export function getOrderKanbanColumn(order: AdminOrder): KanbanColumnId | null {
  if (matchesStockPendingTab(order)) return "stock_pending";
  if (matchesClosedTab(order)) return "closed";
  // Vencidos ≥7d con ítems operacionales → Cancelados (antes que Apartados/Activos)
  if (isExpiredPendingAdminDisassembly(order)) return "cancelled";
  if (matchesActiveTab(order)) return "active";
  if (matchesWaitingTab(order)) return "waiting";
  if (matchesPickedTab(order)) return "picked";
  if (matchesCancelledTab(order)) return "cancelled";
  return null;
}

export function filterOrdersForColumn(
  orders: AdminOrder[],
  columnId: KanbanColumnId
): AdminOrder[] {
  return orders.filter((order) => getOrderKanbanColumn(order) === columnId);
}

export function getPrimaryColumnForActions(order: AdminOrder): KanbanColumnId {
  return getOrderKanbanColumn(order) ?? "active";
}
