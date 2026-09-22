-- 351_BACKFILL_pending_payment_by_transport.sql
-- REQUIERE APROBACIÓN EXPLÍCITA ANTES DE CORRER EN PRODUCCIÓN.
--
-- Corrige payment_method = 'Pendiente' en closed/sent según transporte:
--   SEDE / MyM / Expreso Norte → Contra Reembolso
--     (salvo preferred_payment_method Pagado del cliente → Pagado)
--   Via Cargo / Credifin / Snaider / Correo Argentino → Pagado
-- NO toca filas sin transporte (legacy) ni payment_method NULL.
--
-- Riesgo: bajo (solo reetiqueta método; no toca stock ni remesas confirmadas).
-- Rollback: restaurar desde snapshot.

-- Snapshot (correr primero):
-- SELECT o.id, o.order_number, o.status, o.payment_method, t.name AS transport
-- FROM orders o
-- LEFT JOIN transports t ON t.id = o.transport_id
-- WHERE o.status IN ('closed', 'sent')
--   AND lower(trim(coalesce(o.payment_method, ''))) IN ('pendiente', 'pending');

BEGIN;

UPDATE public.orders o
SET
  payment_method = public.fn_resolve_order_close_payment_method(o.id, o.payment_method),
  updated_at = now()
FROM public.transports t
WHERE t.id = o.transport_id
  AND o.status IN ('closed', 'sent')
  AND lower(trim(coalesce(o.payment_method, ''))) IN ('pendiente', 'pending')
  AND public.fn_closed_order_transport_category(t.name) IN (
    'cod', 'transfer', 'correo'
  );

-- Verificación: Pendiente restantes solo sin transporte conocido
-- SELECT o.order_number, t.name, o.payment_method
-- FROM orders o
-- LEFT JOIN transports t ON t.id = o.transport_id
-- WHERE o.status IN ('closed','sent')
--   AND lower(trim(coalesce(o.payment_method,''))) IN ('pendiente','pending');

COMMIT;
