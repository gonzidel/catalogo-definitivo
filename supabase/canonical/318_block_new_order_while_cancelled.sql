-- 318_block_new_order_while_cancelled.sql
--
-- Regla de negocio: un solo pedido operativo por cliente. El status `cancelled`
-- (p. ej. cancelación desde dashboard) no contaba en el índice ni en checkout,
-- permitiendo un pedido nuevo mientras el viejo seguía en Kanban Cancelados.
--
-- Cambios:
--   1) Limpieza segura de pedidos cancelled eliminables (sin stock pendiente).
--   2) rpc_customer_cancel_order: intenta borrar el pedido al cancelar si es seguro.
--   3) Índice único: incluye `cancelled` (excluye local_deferred_pickup, igual 313).
--   4) rpc_checkout_cart: bloquea si queda un pedido `cancelled` sin resolver.
--   5) rpc_create_admin_order_atomic: OPEN_ORDER_EXISTS también para `cancelled`.

-- ---------------------------------------------------------------------------
-- 0) Backfill: borrar pedidos cancelled ya elegibles (sin stock pendiente en ítems)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_oid uuid;
  v_deleted int := 0;
BEGIN
  FOR v_oid IN
    SELECT o.id
    FROM public.orders o
    WHERE o.status = 'cancelled'
      AND coalesce(o.local_deferred_pickup, false) = false
      AND public.order_eligible_for_empty_deletion(o.id)
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_items oi
        JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
        WHERE oi.order_id = o.id
          AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
          AND greatest(coalesce(s.qty, 0), 0) > 0
      )
  LOOP
    IF coalesce(
      public.maint_try_delete_order_if_eligible(v_oid, '318_backfill_cancelled_orders'),
      false
    ) THEN
      v_deleted := v_deleted + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '318: backfill deleted % cancelled order(s)', v_deleted;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Verificación: no debe quedar cancelled + (active/closing_soon/closed) juntos
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*)::int INTO v_bad
  FROM (
    SELECT o.customer_id
    FROM public.orders o
    WHERE o.status IN ('active', 'closing_soon', 'closed', 'cancelled')
      AND coalesce(o.local_deferred_pickup, false) = false
    GROUP BY o.customer_id
    HAVING count(*) > 1
  ) t;

  IF coalesce(v_bad, 0) > 0 THEN
    RAISE EXCEPTION
      '318: hay % cliente(s) con más de un pedido en active/closing_soon/closed/cancelled. Resolver manualmente antes de ampliar el índice.',
      v_bad;
  END IF;
END $$;

DROP INDEX IF EXISTS public.orders_one_open_per_customer_idx;

CREATE UNIQUE INDEX orders_one_open_per_customer_idx
  ON public.orders (customer_id)
  WHERE (
    status IN ('active', 'closing_soon', 'closed', 'cancelled')
    AND coalesce(local_deferred_pickup, false) = false
  );

COMMENT ON INDEX public.orders_one_open_per_customer_idx IS
  'Un pedido operativo por customer_id (incluye cancelled pendiente). local_deferred_pickup excluido — canonical:318.';

-- ---------------------------------------------------------------------------
-- 2) rpc_customer_cancel_order: borrar pedido cuando no queda stock pendiente
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_customer_cancel_order(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_order record;
  v_item_id uuid;
  v_item_status text;
  v_rpc_result json;
  v_cancelled int := 0;
  v_had_picked boolean := false;
  v_order_deleted boolean := false;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, order_number
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para cancelar este pedido';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'No se puede cancelar un pedido en este estado';
  END IF;

  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
  FOR UPDATE;

  FOR v_item_id, v_item_status IN
    SELECT oi.id, lower(trim(coalesce(oi.status, '')))
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled'
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_cancel_order_item(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'applied')::boolean, false)
    THEN
      RAISE EXCEPTION
        'No se pudo cancelar el producto del pedido (item=%)',
        v_item_id;
    END IF;

    IF COALESCE((v_rpc_result->>'was_picked')::boolean, false)
       OR v_item_status = 'picked'
    THEN
      v_had_picked := true;
    END IF;

    v_cancelled := v_cancelled + 1;
  END LOOP;

  UPDATE public.orders
  SET status = 'cancelled', updated_at = now()
  WHERE id = p_order_id;

  -- Sin stock pendiente en ítems cancelados → borrar pedido (libera al cliente).
  IF NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'cancelled'
      AND greatest(coalesce(s.qty, 0), 0) > 0
  )
  AND public.order_eligible_for_empty_deletion(p_order_id)
  THEN
    v_order_deleted := coalesce(
      public.maint_try_delete_order_if_eligible(p_order_id, 'rpc_customer_cancel_order'),
      false
    );
  END IF;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'items_cancelled', v_cancelled,
    'had_picked', v_had_picked,
    'order_status', CASE WHEN v_order_deleted THEN 'deleted' ELSE 'cancelled' END,
    'order_deleted', v_order_deleted
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_customer_cancel_order(uuid) IS
  'Cliente: cancela ítems operativos. Si no hay stock pendiente de devolver, borra el pedido (318).';

