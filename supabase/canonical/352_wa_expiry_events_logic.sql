-- 352_wa_expiry_events_logic.sql
--
-- Lógica de avisos de vencimiento (helpers + candidatos + preview + encolar).
-- Depende de las tablas de 351. NO instala pg_net, NO agenda cron, NO llama a
-- ninguna URL externa: rpc_wa_enqueue_expiry_events solo escribe filas
-- 'queued' en wa_outbox. Nada las despacha todavía — eso es la Edge Function
-- wa-dispatch de una fase futura, que además necesita pg_net (no instalada).
--
-- Reglas de negocio (decisión del usuario, 2026-09-21/22):
--   - Aplica a TODOS los pedidos (admin y clienta), no solo autogestionados.
--   - Mínimo 4 unidades (no canceladas, sin líneas de descuento negativas).
--   - Excluye retiro local diferido y la zona de 36h (fn_is_local_pickup_short_deadline_zone).
--   - "Por vencer": se dispara exactamente 24h antes de dismantle_at.
--   - "Venció": se dispara cuando el pedido ya está status='expired' (mismo
--     momento en que el cron de mantenimiento lo desarma, ~17:00 AR).
--   - Sin prórroga automática ni link de extensión en los mensajes (opción B,
--     "dejemos como está" — ver memoria de sesión).
--   - launch_cutoff_at evita reenviar el historial de pedidos que ya estaban
--     vencidos/por vencer antes de encender esto.
--
-- Rollback: 352_ROLLBACK_wa_expiry_events_logic.sql
-- Tests: 352_wa_expiry_events_logic_tests.sql
--
-- Antes de aplicar en producción: presentar SQL, riesgo, rollback y
-- verificación (regla FYL Supabase Production Safety).

-- =============================================================================
-- A) fn_wa_phone_e164 — normaliza un teléfono argentino a formato E.164 WhatsApp
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_wa_phone_e164(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT CASE
    WHEN d ~ '^549\d{10}$' THEN '+' || d
    WHEN d ~ '^54\d{10}$' THEN '+549' || substr(d, 3)
    WHEN d ~ '^0\d{10}$' THEN '+549' || substr(d, 2)
    WHEN d ~ '^\d{10}$' THEN '+549' || d
    ELSE NULL
  END
  FROM (SELECT regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') AS d) s;
$function$;

COMMENT ON FUNCTION public.fn_wa_phone_e164(text) IS
  '352: normaliza customers.phone a E.164 (+549...) para WhatsApp. '
  'Devuelve NULL si el teléfono no matchea ningún patrón conocido '
  '(verificado contra producción: ~197 de 7107 quedan sin convertir).';

REVOKE ALL ON FUNCTION public.fn_wa_phone_e164(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_wa_phone_e164(text) TO authenticated;

-- =============================================================================
-- B) fn_wa_format_deadline_es — fecha legible en castellano, hora Argentina
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_wa_format_deadline_es(p_ts timestamptz)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_local timestamp;
  v_days text[] := ARRAY['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
BEGIN
  IF p_ts IS NULL THEN
    RETURN NULL;
  END IF;

  v_local := p_ts AT TIME ZONE 'America/Argentina/Buenos_Aires';

  RETURN v_days[extract(dow FROM v_local)::int + 1]
    || ' ' || to_char(v_local, 'DD/MM')
    || ' a las ' || to_char(v_local, 'HH24:MI');
END;
$function$;

COMMENT ON FUNCTION public.fn_wa_format_deadline_es(timestamptz) IS
  '352: "lunes 28/09 a las 17:00", en hora Argentina. Solo para uso interno '
  '(preview/logs) — los textos finales de los mensajes NO llevan esta fecha '
  '(decisión del usuario: "mañana se vence tu plazo", sin fecha explícita).';

REVOKE ALL ON FUNCTION public.fn_wa_format_deadline_es(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_wa_format_deadline_es(timestamptz) TO authenticated;

-- =============================================================================
-- C) fn_wa_expiry_candidates — helper interno (no se otorga a authenticated/anon).
-- Solo lo llaman las dos RPC de abajo, que sí validan que quien llama es admin.
-- =============================================================================

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

COMMENT ON FUNCTION public.fn_wa_expiry_candidates() IS
  '352: helper interno (sin GRANT a authenticated/anon). Calcula, sin escribir '
  'nada, qué avisos de vencimiento corresponden ahora mismo y por qué se '
  'salteería cada uno. Solo lo llaman rpc_wa_preview_expiry_events y '
  'rpc_wa_enqueue_expiry_events, que validan admin antes de exponerlo.';

REVOKE ALL ON FUNCTION public.fn_wa_expiry_candidates() FROM PUBLIC;

-- =============================================================================
-- D) rpc_wa_preview_expiry_events — SOLO LECTURA. No escribe nada, no envía nada.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_wa_preview_expiry_events()
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

COMMENT ON FUNCTION public.rpc_wa_preview_expiry_events() IS
  '352: solo lectura, admin-only. Muestra qué avisos de vencimiento se '
  'enviarían ahora mismo y por qué se salteería cada uno. Usar esto para '
  'verificar antes de tocar wa_settings.mode.';

REVOKE ALL ON FUNCTION public.rpc_wa_preview_expiry_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_wa_preview_expiry_events() TO authenticated;

-- =============================================================================
-- E) rpc_wa_enqueue_expiry_events — escribe en wa_outbox (status='queued').
-- NO llama a YCloud, NO abre conexión a internet, NO está agendada en ningún
-- cron todavía. Respeta wa_settings.mode/daily_cap/whitelist_phones.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_wa_enqueue_expiry_events()
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
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

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

COMMENT ON FUNCTION public.rpc_wa_enqueue_expiry_events() IS
  '352: admin-only. Encola avisos elegibles en wa_outbox (status=queued). '
  'No envía nada — no hay dispatcher ni pg_net todavía. mode=off no inserta '
  'nada; mode=shadow/whitelist/live sí insertan (whitelist filtra por '
  'wa_settings.whitelist_phones). Respeta daily_cap.';

REVOKE ALL ON FUNCTION public.rpc_wa_enqueue_expiry_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_wa_enqueue_expiry_events() TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
