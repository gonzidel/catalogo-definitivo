import { getDashboardActiveOrderUrl } from "@/lib/orders/customer-status-message";

import type { MessageProfile, PriorDecisionSnapshot } from "@/lib/orders/customer-status-message";

import type { SupabaseClient } from "@supabase/supabase-js";



export interface AdminOrderMsgNotificationRow {

  id: string;

  order_id: string;

  customer_name: string;

  customer_phone: string | null;

  message: string;

  kind: string;

  copied_at: string | null;

  dismissed_at: string | null;

  created_at: string;

}



function parseNotificationsPayload(data: unknown): AdminOrderMsgNotificationRow[] {

  if (!data || typeof data !== "object") return [];

  const obj = data as { notifications?: unknown };

  if (!Array.isArray(obj.notifications)) return [];

  return obj.notifications as AdminOrderMsgNotificationRow[];

}



function parseOrderIdsPayload(data: unknown): string[] {

  if (!data || typeof data !== "object") return [];

  const obj = data as { order_ids?: unknown };

  if (!Array.isArray(obj.order_ids)) return [];

  return obj.order_ids.filter((id): id is string => typeof id === "string");

}



export async function fetchAdminOrderMessageNotifications(

  supabase: SupabaseClient

): Promise<AdminOrderMsgNotificationRow[]> {

  const { data, error } = await supabase.rpc("rpc_list_admin_order_message_notifications");

  if (error) throw error;

  return parseNotificationsPayload(data);

}



function isRpcSignatureMismatch(error: { code?: string; message?: string }): boolean {
  const msg = String(error.message ?? "").toLowerCase();
  return (
    error.code === "PGRST202" ||
    msg.includes("could not find the function") ||
    msg.includes("schema cache")
  );
}

export async function upsertAdminLocalWaitSnapshot(
  supabase: SupabaseClient,
  input: {
    orderId: string;
    customerName: string;
    phone: string | null;
    prior: PriorDecisionSnapshot;
    waitingLocalItemIds: string[];
    waitingFabricaItemIds?: string[];
    messageProfile?: MessageProfile;
    pickupDeadlineAt?: string | null;
    dashboardUrl?: string;
  }
): Promise<void> {
  const localIds = input.waitingLocalItemIds ?? [];
  const fabricaIds = input.waitingFabricaItemIds ?? [];
  const mergedWaitingIds = [...new Set([...localIds, ...fabricaIds])];
  if (mergedWaitingIds.length === 0) {
    throw new Error("No hay ítems en espera para el snapshot");
  }

  const dashboardUrl = input.dashboardUrl ?? getDashboardActiveOrderUrl();
  const basePayload = {
    p_order_id: input.orderId,
    p_customer_name: input.customerName,
    p_customer_phone: input.phone,
    p_prior_confirmed_count: input.prior.confirmedCount,
    p_prior_missing_labels: input.prior.missingLabels,
    p_dashboard_url: dashboardUrl,
  };

  // Migración 314: arrays separados (espera fábrica en local especial).
  const extendedPayload = {
    ...basePayload,
    p_waiting_local_item_ids: localIds,
    p_waiting_fabrica_item_ids: fabricaIds,
    p_message_profile: input.messageProfile ?? "shipping",
    p_pickup_deadline_at: input.pickupDeadlineAt ?? null,
  };

  // Migración 305: un solo array; incluir fábrica en waiting_local_item_ids.
  const legacyPayload = {
    ...basePayload,
    p_waiting_local_item_ids: mergedWaitingIds,
  };

  let { error } = await supabase.rpc(
    "rpc_upsert_admin_local_wait_snapshot",
    extendedPayload
  );
  if (error && isRpcSignatureMismatch(error)) {
    ({ error } = await supabase.rpc(
      "rpc_upsert_admin_local_wait_snapshot",
      legacyPayload
    ));
  }
  if (error) throw error;
}



export async function updateAdminLocalWaitSnapshotPrior(

  supabase: SupabaseClient,

  orderId: string,

  prior: PriorDecisionSnapshot

): Promise<boolean> {

  const { data, error } = await supabase.rpc("rpc_update_admin_local_wait_snapshot_prior", {

    p_order_id: orderId,

    p_prior_confirmed_count: prior.confirmedCount,

    p_prior_missing_labels: prior.missingLabels,

  });

  if (error) throw error;

  return Boolean((data as { updated?: boolean } | null)?.updated);

}



export async function recordAdminLocalWaitResolution(

  supabase: SupabaseClient,

  orderId: string,

  itemId: string,

  outcome: "picked" | "missing",

  label: string

): Promise<{ notificationCreated: boolean }> {

  const { data, error } = await supabase.rpc("rpc_record_admin_local_wait_resolution", {

    p_order_id: orderId,

    p_item_id: itemId,

    p_outcome: outcome,

    p_label: label,

  });

  if (error) throw error;

  const payload = data as { notification_created?: boolean } | null;

  return { notificationCreated: Boolean(payload?.notification_created) };

}



