/**
 * Modo borrador para la columna "Activos" en mobile: tocar ✓ / ⏳ / ✕ solo
 * marca un cambio pendiente (visual) por ítem. Nada se aplica al backend
 * hasta que el admin toca "Confirmar cambios" en la barra al final del pedido.
 */

export type DraftChangeKind = "picked" | "waiting-fabrica" | "waiting-local" | "missing" | "split";

export interface DraftChange {
  kind: DraftChangeKind;
  /** Solo para kind === "split": reparto manual de unidades */
  nPicked?: number;
  nWaiting?: number;
  nMissing?: number;
  waitingSource?: "fabrica" | "local";
}

export type DraftChangesMap = Record<string, DraftChange>;

export function draftChangeLabel(change: DraftChange): string {
  switch (change.kind) {
    case "picked":
      return "Apartar";
    case "waiting-fabrica":
      return "Espera (Fábrica)";
    case "waiting-local":
      return "Espera (Local)";
    case "missing":
      return "Sin stock";
    case "split": {
      const parts: string[] = [];
      if (change.nPicked) parts.push(`${change.nPicked} apart.`);
      if (change.nWaiting) {
        const src = change.waitingSource === "local" ? "Local" : "Fábrica";
        parts.push(`${change.nWaiting} espera (${src})`);
      }
      if (change.nMissing) parts.push(`${change.nMissing} sin stock`);
      return parts.join(" · ") || "Reparto manual";
    }
    default:
      return "Cambio";
  }
}

export function summarizeDraftChanges(pending: DraftChangesMap): string {
  const changes = Object.values(pending);
  if (!changes.length) return "";
  const counts = { picked: 0, waiting: 0, missing: 0 };
  for (const change of changes) {
    if (change.kind === "picked") counts.picked += 1;
    else if (change.kind === "waiting-fabrica" || change.kind === "waiting-local") counts.waiting += 1;
    else if (change.kind === "missing") counts.missing += 1;
    else if (change.kind === "split") {
      if (change.nPicked) counts.picked += 1;
      if (change.nWaiting) counts.waiting += 1;
      if (change.nMissing) counts.missing += 1;
    }
  }
  const parts: string[] = [];
  if (counts.picked) parts.push(`${counts.picked} a apartar`);
  if (counts.waiting) parts.push(`${counts.waiting} en espera`);
  if (counts.missing) parts.push(`${counts.missing} sin stock`);
  return parts.join(" · ");
}
