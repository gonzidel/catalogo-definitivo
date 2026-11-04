-- 357_wa_deadline_reached_taxonomy.sql
--
-- Reemplaza el kind 'order_expiring_soon' (aviso 24h antes, nunca llegó a
-- habilitarse) por 'order_deadline_reached', que modela el nuevo diseño de
-- ventana de gracia (355): el pedido llega al plazo de 7 días pero sigue
-- reservado 24hs más, con autogestión de prórroga. Ver
-- docs/FYL-Obsidian/67-YCLOUD-WHATSAPP-AVISOS-VENCIMIENTO-2026-09-22.md,
-- sección "Rediseño 2026-09-23".
--
-- Selección de plantilla (en rpc_wa_cron_enqueue_expiry_events) para
-- 'order_deadline_reached':
--   - customer_enable_24h_uses >= 1 (ya extendió una vez, este es el 2do
--     vencimiento) -> pedido_plazo_ultimo_aviso
--   - si no, unidades < 4 -> pedido_plazo_faltan_productos
--   - si no -> pedido_plazo_extendible2 (nombre real en YCloud — se creó con
--     el "2" porque Meta bloqueó recrear pedido_plazo_extendible en Utilidad
--     tras borrar el original en Marketing por error; ver doc 67).
-- 'order_expired' (pedido realmente desarmado) sigue mandando pedido_vencido
-- sin cambiar su condición de disparo.
--
-- Cambio de comportamiento: se elimina el skip_reason 'below_minimum_units'.
-- Antes (352/354), un pedido con <4 unidades nunca generaba ningún aviso.
-- Ahora, por diseño explícito del usuario (mensaje "faltan productos"), SÍ
-- se avisa, con una plantilla distinta. El desarme real
-- (rpc_orders_daily_maintenance) tampoco filtra por unidades, así que sacar
-- el filtro acá alinea el aviso con lo que el pedido efectivamente vive.
--
-- Ninguna plantilla nueva usa variables (decisión: no exponer numero_pedido
-- al cliente) -> template_params pasa a ser '[]'::jsonb siempre.
--
-- wa_settings.mode sigue en 'off' y enabled_kinds = {order_expired} (sin
-- 'order_deadline_reached' todavía) -> esta migración no envía nada nuevo,
-- solo prepara la lógica para cuando Meta apruebe las 3 plantillas nuevas y
-- se decida sumar 'order_deadline_reached' a enabled_kinds.
--
-- Rollback: 357_ROLLBACK_wa_deadline_reached_taxonomy.sql
-- Tests: 357_wa_deadline_reached_taxonomy_tests.sql

-- 1) Helper: cuántas veces la clienta ya usó la prórroga de 24hs de este
-- pedido (mismo campo y misma lectura defensiva de JSON que
-- rpc_customer_request_order_extension_24h, pero sin lanzar excepción: acá
-- es solo lectura para decidir qué plantilla mandar).
CREATE OR REPLACE FUNCTION public.fn_wa_customer_24h_uses(p_notes text)
RETURNS int
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_notes_obj jsonb;
BEGIN
  IF p_notes IS NULL OR trim(p_notes) = '' THEN
    RETURN 0;
  END IF;

  BEGIN
    v_notes_obj := p_notes::jsonb;
  EXCEPTION WHEN others THEN
    RETURN 0;
  END;

  IF jsonb_typeof(v_notes_obj) <> 'object' THEN
    RETURN 0;
  END IF;

  RETURN COALESCE((v_notes_obj->>'customer_enable_24h_uses')::int, 0);
END;
$function$;

COMMENT ON FUNCTION public.fn_wa_customer_24h_uses(text) IS
  '357: lee customer_enable_24h_uses de orders.notes (mismo campo que usa '
  'rpc_customer_request_order_extension_24h), sin excepciones: devuelve 0 '
  'ante notes NULL/vacío/no-JSON/no-objeto. Solo para uso interno de '
  'fn_wa_expiry_candidates.';

