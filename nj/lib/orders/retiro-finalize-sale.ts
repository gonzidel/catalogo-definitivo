import {

  countRegularProductUnits,

  formatPriceAr,

  formatSignedPriceAr,

  getCustomerFromOrder,

  getOrderDisplayNumber,

  getOrderItemLineTotal,

  isCancelledOrderItem,

  isCommonLocalPickupAwaitingAdminSale,

  isMissingOrderItem,

  isReturnOrderItem,

  parseOrderNotesObject,
  applyOrderNotesPatch,
} from "@/lib/orders/domain";

import type { AdminOrder } from "@/types/orders";

import type { SupabaseClient } from "@supabase/supabase-js";



export type RetiroPayMethod = "Efectivo" | "Tarjeta";



export interface RetiroSaleTotals {

  productUnits: number;

  productLines: number;

  subtotal: number;

  notesAdjustments: number;

  surchargePct: number;

  surchargeAmount: number;

  creditUsed: number;

  total: number;

}



type SaleItemPayload = {

  variant_id?: string;

  product_name?: string;

  qty: number;

  price: number;

  size?: string;

  is_return: boolean;

  from_local_order?: boolean;

  is_special_extra?: boolean;

  source?: { venta_publico: number; general: number };

};



type OrderNotesPricing = {

  shipping: number;

  discount: number;

  extras_amount: number;

  extras_percentage: number;

};



function billableItems(order: AdminOrder) {

  return (order.order_items || []).filter(

    (item) => !isCancelledOrderItem(item) && !isMissingOrderItem(item)

  );

}



function parseOrderNotesPricing(order: AdminOrder): OrderNotesPricing {

  const n = parseOrderNotesObject(order.notes);

  return {

    shipping: Number(n.shipping) || 0,

    discount: Number(n.discount) || 0,

    extras_amount: Number(n.extras_amount) || 0,

    extras_percentage: Number(n.extras_percentage) || 0,

  };

}



/** Misma fórmula que public-sales (`applyLocalOrderNotesToTotal`). */

function applyOrderNotesToLinesSubtotal(

  linesSum: number,

  notes: OrderNotesPricing

): number {

  let total = linesSum;

  total += notes.shipping;

  total -= notes.discount;

  total += notes.extras_amount;

  if (notes.extras_percentage > 0) {

    total += total * (notes.extras_percentage / 100);

  }

  return total;

}



function getMirroredLocalOrderId(order: AdminOrder): string | null {

  const notes = parseOrderNotesObject(order.notes);

  if (notes.mirrored_from_local_order !== true) return null;

  const raw = notes.local_order_id;

  return typeof raw === "string" && raw.trim() ? raw.trim() : null;

}



export function getRetiroSaleTotals(

  order: AdminOrder,

  surchargePct = 0,

  creditUsed = 0

): RetiroSaleTotals {

  const items = billableItems(order);

  const linesSubtotal = items.reduce(

    (sum, item) => sum + getOrderItemLineTotal(item),

    0

  );

  const notes = parseOrderNotesPricing(order);

  const withNotes = applyOrderNotesToLinesSubtotal(linesSubtotal, notes);

  const notesAdjustments = withNotes - linesSubtotal;

  const pct = Math.max(0, Number(surchargePct) || 0);

  const surchargeAmount = pct > 0 ? Math.round((withNotes * pct) / 100) : 0;

  const beforeCredit = withNotes + surchargeAmount;

  const appliedCredit = Math.min(Math.max(0, creditUsed), Math.max(0, beforeCredit));

  return {

    productUnits: countRegularProductUnits(items),

    productLines: items.length,

    subtotal: linesSubtotal,

    notesAdjustments,

    surchargePct: pct,

    surchargeAmount,

    creditUsed: appliedCredit,

    total: Math.max(0, beforeCredit - appliedCredit),

  };

}



function appendOrderNotesExtraLines(

  items: SaleItemPayload[],

  order: AdminOrder,

  linesSubtotal: number

): void {

  const notes = parseOrderNotesPricing(order);



  if (notes.extras_amount > 0) {

    items.push({

      product_name: "Extra (monto fijo)",

      qty: 1,

      price: notes.extras_amount,

      is_return: false,

      is_special_extra: true,

    });

  }



  if (notes.extras_percentage > 0) {

    let base = linesSubtotal;

    base += notes.shipping;

    base -= notes.discount;

    base += notes.extras_amount;

    const pctAmt = Math.round(base * (notes.extras_percentage / 100));

    if (pctAmt !== 0) {

      items.push({

        product_name: `Extra ${notes.extras_percentage}%`,

        qty: 1,

        price: pctAmt,

        is_return: false,

        is_special_extra: true,

      });

    }

  }

}



