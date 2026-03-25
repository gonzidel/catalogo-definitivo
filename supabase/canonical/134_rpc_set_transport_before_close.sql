-- 134_rpc_set_transport_before_close.sql
-- Permite al cliente guardar transporte (customers + pedido) antes de cerrar, vía SECURITY DEFINER.
-- Los clientes no tienen política RLS de UPDATE sobre orders; el RPC actualiza ambas tablas.

DO $$
DECLARE
  n text;
  names text[] := ARRAY[
    'SEDE',
    'Retiro de Local',
    'Expreso Norte',
    'Credifin',
    'Transporte Snaider',
    'Via Cargo',
    'Correo Argentino'
  ];
BEGIN
  FOREACH n IN ARRAY names
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.transports WHERE lower(trim(name)) = lower(trim(n))
    ) THEN
      INSERT INTO public.transports (name) VALUES (n);
    END IF;
  END LOOP;
END $$;

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

  IF lower(coalesce(v_status, '')) <> 'active' THEN
    RAISE EXCEPTION 'Este pedido no se puede modificar.';
  END IF;

  SELECT id
  INTO v_tid
  FROM public.transports
  WHERE lower(trim(name)) = lower(trim(p_transport_name))
  LIMIT 1;

  IF v_tid IS NULL THEN
    RAISE EXCEPTION 'Transporte no disponible. Escribinos por WhatsApp.';
  END IF;

  UPDATE public.customers
  SET transport_id = v_tid,
      updated_at = now()
  WHERE id = v_uid;

  UPDATE public.orders
  SET transport_id = v_tid,
      updated_at = now()
  WHERE id = p_order_id
    AND customer_id = v_uid;

  RETURN json_build_object('ok', true, 'transport_id', v_tid);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_set_transport_before_close_order(uuid, text) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
