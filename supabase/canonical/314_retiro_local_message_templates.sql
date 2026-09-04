-- 314_retiro_local_message_templates.sql
-- Retiro local diferido: templates WhatsApp con plazo de retiro + espera fábrica en snapshot.

ALTER TABLE public.admin_order_local_wait_snapshots
  ADD COLUMN IF NOT EXISTS waiting_fabrica_item_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS message_profile text NOT NULL DEFAULT 'shipping',
  ADD COLUMN IF NOT EXISTS pickup_deadline_at timestamptz;

-- =============================================================================
-- Helper: mensaje retiro local (paridad nj/lib/orders/customer-status-message.ts)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_build_retiro_local_customer_status_message(
  p_confirmed_count integer,
  p_missing_labels jsonb,
  p_pickup_deadline_at timestamptz DEFAULT NULL,
  p_dashboard_url text DEFAULT '/nj/dashboard?tab=active-order',
  p_order_number text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_missing text[];
  v_missing_count int;
  v_url text;
  v_confirmed int;
  v_count_label text;
  v_plazo_ready text := '';
  v_plazo_inline text := '';
  v_time text;
  v_days int;
  v_order_no text;
  v_pickup_hint text;
BEGIN
  SELECT coalesce(array_agg(x), '{}'::text[])
    INTO v_missing
    FROM jsonb_array_elements_text(coalesce(p_missing_labels, '[]'::jsonb)) AS t(x);

  v_missing_count := coalesce(array_length(v_missing, 1), 0);
  v_url := coalesce(nullif(trim(p_dashboard_url), ''), '/nj/dashboard?tab=active-order');
  v_confirmed := greatest(0, coalesce(p_confirmed_count, 0));
  v_order_no := nullif(trim(p_order_number), '');

  IF p_pickup_deadline_at IS NOT NULL THEN
    v_time := to_char(p_pickup_deadline_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'HH24:MI') || ' hs';
    v_days := (p_pickup_deadline_at::date - (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date);
    IF v_days <= 0 THEN
      v_plazo_inline := 'hoy a las ' || v_time;
      v_plazo_ready := 'Tenés tiempo hasta ' || v_plazo_inline || '.';
    ELSIF v_days = 1 THEN
      v_plazo_inline := 'mañana a las ' || v_time;
      v_plazo_ready := 'Tenés tiempo hasta ' || v_plazo_inline || '.';
    ELSE
      v_plazo_inline := 'el ' || to_char(p_pickup_deadline_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM') || ' a las ' || v_time;
      v_plazo_ready := 'Tenés tiempo hasta ' || v_plazo_inline || '.';
    END IF;
  END IF;

  IF v_missing_count = 0 THEN
    v_pickup_hint := CASE
      WHEN v_order_no IS NOT NULL THEN 'Al retirar, indicá tu nombre o número de pedido ' || v_order_no || '.'
      ELSE 'Al retirar, indicá tu nombre o número de pedido.'
    END;

    RETURN 'Hola 👋 Tu pedido ya está listo para retirar.' || E'\n\n'
      || 'Podés pasar por nuestro local en Av. Alberdi 1099.'
      || CASE WHEN v_plazo_ready <> '' THEN ' ' || v_plazo_ready ELSE '' END
      || E'\n\n' || v_pickup_hint || E'\n\n'
      || 'Podés revisar tu pedido acá: ' || v_url || ' 😊';
  END IF;

  IF v_confirmed <= 0 THEN
    RETURN 'Hola 👋 No pudimos preparar tu pedido porque los productos que elegiste ya no están disponibles.' || E'\n\n'
      || 'Podés revisar el detalle de tu pedido acá: ' || v_url || E'\n\n'
      || 'Cualquier consulta, podés escribirnos 😊';
  END IF;

  IF v_confirmed = 1 THEN
    v_count_label := '1 producto';
  ELSE
    v_count_label := v_confirmed::text || ' productos';
  END IF;

  RETURN 'Hola 👋 Tu pedido ya está listo para retirar.' || E'\n\n'
    || 'Pudimos preparar *' || v_count_label || '*, pero algunos ya no están disponibles.' || E'\n\n'
    || 'Podés pasar por nuestro local en *Av. Alberdi 1099*.'
    || CASE
         WHEN v_plazo_inline <> '' THEN ' Tenés tiempo hasta *' || v_plazo_inline || '* para retirarlo.'
         ELSE ''
       END
    || E'\n\n'
    || 'Podés revisar qué productos están listos y cuáles faltaron acá: ' || v_url || E'\n\n'
    || 'Cualquier consulta, podés escribirnos 😊';
END;
$$;

-- =============================================================================
-- RPC: upsert snapshot (espera local/depósito + fábrica en local diferido)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_upsert_admin_local_wait_snapshot(
  p_order_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_prior_confirmed_count integer,
  p_prior_missing_labels jsonb,
  p_waiting_local_item_ids uuid[],
  p_dashboard_url text DEFAULT '/nj/dashboard?tab=active-order',
  p_waiting_fabrica_item_ids uuid[] DEFAULT '{}',
  p_message_profile text DEFAULT 'shipping',
  p_pickup_deadline_at timestamptz DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  IF coalesce(array_length(p_waiting_local_item_ids, 1), 0) = 0
     AND coalesce(array_length(p_waiting_fabrica_item_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'waiting item ids vacío';
  END IF;

  INSERT INTO public.admin_order_local_wait_snapshots (
    order_id, customer_name, customer_phone,
    prior_confirmed_count, prior_missing_labels,
    waiting_local_item_ids, waiting_fabrica_item_ids,
    message_profile, pickup_deadline_at,
    resolutions, dashboard_url, updated_at
  )
  VALUES (
    p_order_id,
    coalesce(nullif(trim(p_customer_name), ''), 'Cliente'),
    nullif(trim(p_customer_phone), ''),
    greatest(0, coalesce(p_prior_confirmed_count, 0)),
    coalesce(p_prior_missing_labels, '[]'::jsonb),
    coalesce(p_waiting_local_item_ids, '{}'::uuid[]),
    coalesce(p_waiting_fabrica_item_ids, '{}'::uuid[]),
    coalesce(nullif(trim(p_message_profile), ''), 'shipping'),
    p_pickup_deadline_at,
    '{}'::jsonb,
    coalesce(nullif(trim(p_dashboard_url), ''), '/nj/dashboard?tab=active-order'),
    now()
  )
  ON CONFLICT (order_id) DO UPDATE SET
    customer_name = EXCLUDED.customer_name,
    customer_phone = EXCLUDED.customer_phone,
    prior_confirmed_count = EXCLUDED.prior_confirmed_count,
    prior_missing_labels = EXCLUDED.prior_missing_labels,
    waiting_local_item_ids = EXCLUDED.waiting_local_item_ids,
    waiting_fabrica_item_ids = EXCLUDED.waiting_fabrica_item_ids,
    message_profile = EXCLUDED.message_profile,
    pickup_deadline_at = EXCLUDED.pickup_deadline_at,
    resolutions = '{}'::jsonb,
    dashboard_url = EXCLUDED.dashboard_url,
    updated_at = now();

  RETURN json_build_object('ok', true, 'order_id', p_order_id);
END;
$$;

-- =============================================================================
-- RPC: registrar resolución → notificación si completó todos (local + fábrica)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_record_admin_local_wait_resolution(
  p_order_id uuid,
  p_item_id uuid,
  p_outcome text,
  p_label text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_snap public.admin_order_local_wait_snapshots%rowtype;
  v_resolutions jsonb;
  v_waiting uuid;
  v_all_done boolean;
  v_confirmed int;
  v_missing jsonb;
  v_missing_arr jsonb := '[]'::jsonb;
  v_msg text;
  v_notif_id uuid;
  v_key text;
  v_lbl text;
  v_in_local boolean;
  v_in_fabrica boolean;
  v_order_number text;
  v_pickup_deadline timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  IF p_outcome NOT IN ('picked', 'missing') THEN
    RAISE EXCEPTION 'outcome inválido';
  END IF;

  SELECT * INTO v_snap
    FROM public.admin_order_local_wait_snapshots
   WHERE order_id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', true, 'notification_created', false, 'reason', 'no_snapshot');
  END IF;

  v_in_local := p_item_id = ANY (coalesce(v_snap.waiting_local_item_ids, '{}'::uuid[]));
  v_in_fabrica := p_item_id = ANY (coalesce(v_snap.waiting_fabrica_item_ids, '{}'::uuid[]));

  IF NOT v_in_local AND NOT v_in_fabrica THEN
    RETURN json_build_object('ok', true, 'notification_created', false, 'reason', 'item_not_in_snapshot');
  END IF;

  v_key := p_item_id::text;
  v_resolutions := coalesce(v_snap.resolutions, '{}'::jsonb);
  v_resolutions := v_resolutions || jsonb_build_object(
    v_key,
    jsonb_build_object(
      'outcome', p_outcome,
      'label', coalesce(nullif(trim(p_label), ''), 'Producto')
    )
  );

  UPDATE public.admin_order_local_wait_snapshots
     SET resolutions = v_resolutions, updated_at = now()
   WHERE id = v_snap.id;

  SELECT bool_and(v_resolutions ? w::text)
    INTO v_all_done
    FROM (
      SELECT unnest(coalesce(v_snap.waiting_local_item_ids, '{}'::uuid[])) AS w
      UNION
      SELECT unnest(coalesce(v_snap.waiting_fabrica_item_ids, '{}'::uuid[])) AS w
    ) pending;

  IF NOT coalesce(v_all_done, false) THEN
    RETURN json_build_object('ok', true, 'notification_created', false, 'reason', 'pending');
  END IF;

  v_confirmed := v_snap.prior_confirmed_count;
  v_missing := coalesce(v_snap.prior_missing_labels, '[]'::jsonb);

  FOR v_waiting IN
    SELECT unnest(coalesce(v_snap.waiting_local_item_ids, '{}'::uuid[]))
    UNION
    SELECT unnest(coalesce(v_snap.waiting_fabrica_item_ids, '{}'::uuid[]))
  LOOP
    v_lbl := coalesce(v_resolutions->v_waiting::text->>'label', 'Producto');
    IF coalesce(v_resolutions->v_waiting::text->>'outcome', '') = 'picked' THEN
      v_confirmed := v_confirmed + 1;
    ELSIF coalesce(v_resolutions->v_waiting::text->>'outcome', '') = 'missing' THEN
      v_missing_arr := v_missing_arr || to_jsonb(v_lbl);
    END IF;
  END LOOP;

  v_missing := v_missing || v_missing_arr;

  SELECT o.order_number, o.dismantle_at
    INTO v_order_number, v_pickup_deadline
    FROM public.orders o
   WHERE o.id = p_order_id;

  v_pickup_deadline := coalesce(v_snap.pickup_deadline_at, v_pickup_deadline);

  IF coalesce(v_snap.message_profile, 'shipping') = 'retiro_local' THEN
    v_msg := public.fn_build_retiro_local_customer_status_message(
      v_confirmed,
      v_missing,
      v_pickup_deadline,
      v_snap.dashboard_url,
      v_order_number
    );
  ELSE
    v_msg := public.fn_build_customer_status_message(
      v_confirmed,
      v_missing,
      v_snap.dashboard_url
    );
  END IF;

  INSERT INTO public.admin_order_message_notifications (
    order_id, customer_name, customer_phone, message, kind
  )
  VALUES (
    p_order_id,
    v_snap.customer_name,
    v_snap.customer_phone,
    v_msg,
    'local_wait_resolved'
  )
  RETURNING id INTO v_notif_id;

  DELETE FROM public.admin_order_local_wait_snapshots WHERE id = v_snap.id;

  RETURN json_build_object(
    'ok', true,
    'notification_created', true,
    'notification_id', v_notif_id,
    'message', v_msg
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_build_retiro_local_customer_status_message(integer, jsonb, timestamptz, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text, uuid[], text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_admin_local_wait_resolution(uuid, uuid, text, text) TO authenticated;