function buildSaleItems(

  order: AdminOrder,

  surchargePct: number,

  creditUsed = 0

): { items: SaleItemPayload[]; totals: RetiroSaleTotals } {

  const billable = billableItems(order);

  const linesSubtotal = billable.reduce(

    (sum, item) => sum + getOrderItemLineTotal(item),

    0

  );

  const items: SaleItemPayload[] = [];



  for (const item of billable) {

    const qty = Number(item.quantity) || 0;

    const rawPrice = Number(item.price_snapshot) || 0;

    if (qty <= 0) continue;



    if (item.variant_id) {

      const isReturn = isReturnOrderItem(item) || rawPrice < 0;

      const sizeStr = item.size != null ? String(item.size).trim() : "";

      const line: SaleItemPayload = {

        variant_id: item.variant_id,

        qty,

        price: Math.abs(rawPrice),

        is_return: isReturn,

        from_local_order: !isReturn,

      };

      if (sizeStr) line.size = sizeStr;

      if (!isReturn) {

        line.source = { venta_publico: qty, general: 0 };

      }

      items.push(line);

    } else {

      items.push({

        product_name: item.product_name || "Producto",

        qty,

        price: rawPrice,

        is_return: false,

        is_special_extra: true,

      });

    }

  }



  appendOrderNotesExtraLines(items, order, linesSubtotal);



  const totals = getRetiroSaleTotals(order, surchargePct, creditUsed);



  if (totals.surchargeAmount > 0) {

    items.push({

      product_name: `Recargo tarjeta ${totals.surchargePct}%`,

      qty: 1,

      price: totals.surchargeAmount,

      is_return: false,

      is_special_extra: true,

    });

  }



  return { items, totals };

}



async function resolvePublicSalesCustomerId(

  supabase: SupabaseClient,

  order: AdminOrder

): Promise<string | null> {

  const mirroredLocalId = getMirroredLocalOrderId(order);

  if (mirroredLocalId) {

    const { data: localOrder, error } = await supabase

      .from("local_orders")

      .select("customer_id")

      .eq("id", mirroredLocalId)

      .maybeSingle();

    if (error) throw error;

    if (localOrder?.customer_id) return String(localOrder.customer_id);

  }



  const customerId = order.customer_id?.trim();

  if (!customerId) return null;



  const { data: linked, error: linkErr } = await supabase

    .from("customers")

    .select("public_sales_customer_id")

    .eq("id", customerId)

    .maybeSingle();

  if (linkErr) throw linkErr;

  if (linked?.public_sales_customer_id) {

    return String(linked.public_sales_customer_id);

  }



  const { data: copied, error: copyErr } = await supabase.rpc(

    "rpc_copy_customer_to_local",

    { p_customer_id: customerId }

  );

  if (copyErr) throw copyErr;

  const newId = copied?.customer_id;

  return newId ? String(newId) : null;

}



async function fetchAvailableCredit(

  supabase: SupabaseClient,

  publicSalesCustomerId: string | null

): Promise<number> {

  if (!publicSalesCustomerId) return 0;

  const { data, error } = await supabase.rpc("rpc_get_customer_credits", {

    p_customer_id: publicSalesCustomerId,

  });

  if (error) throw error;

  return (data || []).reduce(

    (sum: number, row: { amount?: number | string | null }) =>

      sum + (Number(row.amount) || 0),

    0

  );

}



async function completeMirroredLocalOrderIfAny(

  supabase: SupabaseClient,

  order: AdminOrder

): Promise<void> {

  const localOrderId = getMirroredLocalOrderId(order);

  if (!localOrderId) return;



  const { error } = await supabase

    .from("local_orders")

    .update({

      status: "completed",

      updated_at: new Date().toISOString(),

    })

    .eq("id", localOrderId)

    .neq("status", "completed");



  if (error) throw error;

}



