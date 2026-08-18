-- 261_rpc_close_order_reject_unresolved_items.sql
--
-- Refuerza rpc_close_order con una validación a nivel servidor: hoy la única
-- barrera contra cerrar un pedido con ítems reserved/waiting pendientes vive
-- en el código cliente de nj (ver docs/FYL-Obsidian/48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01.md,
-- Hallazgo crítico 3). Esta migración agrega defensa en profundidad: si algún
-- bug futuro de frontend (o una llamada directa a la RPC) intenta cerrar un
-- pedido con ítems todavía reservados o en espera, la RPC lo rechaza.
--
-- Los ítems "missing" (sin stock) SÍ pueden seguir cerrándose manualmente --
-- eso es una decisión consciente del admin (botón "Cerrar pedido"), no algo
-- que deba bloquearse acá.
--
-- NO APLICAR sin aprobación explícita del usuario (regla de producción FYL).

CREATE OR REPLACE FUNCTION public.rpc_close_order(p_order_id uuid, p_payment_method text DEFAULT NULL::text)
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

  -- Nuevo: no permitir cerrar con ítems todavía reservados o en espera.
  -- "missing" se deja pasar a propósito (decisión manual del admin).
  SELECT count(*)
  INTO v_pending_count
  FROM public.order_items
  WHERE order_id = p_order_id
    AND status IN ('reserved', 'waiting');

  IF v_pending_count > 0 THEN
    RAISE EXCEPTION 'No se puede cerrar: hay % ítem(s) todavía reservado(s) o en espera', v_pending_count;
  END IF;

  -- Solo actualizar estado; el stock ya se descontó en rpc_checkout_cart.
  -- closed_at = now() guarda el instante real (UTC); el filtro por día en BA se hace al consultar.
  UPDATE public.orders
  SET status = 'closed',
      payment_method = p_payment_method,
      closed_at = now(),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo cerrar el pedido.';
  END IF;
END;
$function$;
