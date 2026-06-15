"use client";

import { create } from "zustand";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import {
  ADMIN_ENABLE_24H_USES_KEY,
  applyOrderNotesPatch,
  getEnable24hUsesFromOrder,
  parseOrderNotesObject,
  parseStockPendingReasonConflict,
} from "@/lib/orders/domain";
import { normalizeSize } from "@/lib/utils/size-normalizer";
import {
  fetchOrderById,
  resolveStockPendingOrderRpc,
  rpcCancelOrderFull,
  rpcCloseOrder,
  rpcMarkOrderItemsPicked,
  rpcRemoveOrderItemRestoreStock,
  rpcReopenOrder,
  rpcSendOrderToLocal,
} from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { AdminOrder, KanbanColumnId } from "@/types/orders";
import type { RealtimeChannel, RealtimePostgresInsertPayload } from "@supabase/supabase-js";

export type ToastKind = "success" | "error" | "info";

export interface OrdersToastState {
  message: string;
  kind: ToastKind;
}

interface OrdersState {
  orders: AdminOrder[];
  hydrated: boolean;
  toast: OrdersToastState | null;
  loadingAction: string | null;

  hydrate: (orders: AdminOrder[]) => void;
  showToast: (message: string, kind?: ToastKind) => void;
  clearToast: () => void;
  getColumnOrders: (columnId: KanbanColumnId) => AdminOrder[];
  patchOrder: (order: AdminOrder) => void;
  removeOrder: (orderId: string) => void;
  addOrderIfMissing: (order: AdminOrder) => void;

  pickAllReserved: (orderId: string) => Promise<void>;
  cancelItem: (orderId: string, itemId: string) => Promise<void>;
  closeOrder: (orderId: string, paymentMethod: string) => Promise<void>;
  sendToLocal: (orderId: string) => Promise<void>;
  reopenOrder: (orderId: string) => Promise<void>;
  resolveStockPending: (orderId: string) => Promise<void>;
  cancelStockPendingOrder: (orderId: string) => Promise<void>;
  dismantleOrder: (orderId: string) => Promise<void>;
  extendOrder24h: (orderId: string) => Promise<void>;

  subscribeNewOrders: () => () => void;
}

function cloneOrders(orders: AdminOrder[]): AdminOrder[] {
  return orders.map((o) => ({
    ...o,
    order_items: (o.order_items || []).map((i) => ({ ...i })),
  }));
}

function findOrder(state: OrdersState, orderId: string): AdminOrder | undefined {
  return state.orders.find((o) => o.id === orderId);
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Ocurrió un error inesperado";
}

let realtimeChannel: RealtimeChannel | null = null;