export async function markAdminOrderMessageCopied(

  supabase: SupabaseClient,

  notificationId: string

): Promise<void> {

  const { error } = await supabase.rpc("rpc_mark_admin_order_message_copied", {

    p_notification_id: notificationId,

  });

  if (error) throw error;

}



export async function dismissAdminOrderMessage(

  supabase: SupabaseClient,

  notificationId: string

): Promise<void> {

  const { error } = await supabase.rpc("rpc_dismiss_admin_order_message", {

    p_notification_id: notificationId,

  });

  if (error) throw error;

}



export async function fetchAdminExpiryWarnSentOrderIds(

  supabase: SupabaseClient

): Promise<Set<string>> {

  const { data, error } = await supabase.rpc("rpc_list_admin_expiry_warn_sent");

  if (error) throw error;

  return new Set(parseOrderIdsPayload(data));

}



export async function markAdminExpiryWarnSent(

  supabase: SupabaseClient,

  orderId: string

): Promise<void> {

  const { error } = await supabase.rpc("rpc_mark_admin_expiry_warn_sent", {

    p_order_id: orderId,

  });

  if (error) throw error;

}



export async function createAdminLocalCannotSeparateAlert(

  supabase: SupabaseClient,

  pendingCount: number

): Promise<void> {

  const { error } = await supabase.rpc("rpc_create_admin_local_cannot_separate_alert", {

    p_pending_count: Math.max(0, pendingCount),

  });

  if (error) throw error;

}



export interface AdminPaymentPendingRow {

  id: string;

  order_id: string;

  customer_name: string;

  customer_phone: string | null;

  transport_name: string;

  created_at: string;

}



function parsePaymentPendingPayload(data: unknown): AdminPaymentPendingRow[] {

  if (!data || typeof data !== "object") return [];

  const obj = data as { payments?: unknown };

  if (!Array.isArray(obj.payments)) return [];

  return obj.payments as AdminPaymentPendingRow[];

}



export async function fetchAdminPaymentPending(

  supabase: SupabaseClient

): Promise<AdminPaymentPendingRow[]> {

  const { data, error } = await supabase.rpc("rpc_list_admin_payment_pending");

  if (error) throw error;

  return parsePaymentPendingPayload(data);

}



export async function confirmClosedOrderPayment(

  supabase: SupabaseClient,

  orderId: string

): Promise<void> {

  const { error } = await supabase.rpc("rpc_confirm_closed_order_payment", {

    p_order_id: orderId,

  });

  if (error) throw error;

}



export async function completeCustomerClosedNotification(

  supabase: SupabaseClient,

  notificationId: string,

  markCopied: boolean

): Promise<{ paymentPending: boolean }> {

  const { data, error } = await supabase.rpc(

    "rpc_complete_customer_closed_notification",

    {

      p_notification_id: notificationId,

      p_mark_copied: markCopied,

    }

  );

  if (error) throw error;

  const payload = data as { payment_pending?: boolean } | null;

  return { paymentPending: Boolean(payload?.payment_pending) };

}



export interface CorreoPendingShippingRow {

  order_id: string;

  customer_name: string;

  order_number: string | null;

  closed_at: string | null;

}



export async function fetchCorreoPendingShippingCost(

  supabase: SupabaseClient

): Promise<CorreoPendingShippingRow[]> {

  const { data, error } = await supabase.rpc("rpc_list_correo_pending_shipping_cost");

  if (error) throw error;

  if (!data || typeof data !== "object") return [];

  const obj = data as { orders?: unknown };

  if (!Array.isArray(obj.orders)) return [];

  return obj.orders as CorreoPendingShippingRow[];

}



export async function setCorreoShippingCost(

  supabase: SupabaseClient,

  orderId: string,

  cost: number

): Promise<void> {

  const { error } = await supabase.rpc("rpc_set_correo_shipping_cost", {

    p_order_id: orderId,

    p_cost: cost,

  });

  if (error) throw error;

}



export async function switchCodOrderToPagado(

  supabase: SupabaseClient,

  orderId: string,

  persist: boolean

): Promise<{ mode: string; fulfillmentStatus?: string }> {

  const { data, error } = await supabase.rpc("rpc_switch_cod_order_to_pagado", {

    p_order_id: orderId,

    p_persist: persist,

  });

  if (error) throw error;

  const payload = data as { mode?: string; fulfillment_status?: string } | null;

  return {

    mode: String(payload?.mode || ""),

    fulfillmentStatus: payload?.fulfillment_status,

  };

}

