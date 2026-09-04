/**
 * Mensajes WhatsApp al cliente sobre el estado de productos del pedido
 * (apartados / sin stock). Usado en borrador Activos y en la campana
 * tras resolver espera local/depósito/fábrica (local diferido).
 */

import type { DraftChangesMap } from "@/lib/orders/draft-changes";
import {
  draftDefersCustomerMessage,
  draftHasWaitingLocal,
  usesRetiroLocalDeferredMessages,
} from "@/lib/orders/draft-changes";
import { calendarDaysUntil, getOrderDeadlineDate } from "@/lib/orders/deadline";
import {
  isCancelledOrderItem,
  isMissingOrderItem,
  isPickedOrderItem,
  isWaitingOrderItem,
} from "@/lib/orders/domain";
import { getWaitingSourceKind } from "@/lib/orders/waiting-source";
import type { AdminOrder, AdminOrderItem, WarehouseIds } from "@/types/orders";

export type MessageProfile = "shipping" | "retiro_local";

/** Dirección del local FYL (retiro zona especial). */
export const FYL_LOCAL_PICKUP_ADDRESS = "Av. Alberdi 1099";

export function formatItemProductLabel(item: {
  product_name?: string | null;
  color?: string | null;
  size?: string | null;
}): string {
  return [item.product_name || "Producto", item.color || "-", item.size || "-"].join(" · ");
}

export function getDashboardActiveOrderUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}/nj/dashboard?tab=active-order`;
  }
  return "/nj/dashboard?tab=active-order";
}

/** Plazo legible para WhatsApp: "mañana a las 15:00", "el 03/09 a las 15:00". */
export function formatPickupDeadlineForMessage(deadline: Date, now = Date.now()): string {
  const days = calendarDaysUntil(deadline, now);
  const time = deadline.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (days <= 0) return `hoy a las ${time}`;
  if (days === 1) return `mañana a las ${time}`;
  const dd = String(deadline.getDate()).padStart(2, "0");
  const mm = String(deadline.getMonth() + 1).padStart(2, "0");
  return `el ${dd}/${mm} a las ${time}`;
}

/** Plazo para mensaje "listo para retirar": p. ej. "mañana a las 15:00 hs" (hora real de cada pedido). */
export function formatPickupDeadlineForRetiroReadyMessage(
  deadline: Date,
  now = Date.now()
): string {
  const phrase = formatPickupDeadlineForMessage(deadline, now);
  return phrase.replace(/(\d{2}:\d{2})$/, "$1 hs");
}

export function resolvePickupDeadlineLabelForRetiroReady(
  order: Pick<AdminOrder, "created_at" | "dismantle_at">,
  now = Date.now()
): string | null {
  if (!order.dismantle_at) return null;
  const deadline = getOrderDeadlineDate(order.created_at, order.dismantle_at);
  if (Number.isNaN(deadline.getTime())) return null;
  return formatPickupDeadlineForRetiroReadyMessage(deadline, now);
}

/** Todo confirmado — plazo y Nº de pedido vienen del pedido (no son fijos). */
function buildRetiroAllConfirmedMessage(opts: {
  pickupDeadlineLabel?: string | null;
  orderNumber?: string | null;
  dashboardUrl: string;
}): string {
  const url = opts.dashboardUrl;
  const plazo = opts.pickupDeadlineLabel?.trim();
  const addressLine = plazo
    ? `Podés pasar por nuestro local en ${FYL_LOCAL_PICKUP_ADDRESS}. Tenés tiempo hasta ${plazo}.`
    : `Podés pasar por nuestro local en ${FYL_LOCAL_PICKUP_ADDRESS}.`;
  const orderNo = opts.orderNumber?.trim();
  const pickupHint = orderNo
    ? `Al retirar, indicá tu nombre o número de pedido ${orderNo}.`
    : "Al retirar, indicá tu nombre o número de pedido.";

  return [
    "Hola 👋 Tu pedido ya está listo para retirar.",
    addressLine,
    pickupHint,
    `Podés revisar tu pedido acá: ${url} 😊`,
  ].join("\n\n");
}

export function resolvePickupDeadlineLabel(
  order: Pick<AdminOrder, "created_at" | "dismantle_at">,
  now = Date.now()
): string | null {
  if (!order.dismantle_at) return null;
  const deadline = getOrderDeadlineDate(order.created_at, order.dismantle_at);
  if (Number.isNaN(deadline.getTime())) return null;
  return formatPickupDeadlineForMessage(deadline, now);
}

/** Aviso WhatsApp: último día de plazo antes del desarme (mín. 4 productos). */
export function buildExpiryWarningMessage(dashboardUrl?: string): string {
  const url = dashboardUrl ?? getDashboardActiveOrderUrl();
  return `Hola 👋 Tu pedido está a punto de vencer.

