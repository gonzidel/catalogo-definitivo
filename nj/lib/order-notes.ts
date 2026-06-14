export const CUSTOMER_ENABLE_24H_USES_KEY = "customer_enable_24h_uses";

/** True si el cliente ya pidió la prórroga única de 24h para este pedido. */
export function hasCustomerUsedOrderExtension(notes?: string | null): boolean {
  if (!notes || !String(notes).trim()) return false;
  try {
    const obj = JSON.parse(String(notes)) as Record<string, unknown>;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
    const n = Number(obj[CUSTOMER_ENABLE_24H_USES_KEY] ?? 0);
    return Number.isFinite(n) && n >= 1;
  } catch {
    return false;
  }
}
