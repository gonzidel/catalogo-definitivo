-- 74_add_qr_code_to_variant_sizes.sql — Agregar columna qr_code para códigos numéricos únicos

-- Agregar columna qr_code a variant_sizes
-- Usamos text para mantener ceros a la izquierda si es necesario (ej: "000001")
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'variant_sizes' 
    AND column_name = 'qr_code'
  ) THEN
    ALTER TABLE public.variant_sizes 
    ADD COLUMN qr_code TEXT;
    
    RAISE NOTICE 'Columna qr_code agregada a variant_sizes';
  ELSE
    RAISE NOTICE 'Columna qr_code ya existe en variant_sizes';
  END IF;
END $$;

-- Crear índice único en qr_code para garantizar unicidad y búsquedas rápidas
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' 
    AND tablename = 'variant_sizes' 
    AND indexname = 'ix_variant_sizes_qr_code_unique'
  ) THEN
    CREATE UNIQUE INDEX ix_variant_sizes_qr_code_unique 
    ON public.variant_sizes(qr_code) 
    WHERE qr_code IS NOT NULL;
    
    RAISE NOTICE 'Índice único ix_variant_sizes_qr_code_unique creado';
  ELSE
    RAISE NOTICE 'Índice único ix_variant_sizes_qr_code_unique ya existe';
  END IF;
END $$;

-- Crear índice normal (no único) para búsquedas rápidas incluso cuando qr_code es NULL
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE schemaname = 'public' 
    AND tablename = 'variant_sizes' 
    AND indexname = 'ix_variant_sizes_qr_code'
  ) THEN
    CREATE INDEX ix_variant_sizes_qr_code 
    ON public.variant_sizes(qr_code);
    
    RAISE NOTICE 'Índice ix_variant_sizes_qr_code creado';
  ELSE
    RAISE NOTICE 'Índice ix_variant_sizes_qr_code ya existe';
  END IF;
END $$;

select pg_notify('pgrst','reload schema');
