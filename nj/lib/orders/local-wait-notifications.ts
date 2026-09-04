/**
 * Notificaciones campana admin — persistencia Supabase (compartida entre dispositivos).
 */

"use client";

import { create } from "zustand";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  dismissAdminOrderMessage,
  fetchAdminOrderMessageNotifications,
  markAdminOrderMessageCopied,
  recordAdminLocalWaitResolution,
  updateAdminLocalWaitSnapshotPrior,
  upsertAdminLocalWaitSnapshot,
  completeCustomerClosedNotification,
  type AdminOrderMsgNotificationRow,
} from "@/lib/supabase/admin-order-messages";
import { isCustomerClosedNotificationKind } from "@/lib/orders/closed-order-messages";
import { usePaymentPendingStore } from "@/lib/orders/payment-pending-notifications";
import type { MessageProfile, PriorDecisionSnapshot } from "@/lib/orders/customer-status-message";
import { buildPriorDecisionFromOrder } from "@/lib/orders/customer-status-message";
import type { AdminOrder, AdminOrderItem, WarehouseIds } from "@/types/orders";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface OrderMsgNotification {
  id: string;
  orderId: string | null;
  customerName: string;
  phone: string | null;
  message: string;
  kind: string;
  copiedAt: string | null;
  createdAt: string;
}

function rowToNotif(row: AdminOrderMsgNotificationRow): OrderMsgNotification {
  return {
    id: row.id,
    orderId: row.order_id,
    customerName: row.customer_name,
    phone: row.customer_phone,
    message: row.message,
    kind: row.kind || "local_wait_resolved",
    copiedAt: row.copied_at,
    createdAt: row.created_at,
  };
}

interface OrderMsgNotifsState {
  hydrated: boolean;
  loading: boolean;
  notifications: OrderMsgNotification[];
  realtimeChannel: RealtimeChannel | null;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  subscribeRealtime: () => () => void;
  saveLocalWaitSnapshot: (input: {
    orderId: string;
    customerName: string;
    phone: string | null;
    prior: PriorDecisionSnapshot;
    waitingLocalItemIds: string[];
    waitingFabricaItemIds?: string[];
    messageProfile?: MessageProfile;
    pickupDeadlineAt?: string | null;
  }) => Promise<void>;
  updateSnapshotPrior: (orderId: string, prior: PriorDecisionSnapshot) => Promise<void>;
  recordLocalWaitResolution: (
    orderId: string,
    itemId: string,
    outcome: "picked" | "missing",
    label: string
  ) => Promise<void>;
  markCopied: (id: string) => Promise<void>;
  dismiss: (id: string) => Promise<void>;
  completeClosed: (id: string, markCopied: boolean) => Promise<void>;
}

export const useOrderMsgNotifsStore = create<OrderMsgNotifsState>((set, get) => ({
  hydrated: false,
  loading: false,
  notifications: [],
  realtimeChannel: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const supabase = getSupabaseBrowserClient();
      const rows = await fetchAdminOrderMessageNotifications(supabase);
      set({ notifications: rows.map(rowToNotif), hydrated: true, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  hydrate: async () => {
    if (get().hydrated && !get().loading) return;
    await get().refresh();
  },

  subscribeRealtime: () => {
    const existing = get().realtimeChannel;
    if (existing) return () => existing.unsubscribe();

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel("admin-order-msg-notifications")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "admin_order_message_notifications" },
        () => {
          void get().refresh();
        }
      )
      .subscribe();

    set({ realtimeChannel: channel });
    return () => {
      channel.unsubscribe();
      set({ realtimeChannel: null });
    };
  },

  saveLocalWaitSnapshot: async (input) => {
    const supabase = getSupabaseBrowserClient();
    await upsertAdminLocalWaitSnapshot(supabase, input);
  },

  updateSnapshotPrior: async (orderId, prior) => {
    const supabase = getSupabaseBrowserClient();
    await updateAdminLocalWaitSnapshotPrior(supabase, orderId, prior);
  },

  recordLocalWaitResolution: async (orderId, itemId, outcome, label) => {
    const supabase = getSupabaseBrowserClient();
    const { notificationCreated } = await recordAdminLocalWaitResolution(
      supabase,
      orderId,
      itemId,
      outcome,
      label
    );
    if (notificationCreated) await get().refresh();
  },

  markCopied: async (id) => {
    const supabase = getSupabaseBrowserClient();
    await markAdminOrderMessageCopied(supabase, id);
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, copiedAt: n.copiedAt ?? new Date().toISOString() } : n
      ),
    }));
  },

  dismiss: async (id) => {
    const notif = get().notifications.find((n) => n.id === id);
    if (notif && isCustomerClosedNotificationKind(notif.kind)) {
      await get().completeClosed(id, false);
      return;
    }
    const supabase = getSupabaseBrowserClient();
    await dismissAdminOrderMessage(supabase, id);
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  completeClosed: async (id, markCopied) => {
    const supabase = getSupabaseBrowserClient();
    const { paymentPending } = await completeCustomerClosedNotification(
      supabase,
      id,
      markCopied
    );
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
    if (paymentPending) {
      void usePaymentPendingStore.getState().refresh();
    }
  },
}));

export async function saveLocalWaitSnapshotFromConfirm(input: {
  orderId: string;
  customerName: string;
  phone: string | null;
  prior: PriorDecisionSnapshot;
  waitingLocalItemIds: string[];
  waitingFabricaItemIds?: string[];
  messageProfile?: MessageProfile;
  pickupDeadlineAt?: string | null;
}): Promise<void> {
  await useOrderMsgNotifsStore.getState().saveLocalWaitSnapshot(input);
}

export async function updateLocalWaitSnapshotPriorFromConfirm(
  orderId: string,
  prior: PriorDecisionSnapshot,
  order?: Pick<AdminOrder, "local_deferred_pickup">
): Promise<void> {
  await useOrderMsgNotifsStore.getState().updateSnapshotPrior(orderId, prior);
  void order;
}

export async function recordLocalWaitItemResolution(
  orderId: string,
  itemId: string,
  outcome: "picked" | "missing",
  label: string
): Promise<{ notificationCreated: boolean }> {
  return useOrderMsgNotifsStore
    .getState()
    .recordLocalWaitResolution(orderId, itemId, outcome, label);
}

/** Sincroniza prior del snapshot si el pedido sigue con espera pendiente. */
export async function syncOrderSnapshotPriorFromOrder(
  orderId: string,
  items: AdminOrderItem[],
  warehouseIds: WarehouseIds,
  order?: Pick<AdminOrder, "local_deferred_pickup">
): Promise<void> {
  const prior = buildPriorDecisionFromOrder(items, warehouseIds, order);
  await updateLocalWaitSnapshotPriorFromConfirm(orderId, prior, order);
}
