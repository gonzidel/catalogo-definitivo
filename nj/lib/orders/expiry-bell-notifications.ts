/**
 * Notificaciones virtuales de campana: pedidos a punto de vencer hoy.
 * Mismos criterios que el botón mobile en OrderCard.
 */

import { buildExpiryWarningMessage } from "@/lib/orders/customer-status-message";
import { getPrimaryColumnForActions } from "@/lib/orders/classification";
import { isOrderExpiringToday } from "@/lib/orders/deadline";
import {
  countRegularProductUnits,
  getCustomerFromOrder,
  isCancelledOrderItem,
  isCustomerSourcedOrder,
} from "@/lib/orders/domain";
import type { OrderMsgNotification } from "@/lib/orders/local-wait-notifications";
import type { AdminOrder } from "@/types/orders";

const EXPIRY_BELL_COLUMNS = new Set(["cancelled", "active", "picked", "waiting"]);

export function orderQualifiesForExpiryBell(order: AdminOrder): boolean {
  // Solo auto-gestión clienta (misma regla que campana cierre / local_wait).
  if (!isCustomerSourcedOrder(order)) return false;
  if (!isOrderExpiringToday(order)) return false;

  const column = getPrimaryColumnForActions(order);
  if (!EXPIRY_BELL_COLUMNS.has(column)) return false;

  const items = order.order_items || [];
  const operationalCount = countRegularProductUnits(
    items.filter((item) => !isCancelledOrderItem(item))
  );
  return operationalCount >= 4;
}

export function buildExpiryBellNotifications(
  orders: AdminOrder[],
  sentIds: Set<string>,
  dismissedIds?: Set<string>
): OrderMsgNotification[] {
  const message = buildExpiryWarningMessage();
  const createdAt = new Date().toISOString();

  return orders
    .filter((order) => {
      if (sentIds.has(order.id)) return false;
      if (dismissedIds?.has(order.id)) return false;
      return orderQualifiesForExpiryBell(order);
    })
    .map((order) => {
      const customer = getCustomerFromOrder(order);
      return {
        id: `expiry:${order.id}`,
        orderId: order.id,
        customerName: customer?.full_name?.trim() || "Cliente",
        phone: customer?.phone?.trim() || null,
        message,
        kind: "expiry_warning",
        copiedAt: null,
        createdAt,
      };
    });
}
