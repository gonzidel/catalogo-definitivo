"use client";

import { create } from "zustand";
import {
  filterOrdersForColumn,
  isFinalOrderStatus,
  shouldAutoCloseAfterCustomerRequest,
} from "@/lib/orders/classification";
import {
  filterOrdersByBoardScope,
  orderBelongsOnKanban,
  otherBoardScope,
  otherBoardTitle,
  realtimeChannelForScope,
  waitingLocalLabel,
  type BoardScope,
} from "@/lib/orders/board-scope";
import {
  ADMIN_ENABLE_24H_USES_KEY,
  applyOrderNotesPatch,
  getCancelledItemsPendingStockReturn,
  getCustomerFromOrder,
  getEnable24hUsesFromOrder,
  parseOrderNotesObject,
  parseStockPendingReasonConflict,
} from "@/lib/orders/domain";
import { normalizeSize } from "@/lib/utils/size-normalizer";
import {
  fetchOrderById,
  fetchOrdersInitial,
  fetchVariantSizeStockQty,
  emitCustomerOrderNotification,
  loadWarehouses,
  resolveStockPendingOrderRpc,
  rpcCancelOrderFull,
  rpcCloseOrder,
  rpcMarkOrderItemWaitingSource,
  rpcMarkOrderItemsPicked,
  rpcRemoveOrderItemRestoreStock,
  rpcRevertOrderToPicked,
  rpcSendOrderToLocal,
  rpcSplitOrderItemStatus,
  rpcUpdateOrderItemStatus,
  rpcZeroVariantSizeStock,
  updateOrderKanbanScope,
} from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isLocalZoneCustomerShippingOrder } from "@/lib/transport/shipping-helpers";
import { formatItemProductLabel } from "@/lib/orders/customer-status-message";
import {
  recordLocalWaitItemResolution,
  syncOrderSnapshotPriorFromOrder,
} from "@/lib/orders/local-wait-notifications";
import { getWaitingSourceKind } from "@/lib/orders/waiting-source";
import type { AdminOrder, AdminOrderItem, KanbanColumnId, WarehouseIds } from "@/types/orders";
import type { RealtimeChannel, RealtimePostgresInsertPayload } from "@supabase/supabase-js";

export type ToastKind = "success" | "error" | "info";

export interface OrdersToastState {
  message: string;
  kind: ToastKind;
}

interface OrdersState {
  orders: AdminOrder[];
  warehouseIds: WarehouseIds;
  boardScope: BoardScope;
  hydrated: boolean;
  toast: OrdersToastState | null;
  loadingAction: string | null;

  hydrate: (orders: AdminOrder[], scope?: BoardScope) => void;
  refreshAll: () => Promise<void>;
  showToast: (message: string, kind?: ToastKind) => void;
  clearToast: () => void;
  getColumnOrders: (columnId: KanbanColumnId) => AdminOrder[];
  patchOrder: (order: AdminOrder) => void;
  removeOrder: (orderId: string) => void;
  addOrderIfMissing: (order: AdminOrder) => void;

