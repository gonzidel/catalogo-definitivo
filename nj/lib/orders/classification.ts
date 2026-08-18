import {
  isPickedManualConfirmed,
  orderHasCancelledItems,
  orderHasCancelledItemsPendingStockReturn,
  wantsCustomerClose,
} from "@/lib/orders/domain";
import { isOrderExpired } from "@/lib/orders/deadline";
import type { AdminOrder, KanbanColumnId } from "@/types/orders";

const STATUS = {
  ACTIVE: "active",
  CLOSING_SOON: "closing_soon",
  PICKED: "picked",
  CLOSED: "closed",
  SENT: "sent",
  WAITING: "waiting",
  CANCELLED: "cancelled",
  STOCK_PENDING: "stock_pending",
  DEVOLUCION: "devolución",
  DEVOLUCION_ALT: "devolucion",
  EXPIRED: "expired",
} as const;

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/**
 * Estados de pedido finales/terminales: no tienen columna propia en este Kanban.
 * "expired" ya se excluye en el fetch inicial (fetchOrdersInitial), pero un pedido
 * puede llegar igual acá vía patchOrder en tiempo real -- este check evita que
 * quede clasificando por ítems (que ya no son operacionales) y cayendo en null.
 */
export function isFinalOrderStatus(order: AdminOrder): boolean {
  const statusNorm = norm(order.status);
  return (
    statusNorm === STATUS.SENT ||
    statusNorm === STATUS.DEVOLUCION ||
    statusNorm === STATUS.DEVOLUCION_ALT ||
    statusNorm === STATUS.EXPIRED
  );
}

function hasAllItemsPicked(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  // Los ítems cancelados (p. ej. la clienta quitó uno del pedido, incluso uno que
  // ya estaba "sin stock") no cuentan para esta cuenta: no deben impedir que un
  // pedido con el resto ya apartado siga clasificando como Apartados. El ítem
  // cancelado se muestra aparte, dentro de la misma card, vía showCancelledBanner
  // en OrderCard — no hace falta mandar todo el pedido a Cancelados por eso.
  const items = order.order_items.filter((item) => norm(item.status) !== STATUS.CANCELLED);
  const totalItems = items.length;
  if (totalItems === 0) return false;
  // "missing" siempre cuenta como resuelto: si el local confirmó que no hay stock,
  // no queda nada más por revisar en Activos — el pedido pasa a Apartados con el
  // aviso "!" para que el admin decida si lo quita, aunque no se haya marcado
  // admin_confirmed_missing explícitamente.
  const pickedItems = items.filter((item) => {
    const st = norm(item.status);
    return (
      st === "picked" ||
      st === "waiting" ||
      st === "missing" ||
      isPickedManualConfirmed(item)
    );
  }).length;
  return pickedItems === totalItems;
}

function hasReservedItems(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  return order.order_items.some((item) => norm(item.status) === "reserved");
}

function hasItemsNeedingAttention(order: AdminOrder): boolean {
  if (!order.order_items || order.order_items.length === 0) return false;
  // "missing" ya no cuenta como pendiente de atención en Activos: una vez que el
  // local confirma que no hay stock no hay nada más que revisar ahí; el pedido
  // se resuelve hacia Apartados (con el aviso "!") en vez de quedar trabado.
  return order.order_items.some(
    (item) => norm(item.status) === "reserved" && !isPickedManualConfirmed(item)
  );
}

function hasWaitingItems(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) {
    return false;
  }
  return order.order_items.some((item) => norm(item.status) === "waiting");
}

function hasOrderPassedCustomerEditWindow(order: AdminOrder): boolean {
  if (!order || !order.created_at) return false;
  return isOrderExpired({ created_at: order.created_at, dismantle_at: order.dismantle_at });
}

function hasOperationalItems(order: AdminOrder): boolean {
  if (!order || !Array.isArray(order.order_items) || order.order_items.length === 0) return false;
  const operational = new Set(["reserved", "picked", "waiting", "missing"]);
  return order.order_items.some((item) => operational.has(norm(item.status)));
}

export function isExpiredPendingAdminDisassembly(order: AdminOrder): boolean {
  if (!order) return false;
  const status = norm(order.status);
  if (status === "cancelled" || isFinalOrderStatus(order)) {
    return false;
  }
  return hasOrderPassedCustomerEditWindow(order) && hasOperationalItems(order);
}

function matchesActiveTab(order: AdminOrder): boolean {
  const statusNorm = norm(order.status);
  if (statusNorm === STATUS.CLOSED || isFinalOrderStatus(order)) {
    return false;
  }
  if (isExpiredPendingAdminDisassembly(order)) return false;
  if (statusNorm === STATUS.ACTIVE) {
    if (!hasOperationalItems(order)) return false;
    // Si ya no quedan ítems reservados/pendientes de revisión, el pedido se va
    // de Activos (a Espera si tiene ítems waiting, o a Apartados si ya está todo picked),
    // aunque conviva con ítems ya apartados.
    if (!hasReservedItems(order) && !hasItemsNeedingAttention(order)) return false;
    return true;
  }
  if (!hasReservedItems(order) && !hasItemsNeedingAttention(order)) return false;
  if (hasAllItemsPicked(order) && !hasWaitingItems(order)) return false;
  return true;
}

