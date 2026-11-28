/** Cada cuánto rotan de lugar las tarjetas del banner de Ofertas. */
export const PROMO_BANNER_ROTATE_MS = 6 * 60 * 60 * 1000;
/** Argentina está a UTC−3. Así el corte cae a las 0, 6, 12 y 18. */
const ART_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Rota la lista un puesto por cada ventana cumplida.
 * Misma hora y misma lista → mismo orden para todas las clientas.
 * Con una sola tarjeta no hay nada que esconder.
 */
export function rotateByTimeWindow<T>(
  items: readonly T[],
  nowMs: number,
  windowMs = PROMO_BANNER_ROTATE_MS
): T[] {
  const count = items.length;
  if (count <= 1) return [...items];
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) {
    return [...items];
  }
  const shift = Math.floor(nowMs / windowMs) % count;
  if (shift === 0) return [...items];
  return [...items.slice(shift), ...items.slice(0, shift)];
}

/** Milisegundos hasta el próximo cambio de ventana. */
export function msUntilNextRotation(nowMs: number, windowMs = PROMO_BANNER_ROTATE_MS): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs <= 0) return windowMs;
  const rest = ((nowMs % windowMs) + windowMs) % windowMs;
  return rest === 0 ? windowMs : windowMs - rest;
}

/** Rotación del banner, con el corte en hora de Argentina. */
export function rotatePromoBanner<T>(items: readonly T[], nowMs: number): T[] {
  return rotateByTimeWindow(items, nowMs - ART_OFFSET_MS);
}

/**
 * Las promos quedan siempre delante de las ofertas.
 * Cada grupo rota solo, así un afiche no pasa al fondo del carrusel.
 */
export function stackPromosBeforeOffers<P, O>(
  promos: readonly P[],
  offers: readonly O[],
  nowMs: number
): Array<P | O> {
  return [...rotatePromoBanner(promos, nowMs), ...rotatePromoBanner(offers, nowMs)];
}

export function msUntilNextPromoRotation(nowMs: number): number {
  return msUntilNextRotation(nowMs - ART_OFFSET_MS);
}
