"use client";

import { useEffect } from "react";
import { useOrdersStore } from "@/hooks/useOrders";
import { KANBAN_COLUMNS, type AdminOrder } from "@/types/orders";
import KanbanColumn from "./KanbanColumn";
import { OrdersToastContainer } from "./OrdersToast";

interface KanbanBoardProps {
  initialOrders: AdminOrder[];
}

export default function KanbanBoard({ initialOrders }: KanbanBoardProps) {
  const hydrate = useOrdersStore((s) => s.hydrate);
  const subscribeNewOrders = useOrdersStore((s) => s.subscribeNewOrders);
  const hydrated = useOrdersStore((s) => s.hydrated);

  useEffect(() => {
    hydrate(initialOrders);
  }, [initialOrders, hydrate]);

  useEffect(() => {
    const unsubscribe = subscribeNewOrders();
    return unsubscribe;
  }, [subscribeNewOrders]);

  return (
    <div className="kanban-board">
      <div className="kanban-board__header">
        <h1 className="kanban-board__title">Pedidos</h1>
        {!hydrated ? <span className="kanban-column__count">…</span> : null}
      </div>
      <div className="kanban-board__columns">
        {KANBAN_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            columnId={col.id}
            label={col.label}
            showAddButton={col.id === "picked"}
          />
        ))}
      </div>
      <OrdersToastContainer />
    </div>
  );
}
