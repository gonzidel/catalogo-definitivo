-- 355_orders_daily_maintenance_grace_window_tests.sql
-- Solo lectura + smoke sobre datos reales (no ejecuta la función). Ejecutar
-- en transacción:
--   BEGIN;
--   \i 355_orders_daily_maintenance_grace_window_tests.sql
--   ROLLBACK;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_orders_daily_maintenance()'::regprocedure) INTO v_def;

  IF v_def NOT LIKE '%interval ''24 hours''%' THEN
    RAISE EXCEPTION '355 FAIL: no se encontró la ventana de gracia de 24hs en la función';
  END IF;

  IF v_def NOT LIKE '%local_deferred_pickup%' THEN
    RAISE EXCEPTION '355 FAIL: falta la distinción local_deferred_pickup en la función';
  END IF;

  RAISE NOTICE '355 OK: función contiene la ventana de gracia y la distinción de retiro local';
END $$;

-- Compara, en modo solo-lectura, qué pedidos habría desarmado la lógica VIEJA
-- vs la NUEVA en este momento (no muta nada).
DO $$
DECLARE
  v_old_count int;
  v_new_count int;
BEGIN
  SELECT count(*) INTO v_old_count
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND o.dismantle_at IS NOT NULL
    AND now() >= o.dismantle_at;

  SELECT count(*) INTO v_new_count
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND o.dismantle_at IS NOT NULL
    AND (
      (coalesce(o.local_deferred_pickup, false) = true AND now() >= o.dismantle_at)
      OR
      (coalesce(o.local_deferred_pickup, false) = false AND now() >= o.dismantle_at + interval '24 hours')
    );

  IF v_new_count > v_old_count THEN
    RAISE EXCEPTION '355 FAIL: la lógica nueva desarma MÁS pedidos que la vieja (nuevo=% viejo=%) — no debería pasar nunca', v_new_count, v_old_count;
  END IF;

  RAISE NOTICE '355 OK: lógica vieja desarmaría % pedidos ahora, la nueva % (nueva <= vieja, como se espera)', v_old_count, v_new_count;
END $$;

-- Pedidos de retiro local no deben verse afectados: mismo criterio antes/después.
DO $$
DECLARE
  v_local_old int;
  v_local_new int;
BEGIN
  SELECT count(*) INTO v_local_old
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND o.dismantle_at IS NOT NULL
    AND coalesce(o.local_deferred_pickup, false) = true
    AND now() >= o.dismantle_at;

  SELECT count(*) INTO v_local_new
  FROM public.orders o
  WHERE o.status IN ('active','closing_soon')
    AND o.dismantle_at IS NOT NULL
    AND coalesce(o.local_deferred_pickup, false) = true
    AND now() >= o.dismantle_at;

  IF v_local_old IS DISTINCT FROM v_local_new THEN
    RAISE EXCEPTION '355 FAIL: retiro local cambió de comportamiento (no debería)';
  END IF;

  RAISE NOTICE '355 OK: retiro local sin cambios (% pedidos elegibles)', v_local_old;
END $$;
