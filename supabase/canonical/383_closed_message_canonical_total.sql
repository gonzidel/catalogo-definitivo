-- 383: el aviso de cierre usa el mismo total que la tarjeta.
--
-- fn_compute_closed_order_products_total sumaba price_snapshot y los extras de
-- notes, pero no restaba la promo 2x1/2xMonto. Esa promo ya vive en
-- fn_order_canonical_total (377): pares cargados mientras la promo estaba
-- vigente, sobrante a precio de línea, oferta solo si ya bajó price_snapshot.
--
-- Los avisos ya guardados no se reescriben acá. La campana los corrige al copiar
-- (rpc_closed_order_products_total). Los que se encolen después nacen bien,
-- porque el alta sigue llamando a fn_compute_closed_order_products_total.
--
-- Rollback: 383_ROLLBACK_closed_message_canonical_total.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_compute_closed_order_products_total(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  -- Fuera del total: 'cancelled', 'expired' y 'missing' (fn_order_canonical_total).
  RETURN public.fn_order_canonical_total(
    p_order_id,
    (SELECT o.notes FROM public.orders o WHERE o.id = p_order_id)
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_compute_closed_order_products_total(uuid) IS
  'canonical:383 — total del aviso de cierre = total de la tarjeta (promo 2x + extras de notes; oferta solo si ya está en price_snapshot).';

CREATE OR REPLACE FUNCTION public.rpc_closed_order_products_total(p_order_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;
  IF p_order_id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN public.fn_compute_closed_order_products_total(p_order_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_closed_order_products_total(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_closed_order_products_total(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_closed_order_products_total(uuid) TO authenticated;

COMMENT ON FUNCTION public.rpc_closed_order_products_total(uuid) IS
  'canonical:383 — total vigente para reescribir el aviso de cierre al copiarlo. Solo admins.';

COMMIT;
