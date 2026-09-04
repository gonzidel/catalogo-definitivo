/**
 * Panel Pagos Kanban — transferencias pendientes de confirmación.
 * Solo pedidos auto-gestionados por la clienta (misma regla que la campana).
 */

"use client";

import { create } from "zustand";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isCustomerSourcedOrder } from "@/lib/orders/domain";
import {
  confirmClosedOrderPayment,
  fetchAdminPaymentPending,
  type AdminPaymentPendingRow,
} from "@/lib/supabase/admin-order-messages";
import type { RealtimeChannel } from "@supabase/supabase-js";

export interface PaymentPendingNotification {
  id: string;
  orderId: string;
  customerName: string;
  phone: string | null;
  transportName: string;
  createdAt: string;
}

function rowToPayment(row: AdminPaymentPendingRow): PaymentPendingNotification {
  return {
    id: row.id,
    orderId: row.order_id,
    customerName: row.customer_name,
    phone: row.customer_phone,
    transportName: row.transport_name,
    createdAt: row.created_at,
  };
}

/** Descarta filas de pedidos admin/PAU (no auto-gestión clienta). */
async function filterCustomerSourcedPayments(
  rows: AdminPaymentPendingRow[]
): Promise<AdminPaymentPendingRow[]> {
  if (rows.length === 0) return rows;

  const supabase = getSupabaseBrowserClient();
  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const { data, error } = await supabase
    .from("orders")
    .select("id, source")
    .in("id", orderIds);

  if (error || !data) {
    // Sin source no podemos arriesgar mostrar pedidos admin: ocultar todo.
    return [];
  }

  const allowed = new Set(
    data
      .filter((o) => isCustomerSourcedOrder(o))
      .map((o) => o.id as string)
  );

  return rows.filter((r) => allowed.has(r.order_id));
}

interface PaymentPendingState {
  hydrated: boolean;
  loading: boolean;
  payments: PaymentPendingNotification[];
  realtimeChannel: RealtimeChannel | null;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  subscribeRealtime: () => () => void;
  confirmPayment: (orderId: string) => Promise<void>;
}

export const usePaymentPendingStore = create<PaymentPendingState>((set, get) => ({
  hydrated: false,
  loading: false,
  payments: [],
  realtimeChannel: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const supabase = getSupabaseBrowserClient();
      const rows = await fetchAdminPaymentPending(supabase);
      const customerRows = await filterCustomerSourcedPayments(rows);
      set({ payments: customerRows.map(rowToPayment), hydrated: true, loading: false });
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
      .channel("admin-order-payment-pending")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "admin_order_payment_pending" },
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

  confirmPayment: async (orderId) => {
    const supabase = getSupabaseBrowserClient();
    await confirmClosedOrderPayment(supabase, orderId);
    set((state) => ({
      payments: state.payments.filter((p) => p.orderId !== orderId),
    }));
  },
}));
