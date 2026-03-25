-- 76_backfill_qr_codes.sql — Generar códigos QR para todos los variant_sizes existentes

-- Este script genera códigos QR únicos para todos los registros de variant_sizes
-- que no tienen código asignado. Se ejecuta una sola vez para migración.

DO $$
DECLARE
  variant_size_record RECORD;
  new_qr_code TEXT;
  total_count INTEGER := 0;
  processed_count INTEGER := 0;
BEGIN
  -- Contar cuántos registros necesitan código
  SELECT COUNT(*) INTO total_count
  FROM public.variant_sizes
  WHERE qr_code IS NULL;
  
  RAISE NOTICE 'Total de variant_sizes sin código QR: %', total_count;
  
  -- Recorrer todos los registros sin código
  FOR variant_size_record IN
    SELECT id, variant_id, size
    FROM public.variant_sizes
    WHERE qr_code IS NULL
    ORDER BY created_at ASC
  LOOP
    BEGIN
      -- Asignar código usando la función
      new_qr_code := public.assign_qr_code_to_variant_size(variant_size_record.id);
      
      processed_count := processed_count + 1;
      
      -- Log cada 100 registros
      IF processed_count % 100 = 0 THEN
        RAISE NOTICE 'Procesados % de % registros...', processed_count, total_count;
      END IF;
      
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Error asignando código a variant_size %: %', variant_size_record.id, SQLERRM;
    END;
  END LOOP;
  
  RAISE NOTICE 'Migración completada. Total procesados: % de %', processed_count, total_count;
  
  -- Verificar que no haya duplicados
  IF EXISTS (
    SELECT qr_code, COUNT(*) 
    FROM public.variant_sizes 
    WHERE qr_code IS NOT NULL
    GROUP BY qr_code 
    HAVING COUNT(*) > 1
  ) THEN
    RAISE WARNING 'ADVERTENCIA: Se encontraron códigos QR duplicados!';
  ELSE
    RAISE NOTICE 'Verificación: No se encontraron códigos QR duplicados.';
  END IF;
  
  -- Verificar cuántos registros quedan sin código
  SELECT COUNT(*) INTO total_count
  FROM public.variant_sizes
  WHERE qr_code IS NULL;
  
  IF total_count > 0 THEN
    RAISE WARNING 'Quedan % registros sin código QR', total_count;
  ELSE
    RAISE NOTICE 'Todos los registros tienen código QR asignado.';
  END IF;
END $$;

-- Opcional: Hacer la columna NOT NULL después de la migración
-- Descomentar estas líneas después de verificar que todos los registros tienen código
/*
DO $$
BEGIN
  ALTER TABLE public.variant_sizes 
  ALTER COLUMN qr_code SET NOT NULL;
  
  RAISE NOTICE 'Columna qr_code ahora es NOT NULL';
END $$;
*/

select pg_notify('pgrst','reload schema');
