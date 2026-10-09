-- 375_manual_confirm_report_filter.sql (aplicada el 2026-10-09 como manual_confirm_report_filter_371)
--
-- Ajuste del reporte vw_stock_audit_manual_confirm_reserved (374). Aplicada,
-- la vista devolvía 9778 filas: 8978 eran pedidos que también se enviaron con
-- su par (había más de uno: sin conflicto). Se excluyen y se etiquetan los
-- casos de riesgo: vencido/cancelado/devolución (la fuente de ese pedido
-- volvió al stock: posible fantasma, como el 1632 T37).
-- Mismas columnas y permisos; solo cambia el filtro y el texto de outcome.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW public.vw_stock_audit_manual_confirm_reserved
WITH (security_invoker = true) AS
WITH mc AS (
  SELECT h.id AS history_id,
         h.created_at AS confirmed_at,
         h.user_id,
         h.variant_id,
         h.size,
         nullif(substring(h.notes from 'order_id:([0-9a-f-]{36})'), '')::uuid AS order_id,
         nullif(substring(h.notes from 'order_item_id:([0-9a-f-]{36})'), '')::uuid AS order_item_id
    FROM public.stock_history h
   WHERE h.change_type = 'admin_manual_confirmation'
     AND h.created_at > now() - interval '90 days'
),
manual_rows AS (
  SELECT 'confirmacion_manual'::text AS kind,
         mc.confirmed_at,
         mc.user_id,
         mc.variant_id,
         mc.size,
         mc.order_id,
         mc.order_item_id,
         oi2.id AS other_order_item_id,
         oi2.order_id AS other_order_id
    FROM mc
    JOIN public.order_items oi2
      ON oi2.variant_id = mc.variant_id
     AND (CASE WHEN trim(coalesce(oi2.size, '')) ~ '^\d+(\.\d+)?$'
               THEN split_part(trim(oi2.size), '.', 1)
               ELSE trim(coalesce(oi2.size, '')) END) = mc.size
     AND oi2.order_id IS DISTINCT FROM mc.order_id
     AND oi2.created_at < mc.confirmed_at
    JOIN public.orders o2 ON o2.id = oi2.order_id
   WHERE (o2.sent_at IS NULL OR o2.sent_at > mc.confirmed_at)
     AND (
       (lower(trim(coalesce(oi2.status, ''))) IN ('picked', 'reserved')
        AND o2.status IS DISTINCT FROM 'sent')
       OR (lower(trim(coalesce(oi2.status, ''))) = 'missing'
           AND (oi2.checked_at IS NULL OR oi2.checked_at > mc.confirmed_at))
       OR (lower(trim(coalesce(oi2.status, ''))) = 'cancelled'
           AND oi2.cancelled_from_status = 'missing'
           AND oi2.updated_at > mc.confirmed_at)
     )
),
taken_rows AS (
  SELECT 'reserva_tomada'::text AS kind,
         h.created_at AS confirmed_at,
         h.user_id,
         h.variant_id,
         h.size,
         nullif(substring(h.notes from 'order_id:([0-9a-f-]{36})'), '')::uuid AS order_id,
         nullif(substring(h.notes from 'order_item_id:([0-9a-f-]{36})'), '')::uuid AS order_item_id,
         nullif(substring(h.notes from 'order_item:([0-9a-f-]{36})'), '')::uuid AS other_order_item_id,
         NULL::uuid AS other_order_id
    FROM public.stock_history h
   WHERE h.change_type = 'reserva_tomada'
     AND h.created_at > now() - interval '90 days'
),
all_rows AS (
  SELECT * FROM manual_rows
  UNION ALL
  SELECT * FROM taken_rows
)
SELECT r.kind,
       r.confirmed_at,
       a.email AS confirmed_by,
       pv.sku,
       r.size,
       o.order_number AS order_number,
       oth_o.order_number AS other_order_number,
       oth_c.full_name AS other_customer,
       oth.created_at AS other_item_created_at,
       oth.status AS other_item_status,
       oth.cancelled_from_status AS other_cancelled_from,
       oth_o.status AS other_order_status,
       CASE
         WHEN r.kind = 'reserva_tomada' THEN 'reserva tomada con aviso'
         WHEN lower(trim(coalesce(oth.status, ''))) = 'missing'
              OR oth.cancelled_from_status = 'missing' THEN 'el otro pedido quedó sin stock'
         WHEN oth_o.status IN ('expired', 'cancelled')
           THEN 'el otro pedido venció o se canceló: su par volvió al stock (posible fantasma)'
         WHEN oth_o.status = 'devolución'
           THEN 'el otro pedido pasó a devolución: revisar si el par volvió al stock'
         WHEN oth_o.status IN ('active', 'closing_soon', 'closed') THEN 'pendiente: el otro pedido sigue con el producto'
         ELSE coalesce(oth_o.status, 'otro pedido borrado')
       END AS outcome,
       r.variant_id,
       r.order_id,
       r.order_item_id,
       r.other_order_item_id,
       coalesce(r.other_order_id, oth.order_id) AS other_order_id
  FROM all_rows r
  LEFT JOIN public.admins a ON a.user_id = r.user_id
  LEFT JOIN public.product_variants pv ON pv.id = r.variant_id
  LEFT JOIN public.orders o ON o.id = r.order_id
  LEFT JOIN public.order_items oth ON oth.id = r.other_order_item_id
  LEFT JOIN public.orders oth_o ON oth_o.id = coalesce(r.other_order_id, oth.order_id)
  LEFT JOIN public.customers oth_c ON oth_c.id = oth_o.customer_id;

COMMENT ON VIEW public.vw_stock_audit_manual_confirm_reserved IS
  'canonical:370/371 — confirmaciones manuales sobre talles reservados por otro pedido (90 días), sin los casos en que ambos pedidos se enviaron, y reservas tomadas con aviso.';

REVOKE ALL ON public.vw_stock_audit_manual_confirm_reserved FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vw_stock_audit_manual_confirm_reserved TO authenticated, service_role;

COMMIT;
