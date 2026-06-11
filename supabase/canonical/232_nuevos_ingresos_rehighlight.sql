-- 232_nuevos_ingresos_rehighlight.sql
--
-- Reingreso destacado: admin marca productos ya publicados para volver al banner
-- "Nuevos ingresos" (7 días). Complementa 231 (solo primera publicación).
--
-- DEPLOY (requiere aprobación producción):
--   apply_migration / SQL editor
--   Verificar: select * from rpc_get_nuevos_ingresos_products(7) limit 10;
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.rpc_get_nuevos_ingresos_products(integer);
--   ALTER TABLE public.products DROP COLUMN IF EXISTS nuevos_ingresos_highlight_at;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS nuevos_ingresos_highlight_at timestamptz;

COMMENT ON COLUMN public.products.nuevos_ingresos_highlight_at IS
  'Marcado en admin al actualizar un producto ya publicado; lo incluye en banner Nuevos ingresos por p_days.';

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
  WITH window_start AS (
    SELECT now() - make_interval(days => greatest(coalesce(p_days, 7), 1)) AS ts
  ),
  first_pub AS (
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
      END AS first_published_at,
      p.nuevos_ingresos_highlight_at
    FROM public.products p
    WHERE p.status IN ('active', 'pending_stock')
  ),
  eligible AS (
    SELECT
      fp.product_name,
      fp.first_published_at AS banner_at
    FROM first_pub fp, window_start w
    WHERE fp.first_published_at IS NOT NULL
      AND fp.first_published_at >= w.ts

    UNION ALL

    SELECT
      fp.product_name,
      fp.nuevos_ingresos_highlight_at AS banner_at
    FROM first_pub fp, window_start w
    WHERE fp.nuevos_ingresos_highlight_at IS NOT NULL
      AND fp.nuevos_ingresos_highlight_at >= w.ts
  )
  SELECT
    e.product_name,
    max(e.banner_at) AS first_published_at
  FROM eligible e
  GROUP BY e.product_name
  ORDER BY max(e.banner_at) DESC;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_nuevos_ingresos_products(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_nuevos_ingresos_products(integer) TO anon, authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
