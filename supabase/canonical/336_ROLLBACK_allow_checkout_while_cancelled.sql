-- 336_ROLLBACK_allow_checkout_while_cancelled.sql
-- Restaura el candado de 318: cancelled vuelve a bloquear pedido nuevo.
-- No aplicar salvo rollback explícito.

DROP INDEX IF EXISTS public.orders_one_open_per_customer_idx;

CREATE UNIQUE INDEX orders_one_open_per_customer_idx
  ON public.orders (customer_id)
  WHERE (
    status IN ('active', 'closing_soon', 'closed', 'cancelled')
    AND coalesce(local_deferred_pickup, false) = false
  );

COMMENT ON INDEX public.orders_one_open_per_customer_idx IS
  'Un pedido operativo por customer_id (incluye cancelled pendiente). local_deferred_pickup excluido — canonical:318.';

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
