import { normalizeSize } from "@/lib/utils/size-normalizer";
import type { AdminOrder, AdminOrderItem } from "@/types/orders";

export function isManualMissingOrderItem(item: AdminOrderItem | null | undefined): boolean {
  const status = String(item?.status || "").trim().toLowerCase();
  return status === "missing" && Boolean(item?.admin_confirmed_missing);
}

export function isPickedManualConfirmed(item: AdminOrderItem | null | undefined): boolean {
  const status = String(item?.status || "").trim().toLowerCase();
  return status === "picked" && Boolean(item?.admin_confirmed_missing);
}

export function parseOrderNotesObject(rawNotes: string | null | undefined): Record<string, unknown> {
  if (!rawNotes) return {};
  try {
    const parsed = JSON.parse(String(rawNotes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

/** La clienta presionó "Enviar pedido" con ítems todavía reservados/en espera. */
export function wantsCustomerClose(order: Pick<AdminOrder, "notes"> | null | undefined): boolean {
  return Boolean(parseOrderNotesObject(order?.notes)?.customer_requested_close);
}

export interface StockPendingConflict {
  variant_id: string;
  size: string;
  available: number;
  requested: number;
}

export function parseStockPendingReasonConflict(rawReason: string | null | undefined): StockPendingConflict | null {
  const reason = String(rawReason || "");
  if (!reason) return null;
  const variantMatch = reason.match(/variant=([0-9a-fA-F-]{36})/);
  const sizeMatch = reason.match(/size=([^,\s)]+)/i);
  const availableMatch = reason.match(/disponible=(\d+)/i);
  const requestedMatch = reason.match(/solicitado=(\d+)/i);
  if (!variantMatch) return null;
  return {
    variant_id: variantMatch[1],
    size: normalizeSize(sizeMatch?.[1] || ""),
    available: Number(availableMatch?.[1] || 0),
    requested: Number(requestedMatch?.[1] || 0),
  };
}

export function describeStockPendingConflict(
  order: AdminOrder,
  parsedConflict: StockPendingConflict | null,
  fallbackReason = ""
): string {
  if (!parsedConflict?.variant_id) return fallbackReason || "Conflicto de stock sin detalle.";
  const items = Array.isArray(order?.order_items) ? order.order_items : [];
  const targetItem = items.find((item) => {
    const sameVariant = String(item?.variant_id || "") === String(parsedConflict.variant_id);
    const sameSize = normalizeSize(item?.size || "") === parsedConflict.size;
    return sameVariant && sameSize;
  });
  if (!targetItem) return fallbackReason || "Conflicto de stock sin detalle.";
  const productLabel = [
    targetItem.product_name || "Producto",
    targetItem.color || "-",
    targetItem.size || "-",
  ].join(" · ");
  return `${productLabel} | Disponible: ${parsedConflict.available} · Solicitado: ${parsedConflict.requested}`;
}

export function formatPriceAr(amount: number | null | undefined): string {
  const n = Number(amount) || 0;
  return `$${n.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}

export function getOrderItemLineTotal(item: {
  price_snapshot?: number | null;
  quantity?: number | null;
}): number {
  return (Number(item.price_snapshot) || 0) * (Number(item.quantity) || 0);
}

export function normalizePhoneDigitsForMatch(text: string | null | undefined): string {
  let d = String(text || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("54") && d.length > 10) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

export function buildWhatsAppUrl(phone: string | null | undefined): string | null {
  const digits = normalizePhoneDigitsForMatch(phone);
  if (!digits || digits.length < 8) return null;
  return `https://wa.me/549${digits}`;
}

export function getOrderDisplayNumber(order: AdminOrder): string {
  if (order.order_number) return String(order.order_number);
  return order.id.slice(0, 8);
}

export function getCustomerFromOrder(order: AdminOrder) {
  const c = order.customers;
  if (Array.isArray(c)) return c[0] ?? null;
  return c ?? null;
}

export function getDaysSinceCreation(createdAt: string): number {
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return 0;
  return Math.floor((Date.now() - createdMs) / (1000 * 60 * 60 * 24));
}

export function getTransportBadgeClass(transportName: string | null | undefined): string {
  const key = String(transportName || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (key === "correo argentino") return "order-card-transport--correo-argentino";
  if (key === "sede") return "order-card-transport--sede";
  if (key === "credifin") return "order-card-transport--credifin";
  if (key === "via cargo" || key === "via carlo") return "order-card-transport--via-cargo";
  if (key === "mym") return "order-card-transport--mym";
  if (key === "snaider") return "order-card-transport--snaider";
  if (key.includes("retira") || key.includes("local")) return "order-card-transport--retira-local";
  return "order-card-transport--default";
}

export function getSourceIcon(source: string | null | undefined): string {
  return String(source || "").trim().toLowerCase() === "admin" ? "💬" : "🌐";
}

/** Pedidos hechos por la clienta (dashboard/catálogo). Default en DB: customer. */
export function isCustomerSourcedOrder(order: { source?: string | null } | null | undefined): boolean {
  const s = String(order?.source || "").trim().toLowerCase();
  if (!s) return true;
  return s !== "admin" && s !== "pau" && !s.startsWith("admin/") && !s.startsWith("nj/admin");
}

export const ADMIN_ENABLE_24H_USES_KEY = "admin_enable_24h_uses";

export function applyOrderNotesPatch(
  rawNotes: string | null | undefined,
  patch: Record<string, unknown>
): string {
  const obj = parseOrderNotesObject(rawNotes);
  return JSON.stringify({ ...obj, ...patch });
}

export function formatOrderNotesExtras(order: AdminOrder): string[] {
  const notes = parseOrderNotesObject(order.notes);
  const lines: string[] = [];

  const shipping = Number(notes.shipping ?? notes.shipping_cost ?? 0);
  const discount = Number(notes.discount ?? 0);
  const extrasAmount = Number(notes.extras_amount ?? notes.extras ?? 0);
  const extrasPercentage = Number(notes.extras_percentage ?? 0);
  const extrasLabel = resolveExtrasDisplayName({
    extras_label: String(notes.extras_label ?? notes.extras_name ?? ""),
  });

  if (shipping > 0) lines.push(`Envío: ${formatPriceAr(shipping)}`);
  if (discount > 0) lines.push(`Descuento: -${formatPriceAr(discount)}`);
  if (extrasAmount > 0) lines.push(`${extrasLabel}: ${formatPriceAr(extrasAmount)}`);

  if (extrasPercentage > 0) {
    const subtotal = (order.order_items || []).reduce((sum, item) => {
      const price = Number(item.price_snapshot) || 0;
      const qty = Number(item.quantity) || 0;
      return sum + price * qty;
    }, 0);
    lines.push(
      `${extrasLabel} (${extrasPercentage}%): ${formatPriceAr((subtotal * extrasPercentage) / 100)}`
    );
  }

  return lines;
}

export interface OrderNotesExtras {
  shipping: number;
  discount: number;
  extras_amount: number;
  extras_percentage: number;
  /** Nombre/motivo del extra fijo ($). Vacío → se muestra "Extra". */
  extras_label: string;
}

export function resolveExtrasDisplayName(
  notesExtras: Pick<OrderNotesExtras, "extras_label"> | { extras_label?: string }
): string {
  const label = String(notesExtras.extras_label || "").trim();
  return label || "Extra";
}

export function getEnable24hUsesFromOrder(order: AdminOrder): number {
  const notes = parseOrderNotesObject(order.notes);
  const n = Number(notes[ADMIN_ENABLE_24H_USES_KEY] || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function parseOrderNotesExtrasValues(
  rawNotes: string | null | undefined
): OrderNotesExtras {
  const notes = parseOrderNotesObject(rawNotes);
  return {
    shipping: Math.max(0, Number(notes.shipping ?? notes.shipping_cost ?? 0) || 0),
    discount: Math.max(0, Number(notes.discount ?? 0) || 0),
    extras_amount: Math.max(0, Number(notes.extras_amount ?? notes.extras ?? 0) || 0),
    extras_percentage: Math.max(0, Number(notes.extras_percentage ?? 0) || 0),
    extras_label: String(notes.extras_label ?? notes.extras_name ?? "").trim(),
  };
}

export function isSpecialExtraItem(item: {
  variant_id?: string | null;
  color?: string | null;
  size?: string | null;
  is_special_extra?: boolean | null;
} | null | undefined): boolean {
  if (!item) return false;
  if (item.is_special_extra === true) return true;
  return !item.variant_id && !item.color && !item.size;
}

export function normalizeOrderItemStatus(status: unknown): string {
  return String(status ?? "reserved").trim().toLowerCase();
}

export function isPickedOrderItem(item: AdminOrderItem): boolean {
  if (isSpecialExtraItem(item)) return false;
  return normalizeOrderItemStatus(item.status) === "picked";
}

export function isReservedOrderItem(item: AdminOrderItem): boolean {
  return normalizeOrderItemStatus(item.status) === "reserved";
}

export function isWaitingOrderItem(item: AdminOrderItem): boolean {
  return normalizeOrderItemStatus(item.status) === "waiting";
}

export function isCancelledOrderItem(item: AdminOrderItem): boolean {
  return normalizeOrderItemStatus(item.status) === "cancelled";
}

export function getCancelledOrderItems(order: AdminOrder): AdminOrderItem[] {
  return (order.order_items || []).filter(isCancelledOrderItem);
}

export function orderHasCancelledItems(order: AdminOrder): boolean {
  return getCancelledOrderItems(order).length > 0;
}

/**
 * Un ítem cancelado necesita que el admin confirme la devolución física de stock
 * solo cuando realmente hay algo apartado pendiente de devolver.
 *
 * Reglas (ambas deben cumplirse):
 * 1. NO viene de "missing" (`admin_confirmed_missing=true`, migración 269): el
 *    local avisó que no existía físicamente; no hay nada que devolver aunque
 *    arrastre trazas obsoletas heredadas de un split previo.
 * 2. Todavía tiene `order_item_stock_sources` con qty > 0: eso solo queda cuando
 *    se canceló un ítem ya "picked"/Apartado (rpc_cancel_order_item NO restaura
 *    stock automáticamente en ese caso). Si se canceló estando "reserved" o
 *    "waiting", el mismo RPC ya devolvió el stock y borró las fuentes — ese
 *    producto nunca estuvo confirmado/apartado y NO debe aparecer en el banner
 *    amarillo de "confirmá para devolver stock".
 */
export function cancelledItemNeedsStockConfirmation(item: AdminOrderItem): boolean {
  if (!isCancelledOrderItem(item)) return false;
  if (item.admin_confirmed_missing) return false;
  const sources = item.order_item_stock_sources ?? [];
  return sources.some((s) => Number(s?.qty ?? 0) > 0);
}

export function getCancelledItemsPendingStockReturn(order: AdminOrder): AdminOrderItem[] {
  return getCancelledOrderItems(order).filter(cancelledItemNeedsStockConfirmation);
}

export function orderHasCancelledItemsPendingStockReturn(order: AdminOrder): boolean {
  return getCancelledItemsPendingStockReturn(order).length > 0;
}

export function countPickedOrderItems(items: AdminOrderItem[]): number {
  return items.filter(isPickedOrderItem).length;
}

/** Ítem sin stock, visible como "Sin stock" en el dashboard de la clienta. */
export function isMissingOrderItem(item: AdminOrderItem): boolean {
  return (
    normalizeOrderItemStatus(item.status) === "missing" && Number(item.quantity ?? 0) > 0
  );
}

/** El pedido tiene al menos un producto sin stock que la clienta ve en su dashboard. */
export function orderHasMissingItem(order: AdminOrder): boolean {
  return (order.order_items || []).some(isMissingOrderItem);
}

export function countRegularProductUnits(
  items: Array<{
    quantity?: number | null;
    variant_id?: string | null;
    color?: string | null;
    size?: string | null;
    is_special_extra?: boolean | null;
  }>
): number {
  return items.reduce((sum, item) => {
    if (isSpecialExtraItem(item)) return sum;
    return sum + (Number(item.quantity) || 0);
  }, 0);
}

export function partitionOrderItemsForDisplay(items: AdminOrderItem[]): {
  products: AdminOrderItem[];
  specialExtras: AdminOrderItem[];
} {
  const products: AdminOrderItem[] = [];
  const specialExtras: AdminOrderItem[] = [];
  for (const item of items) {
    if (isSpecialExtraItem(item)) specialExtras.push(item);
    else products.push(item);
  }
  return { products, specialExtras };
}

export interface OrderNoteExtraRow {
  key: string;
  label: string;
  badge: string;
  amount: number;
}

export function computeItemsLineSubtotal(
  items: Array<{ price_snapshot?: number | null; quantity?: number | null }>
): number {
  return items.reduce((sum, item) => {
    const price = Number(item.price_snapshot) || 0;
    const qty = Number(item.quantity) || 0;
    return sum + price * qty;
  }, 0);
}

export function buildOrderNoteExtraRows(
  notesExtras: OrderNotesExtras,
  itemsSubtotal: number
): OrderNoteExtraRow[] {
  const rows: OrderNoteExtraRow[] = [];
  if (notesExtras.shipping > 0) {
    rows.push({ key: "shipping", label: "Envío", badge: "Envío", amount: notesExtras.shipping });
  }
  if (notesExtras.discount > 0) {
    rows.push({
      key: "discount",
      label: "Descuento",
      badge: "Descuento",
      amount: -notesExtras.discount,
    });
  }
  const extrasName = resolveExtrasDisplayName(notesExtras);
  if (notesExtras.extras_amount > 0) {
    rows.push({
      key: "extras_amount",
      label: extrasName,
      badge: extrasName,
      amount: notesExtras.extras_amount,
    });
  }
  if (notesExtras.extras_percentage > 0) {
    rows.push({
      key: "extras_percentage",
      label: `${extrasName} (${notesExtras.extras_percentage}%)`,
      badge: `${extrasName} %`,
      amount: (itemsSubtotal * notesExtras.extras_percentage) / 100,
    });
  }
  return rows;
}

export type OrderEditSummaryChipTone =
  | "shipping"
  | "discount"
  | "extra"
  | "special"
  | "pending";

export interface OrderEditSummaryChip {
  label: string;
  tone: OrderEditSummaryChipTone;
}

export function buildOrderEditSummaryChips(
  notesExtras: OrderNotesExtras,
  specialExtraNames: string[],
  hasPendingDraft: boolean
): OrderEditSummaryChip[] {
  const chips: OrderEditSummaryChip[] = [];
  const extrasName = resolveExtrasDisplayName(notesExtras);
  if (notesExtras.shipping > 0) chips.push({ label: "Envío", tone: "shipping" });
  if (notesExtras.discount > 0) chips.push({ label: "Descuento", tone: "discount" });
  if (notesExtras.extras_amount > 0) {
    chips.push({
      label: extrasName.length > 20 ? `${extrasName.slice(0, 18)}…` : extrasName,
      tone: "extra",
    });
  }
  if (notesExtras.extras_percentage > 0) {
    const pctLabel = `${extrasName} ${notesExtras.extras_percentage}%`;
    chips.push({
      label: pctLabel.length > 20 ? `${pctLabel.slice(0, 18)}…` : pctLabel,
      tone: "extra",
    });
  }
  for (const name of specialExtraNames) {
    const trimmed = String(name || "").trim() || "Extra esp.";
    chips.push({
      label: trimmed.length > 20 ? `${trimmed.slice(0, 18)}…` : trimmed,
      tone: "special",
    });
  }
  if (hasPendingDraft) chips.push({ label: "Sin guardar", tone: "pending" });
  return chips;
}

export function formatSignedPriceAr(amount: number): string {
  const n = Number(amount) || 0;
  if (n < 0) return `− ${formatPriceAr(Math.abs(n))}`;
  return formatPriceAr(n);
}

export function computeOrderTotalFromItems(
  items: Array<{ price_snapshot?: number | null; quantity?: number | null }>,
  notesExtras: OrderNotesExtras
): number {
  const subtotal = items.reduce((sum, item) => {
    const price = Number(item.price_snapshot) || 0;
    const qty = Number(item.quantity) || 0;
    return sum + price * qty;
  }, 0);
  const fromPercentage =
    notesExtras.extras_percentage > 0
      ? (subtotal * notesExtras.extras_percentage) / 100
      : 0;
  return (
    subtotal +
    notesExtras.shipping -
    notesExtras.discount +
    notesExtras.extras_amount +
    fromPercentage
  );
}

export function parseMoneyInput(value: string): number {
  const normalized = String(value || "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** Reparto depósito general vs venta (misma lógica que admin/orders-domain.js). */
export function computeWarehouseQtySplitForOrderItem(
  quantity: number,
  stockGeneral: number,
  stockVenta: number
): { qty_from_general: number; qty_from_venta: number } {
  const q = Math.max(0, Number(quantity) || 0);
  const gAvail = Math.max(0, Number(stockGeneral) || 0);
  const vAvail = Math.max(0, Number(stockVenta) || 0);
  let qtyFromVenta = 0;
  let qtyFromGeneral = 0;
  if (vAvail > 0) {
    qtyFromVenta = Math.min(q, vAvail);
    const remaining = q - qtyFromVenta;
    if (remaining > 0 && gAvail > 0) {
      qtyFromGeneral = Math.min(remaining, gAvail);
    }
  } else if (gAvail > 0) {
    qtyFromGeneral = Math.min(q, gAvail);
  }
  return { qty_from_general: qtyFromGeneral, qty_from_venta: qtyFromVenta };
}
