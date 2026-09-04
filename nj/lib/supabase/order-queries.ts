import {
  applyOrderNotesPatch,
  getTransportBadgeClass,
  parseOrderNotesObject,
} from "@/lib/orders/domain";
import {
  filterOrdersByBoardScope,
  type BoardScope,
} from "@/lib/orders/board-scope";
import { isFinalOrderStatus } from "@/lib/orders/classification";
import { enrichOrderItemsWithOfferFlags } from "@/lib/orders/offer-badges";
import { enrichOrderItemsWithWarehouseLabels } from "@/lib/orders/warehouse-labels";
import { isDashboardRetiroLocalZone } from "@/lib/transport/shipping-helpers";
import type {
  AdminOrder,
  AdminTransport,
  PaymentMethod,
  WarehouseIds,
} from "@/types/orders";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Única fuente de verdad — SSR, fetchOrderById, realtime, post-RPC.
 *  Nota: `deferred_stock_pending` (312) se agrega al select tras aplicar la migración en prod. */
export const ORDER_SELECT = `
  id, order_number, status, customer_id, total_amount, notes, source, payment_method,
  created_at, sent_at, expires_at, dismantle_at, local_deferred_pickup, pickup_timer_started_at, transport_id,
  customers(id, full_name, phone, email, dni, transport_id, city, province),
  order_items(
    id, order_id, variant_id, product_name, color, size, quantity,
    price_snapshot, imagen, status, admin_confirmed_missing, checked_by, checked_at,
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
  let transportName = transport?.name ?? null;

  // Zona retiro local / deferred: la geo del dashboard fuerza Retira local.
  // Si el customer aún tiene un transport_id viejo (MyM, etc.), no debe
  // mandar el badge ni el Kanban. Si admin movió a Pedidos (kanban_scope =
  // shipping), no forzar.
  const notesKanban = parseOrderNotesObject(order.notes).kanban_scope;
  if (
    notesKanban !== "shipping" &&
    (order.local_deferred_pickup ||
      isDashboardRetiroLocalZone(customer?.province, customer?.city))
  ) {
    transportName = "Retira local";
  }

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
  const withOffers = await enrichOrderItemsWithOfferFlags(supabase, withWarehouses);
  return withOffers.map((o) => attachTransportMeta(o, transports));
}

export async function fetchOrdersInitial(
  supabase: SupabaseClient,
  scope: BoardScope = "shipping"
): Promise<AdminOrder[]> {
  const [warehouseIds, transports] = await Promise.all([
    loadWarehouses(supabase),
    loadTransports(supabase),
  ]);

  // Estados finales: no viven en el Kanban operativo (paridad con "sent"/"devolución").
  // "expired" (pedido desarmado automáticamente por rpc_orders_daily_maintenance) no
  // tiene columna propia ni ítems operacionales -- si se incluyera, getOrderKanbanColumn
  // devuelve null y el pedido queda flotando sin poder clasificarse en ninguna columna.
  // Nota: "cancelled" (a nivel pedido) SÍ debe seguir incluido -- se resuelve vía
  // orderHasCancelledItems() y aparece en la columna "Cancelados" con acción "Desarmar".
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .not("status", "in", '("sent","devolución","devolucion","expired")')
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("fetchOrdersInitial error:", error);
    return [];
  }

  const enriched = await enrichOrders(
    supabase,
    (data || []) as AdminOrder[],
    warehouseIds,
    transports
  );
  return filterOrdersByBoardScope(enriched, scope, { warehouseIds }).filter(
    (order) => !isFinalOrderStatus(order)
  );
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

export async function rpcUpdateOrderItemStatus(
  supabase: SupabaseClient,
  itemId: string,
  status: string,
  checkedBy: string
) {
  const { data, error } = await supabase.rpc("rpc_update_order_item_status", {
    p_item_id: itemId,
    p_status: status,
    p_checked_by: checkedBy,
  });
  if (error) throw error;
  return data;
}

export async function rpcSplitOrderItemStatus(
  supabase: SupabaseClient,
  itemId: string,
  nPicked: number,
  nWaiting: number,
  nMissing: number,
  checkedBy: string
) {
  const { data, error } = await supabase.rpc("rpc_split_order_item_status", {
    p_item_id: itemId,
    p_n_picked: nPicked,
    p_n_waiting: nWaiting,
    p_n_missing: nMissing,
    p_checked_by: checkedBy,
  });
  if (error) throw error;
  return data;
}

export async function rpcMarkOrderItemWaitingSource(
  supabase: SupabaseClient,
  itemId: string,
  sourceCode: "general" | "venta-publico",
  checkedBy: string
) {
  const { data, error } = await supabase.rpc("rpc_mark_order_item_waiting_source", {
    p_item_id: itemId,
    p_source_code: sourceCode,
    p_checked_by: checkedBy,
  });
  if (error) throw error;
  return data;
}

export async function emitCustomerOrderNotification(
  supabase: SupabaseClient,
  params: {
    customerId: string;
    orderId: string;
    type: string;
    message: string;
    payload?: Record<string, unknown>;
    dedupeTypes?: string[];
  }
) {
  const { customerId, orderId, type, message, payload, dedupeTypes } = params;
  if (!customerId || !type || !message) return;

  if (dedupeTypes?.length) {
    await supabase
      .from("customer_notifications")
      .delete()
      .eq("customer_id", customerId)
      .eq("order_id", orderId)
      .in("type", dedupeTypes);
  }

  await supabase.from("customer_notifications").insert({
    customer_id: customerId,
    order_id: orderId,
    type,
    message,
    payload: payload ?? {},
    read: false,
    read_at: null,
  });
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

/**
 * Cliente pide cerrar con ítems todavía reserved/waiting: setea
 * notes.customer_requested_close vía SECURITY DEFINER (no hay RLS UPDATE
 * de customers sobre orders — un .update() directo falla en silencio).
 */
export async function rpcCustomerRequestClose(
  supabase: SupabaseClient,
  orderId: string
) {
  const { data, error } = await supabase.rpc("rpc_customer_request_close", {
    p_order_id: orderId,
  });
  if (error) throw error;
  return data;
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

/**
 * Mueve el pedido al otro Kanban (Pedidos ↔ Retiro) vía notes.kanban_scope.
 * No usa rpc_send_order_to_local (eso copia a local_orders / venta al público).
 */
export async function updateOrderKanbanScope(
  supabase: SupabaseClient,
  orderId: string,
  currentNotes: string | null | undefined,
  targetScope: "shipping" | "local_pickup"
) {
  const patch: Record<string, unknown> = { kanban_scope: targetScope };
  // Pedidos → Retiro: marca origen para color amarillo en Activos.
  // Retiro → Pedidos: limpia esa marca.
  if (targetScope === "local_pickup") {
    patch.retiro_origin = "moved_from_orders";
  } else {
    patch.retiro_origin = null;
  }
  const notes = applyOrderNotesPatch(currentNotes, patch);
  const { error } = await supabase
    .from("orders")
    .update({ notes, updated_at: new Date().toISOString() })
    .eq("id", orderId);
  if (error) throw error;
}

/**
 * Revierte un pedido "closed" a "active" (columna Apartados). Solo admin
 * (a diferencia de rpc_reopen_order, que es exclusiva de la propia clienta).
 * Ya en uso probado en admin/closed-orders.js.
 */
export async function rpcRevertOrderToPicked(
  supabase: SupabaseClient,
  orderId: string
) {
  const { error } = await supabase.rpc("rpc_revert_order_to_picked", {
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

/**
 * Existencias que figuran hoy en la web (catálogo público) para una variante+talle.
 * Fuente: variant_sizes.stock_qty — el mismo total que ve la clienta, sincronizado
 * automáticamente desde variant_size_warehouse_stock (trigger 84).
 */
export async function fetchVariantSizeStockQty(
  supabase: SupabaseClient,
  variantId: string,
  size: string
): Promise<number> {
  const normalized = normalizeSizeForStockLookup(size);
  if (!variantId || !normalized) return 0;

  const { data, error } = await supabase
    .from("variant_sizes")
    .select("stock_qty")
    .eq("variant_id", variantId)
    .eq("size", normalized)
    .maybeSingle();

  if (error || !data) return 0;
  return Number(data.stock_qty) || 0;
}

function normalizeSizeForStockLookup(size: string | null | undefined): string {
  const trimmed = String(size ?? "").trim();
  if (!trimmed) return "";
  return /^\d+(\.\d+)?$/.test(trimmed) ? trimmed.split(".")[0] : trimmed;
}

/**
 * Lleva a 0 el stock de una variante+talle (todos los depósitos) cuando el admin
 * confirma que no hay existencia real, aunque el sistema mostrara > 0.
 */
export async function rpcZeroVariantSizeStock(
  supabase: SupabaseClient,
  variantId: string,
  size: string,
  orderItemId?: string | null
) {
  const { data, error } = await supabase.rpc("rpc_admin_zero_variant_size_stock", {
    p_variant_id: variantId,
    p_size: size,
    p_order_item_id: orderItemId ?? null,
  });
  if (error) throw error;
  return data;
}
