-- 53_remove_size_from_product_variants.sql — Remover constraint NOT NULL de size en product_variants

-- 1. Hacer size nullable en product_variants
-- IMPORTANTE: Los talles ahora se guardan en variant_sizes, no en product_variants
ALTER TABLE public.product_variants
  ALTER COLUMN size DROP NOT NULL;

-- 2. Eliminar índices que incluyen size (ya no aplican)
DROP INDEX IF EXISTS public.ux_variants_product_color_size;
DROP INDEX IF EXISTS public.ix_variants_color_size;

-- 3. Comentario para documentar que size ya no se usa
COMMENT ON COLUMN public.product_variants.size IS 'DEPRECATED: Los talles ahora se guardan en variant_sizes. Esta columna se mantiene por compatibilidad temporal y debe ser NULL.';

select pg_notify('pgrst','reload schema');

