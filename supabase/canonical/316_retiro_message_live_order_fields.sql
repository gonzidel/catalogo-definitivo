-- 316: campana retiro local — Nº pedido y plazo siempre del pedido vivo (no snapshot stale).

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
