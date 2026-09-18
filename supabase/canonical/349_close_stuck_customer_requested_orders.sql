-- 349_close_stuck_customer_requested_orders.sql
--
-- Red de seguridad post A56955 / A56950: pedidos con
-- notes.customer_requested_close=true, status active/closing_soon, sin ítems
-- reserved/waiting/awaiting_apartado, transporte ≠ retiro local, y al menos
-- un picked — quedaron en Apartados / "En preparación" sin cerrar de verdad.
--
-- 348 evita el caso nuevo al pedir cierre. Este sweep cierra los residuales
-- (flag seteado antes de 348, fallos de rpc_close_order, etc.).
-- Pensado para cron cada 15 min junto a rpc_orders_daily_maintenance.

CREATE OR REPLACE FUNCTION public.rpc_close_stuck_customer_requested_orders()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  r record;
  v_closed int := 0;
  v_skipped_local int := 0;
  v_errors int := 0;
BEGIN
  FOR r IN
    SELECT o.id, o.order_number, coalesce(t.name, '') AS transport_name
    FROM public.orders o
    LEFT JOIN public.transports t ON t.id = o.transport_id
    WHERE o.status IN ('active', 'closing_soon')
      AND coalesce((o.notes::jsonb ->> 'customer_requested_close')::boolean, false) = true
      AND NOT EXISTS (
        SELECT 1
        FROM public.order_items oi
        WHERE oi.order_id = o.id
          AND oi.status IN ('reserved', 'waiting', 'awaiting_apartado')
      )
      AND EXISTS (
        SELECT 1
        FROM public.order_items oi
        WHERE oi.order_id = o.id
          AND oi.status = 'picked'
      )
  LOOP
    IF lower(trim(r.transport_name)) IN ('retira local', 'retiro de local') THEN
      v_skipped_local := v_skipped_local + 1;
      CONTINUE;
    END IF;

    BEGIN
      UPDATE public.orders
      SET
        status = 'closed',
        payment_method = coalesce(nullif(trim(payment_method), ''), 'Pendiente'),
        closed_at = coalesce(closed_at, now()),
        updated_at = now()
      WHERE id = r.id
        AND status IN ('active', 'closing_soon');

      IF FOUND THEN
        BEGIN
          PERFORM public.rpc_enqueue_customer_closed_notifications(r.id);
        EXCEPTION
          WHEN OTHERS THEN
            RAISE NOTICE 'rpc_close_stuck: notify failed for %: %', r.order_number, SQLERRM;
        END;
        v_closed := v_closed + 1;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        v_errors := v_errors + 1;
        RAISE NOTICE 'rpc_close_stuck: failed %: %', r.order_number, SQLERRM;
    END;
  END LOOP;

  RETURN json_build_object(
    'ok', true,
    'closed', v_closed,
    'skipped_local_pickup', v_skipped_local,
    'errors', v_errors
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_close_stuck_customer_requested_orders() IS
  'Sweep: cierra pedidos stuck con customer_requested_close + todo apartado (no retiro local). Red de seguridad tras 348 / A56955.';

-- Solo cron / service: no exponer a clients autenticados.
REVOKE ALL ON FUNCTION public.rpc_close_stuck_customer_requested_orders() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_close_stuck_customer_requested_orders() FROM anon;
REVOKE ALL ON FUNCTION public.rpc_close_stuck_customer_requested_orders() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_close_stuck_customer_requested_orders() TO postgres;
GRANT EXECUTE ON FUNCTION public.rpc_close_stuck_customer_requested_orders() TO service_role;
