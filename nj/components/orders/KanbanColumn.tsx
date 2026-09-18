"use client";

import { useEffect, useMemo, useState } from "react";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import { isCommonLocalPickupAwaitingAdminSale } from "@/lib/orders/domain";
import { retiroActiveColumnSortKey } from "@/lib/orders/board-scope";
import { orderMatchesCustomerSearch } from "@/lib/orders/customer-search";
import { useExpiryWarnSentStore } from "@/lib/orders/expiry-warning-sent";
import { isExpiryWarnCooldownActive } from "@/lib/orders/deadline";
import { getWaitingColumnSortKey } from "@/lib/orders/waiting-source";
import { filterOrdersByKanbanInboxView } from "@/lib/orders/kanban-inbox";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { searchOrdersGlobal } from "@/lib/supabase/order-queries";
import { useOrdersStore } from "@/hooks/useOrders";
import type { AdminOrder, KanbanColumnId } from "@/types/orders";
import KanbanColumnSearch from "./KanbanColumnSearch";
import NewOrderForm from "./NewOrderForm";
import OrderCard from "./OrderCard";
import OrderSearchResultCard from "./OrderSearchResultCard";
import RetiroOriginLegend from "./RetiroOriginLegend";
import WaitingLegend from "./WaitingLegend";

const GLOBAL_SEARCH_MIN_LEN = 2;
const GLOBAL_SEARCH_DEBOUNCE_MS = 350;

interface KanbanColumnProps {
  columnId: KanbanColumnId;
  label: string;
  showAddButton?: boolean;
  hideHeader?: boolean;
}

export default function KanbanColumn({
  columnId,
  label,
  showAddButton = false,
  hideHeader = false,
}: KanbanColumnProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [globalMatches, setGlobalMatches] = useState<AdminOrder[]>([]);
  const allOrders = useOrdersStore((s) => s.orders);
  const warehouseIds = useOrdersStore((s) => s.warehouseIds);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const inboxView = useOrdersStore((s) => s.inboxView);
  const expiryWarnSentAt = useExpiryWarnSentStore((s) => s.sentAtByOrderId);
  const hydrateExpiryWarn = useExpiryWarnSentStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateExpiryWarn();
  }, [hydrateExpiryWarn]);

  const orders = useMemo(() => {
    const scoped = filterOrdersByKanbanInboxView(allOrders, inboxView, {
      boardScope,
      columnId,
    });
    const filtered = filterOrdersForColumn(scoped, columnId, {
      boardScope,
      warehouseIds,
    });
    const now = Date.now();
    const isCooldown = (id: string) => {
      const sentAt = expiryWarnSentAt.get(id);
      return isExpiryWarnCooldownActive(sentAt, now);
    };
    const sentToEnd = (a: { id: string }, b: { id: string }) => {
      const aSent = isCooldown(a.id);
      const bSent = isCooldown(b.id);
      if (aSent === bSent) return 0;
      return aSent ? 1 : -1;
    };
    const byCreatedAsc = (a: AdminOrder, b: AdminOrder) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime();

    if (columnId === "waiting") {
      return [...filtered].sort(
        (a, b) =>
          getWaitingColumnSortKey(a, warehouseIds, boardScope) -
          getWaitingColumnSortKey(b, warehouseIds, boardScope)
      );
    }
    if (columnId === "expired") {
      // Sin aviso vigente (rojo/amarillo) arriba por antigüedad; azules (cooldown) abajo.
      return [...filtered].sort((a, b) => {
        const byCooldown = sentToEnd(a, b);
        if (byCooldown !== 0) return byCooldown;
        return byCreatedAsc(a, b);
      });
    }
    if (columnId === "cancelled") {
      return [...filtered].sort(sentToEnd);
    }
    if (columnId === "active" && boardScope === "local_pickup") {
      return [...filtered].sort((a, b) => {
        const byOrigin = retiroActiveColumnSortKey(a) - retiroActiveColumnSortKey(b);
        if (byOrigin !== 0) return byOrigin;
        const byExpiry = sentToEnd(a, b);
        if (byExpiry !== 0) return byExpiry;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    }
    if (columnId === "picked" && boardScope === "local_pickup") {
      return [...filtered].sort((a, b) => {
        const aClosed = isCommonLocalPickupAwaitingAdminSale(a, a.transportName ?? null)
          ? 0
          : 1;
        const bClosed = isCommonLocalPickupAwaitingAdminSale(b, b.transportName ?? null)
          ? 0
          : 1;
        if (aClosed !== bClosed) return aClosed - bClosed;
        return sentToEnd(a, b);
      });
    }
    if (columnId === "active" || columnId === "picked") {
      return [...filtered].sort(sentToEnd);
    }
    return filtered;
  }, [allOrders, columnId, warehouseIds, boardScope, expiryWarnSentAt, inboxView]);
  const visibleOrders = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return orders;
    return orders.filter((order) => orderMatchesCustomerSearch(order, q));
  }, [orders, searchQuery]);

  // Mismo buscador de columna: además de filtrar el pool operativo (arriba),
  // dispara (con debounce) una búsqueda global sin filtro de status para
  // encontrar pedidos que quedaron en estado terminal (expired/sent/devolución)
  // y por eso son invisibles en todo el Kanban. Ver auditoría 2026-09-15.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < GLOBAL_SEARCH_MIN_LEN) {
      setGlobalMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const supabase = getSupabaseBrowserClient();
      searchOrdersGlobal(supabase, q)
        .then((results) => {
          if (!cancelled) setGlobalMatches(results);
        })
        .catch((err) => {
          console.error("searchOrdersGlobal error:", err);
          if (!cancelled) setGlobalMatches([]);
        });
    }, GLOBAL_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery]);

  // Solo mostramos los que NO están ya en el pool operativo del store: si un
  // pedido activo aparece en otra columna, no lo duplicamos acá.
  const outOfBoardMatches = useMemo(() => {
    if (!globalMatches.length) return [];
    const knownIds = new Set(allOrders.map((o) => o.id));
    return globalMatches.filter((order) => !knownIds.has(order.id));
  }, [globalMatches, allOrders]);

  return (
    <section className="kanban-column" aria-label={label}>
      {!hideHeader ? (
        <div className="kanban-column__header">
          <div className="kanban-column__title-group">
            <h2 className="kanban-column__title">{label}</h2>
            {columnId === "waiting" ? <WaitingLegend /> : null}
            {columnId === "picked" && boardScope === "local_pickup" ? (
              <RetiroOriginLegend />
            ) : null}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {showAddButton ? <NewOrderForm /> : null}
            <span className="kanban-column__count">{orders.length}</span>
          </div>
        </div>
      ) : null}
      <KanbanColumnSearch
        value={searchQuery}
        onChange={setSearchQuery}
        columnLabel={label}
      />
      <div className="kanban-column__list">
        {orders.length === 0 && outOfBoardMatches.length === 0 ? (
          <p className="kanban-column__empty">Sin pedidos</p>
        ) : visibleOrders.length === 0 && outOfBoardMatches.length === 0 ? (
          <p className="kanban-column__empty">Sin coincidencias</p>
        ) : (
          visibleOrders.map((order) => <OrderCard key={order.id} order={order} />)
        )}
        {outOfBoardMatches.length > 0 ? (
          <div className="kanban-column__global-results">
            <p className="kanban-column__global-results-title">
              Fuera del tablero ({outOfBoardMatches.length})
            </p>
            {outOfBoardMatches.map((order) => (
              <OrderSearchResultCard key={order.id} order={order} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
