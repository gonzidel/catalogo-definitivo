/**
 * Regla 411 (SQL `rpc_orders_auto_delete_all_missing`): un pedido normal con TODOS
 * los ítems sin stock (`missing`) se elimina solo a los 5 días de creado.
 *
 * Este helper espeja la condición SQL para avisar a la clienta en "Mi pedido".
 * Si la condición cambia en SQL, cambiarla acá también.
 *
 * - Solo pedidos `active` / `closing_soon`.
 * - No aplica a Retira Local diferido (`local_deferred_pickup`).
 * - Espeja SQL: >= 1 ítem y TODOS `missing`. Cualquier otro estado (incluido
 *   `cancelled`) hace que la regla no aplique.
 */

export const ALL_MISSING_AUTO_DELETE_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

type AutoDeleteOrderLike = {
  status?: string | null;
  created_at?: string | null;
  local_deferred_pickup?: boolean | null;
  order_items?: ReadonlyArray<{ status?: string | null }> | null;
};

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

/** Fecha en que se eliminaría el pedido, o `null` si la regla no aplica. */
export function getAllMissingAutoDeleteDate(order: AutoDeleteOrderLike | null | undefined): Date | null {
  if (!order) return null;

  const status = norm(order.status);
  if (status !== "active" && status !== "closing_soon") return null;
  if (order.local_deferred_pickup) return null;

  const items = order.order_items ?? [];
  if (items.length === 0) return null;
  if (!items.every((item) => norm(item.status) === "missing")) return null;

  const created = order.created_at ? new Date(order.created_at).getTime() : NaN;
  if (Number.isNaN(created)) return null;

  return new Date(created + ALL_MISSING_AUTO_DELETE_DAYS * DAY_MS);
}
