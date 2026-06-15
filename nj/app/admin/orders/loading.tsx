import { KANBAN_COLUMNS } from "@/types/orders";

export default function OrdersLoading() {
  return (
    <div className="kanban-board">
      <div className="kanban-board__header">
        <h1 className="kanban-board__title">Pedidos</h1>
      </div>
      <div className="kanban-board__columns">
        {KANBAN_COLUMNS.map((col) => (
          <div key={col.id} className="kanban-skeleton-column">
            <div className="kanban-column__header">
              <h2 className="kanban-column__title">{col.label}</h2>
              <span className="kanban-column__count">—</span>
            </div>
            <div className="kanban-skeleton-card" />
            <div className="kanban-skeleton-card" />
            <div className="kanban-skeleton-card" />
          </div>
        ))}
      </div>
    </div>
  );
}
