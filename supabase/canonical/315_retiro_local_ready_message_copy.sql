-- 315: copy WhatsApp "todo confirmado" retiro local especial (Av. Alberdi + plazo hs + Nº pedido).

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
  v_plazo_partial text := '';
  v_time text;
  v_days int;
  v_plazo_ready text := '';
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
      v_plazo_ready := 'Tenés tiempo hasta hoy a las ' || v_time || '.';
      v_plazo_partial := E'\n\nTambién tenés hasta hoy a las ' || v_time || ' para retirar los productos confirmados.';
    ELSIF v_days = 1 THEN
      v_plazo_ready := 'Tenés tiempo hasta mañana a las ' || v_time || '.';
      v_plazo_partial := E'\n\nTambién tenés hasta mañana a las ' || v_time || ' para retirar los productos confirmados.';
    ELSE
      v_plazo_ready := 'Tenés tiempo hasta el ' || to_char(p_pickup_deadline_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM') || ' a las ' || v_time || '.';
      v_plazo_partial := E'\n\nTambién tenés hasta el ' || to_char(p_pickup_deadline_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'DD/MM') || ' a las ' || v_time || ' para retirar los productos confirmados.';
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
    RETURN public.fn_build_customer_status_message(v_confirmed, p_missing_labels, v_url);
  END IF;

  IF v_confirmed = 1 THEN
    v_count_label := '1 producto';
  ELSE
    v_count_label := v_confirmed::text || ' productos';
  END IF;

  RETURN 'Hola 👋 Ya apartamos ' || v_count_label || ' de tu pedido, pero algunos ya no están disponibles.' || v_plazo_partial || E'\n\n'
    || 'Podés revisar cuáles quedaron apartados y cuáles faltaron desde acá: ' || v_url || '.' || E'\n\n'
    || 'Cualquier consulta, podés escribirnos 😊';
END;
$$;

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
