export function roundToNearest100(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 100) * 100;
}

/** precio = costo + costo * porcentaje/100 + monto_logistico, redondeado hacia arriba a la centena. */
export function calculateRecommendedPrice(
  cost: number,
  percentage: number,
  logisticAmount: number
): number {
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  const raw = cost + (cost * (percentage || 0)) / 100 + (logisticAmount || 0);
  return roundToNearest100(raw);
}

/** Inversa: dado un precio de venta sin costo, estima el costo. Ver docs/FYL-Obsidian propuesta de tags. */
export function estimateCostFromPrice(
  price: number,
  percentage: number,
  logisticAmount: number
): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  const denom = 1 + (percentage || 0) / 100;
  if (denom <= 0) return 0;
  const estimated = (price - (logisticAmount || 0)) / denom;
  return estimated > 0 ? Math.round(estimated) : 0;
}
