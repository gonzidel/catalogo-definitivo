/** Referencia visual en Vencido: rojo / azul (amarillo “1 día” vive en Apartados). */
export default function VencidoLegend() {
  return (
    <span
      className="kanban-column__legend kanban-column__legend--vencido"
      title="Color según plazo y aviso WhatsApp"
      aria-label="Leyenda de colores Vencido"
    >
      <span className="kanban-column__legend-chip">
        <span className="kanban-column__legend-swatch kanban-column__legend-swatch--vencido-red" />
        Vencido
      </span>
      <span className="kanban-column__legend-chip">
        <span className="kanban-column__legend-swatch kanban-column__legend-swatch--vencido-blue" />
        Aviso 24h
      </span>
    </span>
  );
}
