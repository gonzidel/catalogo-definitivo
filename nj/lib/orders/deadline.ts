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

/** Zona retiro local: Resistencia, Barranqueras, Puerto Vilelas, Fontana. */
export const LOCAL_PICKUP_DEADLINE_HOURS = 36;

const ONE_DAY_MS = 1000 * 60 * 60 * 24;
const ONE_HOUR_MS = 1000 * 60 * 60;

/** Horas restantes hasta dismantle_at (redondeo hacia arriba). */
export function hoursUntilDeadline(deadline: Date, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline.getTime() - now) / ONE_HOUR_MS));
}

/**
 * Cuenta regresiva corta para chip/UI: "1d 5h" / "29h 15m" / "45m" / "Vencido".
 * Pensada para ventana de retiro local (~36 h).
 */
export function formatRemainingCountdown(deadline: Date, now = Date.now()): string {
  const ms = deadline.getTime() - now;
  if (Number.isNaN(ms) || ms <= 0) return "Vencido";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hoursOfDay = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  // Ventanas largas: "2d 5h". En retiro local (~36 h) preferimos horas seguidas: "26h 13m".
  if (days >= 2) return hoursOfDay > 0 ? `${days}d ${hoursOfDay}h` : `${days}d`;
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours > 0) return `${totalHours}h ${String(mins).padStart(2, "0")}m`;
  return `${Math.max(1, mins)}m`;
}

/** Copy para pedidos con ventana de 36 h (zona retiro local). */
export function getLocalPickupDeadlineExplanation(deadline: Date, now = Date.now()): string {
  const hours = hoursUntilDeadline(deadline, now);
  const time = deadline.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (hours <= 1) {
    return `Tu pedido vence hoy. Cerralo antes de las ${time}. Después ya no podrás agregar ni modificar productos.`;
  }
  return `Tenés ${hours} horas para cerrar tu pedido (vence a las ${time}). Podés seguir agregando productos hasta ese horario.`;
}

/** True si la ventana es claramente menor que 7 días (pedido zona local, puede extenderse por feriado). */
export function isShortPickupDeadlineWindow(
  createdAt: string,
  dismantleAt?: string | null
): boolean {
  const created = new Date(createdAt).getTime();
  const deadline = getOrderDeadlineDate(createdAt, dismantleAt).getTime();
  if (Number.isNaN(created) || Number.isNaN(deadline)) return false;
  const windowHours = (deadline - created) / ONE_HOUR_MS;
  return windowHours > 0 && windowHours < (ORDER_DISMANTLE_DAYS - 1) * 24;
}

export interface OrderDeadlineInput {
  created_at: string;
  dismantle_at?: string | null;
  local_deferred_pickup?: boolean | null;
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

/**
 * dismantle_at para UI/vencimiento cliente: 36 h solo en retiro especial
 * (`local_deferred_pickup`). Retiro común y envío usan 7 días aunque la fila
 * tenga un dismantle_at corto heredado de la zona (307).
 */
export function getCustomerFacingDismantleAt(
  order: OrderDeadlineInput
): string | null | undefined {
  if (order.local_deferred_pickup) {
    return order.dismantle_at;
  }
  if (
    order.dismantle_at &&
    isShortPickupDeadlineWindow(order.created_at, order.dismantle_at)
  ) {
    return null;
  }
  return order.dismantle_at;
}

export function getCustomerOrderDeadlineDate(order: OrderDeadlineInput): Date {
  return getOrderDeadlineDate(order.created_at, getCustomerFacingDismantleAt(order));
}

export function orderDaysRemainingForOrder(
  order: OrderDeadlineInput,
  now = Date.now()
): number {
  return orderDaysRemaining(
    order.created_at,
    getCustomerFacingDismantleAt(order),
    now
  );
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
  if (order.local_deferred_pickup && !order.dismantle_at) {
    return false;
  }
  const dismantleAt = getCustomerFacingDismantleAt(order);
  if (dismantleAt) {
    const t = new Date(dismantleAt).getTime();
    if (!Number.isNaN(t)) return now >= t;
  }
  if (order.local_deferred_pickup) {
    return false;
  }
  if (!order.created_at) return false;
  const elapsed = (now - new Date(order.created_at).getTime()) / ONE_DAY_MS;
  return elapsed >= ORDER_DISMANTLE_DAYS;
}

/** Último día calendario antes de la hora exacta de vencimiento. */
export function isOrderExpiringToday(
  order: OrderDeadlineInput,
  now = Date.now()
): boolean {
  if (isOrderExpired(order, now)) return false;
  const deadline = getCustomerOrderDeadlineDate(order);
  return calendarDaysUntil(deadline, now) === 0;
}

/** Chip corto para admin Kanban: "5 días" / "Mañana" / "Hoy" / "Vencido". */
export function formatAdminDeadlineCountdown(calendarDaysLeft: number): string {
  if (calendarDaysLeft < 0) return "Vencido";
  if (calendarDaysLeft === 0) return "Hoy";
  if (calendarDaysLeft === 1) return "Mañana";
  return `${calendarDaysLeft} días`;
}