REVOKE ALL ON FUNCTION public.fn_wa_customer_24h_uses(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_wa_customer_24h_uses(text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_wa_customer_24h_uses(text) FROM anon;

-- 2) fn_wa_expiry_candidates: nuevo kind + columna customer_enable_24h_uses.
-- Cambia el tipo de retorno (columna nueva) -> hace falta DROP antes de
-- recrear (CREATE OR REPLACE no permite cambiar RETURNS TABLE). Esto resetea
-- los privilegios por defecto del proyecto (lección de 352b) -> hay que
-- volver a revocar EXECUTE de authenticated/anon explícitamente después.
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
  customer_enable_24h_uses int,
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
      public.fn_wa_customer_24h_uses(o.notes) AS b_24h_uses,
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
  deadline_reached AS (
    SELECT
      'order_deadline_reached'::text AS u_kind,
      base.*,
      base.b_dismantle_at AS u_event_at
    FROM base
    WHERE base.b_status IN ('active', 'closing_soon')
      AND now() >= base.b_dismantle_at
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
    SELECT * FROM deadline_reached
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
    u.b_24h_uses,
    public.fn_wa_format_deadline_es(u.b_dismantle_at),
    EXISTS (
      SELECT 1 FROM public.wa_outbox w
      WHERE w.order_id = u.b_order_id AND w.kind = u.u_kind AND w.dismantle_at = u.b_dismantle_at
    ),
    CASE
      WHEN v_cutoff IS NULL THEN 'launch_cutoff_not_set'
      WHEN NOT (u.u_kind = ANY(coalesce(v_enabled_kinds, '{}'::text[]))) THEN 'kind_disabled'
      WHEN u.u_event_at < v_cutoff THEN 'before_launch_cutoff'
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
  '357: helper interno (sin GRANT a authenticated/anon). order_expiring_soon '
  'reemplazado por order_deadline_reached (dispara al llegar a dismantle_at, '
  'no 24h antes — ver 355 ventana de gracia). Se agrega '
  'customer_enable_24h_uses para elegir sub-plantilla en el enqueue. Se saca '
  'el skip below_minimum_units: ahora <4 unidades manda '
  'pedido_plazo_faltan_productos en vez de no avisar nada.';

REVOKE ALL ON FUNCTION public.fn_wa_expiry_candidates() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_wa_expiry_candidates() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_wa_expiry_candidates() FROM anon;

-- 3) rpc_wa_preview_expiry_events: agrega customer_enable_24h_uses al
-- preview admin (mismo motivo: cambia RETURNS TABLE -> DROP + CREATE).
DROP FUNCTION IF EXISTS public.rpc_wa_preview_expiry_events();

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
  customer_enable_24h_uses int,
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
    c.channel_owner, c.dismantle_at, c.event_at, c.units,
    c.customer_enable_24h_uses, c.deadline_label,
    (c.skip_reason IS NULL) AS would_send,
    c.skip_reason
  FROM public.fn_wa_expiry_candidates() c;
END;
$function$;

COMMENT ON FUNCTION public.rpc_wa_preview_expiry_events() IS
  '357: agrega customer_enable_24h_uses al preview admin (mismo chequeo de '
  'admin que antes, sin más cambios de comportamiento).';

-- 4) rpc_wa_cron_enqueue_expiry_events: selección de plantilla para el nuevo
-- taxonomy (mismo signature/return type que antes -> CREATE OR REPLACE
-- alcanza, no resetea privilegios; se revoca igual, por prolijidad/lección
-- 352b).
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

    IF v_row.kind = 'order_expired' THEN
      v_template := 'pedido_vencido';
      v_preview :=
        'Hola 👋 Tu pedido venció y se desarmó porque finalizó el plazo de reserva.' || E'\n\n'
        || 'Cualquier consulta, podés escribirnos 😊';
    ELSIF v_row.customer_enable_24h_uses >= 1 THEN
      v_template := 'pedido_plazo_ultimo_aviso';
      v_preview :=
        'Hola 👋 El plazo adicional de tu pedido también llegó a su fin.' || E'\n\n'
        || 'Si todavía querés finalizarlo, respondé este mensaje y te ayudamos a revisar el pedido antes de desarmarlo.' || E'\n\n'
        || 'Si no recibimos respuesta, mañana por la mañana el pedido se desarmará automáticamente.' || E'\n\n'
        || '👉 https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart';
    ELSIF v_row.units < 4 THEN
      v_template := 'pedido_plazo_faltan_productos';
      v_preview :=
        'Hola 👋 Tu pedido ya cumplió el plazo de reserva de 7 días.' || E'\n\n'
        || 'Todavía te faltan productos para completar la compra mínima de 4 productos surtidos. Si querés continuar, podés agregar lo que te falta y darte 24 hs más desde tu pedido 😊' || E'\n\n'
        || '👉 https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart' || E'\n\n'
        || 'Si no extendés el plazo ni nos respondés, mañana por la mañana el pedido se desarmará automáticamente.';
    ELSE
      v_template := 'pedido_plazo_extendible2';
      v_preview :=
        'Hola 👋 Tu pedido ya cumplió el plazo de reserva de 7 días.' || E'\n\n'
        || 'Si todavía querés finalizarlo, podés darte 24 hs más desde tu pedido para conservarlo un día adicional 😊' || E'\n\n'
        || '👉 https://nj-fyl-testing.vercel.app/nj/dashboard?tab=cart' || E'\n\n'
        || 'Si no extendés el plazo ni nos respondés, mañana por la mañana el pedido se desarmará automáticamente.';
    END IF;

    INSERT INTO public.wa_outbox (
      order_id, kind, dismantle_at, channel_owner, to_phone_e164,
      customer_name, order_number, template_name, template_params,
      preview_text, status
    ) VALUES (
      v_row.order_id, v_row.kind, v_row.dismantle_at, v_row.channel_owner, v_row.phone_e164,
      v_row.customer_name, v_row.order_number, v_template,
      '[]'::jsonb,
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

COMMENT ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() IS
  '357: selección de plantilla para el nuevo taxonomy de 3 mensajes en '
  'order_deadline_reached (por customer_enable_24h_uses/unidades) + '
  'pedido_vencido sin cambios en order_expired. Ninguna plantilla usa '
  'variables -> template_params siempre [].';

REVOKE ALL ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_wa_cron_enqueue_expiry_events() FROM anon;

-- 5) wa_outbox.kind: 'order_expiring_soon' -> 'order_deadline_reached'.
-- La tabla está vacía (mode='off' desde que existe) -> sin filas que migrar.
ALTER TABLE public.wa_outbox DROP CONSTRAINT wa_outbox_kind_check;
ALTER TABLE public.wa_outbox
  ADD CONSTRAINT wa_outbox_kind_check
  CHECK (kind = ANY (ARRAY['order_deadline_reached'::text, 'order_expired'::text]));

-- 6) Actualiza el comentario de 354 (valores válidos cambiaron).
COMMENT ON COLUMN public.wa_settings.enabled_kinds IS
  '357: qué tipos de aviso puede encolar rpc_wa_cron_enqueue_expiry_events. '
  'Valores válidos: order_deadline_reached, order_expired. Un tipo fuera de '
  'esta lista nunca se encola (skip_reason=kind_disabled en el preview).';

SELECT pg_notify('pgrst', 'reload schema');
