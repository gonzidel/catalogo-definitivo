-- 333C_ROLLBACK_revoke_insecure_catalog_writes.sql
-- Restaura policies *_all_access y GRANTs previos a 333C.
-- No toca reserved_qty, cart_items, 330/331/332/309.

DROP POLICY IF EXISTS products_admin_manage ON public.products;
DROP POLICY IF EXISTS variant_images_admin_manage ON public.variant_images;

DROP POLICY IF EXISTS product_variants_all_access ON public.product_variants;
CREATE POLICY product_variants_all_access ON public.product_variants
  FOR ALL
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS products_all_access ON public.products;
CREATE POLICY products_all_access ON public.products
  FOR ALL
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS variant_images_all_access ON public.variant_images;
CREATE POLICY variant_images_all_access ON public.variant_images
  FOR ALL
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS colors_all_access ON public.colors;
CREATE POLICY colors_all_access ON public.colors
  FOR ALL
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS tags_all_access ON public.tags;
CREATE POLICY tags_all_access ON public.tags
  FOR ALL
  USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS product_tags_all_access ON public.product_tags;
CREATE POLICY product_tags_all_access ON public.product_tags
  FOR ALL
  USING (auth.role() = 'authenticated');

GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.product_variants TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_images TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.colors TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.tags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.product_tags TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_size_warehouse_stock TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_sizes TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.variant_warehouse_stock TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.warehouses TO anon, authenticated;
