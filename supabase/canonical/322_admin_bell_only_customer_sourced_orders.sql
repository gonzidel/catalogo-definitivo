-- 322_admin_bell_only_customer_sourced_orders.sql
-- Campana (local_wait_resolved / snapshots) y panel Pagos:
-- solo pedidos auto-gestionados por la clienta.
-- Pedidos source admin / pau / nj/admin -> no snapshot, no aviso, no payment_pending.
-- Aplica a shipping, retiro (/nj/admin/retiro) y boton Pagos.
-- Paridad frontend: isCustomerSourcedOrder() en nj/lib/orders/domain.ts

CREATE OR REPLACE FUNCTION public.fn_order_is_customer_self_managed(p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_source text;
BEGIN
  SELECT lower(trim(coalesce(o.source, '')))
    INTO v_source
    FROM public.orders o
   WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_source = '' THEN
    RETURN true;
  END IF;

  IF v_source IN ('admin', 'pau')
     OR v_source LIKE 'admin/%'
     OR v_source LIKE 'nj/admin%' THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.fn_order_is_customer_self_managed(uuid) IS
  'True si el pedido es auto-gestionado por la clienta (no creado solo por admin/PAU).';

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

  IF NOT public.fn_order_is_customer_self_managed(p_order_id) THEN
    RETURN json_build_object(
      'ok', true,
      'skipped', true,
      'reason', 'admin_sourced_order'
    );
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

  IF NOT public.fn_order_is_customer_self_managed(p_order_id) THEN
    DELETE FROM public.admin_order_local_wait_snapshots WHERE order_id = p_order_id;
    RETURN json_build_object(
      'ok', true,
      'notification_created', false,
      'skipped', true,
      'reason', 'admin_sourced_order'
    );
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

-- =============================================================================
-- Pagos pendientes: misma regla (solo auto-gestión clienta)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_ensure_payment_pending(
  p_order_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_transport_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT public.fn_order_is_customer_self_managed(p_order_id) THEN
    RETURN;
  END IF;

  INSERT INTO public.admin_order_payment_pending (
    order_id, customer_name, customer_phone, transport_name
  )
  VALUES (
    p_order_id,
    coalesce(p_customer_name, ''),
    p_customer_phone,
    coalesce(p_transport_name, '')
  )
  ON CONFLICT (order_id) DO UPDATE
    SET customer_name = excluded.customer_name,
        customer_phone = excluded.customer_phone,
        transport_name = excluded.transport_name
  WHERE public.admin_order_payment_pending.confirmed_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_list_admin_payment_pending()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_rows json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
    INTO v_rows
    FROM (
      SELECT p.id, p.order_id, p.customer_name, p.customer_phone, p.transport_name, p.created_at
        FROM public.admin_order_payment_pending p
       WHERE p.confirmed_at IS NULL
         AND public.fn_order_is_customer_self_managed(p.order_id)
       ORDER BY p.created_at DESC
       LIMIT 50
    ) t;

  RETURN json_build_object('ok', true, 'payments', v_rows);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_order_is_customer_self_managed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ensure_payment_pending(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text, uuid[], text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_admin_local_wait_resolution(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_list_admin_payment_pending() TO authenticated;
