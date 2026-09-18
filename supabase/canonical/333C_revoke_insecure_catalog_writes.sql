-- 333C_revoke_insecure_catalog_writes.sql
-- Fase 6C: cerrar writes de catálogo/stock a cualquier authenticated.
--
-- Contexto:
--   nj/ es la arquitectura objetivo y próxima producción pública.
--   catalogo1/ es temporal (~2 días): solo necesita SELECT.
--   vanilla público residual no justifica conservar agujeros.
--   admin vanilla sigue operativo y escribe variantes/stock/productos.
--
-- Qué cierra:
--   Policies *_all_access (auth.role()='authenticated' → ALL).
--   GRANT I/U/D/TRUNCATE de anon en tablas de catálogo/stock.
--   GRANT TRUNCATE de authenticated (nadie trunca por PostgREST).
--   GRANT I/U/D de warehouses a authenticated (admin solo SELECT; no hay policy write).
--
-- Qué NO toca:
--   reserved_qty (columna ni writers).
--   cart_items / carts (staging NJ checkout).
--   330 / 331 / 332 / 309 / ColorHex.
--   EXECUTE anon de rpc_get_variant_size_reserved (vanilla residual ~2 días).
--   SELECT anon/authenticated de snapshot, variants, sizes, images, colors, VSS.
--
-- Reemplazo admin:
--   product_variants ya tiene variants_admin_manage.
--   colors / tags / product_tags ya tienen admin_manage + admin_write.
--   products y variant_images NO tenían policy admin: se crean antes del DROP.
--
-- Rollback: 333C_ROLLBACK_revoke_insecure_catalog_writes.sql
-- Tests:    333C_revoke_insecure_catalog_writes_tests.sql

-- ---------------------------------------------------------------------------
-- 1) Policies admin mínimas que faltaban
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS products_admin_manage ON public.products;
CREATE POLICY products_admin_manage ON public.products
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));

DROP POLICY IF EXISTS variant_images_admin_manage ON public.variant_images;
CREATE POLICY variant_images_admin_manage ON public.variant_images
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- 2) Quitar agujeros ALL authenticated
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS product_variants_all_access ON public.product_variants;
DROP POLICY IF EXISTS products_all_access ON public.products;
DROP POLICY IF EXISTS variant_images_all_access ON public.variant_images;
DROP POLICY IF EXISTS colors_all_access ON public.colors;
DROP POLICY IF EXISTS tags_all_access ON public.tags;
DROP POLICY IF EXISTS product_tags_all_access ON public.product_tags;

-- ---------------------------------------------------------------------------
-- 3) Recortar GRANTs excesivos (RLS no basta como única defensa)
--    authenticated conserva I/U/D donde admin vanilla / NJ admin escriben.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.product_variants FROM anon;
REVOKE TRUNCATE ON TABLE public.product_variants FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.products FROM anon;
REVOKE TRUNCATE ON TABLE public.products FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_images FROM anon;
REVOKE TRUNCATE ON TABLE public.variant_images FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.colors FROM anon;
REVOKE TRUNCATE ON TABLE public.colors FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.tags FROM anon;
REVOKE TRUNCATE ON TABLE public.tags FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.product_tags FROM anon;
REVOKE TRUNCATE ON TABLE public.product_tags FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_size_warehouse_stock FROM anon;
REVOKE TRUNCATE ON TABLE public.variant_size_warehouse_stock FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_sizes FROM anon;
REVOKE TRUNCATE ON TABLE public.variant_sizes FROM authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_warehouse_stock FROM anon;
REVOKE TRUNCATE ON TABLE public.variant_warehouse_stock FROM authenticated;

-- warehouses: admin y NJ solo SELECT. No hay policy de write.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.warehouses FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.warehouses FROM authenticated;

-- Reafirmar SELECT público necesario para catalogo1 + NJ
GRANT SELECT ON TABLE public.product_variants TO anon, authenticated;
GRANT SELECT ON TABLE public.products TO anon, authenticated;
GRANT SELECT ON TABLE public.variant_images TO anon, authenticated;
GRANT SELECT ON TABLE public.colors TO anon, authenticated;
GRANT SELECT ON TABLE public.tags TO anon, authenticated;
GRANT SELECT ON TABLE public.product_tags TO anon, authenticated;
GRANT SELECT ON TABLE public.variant_size_warehouse_stock TO anon, authenticated;
GRANT SELECT ON TABLE public.variant_sizes TO anon, authenticated;
GRANT SELECT ON TABLE public.variant_warehouse_stock TO anon, authenticated;
GRANT SELECT ON TABLE public.warehouses TO anon, authenticated;

-- Writes admin (JWT authenticated + policy is_admin)
GRANT INSERT, UPDATE, DELETE ON TABLE public.product_variants TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.products TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.variant_images TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.colors TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.tags TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.product_tags TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.variant_size_warehouse_stock TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.variant_sizes TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.variant_warehouse_stock TO authenticated;

-- Vanilla residual /catalogo.html: no revocar todavía
GRANT EXECUTE ON FUNCTION public.rpc_get_variant_size_reserved(uuid[]) TO anon, authenticated, service_role;