function matchesWaitingTab(order: AdminOrder): boolean {
  if (norm(order.status) === STATUS.CLOSED || isFinalOrderStatus(order)) {
    return false;
  }
  if (!hasWaitingItems(order)) return false;
  if (matchesActiveTab(order)) return false;
  return true;
}

function matchesPickedTab(order: AdminOrder): boolean {
  if (norm(order.status) === STATUS.CLOSED || isFinalOrderStatus(order)) {
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
  const items = order.order_items || [];
  if (items.length === 0) return false;
  // Paridad admin/orders.js (filterOrders CANCELLED): cualquier ítem cancelado por la clienta.
  // Sin esto, pedido picked + ítem cancelled no entra en Apartados (hasAllItemsPicked=false)
  // ni en Cancelados (!hasOperational), y desaparece del tablero.
  return orderHasCancelledItems(order);
}

function matchesStockPendingTab(order: AdminOrder): boolean {
  return norm(order.status) === STATUS.STOCK_PENDING;
}

/**
 * Todos los ítems no cancelados están literalmente "picked" (apartados de verdad).
 * A propósito es más estricto que `hasAllItemsPicked` (que también cuenta "waiting"
 * y "missing" como resueltos para efectos de en qué columna se ve el pedido): acá
 * "missing"/"waiting" NO cuentan como listos, porque el criterio es "¿está todo
 * físicamente en mano para poder cerrar/enviar?", no "¿en qué columna se muestra?".
 */
function isOrderStrictlyFullyPicked(order: AdminOrder): boolean {
  if (norm(order.status) === STATUS.CLOSED || isFinalOrderStatus(order)) return false;
  if (orderHasCancelledItems(order)) return false;
  const items = (order.order_items || []).filter((item) => norm(item.status) !== STATUS.CANCELLED);
  if (items.length === 0) return false;
  return items.every((item) => norm(item.status) === STATUS.PICKED);
}

/**
 * La clienta ya pidió cerrar el pedido (`customer_requested_close` en notes) mientras
 * todavía tenía ítems reservados/en espera -- ver `ActiveOrderTab.handleSend`. El pedido
 * queda "en preparación" hasta que el admin termine de apartar todo. Este helper centraliza
 * el "¿ya está todo listo para cerrar solo?" para que se pueda invocar después de CUALQUIER
 * acción que resuelva ítems (apartar uno, apartar todos, dividir, confirmar cancelado) y no
 * solo desde el botón "Apartar todos" -- antes solo se chequeaba ahí y el resto de las
 * acciones dejaban el flag sin consumir (bug real, pedido quedaba en Apartados para siempre
 * esperando que alguien lo cierre a mano).
 *
 * A propósito NO cuenta "missing" como listo: si un ítem quedó marcado sin stock, cerrar
 * solo el pedido sería enviarlo incompleto sin que nadie lo revise -- el admin tiene que
 * cerrar ese caso a mano con el botón "Cerrar pedido".
 */
export function shouldAutoCloseAfterCustomerRequest(order: AdminOrder): boolean {
  return wantsCustomerClose(order) && isOrderStrictlyFullyPicked(order);
}

export function getOrderKanbanColumn(order: AdminOrder): KanbanColumnId | null {
  // Estados terminales (sent/devolución/expired) no tienen columna: no son operacionales.
  // Guard explícito acá (además del filtro en fetchOrdersInitial) por si un pedido llega
  // a este estado vía patchOrder en tiempo real mientras ya estaba cargado en memoria.
  if (isFinalOrderStatus(order)) return null;
  if (matchesStockPendingTab(order)) return "stock_pending";
  if (matchesClosedTab(order)) return "closed";
  // Vencidos ≥7d con ítems operacionales → Cancelados (antes que Apartados/Activos)
  if (isExpiredPendingAdminDisassembly(order)) return "cancelled";
  if (matchesActiveTab(order)) return "active";
  if (matchesWaitingTab(order)) return "waiting";
  if (matchesPickedTab(order)) {
    // La clienta canceló unidades de un ítem ya apartado (con stock_sources qty>0)
    // → Cancelados para que el admin confirme y devuelva stock. Una vez confirmado
    // (fila eliminada) vuelve a Apartados. Cancelaciones de reserved/waiting o de
    // missing no cuentan: el stock ya volvió (o nunca hubo) y el pedido sigue acá.
    if (orderHasCancelledItemsPendingStockReturn(order)) return "cancelled";
    return "picked";
  }
  if (matchesCancelledTab(order)) return "cancelled";
  if (orderHasCancelledItems(order)) return "cancelled";
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
