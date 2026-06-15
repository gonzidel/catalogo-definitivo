"use client";

import { useMemo } from "react";
import { filterOrdersForColumn } from "@/lib/orders/classification";
import { useOrdersStore } from "@/hooks/useOrders";
import type { KanbanColumnId } from "@/types/orders";
import OrderCard from "./OrderCard";

interface KanbanColumnProps {
  columnId: KanbanColumnId;
  label: string;
  showAddButton?: boolean;
}

export default function KanbanColumn({
  columnId,
  label,
  showAddButton = false,
}: KanbanColumnProps) {
  const allOrders = useOrdersStore((s) => s.orders);
  const orders = useMemo(
    () => filterOrdersForColumn(allOrders, columnId),
    [allOrders, columnId]
  );

  return (
    <section className="kanban-column" aria-label={label}>
      <div className="kanban-column__header">
        <h2 className="kanban-column__title">{label}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {showAddButton ? (
            <button
              type="button"
              className="kanban-column__add-btn"
              disabled
              title="Próximamente"
              aria-label="Crear pedido manual (próximamente)"
            >
              +
            </button>
          ) : null}
          <span className="kanban-column__count">{orders.length}</span>
        </div>
      </div>
      <div className="kanban-column__list">
        {orders.length === 0 ? (
          <p className="kanban-column__empty">Sin pedidos</p>
        ) : (
          orders.map((order) => <OrderCard key={order.id} order={order} />)
        )}
      </div>
    </section>
  );
}
