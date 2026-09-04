import { isCustomerSourcedOrder, parseOrderNotesObject } from "@/lib/orders/domain";
import { orderHasRetiroDepositWaiting, orderHasPedidosLocalWaiting } from "@/lib/orders/retiro-deposit-waiting";
import { isDashboardRetiroLocalZone, isLocalPickupTransport } from "@/lib/transport/shipping-helpers";
import type { AdminOrder, AdminOrderCustomer, WarehouseIds } from "@/types/orders";

export type BoardScope = "shipping" | "local_pickup";

/**
 * Color de origen en columna Apartados de Retiro:
 * - customer → verde (dashboard/clienta)
 * - moved → amarillo (enviado desde Pedidos)
 * - admin_local → celeste (public-sales / espejo / admin en retiro)
 */
export type RetiroActiveOriginTone = "customer" | "moved" | "from_closed" | "admin_local";

export function getRetiroActiveOriginTone(
  order: Pick<AdminOrder, "source" | "notes">
): RetiroActiveOriginTone {
  const notes = parseOrderNotesObject(order.notes);
  if (
    notes.mirrored_from_local_order === true ||
    notes.retiro_origin === "public_sales" ||
    notes.retiro_origin === "retiro" ||
    notes.retiro_origin === "admin_local"
  ) {
    return "admin_local";
  }

  const source = String(order.source || "").trim().toLowerCase();
  if (
    source === "admin" ||
    source === "pau" ||
    source.startsWith("admin/") ||
    source.startsWith("nj/admin")
  ) {
    return "admin_local";
  }

  if (notes.retiro_origin === "moved_from_closed") {
    return "from_closed";
  }

  if (notes.retiro_origin === "moved_from_orders" || notes.kanban_scope === "local_pickup") {
    return "moved";
  }

  if (isCustomerSourcedOrder(order)) return "customer";
  return "admin_local";
}

/** Retiro → Activos: común (clienta) arriba; luego Pedidos; luego Retiro/Caja. */
export function retiroActiveColumnSortKey(
  order: Pick<AdminOrder, "source" | "notes">
): number {
  const tone = getRetiroActiveOriginTone(order);
  if (tone === "customer") return 0;
  if (tone === "moved" || tone === "from_closed") return 1;
  return 2;
}

/** Override manual admin (notes.kanban_scope) para mover entre Pedidos ↔ Retiro. */
export function getKanbanScopeOverride(
  order: Pick<AdminOrder, "notes">
): BoardScope | null {
  const raw = parseOrderNotesObject(order.notes).kanban_scope;
  if (raw === "shipping" || raw === "local_pickup") return raw;
  return null;
}

function getOrderCustomer(
  order: Pick<AdminOrder, "customers">
): AdminOrderCustomer | null {
  const raw = order.customers;
  if (!raw) return null;
  return (Array.isArray(raw) ? raw[0] : raw) ?? null;
}

/**
 * Retiro local en Kanban: mismo criterio que el dashboard al asignar
 * "Retiro de Local":
 * - transporte Retira local / Retiro de Local
 * - local_deferred_pickup (checkout 309)
 * - geo dashboard (Chaco especial + Corrientes Capital), aunque el
 *   transport_id esté viejo (ej. MyM)
 *
 * notes.kanban_scope gana sobre geo/transporte (botón Local / Depósito).
 */
export function isLocalPickupBoardOrder(
  order: Pick<AdminOrder, "transportName" | "local_deferred_pickup" | "customers" | "notes">
): boolean {
  const override = getKanbanScopeOverride(order);
  if (override === "shipping") return false;
  if (override === "local_pickup") return true;

  if (isLocalPickupTransport(order.transportName)) return true;
  if (order.local_deferred_pickup) return true;

  const customer = getOrderCustomer(order);
  if (
    customer &&
    isDashboardRetiroLocalZone(customer.province, customer.city)
  ) {
    return true;
  }

  return false;
}

export function orderMatchesBoardScope(
  order: Pick<AdminOrder, "transportName" | "local_deferred_pickup" | "customers" | "notes">,
  scope: BoardScope
): boolean {
  const isPickup = isLocalPickupBoardOrder(order);
  return scope === "local_pickup" ? isPickup : !isPickup;
}

/** Destino del botón Apartados: Local ↔ Depósito (otro tablero). */
export function otherBoardScope(scope: BoardScope): BoardScope {
  return scope === "local_pickup" ? "shipping" : "local_pickup";
}

export function otherBoardButtonLabel(scope: BoardScope): string {
  return scope === "local_pickup" ? "Depósito" : "Local";
}

export function otherBoardTitle(scope: BoardScope): string {
  return scope === "local_pickup" ? "Pedidos" : "Retiro";
}

export function filterOrdersByBoardScope(
  orders: AdminOrder[],
  scope: BoardScope,
  options?: { warehouseIds?: WarehouseIds }
): AdminOrder[] {
  const wh = options?.warehouseIds;
  if (wh?.general || wh?.ventaPublico) {
    return orders.filter((order) => orderBelongsOnKanban(order, scope, wh));
  }
  return orders.filter((order) => orderMatchesBoardScope(order, scope));
}

/** Pedido visible en el tablero (incl. espera cruzada entre Pedidos ↔ Retiro). */
export function orderBelongsOnKanban(
  order: AdminOrder,
  scope: BoardScope,
  warehouseIds?: WarehouseIds
): boolean {
  if (orderMatchesBoardScope(order, scope)) return true;
  if (!warehouseIds) return false;
  if (
    scope === "shipping" &&
    isLocalPickupBoardOrder(order) &&
    orderHasRetiroDepositWaiting(order, warehouseIds)
  ) {
    return true;
  }
  if (
    scope === "local_pickup" &&
    !isLocalPickupBoardOrder(order) &&
    orderHasPedidosLocalWaiting(order, warehouseIds)
  ) {
    return true;
  }
  return false;
}

/** Label UI del origen waiting `local` (venta-publico). */
export function waitingLocalLabel(scope: BoardScope): string {
  return scope === "local_pickup" ? "Depósito" : "Local";
}

export function waitingLocalShortLabel(scope: BoardScope): string {
  return scope === "local_pickup" ? "D" : "L";
}

export function realtimeChannelForScope(scope: BoardScope): string {
  return scope === "local_pickup"
    ? "orders-kanban-retiro"
    : "orders-kanban-shipping";
}

export function boardTitleForScope(scope: BoardScope): string {
  return scope === "local_pickup" ? "Retiro" : "Pedidos";
}
