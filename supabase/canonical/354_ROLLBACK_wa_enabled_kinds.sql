-- 354_ROLLBACK_wa_enabled_kinds.sql
-- Revierte 354: quita el chequeo kind_disabled y la columna (vuelve fn_wa_expiry_candidates a la versión de 352).

CREATE OR REPLACE FUNCTION public.fn_wa_expiry_candidates()
RETURNS TABLE (
  kind text,
  order_id uuid,
  order_number text,
  customer_id uuid,
  customer_name text,
  phone_raw text,
  phone_e164 text,
  channel_owner text,
  dismantle_at timestamptz,
  event_at timestamptz,
  units int,
  deadline_label text,
  already_queued boolean,
  skip_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_cutoff timestamptz;
BEGIN
  SELECT launch_cutoff_at INTO v_cutoff FROM public.wa_settings WHERE id = true;

  RETURN QUERY
  WITH base AS (
    SELECT
      o.id AS b_order_id,
      o.order_number AS b_order_number,
      o.customer_id AS b_customer_id,
      o.dismantle_at AS b_dismantle_at,
      o.expired_at AS b_expired_at,
      o.status AS b_status,
      c.full_name AS b_customer_name,
      c.phone AS b_phone_raw,
      c.kanban_inbox_owner AS b_channel_owner,
      coalesce((
        SELECT sum(oi.quantity)
        FROM public.order_items oi
        WHERE oi.order_id = o.id
          AND oi.status <> 'cancelled'
          AND coalesce(oi.price_snapshot, 0) >= 0
      ), 0)::int AS b_units
    FROM public.orders o
    JOIN public.customers c ON c.id = o.customer_id
    WHERE o.dismantle_at IS NOT NULL
      AND coalesce(o.local_deferred_pickup, false) = false
      AND NOT public.fn_is_local_pickup_short_deadline_zone(c.province, c.city)
  ),
  expiring AS (
    SELECT
      'order_expiring_soon'::text AS u_kind,
      base.*,
      (base.b_dismantle_at - interval '24 hours') AS u_event_at
    FROM base
    WHERE base.b_status IN ('active', 'closing_soon')
      AND now() >= (base.b_dismantle_at - interval '24 hours')
      AND now() < base.b_dismantle_at
  ),
  expired AS (
    SELECT
      'order_expired'::text AS u_kind,
      base.*,
      base.b_expired_at AS u_event_at
    FROM base
    WHERE base.b_status = 'expired'
      AND base.b_expired_at IS NOT NULL
  ),
  unioned AS (
    SELECT * FROM expiring
    UNION ALL
    SELECT * FROM expired
  )
  SELECT
    u.u_kind,
    u.b_order_id,
    u.b_order_number,
    u.b_customer_id,
    u.b_customer_name,
    u.b_phone_raw,
    public.fn_wa_phone_e164(u.b_phone_raw),
    u.b_channel_owner,
    u.b_dismantle_at,
    u.u_event_at,
    u.b_units,
    public.fn_wa_format_deadline_es(u.b_dismantle_at),
    EXISTS (
      SELECT 1 FROM public.wa_outbox w
      WHERE w.order_id = u.b_order_id AND w.kind = u.u_kind AND w.dismantle_at = u.b_dismantle_at
    ),
    CASE
      WHEN v_cutoff IS NULL THEN 'launch_cutoff_not_set'
      WHEN u.u_event_at < v_cutoff THEN 'before_launch_cutoff'
      WHEN u.b_units < 4 THEN 'below_minimum_units'
      WHEN u.b_channel_owner IS NULL THEN 'no_channel_owner'
      WHEN public.fn_wa_phone_e164(u.b_phone_raw) IS NULL THEN 'invalid_phone'
      WHEN EXISTS (
        SELECT 1 FROM public.admin_order_expiry_warn_sent s
        WHERE s.order_id = u.b_order_id AND s.sent_at > now() - interval '24 hours'
      ) THEN 'manual_warn_sent_recently'
      WHEN EXISTS (
        SELECT 1 FROM public.wa_outbox w
        WHERE w.order_id = u.b_order_id AND w.kind = u.u_kind AND w.dismantle_at = u.b_dismantle_at
      ) THEN 'already_queued'
      ELSE NULL
    END
  FROM unioned u
  ORDER BY u.u_event_at;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_wa_expiry_candidates() FROM PUBLIC;

ALTER TABLE public.wa_settings DROP COLUMN IF EXISTS enabled_kinds;

SELECT pg_notify('pgrst', 'reload schema');