function buildTicketHtml(input: {

  saleNumber: string;

  createdAt: string;

  customerName: string | null;

  orderNumber: string;

  payMethod: RetiroPayMethod;

  items: Array<{

    product_name: string;

    color?: string | null;

    size?: string | null;

    qty: number;

    price: number;

    is_return?: boolean;

  }>;

  total: number;

}): string {

  const saleDate = new Date(input.createdAt);

  const dateStr = saleDate.toLocaleDateString("es-AR", {

    year: "numeric",

    month: "long",

    day: "numeric",

    timeZone: "America/Argentina/Buenos_Aires",

  });

  const timeStr = saleDate.toLocaleTimeString("es-AR", {

    hour: "2-digit",

    minute: "2-digit",

    timeZone: "America/Argentina/Buenos_Aires",

  });



  const rows = input.items

    .map((item) => {

      const isReturn = Boolean(item.is_return) || Number(item.price) < 0;

      const absPrice = Math.abs(Number(item.price) || 0);

      const signedUnit = isReturn ? -absPrice : absPrice;

      const lineTotal = signedUnit * item.qty;

      const name = [

        isReturn ? "[DEV]" : "",

        item.product_name || "N/A",

        item.color ? String(item.color) : "",

        item.size ? `(${item.size})` : "",

      ]

        .filter(Boolean)

        .join(" ");

      const red = isReturn ? "color:#dc3545;font-weight:700;" : "";

      return `<tr>

        <td style="padding:6px 2px;border-bottom:1px dotted #999;${red}">${escapeHtml(name)}</td>

        <td style="padding:6px 2px;text-align:center;border-bottom:1px dotted #999;">${item.qty}</td>

        <td style="padding:6px 2px;text-align:right;border-bottom:1px dotted #999;${red}">${formatSignedPriceAr(signedUnit)}</td>

        <td style="padding:6px 2px;text-align:right;border-bottom:1px dotted #999;${red}">${formatSignedPriceAr(lineTotal)}</td>

      </tr>`;

    })

    .join("");



  return `<!doctype html>

<html><head><meta charset="utf-8"/><title>Ticket ${escapeHtml(input.saleNumber)}</title>

<style>

  @page { margin: 8mm; }

  body { font-family: Arial, sans-serif; color: #000; margin: 0; padding: 8px; font-size: 14px; }

  h1 { margin: 0 0 10px; font-size: 28px; text-align: center; }

  table { width: 100%; border-collapse: collapse; }

  .meta { margin: 10px 0 14px; }

  .meta div { display: flex; justify-content: space-between; margin-bottom: 4px; }

  .total { margin-top: 12px; border-top: 2px solid #000; padding-top: 8px; font-size: 18px; font-weight: 800;

    display:flex; justify-content:space-between; }

</style></head><body>

  <h1>FYL moda</h1>

  <div class="meta">

    <div><strong>Venta:</strong><span>${escapeHtml(input.saleNumber)}</span></div>

    <div><strong>Pedido:</strong><span>${escapeHtml(input.orderNumber)}</span></div>

    <div><strong>Pago:</strong><span>${escapeHtml(input.payMethod)}</span></div>

    <div><strong>Fecha:</strong><span>${escapeHtml(dateStr)}</span></div>

    <div><strong>Hora:</strong><span>${escapeHtml(timeStr)}</span></div>

    ${

      input.customerName

        ? `<div><strong>Cliente:</strong><span>${escapeHtml(input.customerName)}</span></div>`

        : ""

    }

  </div>

  <table>

    <thead>

      <tr>

        <th style="text-align:left;border-bottom:2px solid #000;padding:6px 2px;">Producto</th>

        <th style="text-align:center;border-bottom:2px solid #000;padding:6px 2px;">Cant.</th>

        <th style="text-align:right;border-bottom:2px solid #000;padding:6px 2px;">Precio</th>

        <th style="text-align:right;border-bottom:2px solid #000;padding:6px 2px;">Total</th>

      </tr>

    </thead>

    <tbody>${rows}</tbody>

  </table>

  <div class="total"><span>TOTAL</span><span>${formatPriceAr(input.total)}</span></div>

  <script>window.onload=function(){window.focus();window.print();}</script>

</body></html>`;

}



