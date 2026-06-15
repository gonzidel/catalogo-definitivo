import {
  getTransportBadgeClass,
  parseOrderNotesObject,
} from "@/lib/orders/domain";
import { enrichOrderItemsWithWarehouseLabels } from "@/lib/orders/warehouse-labels";
import type {
  AdminOrder,
  AdminTransport,
  PaymentMethod,
  WarehouseIds,
} from "@/types/orders";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Única fuente de verdad — SSR, fetchOrderById, realtime, post-RPC */
export const ORDER_SELECT = `
  id, order_number, status, customer_id, total_amount, notes, source,
  created_at, sent_at, expires_at, dismantle_at, transport_id,
  customers(id, full_name, phone, email, dni, transport_id),
  order_items(
    id, order_id, variant_id, product_name, color, size, quantity,
    price_snapshot, status, admin_confirmed_missing, checked_by, checked_at,
    order_item_stock_sources(warehouse_id, qty)
  )
`;

export async function loadWarehouses(
  supabase: SupabaseClient
): Promise<WarehouseIds> {
  const { data } = await supabase.from("warehouses").select("id, code");
  const ids: WarehouseIds = { general: null, ventaPublico: null };
  for (const w of data || []) {
    if (w.code === "general") ids.general = w.id;
    if (w.code === "venta-publico") ids.ventaPublico = w.id;
  }
  return ids;
}

export async function loadTransports(
  supabase: SupabaseClient
): Promise<Map<string, AdminTransport>> {
  const { data } = await supabase.from("transports").select("id, name");
  const map = new Map<string, AdminTransport>();
  for (const t of data || []) {
    if (t.id && t.name) map.set(t.id, { id: t.id, name: t.name });
  }
  return map;
}

export async function loadPaymentMethods(
  supabase: SupabaseClient
): Promise<PaymentMethod[]> {
  const { data, error } = await supabase
    .from("payment_methods")
    .select("id, name")
    .order("name", { ascending: true });
  if (error) return [];
  return (data || []) as PaymentMethod[];
}

function attachTransportMeta(
  order: AdminOrder,
  transports: Map<string, AdminTransport>
): AdminOrder {
  const orderTransportId = String(order.transport_id || "").trim();
  const customer = Array.isArray(order.customers)
    ? order.customers[0]
    : order.customers;
  const customerTransportId = String(customer?.transport_id || "").trim();
  const transportId = orderTransportId || customerTransportId;
  const transport = transportId ? transports.get(transportId) : null;
  const transportName = transport?.name ?? null;
  return {
    ...order,
    transportName,
    transportBadgeClass: getTransportBadgeClass(transportName),
  };
}

export async function enrichOrders(
  supabase: SupabaseClient | null,
  orders: AdminOrder[],
  warehouseIds: WarehouseIds,
  transports: Map<string, AdminTransport>
): Promise<AdminOrder[]> {
  const withWarehouses = await enrichOrderItemsWithWarehouseLabels(
    supabase,
    orders,
    warehouseIds
  );
  return withWarehouses.map((o) => attachTransportMeta(o, transports));
}

export async function fetchOrdersInitial(
  supabase: SupabaseClient
): Promise<AdminOrder[]> {
  const [warehouseIds, transports] = await Promise.all([
    loadWarehouses(supabase),
    loadTransports(supabase),
  ]);

  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .not("status", "in", '("sent","devolución")')
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("fetchOrdersInitial error:", error);
    return [];
  }

  return enrichOrders(supabase, (data || []) as AdminOrder[], warehouseIds, transports);
}

export async function fetchOrderById(
  supabase: SupabaseClient,
  orderId: string
): Promise<AdminOrder | null> {
  const [warehouseIds, transports] = await Promise.all([
    loadWarehouses(supabase),
    loadTransports(supabase),
  ]);

  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .maybeSingle();

  if (error || !data) return null;

  const enriched = await enrichOrders(
    supabase,
    [data as AdminOrder],
    warehouseIds,
    transports
  );
  return enriched[0] ?? null;
}

function generateOperationId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const nowHex = Date.now().toString(16).padStart(12, "0");
  const randHex = Math.random().toString(16).slice(2).padEnd(20, "0").slice(0, 20);
  return `${nowHex.slice(0, 8)}-${nowHex.slice(8, 12)}-4${randHex.slice(0, 3)}-a${randHex.slice(3, 6)}-${randHex.slice(6, 18)}`;
}

export async function rpcMarkOrderItemsPicked(
  supabase: SupabaseClient,
  itemIds: string[],
  action = "pick_all"
) {
  const { data, error } = await supabase.rpc("rpc_mark_order_items_picked", {
    p_order_item_ids: itemIds,
    p_operation_id: generateOperationId(),
    p_request: { source: "nj/admin/orders", action },
  });
  if (error) throw error;
  return data;
}

export async function rpcCloseOrder(
  supabase: SupabaseClient,
  orderId: string,
  paymentMethod: string
) {
  const { error } = await supabase.rpc("rpc_close_order", {
    p_order_id: orderId,
    p_payment_method: paymentMethod,
  });
  if (error) throw error;
}

export async function rpcSendOrderToLocal(
  supabase: SupabaseClient,
  orderId: string
) {
  const { data, error } = await supabase.rpc("rpc_send_order_to_local", {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data;
}

export async function rpcReopenOrder(
  supabase: SupabaseClient,
  orderId: string
) {
  const { error } = await supabase.rpc("rpc_reopen_order", {
    p_order_id: orderId,
  });
  if (error) throw error;
}

export async function rpcRemoveOrderItemRestoreStock(
  supabase: SupabaseClient,
  orderItemId: string
) {
  const { data, error } = await supabase.rpc("rpc_remove_order_item_restore_stock", {
    p_order_item_id: orderItemId,
  });
  if (error) throw error;
  if (!data || data.ok !== true) {
    throw new Error("No se pudo quitar el producto del pedido");
  }
  return data;
}

export async function rpcCancelOrderFull(
  supabase: SupabaseClient,
  orderId: string
) {
  const { data, error } = await supabase.rpc("rpc_cancel_order_full", {
    p_order_id: orderId,
  });
  if (error) throw error;
  if (!data || data.ok !== true) {
    throw new Error("No se pudo cancelar el pedido");
  }
  return data;
}

export async function resolveStockPendingOrderRpc(
  supabase: SupabaseClient,
  order: AdminOrder,
  targetItemId: string
): Promise<AdminOrder | null> {
  const notesObj = parseOrderNotesObject(order.notes);
  const { data: removeData, error: removeError } = await supabase.rpc(
    "rpc_remove_order_item_restore_stock",
    { p_order_item_id: targetItemId }
  );
  if (removeError) throw removeError;
  if (removeData && removeData.ok === false) {
    throw new Error("No se pudo resolver el conflicto de stock");
  }

  const nextNotes = { ...notesObj };
  delete nextNotes.stock_pending_reason;
  delete nextNotes.stock_pending_at;
  delete nextNotes.stock_pending_source;
  const nextNotesRaw = JSON.stringify(nextNotes);

  const { error: updateError } = await supabase
    .from("orders")
    .update({
      status: "active",
      notes: nextNotesRaw === "{}" ? null : nextNotesRaw,
      updated_at: new Date().toISOString(),
    })
    .eq("id", order.id);

  if (updateError) throw updateError;

  return fetchOrderById(supabase, order.id);
}
