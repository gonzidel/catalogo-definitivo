-- 303_rpc_customer_transport_link.sql
-- Vincula transporte cliente (NJ/dashboard) <-> admin (closed-orders).
-- Fuente de verdad: customers.transport_id (+ orders.transport_id en pedidos abiertos/cerrados).
-- Match de nombres canónico (Retira local / Retiro de Local, Snaider / Transporte Snaider, etc.).

CREATE OR REPLACE FUNCTION public.normalize_transport_name(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT regexp_replace(
    lower(
      trim(
        translate(
          coalesce(p_value, ''),
          'áàäâãéèëêíìïîóòöôõúùüûñ',
          'aaaaaeeeeiiiiooooouuuun'
        )
      )
    ),
    '\s+',
    ' ',
    'g'
  );
$$;

-- Resuelve un nombre (o alias) de transporte al UUID preferido en public.transports.
CREATE OR REPLACE FUNCTION public.resolve_transport_id(p_transport_name text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_key text := public.normalize_transport_name(p_transport_name);
  v_aliases text[];
  v_tid uuid;
BEGIN
  IF v_key IS NULL OR v_key = '' THEN
    RETURN NULL;
  END IF;

  -- Alias → grupo canónico (alineado con scripts/transport-canonical.js)
  IF v_key IN (
    'retira local',
    'retiro de local',
    'retiro del local',
    'retiro local'
  ) THEN
    v_aliases := ARRAY[
      'retira local',
      'retiro de local',
      'retiro del local',
      'retiro local'
    ];
  ELSIF v_key IN ('snaider', 'transporte snaider') THEN
    v_aliases := ARRAY['snaider', 'transporte snaider'];
  ELSIF v_key IN ('via cargo', 'viacargo') THEN
    v_aliases := ARRAY['via cargo', 'viacargo'];
  ELSIF v_key IN ('correo argentino', 'correo') THEN
    v_aliases := ARRAY['correo argentino', 'correo'];
  ELSIF v_key IN ('mym', 'my m') THEN
    v_aliases := ARRAY['mym', 'my m'];
  ELSE
    v_aliases := ARRAY[v_key];
  END IF;

  SELECT t.id
  INTO v_tid
  FROM public.transports t
  WHERE public.normalize_transport_name(t.name) = ANY (v_aliases)
  ORDER BY
    CASE public.normalize_transport_name(t.name)
      WHEN 'retira local' THEN 0
      WHEN 'retiro de local' THEN 1
      WHEN 'snaider' THEN 0
      WHEN 'transporte snaider' THEN 1
      ELSE 2
    END,
    t.created_at ASC NULLS LAST
  LIMIT 1;

  RETURN v_tid;
END;
$$;

-- Cliente: guarda su transporte preferido (perfil / cambio sin cerrar pedido).
CREATE OR REPLACE FUNCTION public.rpc_set_my_transport(p_transport_name text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tid uuid;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Tenés que iniciar sesión.';
  END IF;

  IF p_transport_name IS NULL OR trim(p_transport_name) = '' THEN
    RAISE EXCEPTION 'Elegí un transporte.';
  END IF;

  v_tid := public.resolve_transport_id(p_transport_name);
  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'Transporte no disponible. Escribinos por WhatsApp.';
  END IF;

  SELECT name INTO v_name FROM public.transports WHERE id = v_tid;

  UPDATE public.customers
  SET transport_id = v_tid,
      updated_at = now()
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente no encontrado.';
  END IF;

  -- Pedidos operativos alineados (closed-orders / kanban / COD).
  -- No tocar pedidos ya cumplidos (ticket / retiro cobrado): un cambio de
  -- perfil no debe reabrir ni reclasificar un cerrado con ticket.
  UPDATE public.orders
  SET transport_id = v_tid,
      updated_at = now()
  WHERE customer_id = v_uid
    AND lower(coalesce(status, '')) IN ('active', 'closing_soon', 'closed')
    AND coalesce(labels_printed, false) = false
    AND (
      notes IS NULL
      OR position('"local_pickup_fulfilled_at"' in notes) = 0
    );

  RETURN json_build_object(
    'ok', true,
    'transport_id', v_tid,
    'transport_name', v_name
  );
END;
$$;

-- Antes de cerrar: customers + ese pedido (mejora match canónico + closing_soon).
CREATE OR REPLACE FUNCTION public.rpc_set_transport_before_close_order(
  p_order_id uuid,
  p_transport_name text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_tid uuid;
  v_customer_id uuid;
  v_status text;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Tenés que iniciar sesión.';
  END IF;

  IF p_transport_name IS NULL OR trim(p_transport_name) = '' THEN
    RAISE EXCEPTION 'Elegí un transporte.';
  END IF;

  SELECT customer_id, status
  INTO v_customer_id, v_status
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado.';
  END IF;

  IF v_customer_id <> v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para este pedido.';
  END IF;

  IF lower(coalesce(v_status, '')) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'Este pedido no se puede modificar.';
  END IF;

  v_tid := public.resolve_transport_id(p_transport_name);
  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'Transporte no disponible. Escribinos por WhatsApp.';
  END IF;

  SELECT name INTO v_name FROM public.transports WHERE id = v_tid;

  UPDATE public.customers
  SET transport_id = v_tid,
      updated_at = now()
  WHERE id = v_uid;

  UPDATE public.orders
  SET transport_id = v_tid,
      updated_at = now()
  WHERE id = p_order_id
    AND customer_id = v_uid;

  RETURN json_build_object(
    'ok', true,
    'transport_id', v_tid,
    'transport_name', v_name
  );
END;
$$;

-- Admin: al asignar transporte al cliente, sincronizar pedidos operativos.
CREATE OR REPLACE FUNCTION public.rpc_update_customer_transport(
  p_customer_id uuid,
  p_transport_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_updated_customer record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden actualizar el transporte de clientes';
  END IF;

  IF p_transport_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.transports WHERE id = p_transport_id
  ) THEN
    RAISE EXCEPTION 'Transporte no encontrado';
  END IF;

  UPDATE public.customers
  SET transport_id = p_transport_id,
      updated_at = now()
  WHERE id = p_customer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente no encontrado';
  END IF;

  UPDATE public.orders
  SET transport_id = p_transport_id,
      updated_at = now()
  WHERE customer_id = p_customer_id
    AND lower(coalesce(status, '')) IN ('active', 'closing_soon', 'closed')
    AND coalesce(labels_printed, false) = false
    AND (
      notes IS NULL
      OR position('"local_pickup_fulfilled_at"' in notes) = 0
    );

  SELECT id, transport_id, full_name
  INTO v_updated_customer
  FROM public.customers
  WHERE id = p_customer_id;

  RETURN json_build_object(
    'id', v_updated_customer.id,
    'transport_id', v_updated_customer.transport_id,
    'full_name', v_updated_customer.full_name
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_transport_id(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_my_transport(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_transport_before_close_order(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_customer_transport(uuid, uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
