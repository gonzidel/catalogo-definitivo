/**
 * Inbox Ani / Fati — solo tablero Pedidos (`boardScope=shipping`).
 * Dueña por clienta; vistas filtran Activos/Espera/Cancelados/Cerrados/campana.
 * Apartados y vista General muestran todas.
 */

import { getCustomerFromOrder } from "@/lib/orders/domain";
import type { AdminOrder, KanbanColumnId } from "@/types/orders";

export type KanbanInboxOwner = "ani" | "fati";
export type KanbanInboxView = "ani" | "fati" | "general";

export const KANBAN_INBOX_VIEW_STORAGE_KEY = "fyl-orders-inbox-view";

export const KANBAN_INBOX_OWNERS: {
  id: KanbanInboxOwner;
  label: string;
  colorClass: string;
}[] = [
  { id: "ani", label: "Ani", colorClass: "kanban-inbox-chip--ani" },
  { id: "fati", label: "Fati", colorClass: "kanban-inbox-chip--fati" },
];

export function isKanbanInboxOwner(value: unknown): value is KanbanInboxOwner {
  return value === "ani" || value === "fati";
}

export function isKanbanInboxView(value: unknown): value is KanbanInboxView {
  return value === "ani" || value === "fati" || value === "general";
}

export function loadKanbanInboxView(): KanbanInboxView {
  if (typeof window === "undefined") return "general";
  try {
    const raw = window.localStorage.getItem(KANBAN_INBOX_VIEW_STORAGE_KEY);
    return isKanbanInboxView(raw) ? raw : "general";
  } catch {
    return "general";
  }
}

export function persistKanbanInboxView(view: KanbanInboxView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KANBAN_INBOX_VIEW_STORAGE_KEY, view);
  } catch {
    // cuota / modo privado
  }
}

export function inboxOwnerLabel(owner: KanbanInboxOwner | null | undefined): string {
  if (owner === "ani") return "Ani";
  if (owner === "fati") return "Fati";
  return "—";
}

export function getOrderInboxOwner(
  order: Pick<AdminOrder, "customers">
): KanbanInboxOwner | null {
  const customer = getCustomerFromOrder(order as AdminOrder);
  const raw = customer?.kanban_inbox_owner;
  return isKanbanInboxOwner(raw) ? raw : null;
}

/**
 * ¿La tarjeta / aviso entra en la vista actual?
 * - Retiro: siempre true (sin filtro).
 * - Apartados: siempre true.
 * - General: siempre true.
 * - Ani/Fati: solo si la clienta tiene esa dueña (sin dueña → no se muestra en Ani/Fati).
 */
export function orderMatchesKanbanInboxView(
  order: Pick<AdminOrder, "customers">,
  view: KanbanInboxView,
  options?: { boardScope?: "shipping" | "local_pickup"; columnId?: KanbanColumnId }
): boolean {
  if (options?.boardScope === "local_pickup") return true;
  if (options?.columnId === "picked") return true;
  if (view === "general") return true;
  const owner = getOrderInboxOwner(order);
  return owner === view;
}

export function filterOrdersByKanbanInboxView<T extends Pick<AdminOrder, "customers">>(
  orders: T[],
  view: KanbanInboxView,
  options?: { boardScope?: "shipping" | "local_pickup"; columnId?: KanbanColumnId }
): T[] {
  if (options?.boardScope === "local_pickup" || view === "general" || options?.columnId === "picked") {
    return orders;
  }
  return orders.filter((order) => orderMatchesKanbanInboxView(order, view, options));
}
