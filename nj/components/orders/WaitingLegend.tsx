/** Referencia visual de colores en la columna Espera: verde = Local, amarillo = Fábrica. */
export default function WaitingLegend() {
  return (
    <span className="kanban-column__legend" title="Color según origen de la espera">
      <span className="kanban-column__legend-chip">
        <span className="kanban-column__legend-swatch kanban-column__legend-swatch--local" />
        Local
      </span>
      <span className="kanban-column__legend-chip">
        <span className="kanban-column__legend-swatch kanban-column__legend-swatch--fabrica" />
        Fábrica
      </span>
    </span>
  );
}