  pickAllReserved: (orderId: string) => Promise<void>;
  cancelItem: (orderId: string, itemId: string) => Promise<void>;
  confirmCancelledItem: (orderId: string, itemId: string) => Promise<void>;
  confirmAllCancelledItems: (orderId: string) => Promise<void>;
  markItemMissing: (orderId: string, itemId: string) => Promise<void>;
  /** Existencias que figuran hoy en la web para variante+talle (para el aviso al presionar ✕). */
  getVariantSizeStockQty: (variantId: string, size: string) => Promise<number>;
  /** Lleva a 0 el stock de variante+talle: admin confirmó que no hay existencia real. */
  zeroVariantSizeStock: (
    variantId: string,
    size: string,
    itemId?: string | null
  ) => Promise<void>;
  markItemPicked: (orderId: string, itemId: string) => Promise<void>;
  markItemWaiting: (
    orderId: string,
    itemId: string,
    source: "fabrica" | "local"
  ) => Promise<void>;
  /** Reparte un ítem con varias unidades entre apartado/espera/sin stock (flujo "¿Cuántas hay disponibles?"). */
  splitReservedItem: (
    orderId: string,
    itemId: string,
    nPicked: number,
    nWaiting: number,
    nMissing: number,
    waitingSource?: "fabrica" | "local"
  ) => Promise<void>;
  /**
   * Igual que splitReservedItem, pero permite que la espera se reparta entre
   * fábrica Y local en la misma acción (reparto por unidad). rpc_split_order_item_status
   * solo genera un ítem "waiting" por llamada, así que esto encadena dos llamadas:
   * primero separa el grupo "local" (dejando apartado real + fábrica agrupados como
   * "picked" intermedio), y después vuelve a repartir ese intermedio en apartado real
   * + espera fábrica. Un solo refresh al final.
   */
  splitReservedItemMixed: (
    orderId: string,
    itemId: string,
    nPicked: number,
    nFabrica: number,
    nLocal: number,
    nMissing: number
  ) => Promise<void>;
  closeOrder: (orderId: string, paymentMethod: string) => Promise<void>;
  sendToLocal: (orderId: string) => Promise<void>;
  /** Apartados: mueve el pedido al otro tablero (Pedidos ↔ Retiro). */
  moveOrderToOtherBoard: (orderId: string) => Promise<void>;
  /** Cerrados -> Apartados: solo admin (rpc_revert_order_to_picked) */
  revertOrderToPicked: (orderId: string) => Promise<void>;
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

/** Ítem en espera cuya resolución alimenta snapshot → campana (local/depósito o fábrica en local diferido). */
function itemWaitingForSnapshotResolution(
  item: AdminOrderItem | undefined,
  order: AdminOrder | undefined,
  wh: WarehouseIds
): boolean {
  if (!item || !order) return false;
  if (String(item.status || "").trim().toLowerCase() !== "waiting") return false;
  const kind = getWaitingSourceKind(item, wh);
  if (kind === "local") return true;
  return kind === "fabrica" && Boolean(order.local_deferred_pickup);
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Ocurrió un error inesperado";
}

let realtimeChannel: RealtimeChannel | null = null;

/** Checkout inserta order y luego items: reintentar hasta que haya ítems operativos. */
async function fetchOrderWhenReady(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  orderId: string,
  attempts = 5
): Promise<AdminOrder | null> {
  let last: AdminOrder | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchOrderById(supabase, orderId);
    if (last && (last.order_items?.length ?? 0) > 0) return last;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return last;
}

/**
 * Refresca el pedido después de resolver un ítem (apartar, marcar sin stock, dividir,
 * confirmar cancelado, etc.) y, si la clienta ya había pedido cerrar (`customer_requested_close`)
 * y el pedido quedó totalmente apartado, lo cierra automáticamente en vez de dejarlo
 * esperando en Apartados. Centralizado acá para que TODAS las acciones que puedan dejar
 * un pedido "listo" lo chequeen igual, no solo "Apartar todos" (ver `shouldAutoCloseAfterCustomerRequest`).
 *
 * Si el intento de auto-cierre falla (ej. `rpc_close_order` rechaza por `dismantle_at`
 * ya vencido, carrera con el cron de mantenimiento), la acción que sí tuvo éxito
 * (apartar/dividir/confirmar) NO se revierte: solo queda sin auto-cerrar, para que
 * el admin lo cierre a mano. El caller no debe volver a lanzar este error.
 */
/**
 * Exportada (no solo de uso interno del store) porque cualquier flujo que pueda
 * dejar un pedido "todo apartado" mientras la clienta ya pidió cerrar necesita
 * este mismo chequeo -- no solo las acciones del store. Ver bug real: agregar un
 * producto desde "Editar pedido"/"Crear pedido" (admin) marcándolo apartado de
 * una podía completar el pedido sin que nadie consumiera `customer_requested_close`,
 * dejándolo trabado en Apartados con el botón "Cerrar pedido" pendiente para siempre.
 */
export async function refreshAndMaybeAutoClose(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  orderId: string
): Promise<{ order: AdminOrder | null; autoClosed: boolean }> {
  const refreshed = await fetchOrderById(supabase, orderId);
  if (!refreshed) return { order: null, autoClosed: false };
  if (!shouldAutoCloseAfterCustomerRequest(refreshed)) {
    return { order: refreshed, autoClosed: false };
  }
  try {
    await rpcCloseOrder(supabase, orderId, "Pendiente");
  } catch {
    return { order: refreshed, autoClosed: false };
  }
  const customer = getCustomerFromOrder(refreshed);
  if (
    isLocalZoneCustomerShippingOrder(
      customer?.province,
      customer?.city,
      refreshed.transportName ?? null
    )
  ) {
    await supabase
      .from("orders")
      .update({
        notes: applyOrderNotesPatch(refreshed.notes, {
          local_zone_shipping_close: true,
        }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId);
  }
  const closed = await fetchOrderById(supabase, orderId);
  return { order: closed ?? refreshed, autoClosed: true };
}

export const useOrdersStore = create<OrdersState>((set, get) => ({
  orders: [],
  warehouseIds: { general: null, ventaPublico: null },
  boardScope: "shipping",
  hydrated: false,
  toast: null,
  loadingAction: null,

  hydrate: (orders, scope) =>
    set((state) => {
      const boardScope = scope ?? state.boardScope;
      const wh = state.warehouseIds;
      const hasWarehouses = Boolean(wh.general || wh.ventaPublico);
      return {
        orders: hasWarehouses
          ? filterOrdersByBoardScope(orders, boardScope, { warehouseIds: wh })
          : orders,
        boardScope,
        hydrated: true,
      };
    }),

  refreshAll: async () => {
    const supabase = getSupabaseBrowserClient();
    const scope = get().boardScope;
    const [orders, warehouseIds] = await Promise.all([
      fetchOrdersInitial(supabase, scope),
      loadWarehouses(supabase),
    ]);
    set({ orders, warehouseIds, hydrated: true });
  },

  showToast: (message, kind = "info") => set({ toast: { message, kind } }),

  clearToast: () => set({ toast: null }),

  getColumnOrders: (columnId) =>
    filterOrdersForColumn(get().orders, columnId, {
      boardScope: get().boardScope,
      warehouseIds: get().warehouseIds,
    }),

  patchOrder: (order) =>
    set((state) => {
      // Pedido llegó (o pasó) a un estado terminal (sent/devolución/expired) vía
      // realtime: sacarlo del store en vez de dejarlo colgado. Sin esto quedaba
      // en memoria para siempre (bloat + podía matchear mal alguna columna).
      if (isFinalOrderStatus(order)) {
        return { orders: state.orders.filter((o) => o.id !== order.id) };
      }
      if (!orderBelongsOnKanban(order, state.boardScope, state.warehouseIds)) {
        return { orders: state.orders.filter((o) => o.id !== order.id) };
      }
      return {
        orders: state.orders.some((o) => o.id === order.id)
          ? state.orders.map((o) => (o.id === order.id ? order : o))
          : [...state.orders, order],
      };
    }),

  removeOrder: (orderId) =>
    set((state) => ({
      orders: state.orders.filter((o) => o.id !== orderId),
    })),

  addOrderIfMissing: (order) =>
    set((state) => {
      if (!orderBelongsOnKanban(order, state.boardScope, state.warehouseIds)) return state;
      if (state.orders.some((o) => o.id === order.id)) return state;
      return { orders: [order, ...state.orders] };
    }),

  pickAllReserved: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const reservedIds = (order.order_items || [])
      .filter((i) => {
        const st = String(i.status).trim().toLowerCase();
        return st === "reserved" || st === "awaiting_apartado";
      })
      .map((i) => i.id);

    if (reservedIds.length === 0) {
      get().showToast("No hay ítems pendientes de apartar", "info");
      return;
    }

    // Predicción optimista: cómo quedaría el pedido con estos ítems ya apartados,
    // para saber de una si el cierre automático va a aplicar (evita flash en
    // Espera/Apartados antes de que vuelva la respuesta del server).
    const predictedOrder: AdminOrder = {
      ...order,
      order_items: (order.order_items || []).map((item) =>
        reservedIds.includes(item.id) ? { ...item, status: "picked" } : item
      ),
    };
    const willAutoClose = shouldAutoCloseAfterCustomerRequest(predictedOrder);

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : willAutoClose
            ? { ...predictedOrder, status: "closed" }
            : predictedOrder
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcMarkOrderItemsPicked(supabase, reservedIds, "pick_all");
      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast(
        autoClosed ? "Pedido cerrado — el cliente ya había pedido el cierre" : "Ítems apartados",
        "success"
      );
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
      else get().removeOrder(orderId);
      get().showToast("Ítem quitado del pedido", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  confirmAllCancelledItems: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const pending = getCancelledItemsPendingStockReturn(order);
    if (pending.length === 0) {
      get().showToast("No hay cancelaciones pendientes de confirmar", "info");
      return;
    }

    const pendingIds = new Set(pending.map((item) => item.id));
    const loadingKey = `confirm-all-cancelled:${orderId}`;

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              order_items: (o.order_items || []).filter((item) => !pendingIds.has(item.id)),
            }
      ),
      loadingAction: loadingKey,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      for (const item of pending) {
        const result = await rpcRemoveOrderItemRestoreStock(supabase, item.id);
        if (result?.order_deleted) {
          get().removeOrder(orderId);
          get().showToast(
            pending.length === 1
              ? "Cancelación confirmada — pedido actualizado"
              : `${pending.length} cancelaciones confirmadas — pedido actualizado`,
            "success"
          );
          return;
        }
      }

      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      else get().removeOrder(orderId);
      get().showToast(
        autoClosed
          ? "Pedido cerrado — el cliente ya había pedido el cierre"
          : pending.length === 1
            ? "Cancelación confirmada — stock actualizado"
            : `${pending.length} cancelaciones confirmadas — stock actualizado`,
        "success"
      );
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  confirmCancelledItem: async (orderId, itemId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const target = (order.order_items || []).find((i) => i.id === itemId);
    if (!target || String(target.status || "").toLowerCase() !== "cancelled") {
      get().showToast("Este producto no está cancelado", "error");
      return;
    }

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
      const result = await rpcRemoveOrderItemRestoreStock(supabase, itemId);

      // Solo quitar el pedido si el backend lo borró (p. ej. ya no quedan ítems).
      // No usar remainingItems.length: al confirmar 1 de varios cancelados con stock
      // pendiente, el pedido debe seguir visible hasta devolver todo (319).
      if (result?.order_deleted) {
        get().removeOrder(orderId);
        get().showToast("Cancelación confirmada — pedido actualizado", "success");
        return;
      }

      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      else get().removeOrder(orderId);
      get().showToast(
        autoClosed
          ? "Pedido cerrado — el cliente ya había pedido el cierre"
          : "Cancelación confirmada — stock actualizado",
        "success"
      );
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  markItemMissing: async (orderId, itemId) => {
    const snapshot = cloneOrders(get().orders);
    const orderBefore = findOrder(get(), orderId);
    const itemBefore = (orderBefore?.order_items || []).find((item) => item.id === itemId);
    const wh = get().warehouseIds;
    const wasWaitingDeferred = itemWaitingForSnapshotResolution(itemBefore, orderBefore, wh);

    const order = findOrder(get(), orderId);
    if (!order) return;

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              order_items: (o.order_items || []).map((item) =>
                item.id === itemId ? { ...item, status: "missing" } : item
              ),
            }
      ),
      loadingAction: itemId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Sesión admin no disponible");

      await rpcUpdateOrderItemStatus(supabase, itemId, "missing", user.id);

      await emitCustomerOrderNotification(supabase, {
        customerId: order.customer_id,
        orderId,
        type: "ORDER_MISSING_ITEMS",
        message: "1 producto no está disponible. Por favor revisalo en tu pedido.",
        payload: { missingCount: 1, action_url: "/nj/dashboard?tab=active-order" },
        dedupeTypes: ["ORDER_MISSING_ITEMS", "ORDER_ALL_RESERVED"],
      });

      const missingItem = (order.order_items || []).find((item) => item.id === itemId);
      if (wasWaitingDeferred) {
        const { notificationCreated } = await recordLocalWaitItemResolution(
          orderId,
          itemId,
          "missing",
          formatItemProductLabel(missingItem || itemBefore || {})
        );
        if (notificationCreated) {
          get().showToast("Mensaje listo en la campana", "success");
        }
      }

      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) {
        get().patchOrder(refreshed);
        if (!wasWaitingDeferred) {
          try {
            await syncOrderSnapshotPriorFromOrder(
              orderId,
              refreshed.order_items || [],
              get().warehouseIds,
              refreshed
            );
          } catch {
            // sin snapshot activo
          }
        }
      }
      get().showToast("Producto marcado sin stock", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  getVariantSizeStockQty: async (variantId, size) => {
    if (!variantId || !size) return 0;
    try {
      const supabase = getSupabaseBrowserClient();
      return await fetchVariantSizeStockQty(supabase, variantId, size);
    } catch {
      return 0;
    }
  },

  zeroVariantSizeStock: async (variantId, size, itemId) => {
    if (!variantId || !size) return;
    try {
      const supabase = getSupabaseBrowserClient();
      await rpcZeroVariantSizeStock(supabase, variantId, size, itemId ?? null);
      get().showToast("Existencias llevadas a 0", "success");
    } catch (err) {
      get().showToast(getErrorMessage(err), "error");
    }
  },

  markItemPicked: async (orderId, itemId) => {
    const snapshot = cloneOrders(get().orders);
    const orderBefore = findOrder(get(), orderId);
    const itemBefore = (orderBefore?.order_items || []).find((item) => item.id === itemId);
    const wh = get().warehouseIds;
    const wasWaitingDeferred = itemWaitingForSnapshotResolution(itemBefore, orderBefore, wh);

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              order_items: (o.order_items || []).map((item) =>
                item.id === itemId ? { ...item, status: "picked" } : item
              ),
            }
      ),
      loadingAction: itemId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcMarkOrderItemsPicked(supabase, [itemId], "pick_one");
      if (wasWaitingDeferred) {
        const { notificationCreated } = await recordLocalWaitItemResolution(
          orderId,
          itemId,
          "picked",
          formatItemProductLabel(itemBefore || {})
        );
        if (notificationCreated) {
          get().showToast("Mensaje listo en la campana", "success");
        }
      }
      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, orderId);
      if (refreshed) {
        get().patchOrder(refreshed);
        if (!wasWaitingDeferred) {
          try {
            await syncOrderSnapshotPriorFromOrder(
              orderId,
              refreshed.order_items || [],
              get().warehouseIds,
              refreshed
            );
          } catch {
            // sin snapshot activo
          }
        }
      }
      get().showToast(
        autoClosed ? "Pedido cerrado — el cliente ya había pedido el cierre" : "Producto apartado",
        "success"
      );
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  markItemWaiting: async (orderId, itemId, source) => {
    const snapshot = cloneOrders(get().orders);
    const sourceCode = source === "local" ? "venta-publico" : "general";

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id !== orderId
          ? o
          : {
              ...o,
              order_items: (o.order_items || []).map((item) =>
                item.id === itemId ? { ...item, status: "waiting" } : item
              ),
            }
      ),
      loadingAction: itemId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Sesión admin no disponible");

      await rpcMarkOrderItemWaitingSource(supabase, itemId, sourceCode, user.id);
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast(
        source === "local"
          ? `En espera (${waitingLocalLabel(get().boardScope).toLowerCase()})`
          : "En espera (fábrica)",
        "success"
      );
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  splitReservedItem: async (orderId, itemId, nPicked, nWaiting, nMissing, waitingSource) => {
    const snapshot = cloneOrders(get().orders);
    set({ loadingAction: itemId });

    try {
      const supabase = getSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Sesión admin no disponible");

      const result = await rpcSplitOrderItemStatus(
        supabase,
        itemId,
        nPicked,
        nWaiting,
        nMissing,
        user.id
      );

      const newWaitingItemId = (result as { split_item_ids?: { waiting?: string | null } } | null)
        ?.split_item_ids?.waiting;
      if (nWaiting > 0 && waitingSource && newWaitingItemId) {
        const sourceCode = waitingSource === "local" ? "venta-publico" : "general";
        await rpcMarkOrderItemWaitingSource(supabase, newWaitingItemId, sourceCode, user.id);
      }

      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast(
        autoClosed
          ? "Pedido cerrado — el cliente ya había pedido el cierre"
          : `Apartados: ${nPicked} · Espera: ${nWaiting} · Sin stock: ${nMissing}`,
        "success"
      );
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  splitReservedItemMixed: async (orderId, itemId, nPicked, nFabrica, nLocal, nMissing) => {
    const snapshot = cloneOrders(get().orders);
    set({ loadingAction: itemId });

    try {
      const supabase = getSupabaseBrowserClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user?.id) throw new Error("Sesión admin no disponible");

      // Paso 1: separar ya el grupo "local". El resto (apartado real + fábrica)
      // queda agrupado momentáneamente como "picked" para volver a repartirlo.
      const step1 = await rpcSplitOrderItemStatus(
        supabase,
        itemId,
        nPicked + nFabrica,
        nLocal,
        nMissing,
        user.id
      );
      const step1Ids = (step1 as {
        split_item_ids?: { picked?: string | null; waiting?: string | null };
      } | null)?.split_item_ids;

      if (nLocal > 0 && step1Ids?.waiting) {
        await rpcMarkOrderItemWaitingSource(supabase, step1Ids.waiting, "venta-publico", user.id);
      }

      // Paso 2: del intermedio "picked" (apartado real + fábrica), separar la fábrica.
      if (nFabrica > 0 && step1Ids?.picked) {
        const step2 = await rpcSplitOrderItemStatus(
          supabase,
          step1Ids.picked,
          nPicked,
          nFabrica,
          0,
          user.id
        );
        const step2WaitingId = (step2 as { split_item_ids?: { waiting?: string | null } } | null)
          ?.split_item_ids?.waiting;
        if (step2WaitingId) {
          await rpcMarkOrderItemWaitingSource(supabase, step2WaitingId, "general", user.id);
        }
      }

      const { order: refreshed, autoClosed } = await refreshAndMaybeAutoClose(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast(
        autoClosed
          ? "Pedido cerrado — el cliente ya había pedido el cierre"
          : `Apartados: ${nPicked} · Espera fábrica: ${nFabrica} · Espera local: ${nLocal} · Sin stock: ${nMissing}`,
        "success"
      );
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

  moveOrderToOtherBoard: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    const order = findOrder(get(), orderId);
    if (!order) return;

    const targetScope = otherBoardScope(get().boardScope);
    const targetTitle = otherBoardTitle(get().boardScope);
    set({ loadingAction: orderId });

    try {
      const supabase = getSupabaseBrowserClient();
      await updateOrderKanbanScope(supabase, orderId, order.notes, targetScope);
      get().removeOrder(orderId);
      get().showToast(`Pedido enviado a ${targetTitle}`, "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  revertOrderToPicked: async (orderId) => {
    const snapshot = cloneOrders(get().orders);
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === orderId ? { ...o, status: "active" } : o
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcRevertOrderToPicked(supabase, orderId);
      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Pedido vuelto a Apartados", "success");
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
      orders: state.orders.filter((o) => o.id !== orderId),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      await rpcCancelOrderFull(supabase, orderId);
      get().removeOrder(orderId);
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

    // El nuevo vencimiento (17:00 hora Argentina, próximo día hábil) se
    // calcula en el servidor vía rpc_admin_extend_order_24h — no se puede
    // calcular acá sin duplicar la lógica de fn_compute_order_deadline
    // (ver supabase/canonical/258_extension_24h_business_day.sql).
    const nextNotes = applyOrderNotesPatch(order.notes, {
      [ADMIN_ENABLE_24H_USES_KEY]: getEnable24hUsesFromOrder(order) + 1,
    });

    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === orderId ? { ...o, notes: nextNotes } : o
      ),
      loadingAction: orderId,
    }));

    try {
      const supabase = getSupabaseBrowserClient();
      const { error } = await supabase.rpc("rpc_admin_extend_order_24h", {
        p_order_id: orderId,
      });

      if (error) throw error;

      const refreshed = await fetchOrderById(supabase, orderId);
      if (refreshed) get().patchOrder(refreshed);
      get().showToast("Prórroga aplicada", "success");
    } catch (err) {
      set({ orders: snapshot });
      get().showToast(getErrorMessage(err), "error");
    } finally {
      set({ loadingAction: null });
    }
  },

  subscribeNewOrders: () => {
    const supabase = getSupabaseBrowserClient();
    const scope = get().boardScope;

    if (realtimeChannel) {
      supabase.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }

    const pullOrder = async (orderId: string) => {
      const full = await fetchOrderWhenReady(supabase, orderId);
      if (full) get().patchOrder(full);
    };

    realtimeChannel = supabase
      .channel(realtimeChannelForScope(scope))
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "orders" },
        async (payload: RealtimePostgresInsertPayload<{ id: string }>) => {
          const newId = (payload.new as { id?: string })?.id;
          if (!newId) return;
          await pullOrder(newId);
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "order_items" },
        async (payload: RealtimePostgresInsertPayload<{ order_id?: string }>) => {
          const orderId = (payload.new as { order_id?: string })?.order_id;
          if (!orderId) return;
          await pullOrder(orderId);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders" },
        async (payload: { new: { id?: string } }) => {
          const orderId = payload.new?.id;
          if (!orderId) return;
          const full = await fetchOrderById(supabase, orderId);
          if (full) get().patchOrder(full);
          else get().removeOrder(orderId);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "order_items" },
        async (payload: { new: { order_id?: string } }) => {
          const orderId = payload.new?.order_id;
          if (!orderId) return;
          const full = await fetchOrderById(supabase, orderId);
          if (full) get().patchOrder(full);
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
