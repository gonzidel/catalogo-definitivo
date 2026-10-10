-- 380_arq05_fase1_admin_pricing_rpcs.sql
--
-- ARQ-05 Fase 1, paso 1 (aditivo): acceso a costos de productos solo por RPC
-- y solo para super_admin. No cambia permisos existentes; puede aplicarse antes
-- del deploy del código que la usa.
-- NO aplicada. Requiere autorización explícita.
--
-- Decisión 2026-10-09 (NEGOCIO CONFIRMADO): costos solo super_admin; no existe
-- una clave de permiso de costos.
--
-- Columnas sensibles de public.products: cost, cost_is_estimated,
-- price_percentage, logistic_amount.
--
-- La 381 (después del deploy) quita a authenticated el acceso directo a esas
-- columnas; desde entonces estas RPC son la única vía para leerlas o escribirlas
-- con sesión de usuario.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.rpc_admin_get_product_pricing(p_product_ids uuid[])
RETURNS TABLE (
  product_id uuid,
  cost numeric,
  cost_is_estimated boolean,
  price_percentage numeric,
  logistic_amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Solo super_admin puede ver costos'
      USING ERRCODE = '42501';
  END IF;

  IF p_product_ids IS NULL OR cardinality(p_product_ids) = 0 THEN
    RETURN;
  END IF;

  IF cardinality(p_product_ids) > 1000 THEN
    RAISE EXCEPTION 'Máximo 1000 productos por consulta'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT p.id, p.cost, p.cost_is_estimated, p.price_percentage, p.logistic_amount
  FROM public.products p
  WHERE p.id = ANY (p_product_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_admin_set_product_pricing(
  p_product_id uuid,
  p_cost numeric,
  p_cost_is_estimated boolean,
  p_price_percentage numeric,
  p_logistic_amount numeric
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Solo super_admin puede modificar costos'
      USING ERRCODE = '42501';
  END IF;

  IF p_product_id IS NULL THEN
    RAISE EXCEPTION 'Falta el producto'
      USING ERRCODE = '22004';
  END IF;

  UPDATE public.products
  SET cost = p_cost,
      cost_is_estimated = COALESCE(p_cost_is_estimated, false),
      price_percentage = p_price_percentage,
      logistic_amount = p_logistic_amount
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Producto inexistente'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_admin_get_product_pricing(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_admin_set_product_pricing(uuid, numeric, boolean, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_admin_get_product_pricing(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_admin_set_product_pricing(uuid, numeric, boolean, numeric, numeric) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