Recordá finalizarlo antes de que termine el plazo de reserva para evitar que se desarme.

Podés revisar tu pedido acá: ${url} 😊`;
}

/** Aviso WhatsApp: pedido ya vencido (columna Cancelados). */
export function buildExpiredOrderMessage(): string {
  return `Hola 👋 Tu pedido venció y se desarmó porque finalizó el plazo de reserva.

Si tenés alguna duda o necesitás ayuda, estamos a disposición 😊`;
}

export function buildCustomerStatusMessage(opts: {
  confirmedCount: number;
  missingLabels: string[];
  dashboardUrl?: string;
}): string {
  const missingLabels = opts.missingLabels.filter(Boolean);
  const url = opts.dashboardUrl ?? getDashboardActiveOrderUrl();
  const confirmedCount = Math.max(0, opts.confirmedCount);

  if (missingLabels.length === 0) {
    return `Hola 👋 Todos los productos de tu pedido ya están apartados y listos.

Podés revisar tu pedido cuando quieras desde acá: ${url} 😊`;
  }

  if (confirmedCount <= 0) {
    return `Hola 👋 No pudimos apartar los productos de tu pedido porque ya no quedan disponibles.

Podés revisar cuáles son desde acá: ${url}.

Cualquier consulta, podés escribirnos 😊`;
  }

  const countLabel =
    confirmedCount === 1 ? "1 producto" : `${confirmedCount} productos`;

  return `Hola 👋 Ya apartamos ${countLabel} de tu pedido, pero algunos ya no están disponibles.

Podés revisar cuáles quedaron apartados y cuáles faltaron desde acá: ${url}.

Cualquier consulta, podés escribirnos 😊`;
}

/** Mensajes retiro local diferido (con plazo de retiro cuando aplica). */
export function buildRetiroLocalCustomerStatusMessage(opts: {
  confirmedCount: number;
  missingLabels: string[];
  pickupDeadlineLabel?: string | null;
  orderNumber?: string | null;
  dashboardUrl?: string;
}): string {
  const missingLabels = opts.missingLabels.filter(Boolean);
  const url = opts.dashboardUrl ?? getDashboardActiveOrderUrl();
  const confirmedCount = Math.max(0, opts.confirmedCount);
  const plazo = opts.pickupDeadlineLabel?.trim();

  if (missingLabels.length === 0) {
    return buildRetiroAllConfirmedMessage({
      pickupDeadlineLabel: plazo,
      orderNumber: opts.orderNumber,
      dashboardUrl: url,
    });
  }

  if (confirmedCount <= 0) {
    return `Hola 👋 No pudimos preparar tu pedido porque los productos que elegiste ya no están disponibles.

Podés revisar el detalle de tu pedido acá: ${url}

