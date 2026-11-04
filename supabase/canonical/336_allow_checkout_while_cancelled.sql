-- 336_allow_checkout_while_cancelled.sql
--
-- Reversa parcial de 318: `cancelled` deja de contar como pedido abierto.
-- La clienta puede armar un pedido nuevo aunque el viejo siga en Cancelados
-- (stock apartado pendiente de Desarmar / ✓).
--
-- No se toca:
--   - rpc_customer_cancel_order (sigue borrando si no hay stock pendiente)
--   - bloqueo de `closed` (251)
--   - attach de checkout a active/closing_soon
--   - devolución de stock de apartados cancelados
--
-- Cambios:
--   1) Índice único: vuelve a active/closing_soon/closed (sin cancelled).
--   2) fn_customer_blocking_order_message: cancelled no bloquea.
--   3) rpc_checkout_cart(): saca el RAISE de cancelled.
--   4) rpc_create_admin_order_atomic: cancelled no es OPEN_ORDER_EXISTS.

-- ---------------------------------------------------------------------------
-- 1) Índice: cancelled ya no ocupa el slot de "un pedido por cliente"
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.orders_one_open_per_customer_idx;

CREATE UNIQUE INDEX orders_one_open_per_customer_idx
  ON public.orders (customer_id)
  WHERE (
    status IN ('active', 'closing_soon', 'closed')
    AND coalesce(local_deferred_pickup, false) = false
  );

COMMENT ON INDEX public.orders_one_open_per_customer_idx IS
  'Un pedido operativo por customer_id (active/closing_soon/closed). cancelled no bloquea. local_deferred_pickup excluido — canonical:336.';

-- ---------------------------------------------------------------------------
-- 2) Helper de mensaje: cancelled deja de bloquear
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_customer_blocking_order_message(p_customer_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT o.status
  INTO v_status
  FROM public.orders o
  WHERE o.customer_id = p_customer_id
    AND coalesce(o.local_deferred_pickup, false) = false
    AND o.status IN ('active', 'closing_soon', 'closed')
  ORDER BY
    CASE o.status
      WHEN 'active' THEN 0
      WHEN 'closing_soon' THEN 1
      WHEN 'closed' THEN 2
      ELSE 9
    END,
    o.created_at DESC
  LIMIT 1;

  IF v_status IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_status = 'closed' THEN
    RETURN 'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.fn_customer_blocking_order_message(uuid) IS
  'Mensaje de bloqueo checkout/admin si el cliente ya tiene pedido active/closing_soon/closed. cancelled no bloquea (336).';

REVOKE ALL ON FUNCTION public.fn_customer_blocking_order_message(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_customer_blocking_order_message(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) rpc_checkout_cart(): quitar solo el guard de cancelled (replace exacto)
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_new text;
  v_old text := $c$    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid()
        AND status = 'cancelled'
        AND coalesce(local_deferred_pickup, false) = false
    ) THEN
      RAISE EXCEPTION
        'Tenés un pedido cancelado pendiente de cierre en el local. Esperá a que se procese antes de armar uno nuevo.';
    END IF;
$c$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'rpc_checkout_cart'
    AND pg_get_function_identity_arguments(p.oid) = ''
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE '336: rpc_checkout_cart() no encontrada — omitir parche checkout';
    RETURN;
  END IF;

  v_def := replace(v_def, E'\r\n', E'\n');
  v_old := replace(v_old, E'\r\n', E'\n');

  IF position('Tenés un pedido cancelado pendiente de cierre en el local.' in v_def) = 0 THEN
    RAISE NOTICE '336: rpc_checkout_cart() ya no bloquea cancelled — omitir';
    RETURN;
  END IF;

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION
      '336: ancla exacta de cancelled no encontrada en rpc_checkout_cart()';
  END IF;

  v_new := replace(v_def, v_old, '');

  IF position('Tenés un pedido cancelado pendiente de cierre en el local.' in v_new) > 0 THEN
    RAISE EXCEPTION
      '336: quedó el mensaje cancelled en rpc_checkout_cart()';
  END IF;

  IF position('Ya tenés un pedido cerrado en preparación para el envío.' in v_new) = 0 THEN
    RAISE EXCEPTION
      '336: el parche de checkout eliminó el bloque closed — abortar';
  END IF;

  IF position('IF v_deferred THEN' in v_new) = 0 THEN
    RAISE EXCEPTION
      '336: el parche de checkout perdió el bloque deferred — abortar';
  END IF;

  EXECUTE v_new;
END;
$patch$;

-- ---------------------------------------------------------------------------
-- 4) rpc_create_admin_order_atomic: cancelled no es pedido abierto
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_old text := $o$  select o.id, o.status
    into v_open_order, v_open_order_status
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon', 'closed', 'cancelled')
    and coalesce(o.local_deferred_pickup, false) = false
  order by o.created_at desc
  limit 1;$o$;
  v_new text := $n$  select o.id, o.status
    into v_open_order, v_open_order_status
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon', 'closed')
    and coalesce(o.local_deferred_pickup, false) = false
  order by o.created_at desc
  limit 1;$n$;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'rpc_create_admin_order_atomic'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE '336: rpc_create_admin_order_atomic no encontrada — omitir';
    RETURN;
  END IF;

  v_def := replace(v_def, E'\r\n', E'\n');
  v_old := replace(v_old, E'\r\n', E'\n');
  v_new := replace(v_new, E'\r\n', E'\n');

  IF position(v_old in v_def) = 0 THEN
    IF position('''cancelled''' in v_def) = 0
       AND position('active'', ''closing_soon'', ''closed''' in v_def) > 0 THEN
      RAISE NOTICE '336: rpc_create_admin_order_atomic ya sin cancelled — omitir';
      RETURN;
    END IF;
    RAISE EXCEPTION
      '336: rpc_create_admin_order_atomic sin ancla — revisar manualmente';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$patch$;

SELECT pg_notify('pgrst', 'reload schema');
