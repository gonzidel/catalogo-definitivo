-- 50_variant_images_cloudinary.sql — Agregar columnas Cloudinary a variant_images

-- Agregar columnas para Cloudinary
ALTER TABLE public.variant_images
  ADD COLUMN IF NOT EXISTS public_id text,
  ADD COLUMN IF NOT EXISTS secure_url text;

-- Índice para búsqueda por public_id
CREATE INDEX IF NOT EXISTS ix_variant_images_public_id 
  ON public.variant_images(public_id);

-- Comentarios
COMMENT ON COLUMN public.variant_images.public_id IS 'Cloudinary public_id para transformaciones';
COMMENT ON COLUMN public.variant_images.secure_url IS 'Cloudinary secure_url (HTTPS)';
COMMENT ON COLUMN public.variant_images.url IS 'URL legacy o secure_url (compatibilidad)';

select pg_notify('pgrst','reload schema');

