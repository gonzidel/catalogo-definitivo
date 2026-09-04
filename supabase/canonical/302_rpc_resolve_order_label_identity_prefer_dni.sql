-- 302_rpc_resolve_order_label_identity_prefer_dni.sql
-- Rótulos: si hay al menos un nombre (titular o sub) con DNI, la rotación
-- automática solo elige entre esos. Si ninguno tiene DNI, se mantiene el
-- comportamiento anterior (rotar en el pool completo).
-- Si el pedido ya tenía un nombre fijado sin DNI y existe otro con DNI,
-- se vuelve a resolver para no imprimir sin documento.

CREATE OR REPLACE FUNCTION public.rpc_resolve_order_label_identity(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_admin_check boolean;
  v_order record;
  v_customer record;
  v_pool jsonb := '[]'::jsonb;
  v_pool_full jsonb := '[]'::jsonb;
  v_pool_len int;
  v_idx int;
  v_entry jsonb;
  v_name text;
  v_dni text;
  v_additional jsonb;
  v_item jsonb;
  v_sub_name text;
  i int;
  v_max_sub int;
  v_has_any_dni boolean := false;
  v_reuse_name text;
  v_reuse_dni text;
BEGIN
  SELECT EXISTS(SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_admin_check;
  IF NOT v_admin_check THEN
    RETURN json_build_object('success', false, 'message', 'No autorizado');
  END IF;

  SELECT o.id, o.customer_id, o.label_customer_name, o.label_customer_dni
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Pedido no encontrado');
  END IF;

  SELECT
    c.full_name,
    c.dni,
    COALESCE(c.additional_names, '[]'::jsonb) AS additional_names,
    COALESCE(c.label_name_cursor, 0) AS label_name_cursor
  INTO v_customer
  FROM public.customers c
  WHERE c.id = v_order.customer_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'message', 'Cliente no encontrado');
  END IF;

  -- Pool completo: titular + hasta 3 sub-nombres
  v_pool_full := jsonb_build_array(
    jsonb_build_object(
      'full_name', COALESCE(NULLIF(btrim(v_customer.full_name), ''), 'Sin nombre'),
      'dni', NULLIF(btrim(v_customer.dni), '')
    )
  );

  v_additional := COALESCE(v_customer.additional_names, '[]'::jsonb);
  IF jsonb_typeof(v_additional) = 'array' THEN
    v_max_sub := LEAST(jsonb_array_length(v_additional), 3);
    FOR i IN 0..v_max_sub - 1 LOOP
      v_item := v_additional -> i;
      v_sub_name := COALESCE(
        NULLIF(btrim(v_item ->> 'full_name'), ''),
        NULLIF(btrim(concat_ws(' ', v_item ->> 'first_name', v_item ->> 'last_name')), ''),
        NULLIF(btrim(v_item ->> 'name'), '')
      );
      IF v_sub_name IS NOT NULL THEN
        v_pool_full := v_pool_full || jsonb_build_array(
          jsonb_build_object(
            'full_name', v_sub_name,
            'dni', NULLIF(btrim(v_item ->> 'dni'), '')
          )
        );
      END IF;
    END LOOP;
  END IF;

  -- ¿Hay algún nombre con DNI?
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_pool_full) AS e(elem)
    WHERE NULLIF(btrim(e.elem ->> 'dni'), '') IS NOT NULL
  ) INTO v_has_any_dni;

  -- Reuso: solo si ya hay nombre fijado Y (tiene DNI o nadie en el pool tiene DNI)
  v_reuse_name := NULLIF(btrim(v_order.label_customer_name), '');
  v_reuse_dni := NULLIF(btrim(COALESCE(v_order.label_customer_dni, '')), '');
  IF v_reuse_name IS NOT NULL AND (v_reuse_dni IS NOT NULL OR NOT v_has_any_dni) THEN
    RETURN json_build_object(
      'success', true,
      'customer_name', v_reuse_name,
      'customer_dni', COALESCE(v_order.label_customer_dni, ''),
      'reused', true
    );
  END IF;

  -- Rotación: si hay DNI en el pool, solo entre esos; si no, pool completo
  IF v_has_any_dni THEN
    SELECT COALESCE(jsonb_agg(e.elem), '[]'::jsonb)
    INTO v_pool
    FROM jsonb_array_elements(v_pool_full) AS e(elem)
    WHERE NULLIF(btrim(e.elem ->> 'dni'), '') IS NOT NULL;
  ELSE
    v_pool := v_pool_full;
  END IF;

  v_pool_len := jsonb_array_length(v_pool);
  IF v_pool_len < 1 THEN
    v_pool := v_pool_full;
    v_pool_len := jsonb_array_length(v_pool);
  END IF;

  v_idx := CASE
    WHEN v_pool_len <= 1 THEN 0
    ELSE COALESCE(v_customer.label_name_cursor, 0) % v_pool_len
  END;

  v_entry := v_pool -> v_idx;
  v_name := v_entry ->> 'full_name';
  v_dni := v_entry ->> 'dni';

  IF v_pool_len > 1 THEN
    UPDATE public.customers
    SET
      label_name_cursor = (v_idx + 1) % v_pool_len,
      updated_at = now()
    WHERE id = v_order.customer_id;
  END IF;

  UPDATE public.orders
  SET
    label_customer_name = v_name,
    label_customer_dni = v_dni,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'success', true,
    'customer_name', v_name,
    'customer_dni', COALESCE(v_dni, ''),
    'reused', false,
    'pool_size', v_pool_len,
    'dni_preferred', v_has_any_dni
  );

EXCEPTION WHEN OTHERS THEN
  RETURN json_build_object('success', false, 'message', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_resolve_order_label_identity(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
