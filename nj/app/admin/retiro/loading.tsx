export default function RetiroLoading() {
  return (
    <div className="kanban-shell">
      <div className="kanban-header">
        <h1 className="kanban-header__title">Retiro</h1>
      </div>
      <div className="kanban-main">
        {["Activos", "Apartados", "Cancelados", "Espera"].map((label) => (
          <div key={label} className="kanban-skeleton-column">
            <div className="kanban-column__header">
              <h2 className="kanban-column__title">{label}</h2>
              <span className="kanban-column__count">—</span>
            </div>
            <div className="kanban-skeleton-card" />
            <div className="kanban-skeleton-card" />
          </div>
        ))}
      </div>
    </div>
  );
}
