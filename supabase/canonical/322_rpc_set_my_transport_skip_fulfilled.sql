-- 322_rpc_set_my_transport_skip_fulfilled.sql
-- Al cambiar transporte en perfil, no pisar pedidos closed ya cumplidos
-- (ticket impreso / local_pickup_fulfilled_at). Evita que Mi pedido vuelva
-- a mostrar "en preparación" tras un cambio de localidad/transporte.

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

GRANT EXECUTE ON FUNCTION public.rpc_set_my_transport(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_customer_transport(uuid, uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
