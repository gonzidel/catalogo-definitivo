import type { SupabaseClient } from "@supabase/supabase-js";
import { computeOrderTotalFromItems, type OrderNotesExtras } from "@/lib/orders/domain";
import {
  applyManualConfirmedItems,
  applyOrderStockDeduction,
  type OrderEditDraftItem,
} from "@/lib/supabase/order-edit";
import { loadWarehouses } from "@/lib/supabase/order-queries";

/**
 * Pedido abierto existente del cliente (active/closing_soon/closed/cancelled — un pedido a
 * la vez, igual que admin/order-creator.js). `closed` cuenta como "abierto" a partir de
 * 2026-07-18. `cancelled` también bloquea (318) hasta que admin desarme o se auto-borre.
 */
export async function findOpenOrderForCustomer(
  supabase: SupabaseClient,
  customerId: string
): Promise<{ id: string; order_number: string | null; status: string } | null> {
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status")
    .eq("customer_id", customerId)
    .in("status", ["active", "closing_soon", "closed", "cancelled"])
    .or("local_deferred_pickup.is.null,local_deferred_pickup.eq.false")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * Crea un pedido manual desde cero replicando el pipeline de admin/order-creator.js:
 * insert orders -> insert order_items -> inyección manual (faltantes confirmados) ->
 * descuento de stock regular. Si el descuento falla, intenta revertir el insert;
 * si no puede, deja el pedido en stock_pending (mismo comportamiento que el legado).
 */
export async function createManualOrder(
  supabase: SupabaseClient,
  customerId: string,
  items: OrderEditDraftItem[],
  notesExtras: OrderNotesExtras
): Promise<string> {
  if (!items.length) throw new Error("El pedido necesita al menos un producto.");

  const warehouseIds = await loadWarehouses(supabase);
  const total = computeOrderTotalFromItems(items, notesExtras);
  const extrasLabel = String(notesExtras.extras_label || "").trim();
  const notesPayload: Record<string, unknown> = {
    shipping: notesExtras.shipping,
    discount: notesExtras.discount,
    extras_amount: notesExtras.extras_amount,
    extras_percentage: notesExtras.extras_percentage,
  };
  if (extrasLabel) notesPayload.extras_label = extrasLabel;
  const notes = JSON.stringify(notesPayload);

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert({
      customer_id: customerId,
      status: "active",
      source: "admin",
      total_amount: total,
      notes,
    })
    .select("id")
    .single();

  if (orderError || !order) {
    throw new Error(orderError?.message || "No se pudo crear el pedido.");
  }

  const orderId = order.id as string;

  const orderItemsData = items.map((item) => ({
    order_id: orderId,
    variant_id: item.is_special_extra ? null : item.variant_id,
    product_name: item.product_name,
    color: item.is_special_extra ? null : item.color,
    size: item.is_special_extra ? null : item.size || null,
    quantity: item.quantity,
    price_snapshot: item.price_snapshot,
    imagen: item.imagen ?? null,
    status: item.status || "picked",
    admin_confirmed_missing: Boolean(item.admin_confirmed_missing),
  }));

  const { data: insertedItems, error: itemsError } = await supabase
    .from("order_items")
    .insert(orderItemsData)
    .select("id, variant_id, size, quantity, admin_confirmed_missing");

  if (itemsError) {
    await rollbackOrder(supabase, orderId, itemsError.message);
    throw new Error(`Error agregando productos: ${itemsError.message}`);
  }

  const stockItems = items.filter((item) => !item.is_special_extra);
  const insertedStockItems = (insertedItems || []).filter(
    (_, index) => !items[index]?.is_special_extra
  );

  try {
    await applyManualConfirmedItems(supabase, insertedStockItems, orderId, warehouseIds);
    const itemsWithIds = stockItems.map((item, index) => ({
      ...item,
      order_item_id: insertedStockItems?.[index]?.id ?? null,
    }));
    await applyOrderStockDeduction(supabase, itemsWithIds, orderId, warehouseIds, "order_creation");
  } catch (stockErr) {
    const reason = stockErr instanceof Error ? stockErr.message : String(stockErr);
    await rollbackOrder(supabase, orderId, reason);
    throw new Error(`${reason}. El pedido quedó en stock pendiente.`);
  }

  return orderId;
}

async function rollbackOrder(supabase: SupabaseClient, orderId: string, reason: string): Promise<void> {
  const { error: deleteItemsError } = await supabase
    .from("order_items")
    .delete()
    .eq("order_id", orderId);

  const deleteOrderError = deleteItemsError
    ? deleteItemsError
    : (await supabase.from("orders").delete().eq("id", orderId)).error;

  if (!deleteOrderError) return;

  await supabase
    .from("orders")
    .update({
      status: "stock_pending",
      notes: JSON.stringify({
        stock_pending_reason: reason,
        stock_pending_at: new Date().toISOString(),
        stock_pending_source: "nj/order-create",
      }),
    })
    .eq("id", orderId);
}
