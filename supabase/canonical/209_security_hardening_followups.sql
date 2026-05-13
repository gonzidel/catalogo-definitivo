-- 209_security_hardening_followups.sql
--
-- Follow-up seguro de auditoria Supabase/PostgreSQL FYL: SOLO cambios
-- transaccionales de grants/RLS/policies. Los indices concurrentes viven en
-- 210_security_hardening_indexes_concurrent.sql y deben ejecutarse fuera de
-- cualquier transaction block.
-- Idempotente y no destructivo: no elimina datos, no cambia contratos de RPC,
-- no toca la logica critica de checkout/stock.
--
-- ============================================================================
-- 1) Grants defensivos sobre RPCs legacy ya identificadas como peligrosas
-- ============================================================================

DO $$
DECLARE
  fn regprocedure;
BEGIN
  fn := to_regprocedure('public.get_customer_id_for_user(uuid)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END IF;

  fn := to_regprocedure('public.rpc_link_or_create_customer(uuid,text,text,text,text)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
  END IF;

  fn := to_regprocedure('public.clear_cart_items(uuid)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.add_cart_item(uuid,text,text,text,integer,numeric,text)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.get_cart_items_simple(uuid)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.get_user_cart(uuid)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.rpc_get_or_create_cart()');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.rpc_reserve_item(uuid,integer)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.rpc_submit_cart(uuid)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;

  fn := to_regprocedure('public.rpc_update_cart_item_quantity(uuid,integer,uuid)');
  IF fn IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
  END IF;
END $$;

-- ============================================================================
-- 2) RLS/grants defensivos para tablas operativas sensibles
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.rpc_operations') IS NOT NULL THEN
    ALTER TABLE public.rpc_operations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.rpc_operations FROM PUBLIC, anon, authenticated;
    GRANT ALL ON TABLE public.rpc_operations TO service_role;
  END IF;

  IF to_regclass('public.order_reserved_qty_released') IS NOT NULL THEN
    ALTER TABLE public.order_reserved_qty_released ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.order_reserved_qty_released FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public.order_reserved_qty_released TO authenticated;
    GRANT ALL ON TABLE public.order_reserved_qty_released TO service_role;
  END IF;

  IF to_regclass('public.replenishment_learning') IS NOT NULL THEN
    ALTER TABLE public.replenishment_learning ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.replenishment_learning FROM PUBLIC, anon;
    GRANT SELECT ON TABLE public.replenishment_learning TO authenticated;
    GRANT ALL ON TABLE public.replenishment_learning TO service_role;
  END IF;
END $$;

-- Policies idempotentes: solo admins reales pueden leer tablas operativas.
DO $$
BEGIN
  IF to_regclass('public.order_reserved_qty_released') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'order_reserved_qty_released'
         AND policyname = 'order_reserved_qty_released_admin_select'
     ) THEN
    CREATE POLICY order_reserved_qty_released_admin_select
      ON public.order_reserved_qty_released
      FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;

  IF to_regclass('public.replenishment_learning') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = 'replenishment_learning'
         AND policyname = 'replenishment_learning_admin_select'
     ) THEN
    CREATE POLICY replenishment_learning_admin_select
      ON public.replenishment_learning
      FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;
END $$;

-- ============================================================================
-- 3) Verificacion post-deploy
-- ============================================================================

SELECT
  c.oid::regclass AS tabla,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('rpc_operations', 'order_reserved_qty_released', 'replenishment_learning')
ORDER BY c.relname;

SELECT
  p.oid::regprocedure AS function_signature,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'get_customer_id_for_user',
    'rpc_link_or_create_customer',
    'clear_cart_items',
    'add_cart_item',
    'get_cart_items_simple',
    'get_user_cart',
    'rpc_get_or_create_cart',
    'rpc_reserve_item',
    'rpc_submit_cart',
    'rpc_update_cart_item_quantity'
  )
ORDER BY p.proname, p.oid::regprocedure::text;

SELECT pg_notify('pgrst', 'reload schema');
