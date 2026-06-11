-- 231_rpc_nuevos_ingresos_first_publish.sql
--
-- Banner "Nuevos ingresos": solo productos cuya PRIMERA publicación cae en la ventana.
-- Alineado con admin/publications.js → Instagram "si" (isNew en export sheet).
-- Republicaciones no vuelven a entrar: min(publication_events.published_at) no se mueve.
--
-- DEPLOY (requiere aprobación producción):
--   1) Este archivo vía apply_migration / SQL editor
--   2) Verificar: select * from rpc_get_nuevos_ingresos_products(7) limit 5;
--
-- Rollback: DROP FUNCTION IF EXISTS public.rpc_get_nuevos_ingresos_products(integer);

CREATE OR REPLACE FUNCTION public.rpc_get_nuevos_ingresos_products(p_days integer DEFAULT 7)
RETURNS TABLE (
  product_name text,
  first_published_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  WITH first_pub AS (
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      CASE
        WHEN to_regclass('public.publication_events') IS NOT NULL THEN (
          SELECT min(pe.published_at)
          FROM public.publication_events pe
          WHERE pe.product_id = p.id
        )
        ELSE p.last_published_at
      END AS first_published_at
    FROM public.products p
    WHERE p.status IN ('active', 'pending_stock')
  )
  SELECT
    fp.product_name,
    fp.first_published_at
  FROM first_pub fp
  WHERE fp.first_published_at IS NOT NULL
    AND fp.first_published_at >= (now() - make_interval(days => greatest(coalesce(p_days, 7), 1)))
  ORDER BY fp.first_published_at DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_nuevos_ingresos_products(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_nuevos_ingresos_products(integer) TO anon, authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
