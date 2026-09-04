/**
 * Modo borrador para la columna "Activos": tocar ✓ / ⏳ / ✕ solo
 * marca un cambio pendiente hasta Confirmar.
 */

import type { AdminOrder } from "@/types/orders";

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

export function draftChangeLabel(
  change: DraftChange,
  localLabel: string = "Local"
): string {
  switch (change.kind) {
    case "picked":
      return "Apartar";
    case "waiting-fabrica":
      return "Espera (Fábrica)";
    case "waiting-local":
      return `Espera (${localLabel})`;
    case "missing":
      return "Sin stock";
    case "split": {
      const parts: string[] = [];
      if (change.nPicked) parts.push(`${change.nPicked} apart.`);
      if (change.nWaiting) {
        const src = change.waitingSource === "local" ? localLabel : "Fábrica";
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

/** True si el borrador incluye al menos un ítem (o split) en espera local/depósito. */
export function draftHasWaitingLocal(pending: DraftChangesMap): boolean {
  return Object.values(pending).some((change) => {
    if (change.kind === "waiting-local") return true;
    if (
      change.kind === "split" &&
      (change.nWaiting ?? 0) > 0 &&
      change.waitingSource === "local"
    ) {
      return true;
    }
    return false;
  });
}

/** True si el borrador incluye espera fábrica. */
export function draftHasWaitingFabrica(pending: DraftChangesMap): boolean {
  return Object.values(pending).some((change) => {
    if (change.kind === "waiting-fabrica") return true;
    if (
      change.kind === "split" &&
      (change.nWaiting ?? 0) > 0 &&
      change.waitingSource === "fabrica"
    ) {
      return true;
    }
    return false;
  });
}

/** Pedido local diferido (checkout zona retiro). */
export function usesRetiroLocalDeferredMessages(
  order: Pick<AdminOrder, "local_deferred_pickup">
): boolean {
  return Boolean(order.local_deferred_pickup);
}

/**
 * True si el mensaje al cliente debe diferirse (snapshot → campana al resolver).
 * Local diferido: espera Depósito o Fábrica. Resto: solo espera local/depósito.
 */
export function draftDefersCustomerMessage(
  pending: DraftChangesMap,
  order: Pick<AdminOrder, "local_deferred_pickup">
): boolean {
  if (draftHasWaitingLocal(pending)) return true;
  if (usesRetiroLocalDeferredMessages(order) && draftHasWaitingFabrica(pending)) {
    return true;
  }
  return false;
}