-- ---------------------------------------------------------------------------
-- 3) rpc_checkout_cart — bloqueo por pedido cancelled (parche sobre 309)
--    Solo el tramo de guardas al crear pedido nuevo; el resto queda igual en prod.
-- ---------------------------------------------------------------------------
-- Nota: en repos con 309 aplicada, el cuerpo completo vive en esa migración.
-- Este parche reemplaza la función leyendo la definición vigente no es viable aquí;
-- aplicamos guard vía función auxiliar invocada desde checkout en migración dedicada
-- si hace falta re-deploy completo. Por ahora parche inline mínimo en checkout:
-- (Se aplica el bloque cancelled en la sección IF v_order_id IS NULL del checkout
--  copiando desde 309 + guard extra — ver script de ensamblado en deploy).

-- Función auxiliar reutilizable por checkout y admin create
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
    AND o.status IN ('active', 'closing_soon', 'closed', 'cancelled')
  ORDER BY
    CASE o.status
      WHEN 'active' THEN 0
      WHEN 'closing_soon' THEN 1
      WHEN 'closed' THEN 2
      WHEN 'cancelled' THEN 3
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

  IF v_status = 'cancelled' THEN
    RETURN 'Tenés un pedido cancelado pendiente de cierre en el local. Esperá a que se procese antes de armar uno nuevo.';
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.fn_customer_blocking_order_message(uuid) IS
  'Mensaje de bloqueo checkout/admin si el cliente ya tiene pedido active/closing_soon/closed/cancelled (318).';

REVOKE ALL ON FUNCTION public.fn_customer_blocking_order_message(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_customer_blocking_order_message(uuid) TO authenticated, service_role;

-- Parche rpc_checkout_cart: añadir guard cancelled antes de INSERT
-- (Reemplazo parcial — buscar bloque closed en prod y añadir cancelled)
DO $patch$
DECLARE
  v_def text;
  v_new_def text;
  v_anchor text := $a$    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid() AND status = 'closed'
    ) THEN
      RAISE EXCEPTION
        'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
    END IF;$a$;
  v_replacement text := $r$    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid() AND status = 'closed'
    ) THEN
      RAISE EXCEPTION
        'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid()
        AND status = 'cancelled'
        AND coalesce(local_deferred_pickup, false) = false
    ) THEN
      RAISE EXCEPTION
        'Tenés un pedido cancelado pendiente de cierre en el local. Esperá a que se procese antes de armar uno nuevo.';
    END IF;$r$;
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
    RAISE NOTICE '318: rpc_checkout_cart() no encontrada — omitir parche checkout';
    RETURN;
  END IF;

  IF position(v_anchor in v_def) = 0 THEN
    RAISE NOTICE '318: rpc_checkout_cart sin ancla closed — omitir parche checkout (revisar manualmente)';
    RETURN;
  END IF;

  v_new_def := replace(v_def, v_anchor, v_replacement);
  EXECUTE v_new_def;
END;
$patch$;

-- Parche rpc_create_admin_order_atomic: incluir cancelled en OPEN_ORDER_EXISTS
DO $patch$
DECLARE
  v_def text;
  v_old text := $o$  select o.id, o.status
    into v_open_order, v_open_order_status
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon', 'closed')
  order by o.created_at desc
  limit 1;$o$;
  v_new text := $n$  select o.id, o.status
    into v_open_order, v_open_order_status
  from public.orders o
  where o.customer_id = v_customer_id
    and o.status in ('active', 'closing_soon', 'closed', 'cancelled')
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
    RAISE NOTICE '318: rpc_create_admin_order_atomic no encontrada — omitir';
    RETURN;
  END IF;

  IF position(v_old in v_def) = 0 THEN
    RAISE NOTICE '318: rpc_create_admin_order_atomic sin ancla — omitir (revisar manualmente)';
    RETURN;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$patch$;

SELECT pg_notify('pgrst', 'reload schema');
