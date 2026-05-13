-- 211_anon_attack_surface_hardening.sql
--
-- Cierra superficie anon no publica confirmada por auditoria viva:
-- - vistas operativas vw_stock_*
-- - public_sales / public_sale_items
--
-- Mantiene acceso authenticated para flujos admin existentes. No toca
-- catalog_public_view, catalog_public_available_view, products, variants ni stock
-- fisico hasta tener snapshot publico de catalogo.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('v', 'm')
      AND c.relname LIKE 'vw_stock_%'
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM anon, PUBLIC', r.rel);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM authenticated', r.rel);
    EXECUTE format('GRANT SELECT ON TABLE %s TO authenticated', r.rel);
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.public_sales') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.public_sales FROM anon, PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE public.public_sales FROM authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.public_sales TO authenticated;

    DROP POLICY IF EXISTS public_sales_public_access ON public.public_sales;
  END IF;

  IF to_regclass('public.public_sale_items') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.public_sale_items FROM anon, PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE public.public_sale_items FROM authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.public_sale_items TO authenticated;

    DROP POLICY IF EXISTS public_sale_items_public_access ON public.public_sale_items;
  END IF;
END $$;

SELECT pg_notify('pgrst', 'reload schema');

-- Verificacion:
SELECT
  table_name,
  privilege_type,
  grantee
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee = 'anon'
  AND (table_name LIKE 'vw_stock_%' OR table_name IN ('public_sales', 'public_sale_items'))
ORDER BY table_name, privilege_type;
