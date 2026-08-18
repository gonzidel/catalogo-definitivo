/**
 * Regla única de vencimiento de pedidos (cliente/checkout).
 *
 * Antes esta regla (7 días desde created_at, o dismantle_at si ya está
 * seteado por rpc_checkout_cart / rpc_orders_daily_maintenance) estaba
 * duplicada con literales sueltos en ActiveOrderTab.tsx, DashboardClient.tsx
 * y classification.ts. Si el negocio cambia la ventana, alcanza con tocar
 * ORDER_DISMANTLE_DAYS aquí.
 *
 * Ojo: esto es solo el cálculo del lado del cliente para mostrar UI. La
 * fuente de verdad real es `orders.dismantle_at` en la base, que se
 * completa en rpc_checkout_cart() y se hace cumplir (expirar pedido,
 * devolver stock) en rpc_orders_daily_maintenance() vía pg_cron. Pedidos
 * de admin (source = 'admin') no tienen dismantle_at y no pasan por esta
 * ventana.
 */

export const ORDER_DISMANTLE_DAYS = 7;

const ONE_DAY_MS = 1000 * 60 * 60 * 24;

export interface OrderDeadlineInput {
  created_at: string;
  dismantle_at?: string | null;
}

/** Fecha/hora exacta de vencimiento: dismantle_at si existe, si no created_at + N días. */
export function getOrderDeadlineDate(createdAt: string, dismantleAt?: string | null): Date {
  if (dismantleAt) {
    const t = new Date(dismantleAt);
    if (!Number.isNaN(t.getTime())) return t;
  }
  const created = new Date(createdAt).getTime();
  return new Date(created + ORDER_DISMANTLE_DAYS * ONE_DAY_MS);
}

/** Días restantes en bloques de 24hs (no calendario) hasta el vencimiento. */
export function orderDaysRemaining(
  createdAt: string,
  dismantleAt?: string | null,
  now = Date.now()
): number {
  if (dismantleAt) {
    const t = new Date(dismantleAt).getTime();
    if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - now) / ONE_DAY_MS));
  }
  const created = new Date(createdAt).getTime();
  const elapsed = Math.floor((now - created) / ONE_DAY_MS);
  return Math.max(0, ORDER_DISMANTLE_DAYS - elapsed);
}

/**
 * Diferencia en días CALENDARIO (no bloques de 24hs) entre el vencimiento y
 * ahora, para que "mañana" y "hoy más tarde" no se confundan aunque falten
 * pocas horas en ambos casos.
 */
export function calendarDaysUntil(deadline: Date, now: number): number {
  const d = new Date(deadline);
  d.setHours(0, 0, 0, 0);
  const n = new Date(now);
  n.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - n.getTime()) / ONE_DAY_MS);
}

export function isOrderExpired(order: OrderDeadlineInput, now = Date.now()): boolean {
  if (order.dismantle_at) {
    const t = new Date(order.dismantle_at).getTime();
    if (!Number.isNaN(t)) return now >= t;
  }
  if (!order.created_at) return false;
  const elapsed = (now - new Date(order.created_at).getTime()) / ONE_DAY_MS;
  return elapsed >= ORDER_DISMANTLE_DAYS;
}

/** Chip corto para admin Kanban: "5 días" / "Mañana" / "Hoy" / "Vencido". */
export function formatAdminDeadlineCountdown(calendarDaysLeft: number): string {
  if (calendarDaysLeft < 0) return "Vencido";
  if (calendarDaysLeft === 0) return "Hoy";
  if (calendarDaysLeft === 1) return "Mañana";
  return `${calendarDaysLeft} días`;
}
