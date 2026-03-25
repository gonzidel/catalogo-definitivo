-- 70_clean_duplicate_daily_sales.sql — Limpiar registros duplicados en daily_sales
-- Este script elimina registros duplicados, manteniendo el que tiene el monto correcto (con extras)

-- PASO 1: Identificar duplicados
DO $$
DECLARE
  v_duplicados int;
BEGIN
  -- Contar duplicados (mismo cliente, misma fecha, misma hora, tipo envios)
  SELECT COUNT(*) INTO v_duplicados
  FROM (
    SELECT 
      sale_date,
      sale_time,
      customer_name,
      sale_type,
      COUNT(*) as cnt
    FROM public.daily_sales
    WHERE sale_type = 'envios'
    GROUP BY sale_date, sale_time, customer_name, sale_type
    HAVING COUNT(*) > 1
  ) dups;
  
  RAISE NOTICE '📊 Registros duplicados encontrados: %', v_duplicados;
END $$;

-- PASO 2: Mostrar duplicados antes de limpiar
SELECT 
  'Duplicados encontrados (antes de limpiar)' as descripcion,
  sale_date,
  sale_time,
  customer_name,
  COUNT(*) as cantidad_duplicados,
  STRING_AGG(sale_amount::text, ', ' ORDER BY sale_amount DESC) as montos,
  STRING_AGG(id::text, ', ' ORDER BY sale_amount DESC) as ids
FROM public.daily_sales
WHERE sale_type = 'envios'
GROUP BY sale_date, sale_time, customer_name
HAVING COUNT(*) > 1
ORDER BY sale_date DESC, sale_time DESC;

-- PASO 3: Eliminar duplicados, manteniendo el registro con el monto más alto (que incluye extras)
-- Si hay múltiples registros para el mismo pedido, mantener el que tiene el monto más alto
DELETE FROM public.daily_sales
WHERE id IN (
  SELECT id
  FROM (
    SELECT 
      id,
      sale_date,
      sale_time,
      customer_name,
      sale_amount,
      ROW_NUMBER() OVER (
        PARTITION BY sale_date, sale_time, customer_name, sale_type
        ORDER BY sale_amount DESC, id DESC
      ) as rn
    FROM public.daily_sales
    WHERE sale_type = 'envios'
  ) ranked
  WHERE rn > 1  -- Mantener solo el primero (monto más alto)
);

-- PASO 4: Verificar que se eliminaron los duplicados
DO $$
DECLARE
  v_duplicados_despues int;
  v_total_registros int;
BEGIN
  -- Contar duplicados después de limpiar
  SELECT COUNT(*) INTO v_duplicados_despues
  FROM (
    SELECT 
      sale_date,
      sale_time,
      customer_name,
      sale_type,
      COUNT(*) as cnt
    FROM public.daily_sales
    WHERE sale_type = 'envios'
    GROUP BY sale_date, sale_time, customer_name, sale_type
    HAVING COUNT(*) > 1
  ) dups;
  
  -- Contar total de registros
  SELECT COUNT(*) INTO v_total_registros
  FROM public.daily_sales
  WHERE sale_type = 'envios';
  
  RAISE NOTICE '📊 Después de limpiar:';
  RAISE NOTICE '   - Duplicados restantes: %', v_duplicados_despues;
  RAISE NOTICE '   - Total registros envios: %', v_total_registros;
  
  IF v_duplicados_despues = 0 THEN
    RAISE NOTICE '✅ Todos los duplicados fueron eliminados';
  ELSE
    RAISE WARNING '⚠️ Aún quedan % grupos de duplicados', v_duplicados_despues;
  END IF;
END $$;

-- PASO 5: Mostrar resumen final
SELECT 
  'Resumen final de daily_sales (envios)' as descripcion,
  COUNT(*) as total_registros,
  COUNT(DISTINCT (sale_date, sale_time, customer_name)) as pedidos_unicos
FROM public.daily_sales
WHERE sale_type = 'envios';

-- PASO 6: Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');

