-- 337_allow_checkout_after_local_fulfilled.sql
--
-- Un pedido `closed` cobrado en retiro (notes.local_pickup_fulfilled_at)
-- no debe bloquear un pedido nuevo. El dashboard ya lo trata como cumplido
-- (isLocalPickupOrderFulfilled); checkout e índice seguían viéndolo como
-- "cerrado en preparación para el envío".
--
-- closed de envío (sin fulfilled) sigue bloqueando (251).
-- cancelled sigue sin bloquear (336).

-- ---------------------------------------------------------------------------
-- 1) Índice: closed cumplido en local no ocupa el slot
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.orders_one_open_per_customer_idx;

CREATE UNIQUE INDEX orders_one_open_per_customer_idx
  ON public.orders (customer_id)
  WHERE (
    status IN ('active', 'closing_soon', 'closed')
    AND coalesce(local_deferred_pickup, false) = false
    AND NOT (
      status = 'closed'
      AND position('"local_pickup_fulfilled_at"' in coalesce(notes, '')) > 0
    )
  );

COMMENT ON INDEX public.orders_one_open_per_customer_idx IS
  'Un pedido operativo por customer_id (active/closing_soon/closed). cancelled y closed cumplido en retiro no bloquean. local_deferred_pickup excluido — canonical:337.';

-- ---------------------------------------------------------------------------
-- 2) Helper: closed cumplido no genera mensaje
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
    AND NOT (
      o.status = 'closed'
      AND position('"local_pickup_fulfilled_at"' in coalesce(o.notes, '')) > 0
    )
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
  'Bloqueo checkout/admin si hay active/closing_soon/closed pendiente. cancelled y closed cobrado en retiro no bloquean (337).';

REVOKE ALL ON FUNCTION public.fn_customer_blocking_order_message(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_customer_blocking_order_message(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) rpc_checkout_cart(): closed cumplido en local no bloquea
-- ---------------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_new text;
  v_old text := $c$    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid() AND status = 'closed'
    ) THEN
      RAISE EXCEPTION
        'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
    END IF;
$c$;
  v_rep text := $r$    IF EXISTS (
      SELECT 1 FROM public.orders
      WHERE customer_id = auth.uid()
        AND status = 'closed'
        AND coalesce(local_deferred_pickup, false) = false
        AND position('"local_pickup_fulfilled_at"' in coalesce(notes, '')) = 0
    ) THEN
      RAISE EXCEPTION
        'Ya tenés un pedido cerrado en preparación para el envío. Esperá a que se despache antes de armar uno nuevo.';
    END IF;
$r$;
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
    RAISE EXCEPTION '337: rpc_checkout_cart() no encontrada';
  END IF;

  v_def := replace(v_def, E'\r\n', E'\n');
  v_old := replace(v_old, E'\r\n', E'\n');
  v_rep := replace(v_rep, E'\r\n', E'\n');

  IF position('"local_pickup_fulfilled_at"' in v_def) > 0
     AND position('AND status = ''closed''' in v_def) > 0 THEN
    RAISE NOTICE '337: rpc_checkout_cart() ya excluye closed cumplido — omitir';
    RETURN;
  END IF;

  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION
      '337: ancla closed no encontrada en rpc_checkout_cart()';
  END IF;

  v_new := replace(v_def, v_old, v_rep);

  IF position('Ya tenés un pedido cerrado en preparación para el envío.' in v_new) = 0 THEN
    RAISE EXCEPTION '337: se perdió el mensaje closed — abortar';
  END IF;

  IF position('"local_pickup_fulfilled_at"' in v_new) = 0 THEN
    RAISE EXCEPTION '337: no quedó el filtro fulfilled — abortar';
  END IF;

  EXECUTE v_new;
END;
$patch$;

SELECT pg_notify('pgrst', 'reload schema');
