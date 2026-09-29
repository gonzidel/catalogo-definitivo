-- 357_ROLLBACK_wa_deadline_reached_taxonomy.sql
--
-- Revierte 357: vuelve fn_wa_expiry_candidates/rpc_wa_preview_expiry_events/
-- rpc_wa_cron_enqueue_expiry_events al estado de 354 (kind
-- order_expiring_soon, sin customer_enable_24h_uses, sin
-- fn_wa_customer_24h_uses), y el CHECK de wa_outbox.kind a su forma
-- original. Seguro en cualquier momento: wa_settings.mode='off' desde su
-- creación, wa_outbox sigue vacía.

DROP FUNCTION IF EXISTS public.rpc_wa_preview_expiry_events();
DROP FUNCTION IF EXISTS public.fn_wa_expiry_candidates();

CREATE FUNCTION public.fn_wa_expiry_candidates()
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
  v_enabled_kinds text[];
BEGIN
  SELECT launch_cutoff_at, enabled_kinds INTO v_cutoff, v_enabled_kinds
  FROM public.wa_settings WHERE id = true;

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
      WHEN NOT (u.u_kind = ANY(coalesce(v_enabled_kinds, '{}'::text[]))) THEN 'kind_disabled'
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
REVOKE EXECUTE ON FUNCTION public.fn_wa_expiry_candidates() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_wa_expiry_candidates() FROM anon;

CREATE FUNCTION public.rpc_wa_preview_expiry_events()
RETURNS TABLE (
  kind text,
  order_id uuid,
  order_number text,
  customer_name text,
  phone_e164 text,
  channel_owner text,
  dismantle_at timestamptz,
  event_at timestamptz,
  units int,
  deadline_label text,
  would_send boolean,
  skip_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  RETURN QUERY
  SELECT
    c.kind, c.order_id, c.order_number, c.customer_name, c.phone_e164,
    c.channel_owner, c.dismantle_at, c.event_at, c.units, c.deadline_label,
    (c.skip_reason IS NULL) AS would_send,
    c.skip_reason
  FROM public.fn_wa_expiry_candidates() c;
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_wa_cron_enqueue_expiry_events()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_settings record;
  v_today_count int;
  v_remaining int;
  v_inserted int := 0;
  v_row record;
  v_template text;
  v_preview text;
BEGIN
  SELECT * INTO v_settings FROM public.wa_settings WHERE id = true;

  IF v_settings.mode = 'off' THEN
    RETURN json_build_object('ok', true, 'mode', 'off', 'inserted', 0);
  END IF;

  SELECT count(*) INTO v_today_count
  FROM public.wa_outbox
  WHERE created_at >= date_trunc('day', now());

  v_remaining := greatest(0, v_settings.daily_cap - v_today_count);

  FOR v_row IN
    SELECT * FROM public.fn_wa_expiry_candidates() c WHERE c.skip_reason IS NULL
  LOOP
    EXIT WHEN v_remaining <= 0;

    IF v_settings.mode = 'whitelist' AND NOT EXISTS (
      SELECT 1 FROM unnest(v_settings.whitelist_phones) x
      WHERE public.normalize_phone_digits_for_match(x) = public.normalize_phone_digits_for_match(v_row.phone_e164)
    ) THEN
      CONTINUE;
    END IF;

    v_template := CASE v_row.kind
      WHEN 'order_expiring_soon' THEN 'pedido_por_vencer'
      ELSE 'pedido_vencido'
    END;

    v_preview := CASE v_row.kind
      WHEN 'order_expiring_soon' THEN
        'Hola 👋 Tu pedido ' || coalesce(v_row.order_number, '') || ' se vence mañana a las 17:00 hs.'
      ELSE
        'Hola 👋 Tu pedido ' || coalesce(v_row.order_number, '') || ' venció y el stock reservado se liberó.' || E'\n\n'
        || 'Cualquier consulta, respondé este mensaje 😊'
    END;

    INSERT INTO public.wa_outbox (
      order_id, kind, dismantle_at, channel_owner, to_phone_e164,
      customer_name, order_number, template_name, template_params,
      preview_text, status
    ) VALUES (
      v_row.order_id, v_row.kind, v_row.dismantle_at, v_row.channel_owner, v_row.phone_e164,
      v_row.customer_name, v_row.order_number, v_template,
      jsonb_build_array(coalesce(v_row.order_number, '')),
      v_preview, 'queued'
    )
    ON CONFLICT (order_id, kind, dismantle_at) DO NOTHING;

    IF FOUND THEN
      v_inserted := v_inserted + 1;
      v_remaining := v_remaining - 1;
    END IF;
  END LOOP;

  RETURN json_build_object(
    'ok', true,
    'mode', v_settings.mode,
    'inserted', v_inserted,
    'daily_cap_remaining', v_remaining
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM anon;

DROP FUNCTION IF EXISTS public.fn_wa_customer_24h_uses(text);

ALTER TABLE public.wa_outbox DROP CONSTRAINT wa_outbox_kind_check;
ALTER TABLE public.wa_outbox
  ADD CONSTRAINT wa_outbox_kind_check
  CHECK (kind = ANY (ARRAY['order_expiring_soon'::text, 'order_expired'::text]));

COMMENT ON COLUMN public.wa_settings.enabled_kinds IS
  '354: qué tipos de aviso puede encolar rpc_wa_cron_enqueue_expiry_events. '
  'Valores válidos: order_expiring_soon, order_expired. Un tipo fuera de esta '
  'lista nunca se encola (skip_reason=kind_disabled en el preview).';

SELECT pg_notify('pgrst', 'reload schema');
