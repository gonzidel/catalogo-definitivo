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

export const ADMIN_ENABLE_24H_USES_KEY = "admin_enable_24h_uses";

export function applyOrderNotesPatch(
  rawNotes: string | null | undefined,
  patch: Record<string, unknown>
): string {
  const obj = parseOrderNotesObject(rawNotes);
  return JSON.stringify({ ...obj, ...patch });
}

export function getEnable24hUsesFromOrder(order: AdminOrder): number {
  const notes = parseOrderNotesObject(order.notes);
  const n = Number(notes[ADMIN_ENABLE_24H_USES_KEY] || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function formatOrderNotesExtras(order: AdminOrder): string[] {
  const notes = parseOrderNotesObject(order.notes);
  const lines: string[] = [];

  const shipping = Number(notes.shipping ?? notes.shipping_cost ?? 0);
  const discount = Number(notes.discount ?? 0);
  const extrasAmount = Number(notes.extras_amount ?? notes.extras ?? 0);
  const extrasPercentage = Number(notes.extras_percentage ?? 0);

  if (shipping > 0) lines.push(`Envío: ${formatPriceAr(shipping)}`);
  if (discount > 0) lines.push(`Descuento: -${formatPriceAr(discount)}`);
  if (extrasAmount > 0) lines.push(`Extras: ${formatPriceAr(extrasAmount)}`);

  if (extrasPercentage > 0) {
    const subtotal = (order.order_items || []).reduce((sum, item) => {
      const price = Number(item.price_snapshot) || 0;
      const qty = Number(item.quantity) || 0;
      return sum + price * qty;
    }, 0);
    lines.push(`Extras (${extrasPercentage}%): ${formatPriceAr((subtotal * extrasPercentage) / 100)}`);
  }

  return lines;
}