export const useOrdersStore = create<OrdersState>((set, get) => ({
  orders: [],
  hydrated: false,
  toast: null,
  loadingAction: null,

  hydrate: (orders) => set({ orders, hydrated: true }),

  showToast: (message, kind = "info") => set({ toast: { message, kind } }),

  clearToast: () => set({ toast: null }),

  getColumnOrders: (columnId) => filterOrdersForColumn(get().orders, columnId),

  patchOrder: (order) =>
    set((state) => ({
      orders: state.orders.some((o) => o.id === order.id)
        ? state.orders.map((o) => (o.id === order.id ? order : o))
        : [...state.orders, order],
    })),

  removeOrder: (orderId) =>
    set((state) => ({
      orders: state.orders.filter((o) => o.id !== orderId),
    })),

  addOrderIfMissing: (order) =>
    set((state) => {
      if (state.orders.some((o) => o.id === order.id)) return state;
      return { orders: [order, ...state.orders] };
    }),

  pickAllReserved: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const reservedIds = (order.order_items || [])
      .filter((i) => String(i.status).trim().toLowerCase() === "reserved")
      .map((i) => i.id);

    if (reservedIds.length === 0) {
      get().showToast("No hay ítems reservados para apartar", "info");
      return;
    }

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              order_items: (o.order_items || []).map((item) =>
                reservedIds.includes(item.id) ? { ...item, status: "picked" } : item
              ),
            }
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcMarkOrderItemsPicked(supabase, reservedIds, "pick_all");
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Ítems apartados", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  cancelItem: async (orderId, itemId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const remainingItems = (order.order_items || []).filter((item) => item.id !== itemId);

    set((state) => ({
      orders: state.orders
        .map((o) =>
          o.id !== orderId ? o : { ...o, order_items: remainingItems }
        )
        .filter((o) => o.id !== orderId || (o.order_items || []).length > 0),
      loadingAction: itemId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcRemoveOrderItemRestoreStock(supabase, itemId);

      if (remainingItems.length === 0) {
        get().removeOrder(orderId);
        get().showToast("Ítem quitado — pedido vacío", "success");
        return;
      }

      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Ítem quitado del pedido", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  closeOrder: async (orderId, paymentMethod) => {
    const snapshot = cloneOrders(get().orders);
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === orderId ? { ...o, status: "closed" } : o
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcCloseOrder(supabase, orderId, paymentMethod);
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Pedido cerrado", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  sendToLocal: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    set({ loadingAction: orderId });

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcSendOrderToLocal(supabase, orderId);
      get().removeOrder(orderId);
      get().showToast("Pedido enviado al local", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  reopenOrder: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === orderId ? { ...o, status: "active" } : o
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcReopenOrder(supabase, orderId);
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Pedido reabierto", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  resolveStockPending: async (orderId) => {
    const order = findOrder(get(), orderId);
    if (!order) return;

    if (String(order.status).trim().toLowerCase() !== "stock_pending") {
      get().showToast("Este pedido ya no está en stock pendiente", "info");
      return;
    }

    const notesObj = parseOrderNotesObject(order.notes);
    const reasonRaw = String(notesObj.stock_pending_reason || "").trim();
    const parsed = parseStockPendingReasonConflict(reasonRaw);
    if (!parsed?.variant_id) {
      get().showToast(
        "No se pudo identificar el producto en conflicto. Cancelá el pedido manualmente.",
        "error"
      );
      return;
    }

    const targetItem = (order.order_items || []).find((item) => {
      const sameVariant = String(item?.variant_id || "") === String(parsed.variant_id);
      const sameSize = normalizeSize(item?.size || "") === parsed.size;
      const itemStatus = String(item?.status || "").trim().toLowerCase();
      return sameVariant && sameSize && itemStatus !== "cancelled";
    });

    if (!targetItem?.id) {
      get().showToast("No se encontró el ítem conflictivo", "error");
      return;
    }

    const snapshot = cloneOrders(get().orders);
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              status: "active",
              order_items: (o.order_items || []).filter((i) => i.id !== targetItem.id),
            }
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      const refreshed = await resolveStockPendingOrderRpc(
        supabase,
        order,
        targetItem.id
      );
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Conflicto resuelto", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  cancelStockPendingOrder: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === orderId ? { ...o, status: "cancelled" } : o
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcCancelOrderFull(supabase, orderId);
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Pedido cancelado", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  dismantleOrder: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    set((state) => ({
      orders: state.orders.filter((o) => o.id !== orderId),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcCancelOrderFull(supabase, orderId);
      get().showToast("Pedido desarmado — stock restaurado", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  extendOrder24h: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const newDismantleAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const nextNotes = applyOrderNotesPatch(order.notes, {
      [ADMIN_ENABLE_24H_USES_KEY]: getEnable24hUsesFromOrder(order) + 1,
    });

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === orderId
          ? { ...o, dismantle_at: newDismantleAt, notes: nextNotes }
          : o
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase
        .from("orders")
        .update({
          dismantle_at: newDismantleAt,
          notes: nextNotes,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId);

      if (error) throw error;

      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Prórroga +24hs aplicada", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  subscribeNewOrders: () => {
    const supabase = getSupabaseBrowserClient();

    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    realtimeChannel = supabase
      .channel("orders-new")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "orders" },
        async (payload: RealtimePostgresInsertPayload<{ id: string }>) => {
          const newId = (payload.new as { id?: string })?.id;
          if (!newId) return;
          const full = await fetchOrderById(supabase, newId);
          if (full) get().addOrderIfMissing(full);
        }
      )
      .subscribe();

    return () => {
      if (realtimeChannel) {
        supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
      }
    };
  },
}));

export function useOrders() {
  return useOrdersStore();
}
