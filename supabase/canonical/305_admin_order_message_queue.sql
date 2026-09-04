-- 305_admin_order_message_queue.sql
-- Cola compartida de snapshots (espera local) y notificaciones admin para WhatsApp.
-- Reemplaza localStorage del Kanban mobile — cualquier admin/dispositivo ve lo mismo.

-- =============================================================================
-- Tablas
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.admin_order_local_wait_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_name text NOT NULL DEFAULT '',
  customer_phone text,
  prior_confirmed_count integer NOT NULL DEFAULT 0,
  prior_missing_labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  waiting_local_item_ids uuid[] NOT NULL DEFAULT '{}',
  resolutions jsonb NOT NULL DEFAULT '{}'::jsonb,
  dashboard_url text NOT NULL DEFAULT '/nj/dashboard?tab=active-order',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_order_local_wait_snapshots_order_id_key UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_local_wait_snapshots_updated
  ON public.admin_order_local_wait_snapshots (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_order_message_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  customer_name text NOT NULL DEFAULT '',
  customer_phone text,
  message text NOT NULL,
  kind text NOT NULL DEFAULT 'local_wait_resolved',
  copied_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_order_msg_notif_pending
  ON public.admin_order_message_notifications (created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.admin_order_expiry_warn_sent (
  order_id uuid PRIMARY KEY REFERENCES public.orders(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- =============================================================================
-- Helper: mensaje cliente (paridad nj/lib/orders/customer-status-message.ts)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_build_customer_status_message(
  p_confirmed_count integer,
  p_missing_labels jsonb,
  p_dashboard_url text DEFAULT '/nj/dashboard?tab=active-order'
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
BEGIN
  SELECT coalesce(array_agg(x), '{}'::text[])
    INTO v_missing
    FROM jsonb_array_elements_text(coalesce(p_missing_labels, '[]'::jsonb)) AS t(x);

  v_missing_count := coalesce(array_length(v_missing, 1), 0);
  v_url := coalesce(nullif(trim(p_dashboard_url), ''), '/nj/dashboard?tab=active-order');
  v_confirmed := greatest(0, coalesce(p_confirmed_count, 0));

  IF v_missing_count = 0 THEN
    RETURN 'Hola 👋 Todos los productos de tu pedido ya están apartados y listos.' || E'\n\n'
      || 'Podés revisar tu pedido cuando quieras desde acá: ' || v_url || ' 😊';
  END IF;

  IF v_confirmed <= 0 THEN
    RETURN 'Hola 👋 No pudimos apartar los productos de tu pedido porque ya no quedan disponibles.' || E'\n\n'
      || 'Podés revisar cuáles son desde acá: ' || v_url || '.' || E'\n\n'
      || 'Cualquier consulta, podés escribirnos 😊';
  END IF;

  IF v_confirmed = 1 THEN
    v_count_label := '1 producto';
  ELSE
    v_count_label := v_confirmed::text || ' productos';
  END IF;

  RETURN 'Hola 👋 Ya apartamos ' || v_count_label || ' de tu pedido, pero algunos ya no están disponibles.' || E'\n\n'
    || 'Podés revisar cuáles quedaron apartados y cuáles faltaron desde acá: ' || v_url || '.' || E'\n\n'
    || 'Cualquier consulta, podés escribirnos 😊';
END;
$$;

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.admin_order_local_wait_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_order_message_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_order_expiry_warn_sent ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_order_local_wait_snapshots'
      AND policyname = 'admin_local_wait_snapshots_admin_all'
  ) THEN
    CREATE POLICY admin_local_wait_snapshots_admin_all
      ON public.admin_order_local_wait_snapshots
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_order_message_notifications'
      AND policyname = 'admin_order_msg_notif_admin_all'
  ) THEN
    CREATE POLICY admin_order_msg_notif_admin_all
      ON public.admin_order_message_notifications
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'admin_order_expiry_warn_sent'
      AND policyname = 'admin_expiry_warn_sent_admin_all'
  ) THEN
    CREATE POLICY admin_expiry_warn_sent_admin_all
      ON public.admin_order_expiry_warn_sent
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;
END $$;

-- Realtime para campana
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND tablename = 'admin_order_message_notifications'
      AND schemaname = 'public'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.admin_order_message_notifications;
  END IF;
END $$;

-- =============================================================================
-- RPC: upsert snapshot al confirmar con espera local
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_upsert_admin_local_wait_snapshot(
  p_order_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_prior_confirmed_count integer,
  p_prior_missing_labels jsonb,
  p_waiting_local_item_ids uuid[],
  p_dashboard_url text DEFAULT '/nj/dashboard?tab=active-order'
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

  IF coalesce(array_length(p_waiting_local_item_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'waiting_local_item_ids vacío';
  END IF;

  INSERT INTO public.admin_order_local_wait_snapshots (
    order_id, customer_name, customer_phone,
    prior_confirmed_count, prior_missing_labels,
    waiting_local_item_ids, resolutions, dashboard_url, updated_at
  )
  VALUES (
    p_order_id,
    coalesce(nullif(trim(p_customer_name), ''), 'Cliente'),
    nullif(trim(p_customer_phone), ''),
    greatest(0, coalesce(p_prior_confirmed_count, 0)),
    coalesce(p_prior_missing_labels, '[]'::jsonb),
    p_waiting_local_item_ids,
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
    resolutions = '{}'::jsonb,
    dashboard_url = EXCLUDED.dashboard_url,
    updated_at = now();

  RETURN json_build_object('ok', true, 'order_id', p_order_id);
END;
$$;

-- =============================================================================
-- RPC: actualizar prior sin espera local (clienta agregó productos y se apartaron)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_update_admin_local_wait_snapshot_prior(
  p_order_id uuid,
  p_prior_confirmed_count integer,
  p_prior_missing_labels jsonb
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  UPDATE public.admin_order_local_wait_snapshots
     SET prior_confirmed_count = greatest(0, coalesce(p_prior_confirmed_count, 0)),
         prior_missing_labels = coalesce(p_prior_missing_labels, '[]'::jsonb),
         updated_at = now()
   WHERE order_id = p_order_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN json_build_object('ok', true, 'updated', v_updated > 0);
END;
$$;

-- =============================================================================
-- RPC: registrar resolución local → notificación si completó todos
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

  IF NOT (p_item_id = ANY (v_snap.waiting_local_item_ids)) THEN
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
    FROM unnest(v_snap.waiting_local_item_ids) AS w;

  IF NOT coalesce(v_all_done, false) THEN
    RETURN json_build_object('ok', true, 'notification_created', false, 'reason', 'pending');
  END IF;

  v_confirmed := v_snap.prior_confirmed_count;
  v_missing := coalesce(v_snap.prior_missing_labels, '[]'::jsonb);

  FOR v_waiting IN SELECT unnest(v_snap.waiting_local_item_ids) LOOP
    v_lbl := coalesce(v_resolutions->v_waiting::text->>'label', 'Producto');
    IF coalesce(v_resolutions->v_waiting::text->>'outcome', '') = 'picked' THEN
      v_confirmed := v_confirmed + 1;
    ELSIF coalesce(v_resolutions->v_waiting::text->>'outcome', '') = 'missing' THEN
      v_missing_arr := v_missing_arr || to_jsonb(v_lbl);
    END IF;
  END LOOP;

  v_missing := v_missing || v_missing_arr;

  v_msg := public.fn_build_customer_status_message(
    v_confirmed,
    v_missing,
    v_snap.dashboard_url
  );

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
-- RPC: listar notificaciones pendientes
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_list_admin_order_message_notifications()
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
      SELECT id, order_id, customer_name, customer_phone, message, kind,
             copied_at, dismissed_at, created_at
        FROM public.admin_order_message_notifications
       WHERE dismissed_at IS NULL
       ORDER BY created_at DESC
       LIMIT 50
    ) t;

  RETURN json_build_object('ok', true, 'notifications', v_rows);
END;
$$;

-- =============================================================================
-- RPC: marcar copiado / dismiss
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_mark_admin_order_message_copied(p_notification_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  UPDATE public.admin_order_message_notifications
     SET copied_at = coalesce(copied_at, now())
   WHERE id = p_notification_id AND dismissed_at IS NULL;

  RETURN json_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_dismiss_admin_order_message(p_notification_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  UPDATE public.admin_order_message_notifications
     SET dismissed_at = now()
   WHERE id = p_notification_id;

  RETURN json_build_object('ok', true);
END;
$$;

-- =============================================================================
-- RPC: aviso vencimiento enviado (cross-device)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_mark_admin_expiry_warn_sent(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  INSERT INTO public.admin_order_expiry_warn_sent (order_id, sent_at, sent_by)
  VALUES (p_order_id, now(), auth.uid())
  ON CONFLICT (order_id) DO UPDATE SET sent_at = now(), sent_by = auth.uid();

  RETURN json_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_list_admin_expiry_warn_sent()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_ids json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT coalesce(json_agg(order_id), '[]'::json)
    INTO v_ids
    FROM public.admin_order_expiry_warn_sent;

  RETURN json_build_object('ok', true, 'order_ids', v_ids);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_upsert_admin_local_wait_snapshot(uuid, text, text, integer, jsonb, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_admin_local_wait_snapshot_prior(uuid, integer, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_admin_local_wait_resolution(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_list_admin_order_message_notifications() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mark_admin_order_message_copied(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_dismiss_admin_order_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mark_admin_expiry_warn_sent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_list_admin_expiry_warn_sent() TO authenticated;
