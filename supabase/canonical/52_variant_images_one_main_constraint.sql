-- 52_variant_images_one_main_constraint.sql — Agregar columna is_main e índice único parcial

-- 1. Agregar columna is_main si no existe
ALTER TABLE public.variant_images
  ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;

-- 2. Actualizar is_main = true para la imagen con position = 1 en cada variante (migración de datos existentes)
UPDATE public.variant_images vi1
SET is_main = true
WHERE vi1.position = 1
  AND NOT EXISTS (
    SELECT 1 FROM public.variant_images vi2
    WHERE vi2.variant_id = vi1.variant_id
      AND vi2.id != vi1.id
      AND vi2.is_main = true
  );

-- 3. Índice único parcial: solo puede haber una imagen con is_main = true por variant_id
-- Esto previene inconsistencias a nivel de base de datos
CREATE UNIQUE INDEX IF NOT EXISTS ux_variant_images_one_main
  ON public.variant_images (variant_id)
  WHERE is_main = true;

COMMENT ON COLUMN public.variant_images.is_main IS 'Indica si esta imagen es la principal de la variante (solo una por variante)';
COMMENT ON INDEX public.ux_variant_images_one_main IS 'Garantiza que solo una imagen por variante tenga is_main = true';

