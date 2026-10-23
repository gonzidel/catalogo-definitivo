/**
 * Total de los avisos de cierre (campana).
 * El texto se guarda al cerrar. Al copiar se reescribe el monto con el total
 * vigente del pedido: líneas cobrables, promo 2x, descuento/envío/extras de
 * notes y la oferta solo si ya quedó en price_snapshot.
 */

import { isCustomerClosedNotificationKind } from "@/lib/orders/closed-order-messages";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

const MONEY = String.raw`\$\d{1,3}(?:[.,]\d{3})*`;

function formatLikeSample(amount: number, sample: string): string {
  const n = Math.round(Number(amount) || 0);
  const sep = sample.includes(".") && !sample.includes(",") ? "." : ",";
  const body = Math.abs(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${n < 0 ? "-" : ""}$${body}`;
}

function parseMoney(token: string): number {
  const digits = token.replace(/[^\d-]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Reemplaza el total de productos en un aviso ya armado.
 * En Correo deja el costo de envío como está y recalcula el total a transferir.
 * Si el texto no tiene un monto reconocible, se devuelve igual.
 */
export function rewriteClosedOrderMessageTotal(
  message: string,
  productsTotal: number
): string {
  if (!Number.isFinite(productsTotal)) return message;

  const productosRe = new RegExp(`(Productos: \\*)(${MONEY})(\\*)`);
  const envioRe = new RegExp(`Envío: \\*(${MONEY})\\*`);
  const transferirRe = new RegExp(`(\\*Total a transferir: )(${MONEY})(\\*)`);
  const pedidoRe = new RegExp(`(El total de tu pedido es de \\*)(${MONEY})(\\*)`);

  const productos = message.match(productosRe);
  if (productos) {
    const sample = productos[2];
    const formatted = formatLikeSample(productsTotal, sample);
    let next = message.replace(
      productosRe,
      (_match, open: string, _amount: string, close: string) => `${open}${formatted}${close}`
    );
    const envio = next.match(envioRe);
    const transferir = next.match(transferirRe);
    if (envio && transferir) {
      const total = formatLikeSample(
        productsTotal + parseMoney(envio[1]),
        transferir[2]
      );
      next = next.replace(
        transferirRe,
        (_match, open: string, _amount: string, close: string) => `${open}${total}${close}`
      );
    }
    return next;
  }

  const pedido = message.match(pedidoRe);
  if (!pedido) return message;
  const formatted = formatLikeSample(productsTotal, pedido[2]);
  return message.replace(
    pedidoRe,
    (_match, open: string, _amount: string, close: string) => `${open}${formatted}${close}`
  );
}

async function fetchCanonicalProductsTotal(orderId: string): Promise<number | null> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.rpc("rpc_closed_order_products_total", {
      p_order_id: orderId,
    });
    if (error || data == null || data === "") return null;
    const n = Number(data);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function fetchCardTotal(orderId: string): Promise<number | null> {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from("orders")
      .select("total_amount")
      .eq("id", orderId)
      .maybeSingle();
    if (error || data?.total_amount == null) return null;
    const n = Number(data.total_amount);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Texto listo para copiar o enviar. Los avisos que no son de cierre no se tocan. */
export async function resolveClosedOrderMessageText(input: {
  message: string;
  kind: string;
  orderId: string | null;
  cardTotal?: number | null;
}): Promise<string> {
  if (!isCustomerClosedNotificationKind(input.kind)) return input.message;

  let total: number | null = null;
  if (input.orderId) {
    total = await fetchCanonicalProductsTotal(input.orderId);
  }
  if (total == null && input.cardTotal != null && Number.isFinite(Number(input.cardTotal))) {
    total = Number(input.cardTotal);
  }
  if (total == null && input.orderId) {
    total = await fetchCardTotal(input.orderId);
  }
  if (total == null) return input.message;
  return rewriteClosedOrderMessageTotal(input.message, total);
}
