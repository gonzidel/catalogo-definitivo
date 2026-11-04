-- 381_arq05_fase1_products_column_grants.sql
--
-- ARQ-05 Fase 1, paso 2 (permisos): authenticated (clientes y admins comparten
-- el rol) deja de leer y escribir directamente cost, cost_is_estimated,
-- price_percentage y logistic_amount. super_admin los lee y guarda por
-- rpc_admin_get_product_pricing / rpc_admin_set_product_pricing (380).
-- Reemplaza en la base a la protección 182 (enforce_sensitive_product_fields),
-- que no existe en producción.
-- NO aplicada. Requiere autorización explícita.
--
-- Orden obligatorio: 380 aplicada y código del admin (legacy y NJ) desplegado
-- ANTES de esta migración. Con código viejo, el admin legacy hace select('*')
-- sobre products y recibiría error de permiso.
--
-- Filas y RLS sin cambios (auth_select_products, products_admin_manage).
-- DELETE, REFERENCES, TRIGGER y MAINTAIN se conservan a nivel tabla.
-- Columna size_chart_id (378, tablas de talles): se otorga solo si ya existe;
-- si 378 se aplica después, debe incluir su propio GRANT por columna.

BEGIN;

SET LOCAL lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ON public.products FROM authenticated;

GRANT SELECT (
  id, handle, name, description, status, category, supplier_id,
  created_at, updated_at, last_published_at, publication_status, pack_size,
  nuevos_ingresos_highlight_at, season, target_audience,
  width_cm, height_cm, length_cm, weight_kg
) ON public.products TO authenticated;

GRANT INSERT (
  id, handle, name, description, status, category, supplier_id,
  created_at, updated_at, last_published_at, publication_status, pack_size,
  nuevos_ingresos_highlight_at, season, target_audience,
  width_cm, height_cm, length_cm, weight_kg
) ON public.products TO authenticated;

GRANT UPDATE (
  id, handle, name, description, status, category, supplier_id,
  created_at, updated_at, last_published_at, publication_status, pack_size,
  nuevos_ingresos_highlight_at, season, target_audience,
  width_cm, height_cm, length_cm, weight_kg
) ON public.products TO authenticated;

DO $grant_size_chart$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'size_chart_id'
  ) THEN
    EXECUTE 'GRANT SELECT (size_chart_id), INSERT (size_chart_id), UPDATE (size_chart_id) ON public.products TO authenticated';
  END IF;
END
$grant_size_chart$;

NOTIFY pgrst, 'reload schema';

COMMIT;
