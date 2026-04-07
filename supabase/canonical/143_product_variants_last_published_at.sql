-- 143_product_variants_last_published_at.sql
-- Guarda fecha de publicación por variante/color para publicaciones en redes.

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS last_published_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_product_variants_last_published_at
  ON public.product_variants(last_published_at);

