/**
 * Clarificaciones post-Fase 2 (no editar el plan markdown; viven acá como referencia de código):
 * 1) Mayo 2026 observado en prod (Fase 2): 803 pedidos; 661 con sent_at NULL (closed_at
 *    estimado); 142 con sent_at. Usar 661 — no 653 — como referencia de tests.
 * 2) Irregularidades y pagos sin identificar son métricas globales en Fase 2 (aceptable
 *    mientras sean 0). Con datos reales deben respetar filtros o etiquetarse como globales.
 * 3) KPIs vía agregación TypeScript OK por ahora; si el volumen crece mucho, mover
 *    agregaciones a SQL/RPC (sin vistas todavía).
 */

/** Fecha de inicio del universo conciliable COD (V1). */
export const RECONCILIATION_START_DATE = "2026-05-01";

export const RECONCILIATION_PERMISSION_KEY = "conciliacion-reembolso";

/** Filas por página en el listado de pendientes. */
export const PENDING_PAGE_SIZE = 50;

/** Payment method exacto en producción. */
export const COD_PAYMENT_METHOD = "Contra Reembolso";

/** Observado en producción durante Fase 2 (referencia de tests, no hardcode de UI). */
export const OBSERVED_MAY_2026_ESTIMATED_SENT_AT_NULL = 661;
