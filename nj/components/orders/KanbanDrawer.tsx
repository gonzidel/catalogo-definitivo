"use client";

import type { KanbanColumnId } from "@/types/orders";
import KanbanColumn from "./KanbanColumn";
import NewOrderForm from "./NewOrderForm";
import WaitingLegend from "./WaitingLegend";

type DrawerColumnId = Exclude<KanbanColumnId, "active">;

const DRAWER_LABELS: Record<DrawerColumnId, string> = {
  picked: "Apartados",
  waiting: "Espera",
  closed: "Cerrados",
  stock_pending: "Stock Pendiente",
  cancelled: "Cancelados",
};

const SENT_ORDERS_HREF = "http://localhost:5500/admin/sent-orders.html";

interface KanbanDrawerProps {
  columnId: DrawerColumnId;
  onClose: () => void;
}

export default function KanbanDrawer({ columnId, onClose }: KanbanDrawerProps) {
  const label = DRAWER_LABELS[columnId];

  return (
    <div
      className="kanban-drawer-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        className="kanban-drawer"
        role="dialog"
        aria-labelledby={`kanban-drawer-title-${columnId}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="kanban-drawer__header">
          <div className="kanban-drawer__toolbar">
            <div className="kanban-drawer__toolbar-nav">
              <button
                type="button"
                className="kanban-drawer__close"
                onClick={onClose}
                aria-label="Volver a Activos"
              >
                ←
              </button>
              <NewOrderForm className="kanban-mobile-add-btn" label="+ Pedido" />
            </div>
            <div className="kanban-column__title-group kanban-drawer__toolbar-title">
              <h2
                className="kanban-drawer__title"
                id={`kanban-drawer-title-${columnId}`}
              >
                {label}
              </h2>
              {columnId === "waiting" ? <WaitingLegend /> : null}
            </div>
            <div className="kanban-drawer__toolbar-actions">
              <a
                href={SENT_ORDERS_HREF}
                className="kanban-alert-btn kanban-alert-btn--neutral"
              >
                🚚 Enviados
              </a>
            </div>
          </div>
        </div>
        <div className="kanban-drawer__body">
          <KanbanColumn
            columnId={columnId}
            label={label}
            showAddButton={columnId === "picked"}
            hideHeader
          />
        </div>
      </aside>
    </div>
  );
}
