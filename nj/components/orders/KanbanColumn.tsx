"use client";

import { useEffect, useMemo, useState } from "react";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import { isCommonLocalPickupAwaitingAdminSale } from "@/lib/orders/domain";
import { retiroActiveColumnSortKey } from "@/lib/orders/board-scope";
import { orderMatchesCustomerSearch } from "@/lib/orders/customer-search";
import { useExpiryWarnSentStore } from "@/lib/orders/expiry-warning-sent";
import { getWaitingColumnSortKey } from "@/lib/orders/waiting-source";
import { useOrdersStore } from "@/hooks/useOrders";
import type { KanbanColumnId } from "@/types/orders";
import KanbanColumnSearch from "./KanbanColumnSearch";
import NewOrderForm from "./NewOrderForm";
import OrderCard from "./OrderCard";
import RetiroOriginLegend from "./RetiroOriginLegend";
import WaitingLegend from "./WaitingLegend";

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
  const allOrders = useOrdersStore((s) => s.orders);
  const warehouseIds = useOrdersStore((s) => s.warehouseIds);
  const boardScope = useOrdersStore((s) => s.boardScope);
  const expiryWarnSentIds = useExpiryWarnSentStore((s) => s.sentIds);
  const hydrateExpiryWarn = useExpiryWarnSentStore((s) => s.hydrate);

  useEffect(() => {
    void hydrateExpiryWarn();
  }, [hydrateExpiryWarn]);

  const orders = useMemo(() => {
    const filtered = filterOrdersForColumn(allOrders, columnId, {
      boardScope,
      warehouseIds,
    });
    const sentToEnd = (a: { id: string }, b: { id: string }) => {
      const aSent = expiryWarnSentIds.has(a.id);
      const bSent = expiryWarnSentIds.has(b.id);
      if (aSent === bSent) return 0;
      return aSent ? 1 : -1;
    };
    if (columnId === "waiting") {
      return [...filtered].sort(
        (a, b) =>
          getWaitingColumnSortKey(a, warehouseIds, boardScope) -
          getWaitingColumnSortKey(b, warehouseIds, boardScope)
      );
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
  }, [allOrders, columnId, warehouseIds, boardScope, expiryWarnSentIds]);
  const visibleOrders = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return orders;
    return orders.filter((order) => orderMatchesCustomerSearch(order, q));
  }, [orders, searchQuery]);

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
        {orders.length === 0 ? (
          <p className="kanban-column__empty">Sin pedidos</p>
        ) : visibleOrders.length === 0 ? (
          <p className="kanban-column__empty">Sin coincidencias</p>
        ) : (
          visibleOrders.map((order) => <OrderCard key={order.id} order={order} />)
        )}
      </div>
    </section>
  );
}
