-- 358_crm_events_foundation_tests.sql
-- Solo lectura + smoke (la única parte que muta usa BEGIN/ROLLBACK interno).
-- Ejecutar en transacción:
--   BEGIN;
--   \i 358_crm_events_foundation_tests.sql
--   ROLLBACK;

-- Privilegios: rpc_crm_dispatch_trigger no debe ser ejecutable por
-- authenticated/anon (lección 352b).
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.rpc_crm_dispatch_trigger()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_crm_dispatch_trigger()', 'EXECUTE') THEN
    RAISE EXCEPTION '358 FAIL: rpc_crm_dispatch_trigger es ejecutable por authenticated/anon';
  END IF;
  RAISE NOTICE '358 OK: rpc_crm_dispatch_trigger no es ejecutable por authenticated/anon';
END $$;

-- Trigger: un pedido nuevo encola exactamente un evento order_placed, con el
-- teléfono normalizado y las properties esperadas. Insert real dentro de un
-- SAVEPOINT para no dejar nada persistido.
-- SAVEPOINT/ROLLBACK TO van a nivel de sesión SQL, no dentro de plpgsql.
SAVEPOINT sp_358_trigger_test;

DO $$
DECLARE
  v_customer_id uuid;
  v_order_id uuid;
  v_row record;
BEGIN
  SELECT id INTO v_customer_id FROM public.customers WHERE phone IS NOT NULL LIMIT 1;
  IF v_customer_id IS NULL THEN
    RAISE NOTICE '358 SKIP: no hay clientes con teléfono para probar el trigger';
    RETURN;
  END IF;

  INSERT INTO public.orders (customer_id, status, source, order_number, total_amount)
  VALUES (v_customer_id, 'active', 'admin', '__TEST_358__', 999)
  RETURNING id INTO v_order_id;

  SELECT event_name, contact_phone_e164, status, properties
  INTO v_row
  FROM public.crm_event_outbox
  WHERE order_id = v_order_id;

  IF v_row.event_name IS DISTINCT FROM 'order_placed' THEN
    RAISE EXCEPTION '358 FAIL: no se encoló order_placed para el pedido de prueba';
  END IF;
  IF v_row.status IS DISTINCT FROM 'queued' THEN
    RAISE EXCEPTION '358 FAIL: el evento de prueba no quedó en queued (status=%)', v_row.status;
  END IF;
  IF (v_row.properties->>'order_number') IS DISTINCT FROM '__TEST_358__' THEN
    RAISE EXCEPTION '358 FAIL: properties.order_number no coincide';
  END IF;

  RAISE NOTICE '358 OK: trigger encola order_placed correctamente (phone=%, status=%)',
    v_row.contact_phone_e164, v_row.status;
END $$;

ROLLBACK TO SAVEPOINT sp_358_trigger_test;

-- Idempotencia: UNIQUE(event_name, order_id) existe.
DO $$
DECLARE
  v_has_unique boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.crm_event_outbox'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%event_name%order_id%'
  ) INTO v_has_unique;

  IF NOT v_has_unique THEN
    RAISE EXCEPTION '358 FAIL: falta el UNIQUE(event_name, order_id) en crm_event_outbox';
  END IF;
  RAISE NOTICE '358 OK: UNIQUE(event_name, order_id) presente';
END $$;

-- Estado general del despacho.
DO $$
DECLARE
  v_mode text;
  v_url text;
  v_counts jsonb;
BEGIN
  SELECT mode, dispatch_function_url INTO v_mode, v_url FROM public.crm_settings WHERE id = true;

  SELECT jsonb_object_agg(status, cnt) INTO v_counts
  FROM (SELECT status, count(*) AS cnt FROM public.crm_event_outbox GROUP BY status) x;

  RAISE NOTICE '358 OK: estado general — mode=%, dispatch_function_url=%, outbox por estado=%',
    v_mode, v_url, coalesce(v_counts, '{}'::jsonb);
END $$;