function escapeHtml(value: string): string {

  return String(value)

    .replace(/&/g, "&amp;")

    .replace(/</g, "&lt;")

    .replace(/>/g, "&gt;")

    .replace(/"/g, "&quot;");

}



function openPrintWindow(html: string) {

  const win = window.open("", "_blank", "noopener,noreferrer,width=420,height=720");

  if (!win) {

    throw new Error(

      "El navegador bloqueó la ventana de impresión. Permití popups e intentá de nuevo."

    );

  }

  win.document.open();

  win.document.write(html);

  win.document.close();

}



/**

 * Finaliza el pedido de retiro como venta al público (paridad con

 * "Finalizar Venta" / finalizar pedido local en public-sales) e imprime ticket.

 */

export async function finalizeRetiroOrderSale(

  supabase: SupabaseClient,

  order: AdminOrder,

  payMethod: RetiroPayMethod,

  surchargePct = 0

): Promise<{ saleNumber: string; total: number; creditUsed: number }> {

  const status = String(order.status || "")

    .trim()

    .toLowerCase();

  const awaitingAdminSale = isCommonLocalPickupAwaitingAdminSale(
    order,
    order.transportName ?? null
  );

  if (status === "closed" && !awaitingAdminSale) {

    throw new Error("Este pedido ya está cerrado.");

  }



  const publicSalesCustomerId = await resolvePublicSalesCustomerId(supabase, order);

  const availableCredit = await fetchAvailableCredit(supabase, publicSalesCustomerId);

  const { items, totals } = buildSaleItems(order, surchargePct, availableCredit);



  if (items.length === 0) {

    throw new Error("El pedido no tiene productos para cobrar.");

  }



  const customer = getCustomerFromOrder(order);

  const orderNumber = getOrderDisplayNumber(order);

  const mirroredLocalId = getMirroredLocalOrderId(order);

  const operationId = crypto.randomUUID();

  const notes = [

    mirroredLocalId

      ? `Pedido local ${orderNumber}`

      : `Retiro pedido ${orderNumber}`,

    `Pago: ${payMethod}`,

    totals.surchargePct > 0 ? `Recargo tarjeta ${totals.surchargePct}%` : null,

    totals.creditUsed > 0

      ? `Crédito aplicado ${formatPriceAr(totals.creditUsed)}`

      : null,

  ]

    .filter(Boolean)

    .join(" · ");



  const { data: saleData, error: saleError } = await supabase.rpc(

    "rpc_create_public_sale",

    {

      p_items: items,

      p_customer_id: publicSalesCustomerId,

      p_notes: notes,

      p_apply_credit: true,

      p_total_amount: totals.total,

      p_operation_id: operationId,

      p_request: {

        source: "nj/admin/retiro",

        action: "finalize_retiro_order_sale",

        order_id: order.id,

        local_order_id: mirroredLocalId,

        pay_method: payMethod,

        surcharge_pct: totals.surchargePct,

      },

    }

  );



  if (saleError) throw saleError;



  const saleId = String(saleData?.sale_id || saleData?.id || "");

  const saleNumber = String(saleData?.sale_number || saleId.slice(0, 8) || "—");



  let ticketItems = billableItems(order).map((item) => {

    const raw = Number(item.price_snapshot) || 0;

    const isReturn = isReturnOrderItem(item) || raw < 0;

    return {

      product_name: item.product_name || "Producto",

      color: item.color,

      size: item.size,

      qty: Number(item.quantity) || 0,

      price: isReturn ? -Math.abs(raw) : Math.abs(raw),

      is_return: isReturn,

    };

  });



  if (saleId) {

    const { data: details } = await supabase.rpc("rpc_get_public_sale_details", {

      p_sale_id: saleId,

    });

    if (details?.items?.length) {

      ticketItems = (details.items as Array<Record<string, unknown>>)

        .filter(

          (row) =>

            Number(row.price ?? row.price_snapshot ?? 0) !== 0 ||

            Number(row.qty ?? 0) > 0

        )

        .map((row) => {

          const isReturn = Boolean(row.is_return);

          const abs = Math.abs(Number(row.price ?? row.price_snapshot ?? 0) || 0);

          return {

            product_name: String(row.product_name || "Producto"),

            color: (row.color as string | null) ?? null,

            size: (row.size as string | null) ?? null,

            qty: Number(row.qty) || 0,

            price: isReturn ? -abs : abs,

            is_return: isReturn,

          };

        });

    }

  }



  const html = buildTicketHtml({

    saleNumber,

    createdAt: new Date().toISOString(),

    customerName: customer?.full_name ?? null,

    orderNumber,

    payMethod,

    items: ticketItems,

    total: totals.total,

  });



  await completeMirroredLocalOrderIfAny(supabase, order);

  const fulfilledNotes = applyOrderNotesPatch(order.notes, {
    local_pickup_fulfilled_at: new Date().toISOString(),
  });

  // Retiro común: la clienta pudo cerrar con rpc_close_order (legacy) → ya `closed`
  // con Pago Pendiente. No volver a llamar rpc_close_order (falla si venció dismantle_at).
  if (status === "closed" && awaitingAdminSale) {
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        payment_method: payMethod,
        notes: fulfilledNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
    if (updateError) throw updateError;
  } else {
    const { error: closeError } = await supabase.rpc("rpc_close_order", {
      p_order_id: order.id,
      p_payment_method: payMethod,
    });
    if (closeError) throw closeError;

    const { error: notesError } = await supabase
      .from("orders")
      .update({
        notes: fulfilledNotes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id);
    if (notesError) throw notesError;
  }

  try {

    openPrintWindow(html);

  } catch (printErr) {

    console.warn("Impresión retiro:", printErr);

  }



  return { saleNumber, total: totals.total, creditUsed: totals.creditUsed };

}


