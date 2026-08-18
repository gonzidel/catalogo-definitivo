-- 270_rpc_customer_reopen_order_for_editing.sql
--
-- Bug: el botón "Editar pedido" del dashboard cliente (ActiveOrderTab.tsx,
-- handleReopenForEditing) reabre un pedido `closed` (o con flag
-- customer_requested_close) para que la clienta pueda sumar productos antes
-- de reenviarlo, dándole una ventana corta de 24hs en vez de los 7 días
-- completos de un pedido nuevo. Pero ese cálculo se hacía en el cliente con
-- `new Date(Date.now() + 24*60*60*1000).toISOString()` y un `.update()`
-- directo a la tabla `orders` -- el mismo patrón "now() + interval '24
-- hours'" literal que ya se había corregido en 258 para las prórrogas de
-- pedidos vencidos (rpc_customer_request_order_extension_24h /
-- rpc_admin_extend_order_24h), pero que quedó sin migrar acá.
--
-- Efecto real en producción (2026-08-03): pedido A55552, creado un lunes con
-- dismantle_at correcto (lunes siguiente 17:00 Arg, vía
-- fn_compute_order_deadline), mostraba "vence el 10/8" -- perfecto. Al usar
-- "Editar pedido" pasadas las 19hs, dismantle_at quedó pisado por un
-- timestamp con milisegundos (ej. 21:59:33.175 UTC), es decir "mañana a
-- cualquier hora" en vez de "próximo día hábil a las 17:00 Arg". El pedido
-- pasó de tener margen hasta el 10/8 a vencer al día siguiente.
--
-- Fix: nueva RPC `rpc_customer_reopen_order_for_editing`, que reutiliza
-- `fn_compute_order_deadline(now(), 1)` (ya usada por las prórrogas de 258)
-- para dar el próximo día hábil a las 17:00 Arg, en vez de un literal
-- +24hs. Unifica los dos casos que manejaba el código cliente (pedido
-- `closed` -> vuelve a `active`; pedido `active` con flag
-- `customer_requested_close` -> solo se limpia el flag) en un solo UPDATE,
-- ya que ambos terminan en el mismo estado (`active`, dismantle_at nuevo,
-- flag limpio).

CREATE OR REPLACE FUNCTION public.rpc_customer_reopen_order_for_editing(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_order record;
  v_notes_obj jsonb;
  v_was_requested_close boolean;
  v_new_dismantle timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, notes
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        v_notes_obj := '{}'::jsonb;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_notes_obj := '{}'::jsonb;
    END;
  END IF;

  v_was_requested_close := coalesce((v_notes_obj->>'customer_requested_close')::boolean, false);

  IF v_order.status <> 'closed' AND NOT v_was_requested_close THEN
    RAISE EXCEPTION 'Este pedido no está en preparación, no corresponde reabrirlo para editar';
  END IF;

  -- Mismo criterio que las prórrogas de 24h (257/258): próximo día hábil a
  -- las 17:00 hora Argentina, no un literal +24hs que puede vencer un fin
  -- de semana/feriado a cualquier hora.
  v_new_dismantle := public.fn_compute_order_deadline(now(), 1);
  v_notes_obj := v_notes_obj - 'customer_requested_close';

  UPDATE public.orders
  SET
    status = 'active',
    dismantle_at = v_new_dismantle,
    notes = v_notes_obj::text,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rpc_customer_reopen_order_for_editing(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
