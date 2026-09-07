-- 338_kanban_inbox_ani_fati_tests.sql
-- Tests de lectura / smoke (no mutan producción de forma permanente si se corre
-- en transacción con ROLLBACK). Ejecutar en SQL Editor como admin JWT o service role.
--
-- Uso sugerido:
--   BEGIN;
--   \i 338_kanban_inbox_ani_fati_tests.sql
--   ROLLBACK;

DO $$
BEGIN
  IF to_regclass('public.kanban_inbox_rr') IS NULL THEN
    RAISE EXCEPTION '338 FAIL: falta tabla kanban_inbox_rr';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'customers'
      AND column_name = 'kanban_inbox_owner'
  ) THEN
    RAISE EXCEPTION '338 FAIL: falta customers.kanban_inbox_owner';
  END IF;

  IF to_regprocedure('public.rpc_set_kanban_inbox_owner(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '338 FAIL: falta rpc_set_kanban_inbox_owner';
  END IF;

  IF to_regprocedure('public.fn_order_is_shipping_kanban_inbox(public.orders)') IS NULL THEN
    RAISE EXCEPTION '338 FAIL: falta fn_order_is_shipping_kanban_inbox';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_orders_assign_kanban_inbox'
  ) THEN
    RAISE EXCEPTION '338 FAIL: falta trigger trg_orders_assign_kanban_inbox';
  END IF;

  RAISE NOTICE '338 OK: objetos base presentes';
END $$;

-- Smoke: helper shipping vs retiro
DO $$
DECLARE
  v_ship public.orders;
  v_ret public.orders;
BEGIN
  v_ship := NULL;
  v_ret := NULL;

  SELECT o.* INTO v_ship
  FROM public.orders o
  WHERE coalesce(o.local_deferred_pickup, false) = false
    AND (
      o.notes IS NULL
      OR o.notes NOT ILIKE '%"kanban_scope": "local_pickup"%'
    )
  LIMIT 1;

  SELECT o.* INTO v_ret
  FROM public.orders o
  WHERE coalesce(o.local_deferred_pickup, false) = true
  LIMIT 1;

  IF v_ship.id IS NOT NULL
     AND NOT public.fn_order_is_shipping_kanban_inbox(v_ship) THEN
    RAISE EXCEPTION '338 FAIL: pedido shipping clasificado como no-shipping';
  END IF;

  IF v_ret.id IS NOT NULL
     AND public.fn_order_is_shipping_kanban_inbox(v_ret) THEN
    RAISE EXCEPTION '338 FAIL: pedido local_deferred clasificado como shipping';
  END IF;

  RAISE NOTICE '338 OK: helper shipping/retiro';
END $$;
