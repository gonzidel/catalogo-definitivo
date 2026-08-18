"use client";

import { useMemo, useState } from "react";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import { orderMatchesCustomerSearch } from "@/lib/orders/customer-search";
import { getWaitingColumnSortKey } from "@/lib/orders/waiting-source";
import { useOrdersStore } from "@/hooks/useOrders";
import type { KanbanColumnId } from "@/types/orders";
import KanbanColumnSearch from "./KanbanColumnSearch";
import NewOrderForm from "./NewOrderForm";
import OrderCard from "./OrderCard";
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
  const orders = useMemo(() => {
    const filtered = filterOrdersForColumn(allOrders, columnId);
    if (columnId !== "waiting") return filtered;
    return [...filtered].sort(
      (a, b) =>
        getWaitingColumnSortKey(a, warehouseIds) - getWaitingColumnSortKey(b, warehouseIds)
    );
  }, [allOrders, columnId, warehouseIds]);
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
