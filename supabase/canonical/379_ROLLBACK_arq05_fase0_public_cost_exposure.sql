-- 379_ROLLBACK_arq05_fase0_public_cost_exposure.sql
--
-- Restaura los privilegios y la política previos a 379 (relacl leído en
-- producción 2026-10-09, sin ACL por columna):
--   products                  anon=rxtm  (SELECT, REFERENCES, TRIGGER, MAINTAIN)
--   suppliers                 anon=arwdDxtm (ALL)
--   category_pricing_defaults anon=arwdDxtm (ALL)
--   política authenticated_select_pricing_defaults (SELECT, authenticated, USING true)
--
-- Reabre la exposición de costos a anon: usar solo si 379 rompe el catálogo.

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE SELECT (
  id,
  handle,
  name,
  description,
  status,
  category,
  supplier_id,
  created_at,
  updated_at,
  last_published_at,
  publication_status,
  pack_size,
  nuevos_ingresos_highlight_at,
  season,
  target_audience,
  width_cm,
  height_cm,
  length_cm,
  weight_kg
) ON public.products FROM anon;
GRANT SELECT ON public.products TO anon;

REVOKE SELECT (id, code) ON public.suppliers FROM anon;
GRANT ALL ON public.suppliers TO anon;

GRANT ALL ON public.category_pricing_defaults TO anon;
DROP POLICY IF EXISTS authenticated_select_pricing_defaults ON public.category_pricing_defaults;
CREATE POLICY authenticated_select_pricing_defaults
  ON public.category_pricing_defaults
  FOR SELECT
  TO authenticated
  USING (true);

NOTIFY pgrst, 'reload schema';

COMMIT;
