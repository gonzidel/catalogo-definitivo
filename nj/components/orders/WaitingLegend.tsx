"use client";

import { waitingLocalLabel } from "@/lib/orders/board-scope";
import { useOrdersStore } from "@/hooks/useOrders";

/** Referencia visual en Espera: morado = Depósito (Retiro), verde = Local (Pedidos), amarillo = Fábrica. */
export default function WaitingLegend() {
  const boardScope = useOrdersStore((s) => s.boardScope);
  const localLabel = waitingLocalLabel(boardScope);

  if (boardScope === "local_pickup") {
    return (
      <span className="kanban-column__legend" title="Color según origen de la espera">
        <span className="kanban-column__legend-chip">
          <span className="kanban-column__legend-swatch kanban-column__legend-swatch--deposito" />
          Depósito
        </span>
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

  const localSwatchClass = "kanban-column__legend-swatch--local";

  return (
    <span className="kanban-column__legend" title="Color según origen de la espera">
      <span className="kanban-column__legend-chip">
        <span className={`kanban-column__legend-swatch ${localSwatchClass}`} />
        {localLabel}
      </span>
      <span className="kanban-column__legend-chip">
        <span className="kanban-column__legend-swatch kanban-column__legend-swatch--deposito" />
        Depósito
      </span>
      <span className="kanban-column__legend-chip">
        <span className="kanban-column__legend-swatch kanban-column__legend-swatch--fabrica" />
        Fábrica
      </span>
    </span>
  );
}