Cualquier consulta, podés escribirnos 😊`;
  }

  const countLabel =
    confirmedCount === 1 ? "1 producto" : `${confirmedCount} productos`;

  const addressLine = plazo
    ? `Podés pasar por nuestro local en *${FYL_LOCAL_PICKUP_ADDRESS}*. Tenés tiempo hasta *${plazo}* para retirarlo.`
    : `Podés pasar por nuestro local en *${FYL_LOCAL_PICKUP_ADDRESS}*.`;

  return [
    "Hola 👋 Tu pedido ya está listo para retirar.",
    `Pudimos preparar *${countLabel}*, pero algunos ya no están disponibles.`,
    addressLine,
    `Podés revisar qué productos están listos y cuáles faltaron acá: ${url}`,
    "Cualquier consulta, podés escribirnos 😊",
  ].join("\n\n");
}

export function buildCustomerStatusMessageForOrder(
  order: Pick<
    AdminOrder,
    "local_deferred_pickup" | "created_at" | "dismantle_at" | "order_number"
  >,
  opts: {
    confirmedCount: number;
    missingLabels: string[];
    dashboardUrl?: string;
    now?: number;
  }
): string {
  if (usesRetiroLocalDeferredMessages(order)) {
    const plazoLabel = resolvePickupDeadlineLabelForRetiroReady(order, opts.now);
    return buildRetiroLocalCustomerStatusMessage({
      confirmedCount: opts.confirmedCount,
      missingLabels: opts.missingLabels,
      pickupDeadlineLabel: plazoLabel,
      orderNumber: order.order_number,
      dashboardUrl: opts.dashboardUrl,
    });
  }
  return buildCustomerStatusMessage({
    confirmedCount: opts.confirmedCount,
    missingLabels: opts.missingLabels,
    dashboardUrl: opts.dashboardUrl,
  });
}

/** Clasifica borrador + ítems finalizados para armar el mensaje inmediato. */
export function buildMessageFromOrderAndDraft(
  items: AdminOrderItem[],
  pending: DraftChangesMap,
  warehouseIds: WarehouseIds,
  order?: Pick<
    AdminOrder,
    "local_deferred_pickup" | "created_at" | "dismantle_at" | "order_number"
  >,
  dashboardUrl?: string
): string | null {
  if (!Object.keys(pending).length) return null;
  if (order && draftDefersCustomerMessage(pending, order)) return null;
  if (!order && draftHasWaitingLocal(pending)) return null;

  const localDeferred = order ? usesRetiroLocalDeferredMessages(order) : false;
  let confirmedCount = 0;
  const missingLabels: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const change = pending[item.id];
    if (change) {
      seen.add(item.id);
      const label = formatItemProductLabel(item);
      if (change.kind === "picked") {
        confirmedCount += 1;
      } else if (change.kind === "waiting-fabrica") {
        if (!localDeferred) confirmedCount += 1;
      } else if (change.kind === "missing") {
        missingLabels.push(label);
      } else if (change.kind === "split") {
        if (change.nPicked) confirmedCount += 1;
        if (change.nWaiting && change.waitingSource !== "local" && !localDeferred) {
          confirmedCount += 1;
        }
        if (change.nMissing) missingLabels.push(label);
      }
      continue;
    }

    if (isPickedOrderItem(item)) {
      seen.add(item.id);
      confirmedCount += 1;
      continue;
    }
    if (isMissingOrderItem(item)) {
      seen.add(item.id);
      missingLabels.push(formatItemProductLabel(item));
      continue;
    }
    if (isWaitingOrderItem(item)) {
      const kind = getWaitingSourceKind(item, warehouseIds);
      if (kind === "fabrica" && !localDeferred) {
        seen.add(item.id);
        confirmedCount += 1;
      }
    }
  }

  if (seen.size === 0 && confirmedCount === 0 && missingLabels.length === 0) return null;

  if (order) {
    return buildCustomerStatusMessageForOrder(order, {
      confirmedCount,
      missingLabels,
      dashboardUrl,
    });
  }

  return buildCustomerStatusMessage({ confirmedCount, missingLabels, dashboardUrl });
}

export interface PriorDecisionSnapshot {
  confirmedCount: number;
  missingLabels: string[];
}

/** Extrae prior del borrador (sin ítems que van a espera diferida). */
export function buildPriorDecisionFromDraft(
  items: AdminOrderItem[],
  pending: DraftChangesMap,
  order?: Pick<AdminOrder, "local_deferred_pickup">
): PriorDecisionSnapshot {
  const localDeferred = order ? usesRetiroLocalDeferredMessages(order) : false;
  let confirmedCount = 0;
  const missingLabels: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));

  for (const [itemId, change] of Object.entries(pending)) {
    const item = byId.get(itemId);
    const label = item ? formatItemProductLabel(item) : "Producto";

    if (change.kind === "picked") {
      confirmedCount += 1;
    } else if (change.kind === "waiting-fabrica" && !localDeferred) {
      confirmedCount += 1;
    } else if (change.kind === "missing") {
      missingLabels.push(label);
    } else if (change.kind === "split") {
      if (change.nPicked) confirmedCount += 1;
      if (change.nWaiting && change.waitingSource !== "local" && !localDeferred) {
        confirmedCount += 1;
      }
      if (change.nMissing) missingLabels.push(label);
    }
  }

  for (const item of items) {
    if (pending[item.id]) continue;
    if (isPickedOrderItem(item)) confirmedCount += 1;
    else if (isMissingOrderItem(item)) missingLabels.push(formatItemProductLabel(item));
  }

  return { confirmedCount, missingLabels };
}

/**
 * Estado resuelto del pedido para snapshot (mensaje campana).
 * Excluye ítems en espera local/depósito; en local diferido también excluye espera fábrica.
 */
export function buildPriorDecisionFromOrder(
  items: AdminOrderItem[],
  warehouseIds: WarehouseIds,
  order?: Pick<AdminOrder, "local_deferred_pickup">
): PriorDecisionSnapshot {
  const localDeferred = order ? usesRetiroLocalDeferredMessages(order) : false;
  let confirmedCount = 0;
  const missingLabels: string[] = [];

  for (const item of items) {
    if (isCancelledOrderItem(item)) continue;

    if (isPickedOrderItem(item)) {
      confirmedCount += 1;
      continue;
    }
    if (isMissingOrderItem(item)) {
      missingLabels.push(formatItemProductLabel(item));
      continue;
    }
    if (isWaitingOrderItem(item)) {
      const kind = getWaitingSourceKind(item, warehouseIds);
      if (kind === "fabrica" && !localDeferred) {
        confirmedCount += 1;
      }
    }
  }

  return { confirmedCount, missingLabels };
}

/** IDs de ítems en espera local/depósito tras confirmar borrador. */
export function collectWaitingLocalItemIdsFromDraft(
  draftSnapshot: DraftChangesMap,
  items: AdminOrderItem[],
  warehouseIds: WarehouseIds
): string[] {
  const ids = new Set<string>();
  for (const [itemId, change] of Object.entries(draftSnapshot)) {
    if (change.kind === "waiting-local") ids.add(itemId);
    else if (
      change.kind === "split" &&
      (change.nWaiting ?? 0) > 0 &&
      change.waitingSource === "local"
    ) {
      ids.add(itemId);
    }
  }
  for (const item of items) {
    if (getWaitingSourceKind(item, warehouseIds) === "local") ids.add(item.id);
  }
  return Array.from(ids);
}

/** IDs de ítems en espera fábrica (solo local diferido). */
export function collectWaitingFabricaItemIdsFromDraft(
  draftSnapshot: DraftChangesMap,
  items: AdminOrderItem[],
  warehouseIds: WarehouseIds,
  order: Pick<AdminOrder, "local_deferred_pickup">
): string[] {
  if (!usesRetiroLocalDeferredMessages(order)) return [];
  const ids = new Set<string>();
  for (const [itemId, change] of Object.entries(draftSnapshot)) {
    if (change.kind === "waiting-fabrica") ids.add(itemId);
    else if (
      change.kind === "split" &&
      (change.nWaiting ?? 0) > 0 &&
      change.waitingSource === "fabrica"
    ) {
      ids.add(itemId);
    }
  }
  for (const item of items) {
    if (getWaitingSourceKind(item, warehouseIds) === "fabrica") ids.add(item.id);
  }
  return Array.from(ids);
}

export function resolveMessageProfile(
  order: Pick<AdminOrder, "local_deferred_pickup">
): MessageProfile {
  return usesRetiroLocalDeferredMessages(order) ? "retiro_local" : "shipping";
}

/** Copy del dashboard tras cerrar pedido con retiro en el local. */
export type DashboardLocalPickupCloseCopy = {
  mode: "all_picked" | "partial_pending";
  title: string;
  lead: string;
  detail: string;
  progressLabel: string | null;
};

/** Mensaje en Mi pedido cuando la clienta cierra con retiro local seleccionado. */
export function getDashboardLocalPickupCloseCopy(opts: {
  orderNumber: string;
  totalFormatted: string;
  allItemsPicked: boolean;
  pickupDeadlineLabel?: string | null;
}): DashboardLocalPickupCloseCopy {
  const orderNo = opts.orderNumber?.trim();
  const plazo = opts.pickupDeadlineLabel?.trim();
  const deadlineHint = plazo
    ? ` Tenés tiempo hasta ${plazo}.`
    : " Tenés 48 horas para retirarlo.";

  if (opts.allItemsPicked) {
    return {
      mode: "all_picked",
      title: "Tu pedido está listo para retirar",
      lead: `Podés pasar por nuestro local en ${FYL_LOCAL_PICKUP_ADDRESS}.${deadlineHint} El total es ${opts.totalFormatted}.`,
      detail: orderNo
        ? `Al retirar, decinos tu nombre o el número de pedido ${orderNo}.`
        : "Al retirar, decinos tu nombre o tu número de pedido.",
      progressLabel: null,
    };
  }

  return {
    mode: "partial_pending",
    title: "Podés pasar a retirar tu pedido",
    lead: "Recibimos tu cierre. Todavía estamos confirmando algunos productos.",
    detail: orderNo
      ? `Si surge algún cambio, te avisamos por WhatsApp. El total estimado es ${opts.totalFormatted}. Al venir al local, indicá tu nombre o el pedido #${orderNo}.`
      : `Si surge algún cambio, te avisamos por WhatsApp. El total estimado es ${opts.totalFormatted}. Al venir al local, indicá tu nombre o tu número de pedido.`,
    progressLabel: "Confirmando algunos productos",
  };
}

export { usesRetiroLocalDeferredMessages };
