-- 351_ROLLBACK_rpc_close_order_resolve_payment_by_transport.sql
-- Revierte el comment/canon de close a 320-era (sigue sin fingerprint 83 de stock).
-- NO restaura el hardcode 'Pendiente' a propósito: el rollback operativo es
-- redeploy de 320/348/349 si hace falta el comportamiento previo exacto.

DROP FUNCTION IF EXISTS public.fn_resolve_order_close_payment_method(uuid, text);

-- Restaurar rpc_close_order como en prod pre-351 (320 body + comment 83)
CREATE OR REPLACE FUNCTION public.rpc_close_order(
  p_order_id uuid,
  p_payment_method text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_customer_id uuid;
  v_is_admin boolean;
  v_status text;
  v_dismantle_at timestamptz;
  v_pending_count int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) INTO v_is_admin;

  SELECT customer_id, status, dismantle_at
  INTO v_customer_id, v_status, v_dismantle_at
  FROM public.orders
  WHERE id = p_order_id;

  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_status = 'expired' THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF v_dismantle_at IS NOT NULL AND now() >= v_dismantle_at THEN
    RAISE EXCEPTION 'Pedido vencido';
  END IF;

  IF NOT v_is_admin AND v_customer_id != auth.uid() THEN
    RAISE EXCEPTION 'No tienes permiso para cerrar este pedido';
  END IF;

  SELECT count(*)
  INTO v_pending_count
  FROM public.order_items
  WHERE order_id = p_order_id
    AND status IN ('reserved', 'waiting', 'awaiting_apartado');

  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'No se puede cerrar: hay % ítem(s) todavía reservado(s) o en espera', v_pending_count;
  END IF;

  UPDATE public.orders
  SET status = 'closed',
      payment_method = p_payment_method,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;

  PERFORM public.rpc_enqueue_customer_closed_notifications(p_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_close_order(uuid, text) IS
  'canonical:83 | source:supabase/canonical/83_rpc_close_order_no_stock_deduction.sql';

-- Re-aplicar 348 + 349 desde sus archivos canónicos si se necesita el path Pendiente.
