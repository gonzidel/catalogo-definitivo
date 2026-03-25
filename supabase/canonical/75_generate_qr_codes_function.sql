-- 75_generate_qr_codes_function.sql — Función para generar códigos QR únicos

-- Crear secuencia para generar códigos numéricos únicos
-- Empezamos desde 100000 para tener códigos de 6 dígitos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_sequences 
    WHERE schemaname = 'public' 
    AND sequencename = 'qr_code_sequence'
  ) THEN
    CREATE SEQUENCE public.qr_code_sequence
    START WITH 100000
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
    
    RAISE NOTICE 'Secuencia qr_code_sequence creada';
  ELSE
    RAISE NOTICE 'Secuencia qr_code_sequence ya existe';
  END IF;
END $$;

-- Función para obtener el siguiente código QR único
CREATE OR REPLACE FUNCTION public.get_next_qr_code()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  next_code BIGINT;
  code_text TEXT;
BEGIN
  -- Obtener el siguiente valor de la secuencia
  next_code := nextval('public.qr_code_sequence');
  
  -- Convertir a texto (mantiene el número sin ceros a la izquierda)
  code_text := next_code::TEXT;
  
  RETURN code_text;
END;
$$;

-- Función para generar y asignar código QR a un variant_size específico
CREATE OR REPLACE FUNCTION public.assign_qr_code_to_variant_size(p_variant_size_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  new_qr_code TEXT;
  existing_code TEXT;
BEGIN
  -- Verificar si ya tiene un código
  SELECT qr_code INTO existing_code
  FROM public.variant_sizes
  WHERE id = p_variant_size_id;
  
  IF existing_code IS NOT NULL THEN
    -- Ya tiene código, retornarlo
    RETURN existing_code;
  END IF;
  
  -- Generar nuevo código
  new_qr_code := public.get_next_qr_code();
  
  -- Intentar asignar el código (puede fallar si hay duplicado, pero es muy raro)
  LOOP
    BEGIN
      UPDATE public.variant_sizes
      SET qr_code = new_qr_code
      WHERE id = p_variant_size_id
      AND qr_code IS NULL;
      
      -- Si llegamos aquí, la actualización fue exitosa
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Si hay duplicado (muy raro), generar otro código
      new_qr_code := public.get_next_qr_code();
    END;
  END LOOP;
  
  RETURN new_qr_code;
END;
$$;

-- Comentarios
COMMENT ON FUNCTION public.get_next_qr_code() IS 'Genera el siguiente código QR numérico único de la secuencia';
COMMENT ON FUNCTION public.assign_qr_code_to_variant_size(UUID) IS 'Asigna un código QR único a un variant_size específico si no tiene uno';

select pg_notify('pgrst','reload schema');
