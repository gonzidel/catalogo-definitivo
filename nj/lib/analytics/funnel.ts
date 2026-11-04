import { clipGaParam, gaEvent } from "./ga";
import type { GaEventPayload } from "./catalog-interactions";

/**
 * Eventos del embudo de compra en GA4 (view_item, add_to_cart, begin_checkout, login_success).
 *
 * El catálogo vanilla los mandaba desde scripts/analytics.js y scripts/main-supabase.js. Al pasar
 * el catálogo a nj (21/10/2026) dejaron de emitirse y GA4 los muestra en cero. Acá vuelven con
 * los mismos nombres y la misma forma (moneda ARS, `items` estándar de GA4) para poder comparar.
 *
 * Solo catálogo y carrito: el panel admin no debe llamar estas funciones (ver ga.ts).
 */

const CURRENCY = "ARS";

export type FunnelLine = {
  articulo: string;
  color?: string;
  size?: string;
  qty: number;
  price: number;
};

function toPrice(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

function toQty(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function lineToItem(line: FunnelLine): Record<string, unknown> | null {
  const articulo = clipGaParam(line.articulo, 80);
  if (!articulo) return null;
  const item: Record<string, unknown> = {
    item_id: articulo,
    item_name: articulo,
    price: toPrice(line.price),
    quantity: toQty(line.qty),
  };
  const variant = [line.color, line.size].map((v) => String(v ?? "").trim()).filter(Boolean).join(" / ");
  if (variant) item.item_variant = clipGaParam(variant, 80);
  return item;
}

function cartPayload(name: string, lines: FunnelLine[]): GaEventPayload | null {
  const items = lines.map(lineToItem).filter((i): i is Record<string, unknown> => i !== null);
  if (items.length === 0) return null;
  const value = items.reduce((sum, i) => sum + (i.price as number) * (i.quantity as number), 0);
  return { name, params: { currency: CURRENCY, value: Math.round(value * 100) / 100, items } };
}

/** Vista de ficha de producto. `price` es el precio efectivo mostrado (0 si no hay). */
export function buildViewItemEvent(input: { articulo: string; price: number; category?: string }): GaEventPayload | null {
  const articulo = clipGaParam(input.articulo, 80);
  if (!articulo) return null;
  const item: Record<string, unknown> = { item_id: articulo, item_name: articulo, price: toPrice(input.price) };
  if (input.category) item.item_category = clipGaParam(input.category, 60);
  return { name: "view_item", params: { currency: CURRENCY, value: toPrice(input.price), items: [item] } };
}

export function buildAddToCartEvent(lines: FunnelLine[]): GaEventPayload | null {
  return cartPayload("add_to_cart", lines);
}

export function buildBeginCheckoutEvent(lines: FunnelLine[]): GaEventPayload | null {
  return cartPayload("begin_checkout", lines);
}

export function buildLoginSuccessEvent(method: string): GaEventPayload {
  return { name: "login_success", params: { method: clipGaParam(method || "unknown", 30) } };
}

function send(payload: GaEventPayload | null): void {
  if (payload) gaEvent(payload.name, payload.params);
}

export function trackViewItem(input: { articulo: string; price: number; category?: string }): void {
  send(buildViewItemEvent(input));
}

export function trackAddToCart(lines: FunnelLine[]): void {
  send(buildAddToCartEvent(lines));
}

export function trackBeginCheckout(lines: FunnelLine[]): void {
  send(buildBeginCheckoutEvent(lines));
}

const LOGIN_SEEN_KEY = "fyl_ga_login_seen";

/**
 * Supabase vuelve a emitir SIGNED_IN al volver a la pestaña. Se cuenta una vez por sesión del
 * navegador y por usuario. Si sessionStorage no está disponible, se envía igual.
 */
export function trackLoginSuccessOnce(userId: string, method: string): void {
  try {
    if (sessionStorage.getItem(LOGIN_SEEN_KEY) === userId) return;
    sessionStorage.setItem(LOGIN_SEEN_KEY, userId);
  } catch {
    /* storage bloqueado */
  }
  send(buildLoginSuccessEvent(method));
}
