-- 12_unify_tags3.sql — Unificar Tags3 duplicados por nombre y categoría
-- Script OPCIONAL y MANUAL para unificar Tags3 duplicados existentes
-- Ejecutar solo si hay Tags3 duplicados que necesitan unificarse
-- 
-- IMPORTANTE: Este script es idempotente y seguro, pero se recomienda hacer backup antes de ejecutar

-- Paso 1: Identificar Tags3 duplicados (mismo nombre, misma categoría, level=3, diferentes parent_id)
-- Mantener el primero encontrado (por id) y marcar los demás como duplicados

DO $$
DECLARE
  duplicate_record RECORD;
  keep_tag_id uuid;
  duplicate_tag_id uuid;
  updated_count int := 0;
BEGIN
  -- Iterar sobre grupos de Tags3 duplicados
  FOR duplicate_record IN
    SELECT 
      LOWER(TRIM(name)) as normalized_name,
      category,
      array_agg(id ORDER BY created_at, id) as tag_ids
    FROM public.tags
    WHERE level = 3
    GROUP BY LOWER(TRIM(name)), category
    HAVING COUNT(*) > 1
  LOOP
    -- El primer tag (más antiguo) se mantiene, los demás se unifican
    keep_tag_id := duplicate_record.tag_ids[1];
    
    RAISE NOTICE 'Unificando Tags3 duplicados: nombre="%", categoría="%", mantener ID=%, unificar % tags', 
      duplicate_record.normalized_name, 
      duplicate_record.category, 
      keep_tag_id,
      array_length(duplicate_record.tag_ids, 1) - 1;
    
    -- Procesar cada tag duplicado (excepto el primero)
    FOR i IN 2..array_length(duplicate_record.tag_ids, 1) LOOP
      duplicate_tag_id := duplicate_record.tag_ids[i];
      
      -- 1. Actualizar product_tags.tag3_ids (reemplazar el duplicado por el tag a mantener)
      UPDATE public.product_tags
      SET tag3_ids = array_replace(tag3_ids, duplicate_tag_id, keep_tag_id)
      WHERE duplicate_tag_id = ANY(tag3_ids)
        AND NOT (keep_tag_id = ANY(tag3_ids)); -- Solo si no está ya presente
      
      -- Si el tag a mantener ya está en el array, simplemente eliminar el duplicado
      UPDATE public.product_tags
      SET tag3_ids = array_remove(tag3_ids, duplicate_tag_id)
      WHERE duplicate_tag_id = ANY(tag3_ids)
        AND keep_tag_id = ANY(tag3_ids);
      
      -- 2. Actualizar product_tag_details (reemplazar tag3_id duplicado por el tag a mantener)
      -- Primero, insertar el tag a mantener si no existe ya
      INSERT INTO public.product_tag_details (product_id, tag3_id)
      SELECT DISTINCT product_id, keep_tag_id
      FROM public.product_tag_details
      WHERE tag3_id = duplicate_tag_id
        AND NOT EXISTS (
          SELECT 1 FROM public.product_tag_details ptd2
          WHERE ptd2.product_id = product_tag_details.product_id
            AND ptd2.tag3_id = keep_tag_id
        )
      ON CONFLICT (product_id, tag3_id) DO NOTHING;
      
      -- Luego, eliminar las referencias al tag duplicado
      DELETE FROM public.product_tag_details
      WHERE tag3_id = duplicate_tag_id;
      
      -- 3. Si el tag duplicado tiene hijos (no debería para Tags3, pero por seguridad)
      -- Actualizar parent_id de los hijos al tag a mantener
      UPDATE public.tags
      SET parent_id = keep_tag_id
      WHERE parent_id = duplicate_tag_id;
      
      -- 4. Eliminar el tag duplicado
      DELETE FROM public.tags
      WHERE id = duplicate_tag_id;
      
      updated_count := updated_count + 1;
      
      RAISE NOTICE '  ✓ Unificado tag ID=% → ID=%', duplicate_tag_id, keep_tag_id;
    END LOOP;
  END LOOP;
  
  IF updated_count > 0 THEN
    RAISE NOTICE '✅ Unificación completada: % Tags3 duplicados unificados', updated_count;
  ELSE
    RAISE NOTICE 'ℹ️ No se encontraron Tags3 duplicados para unificar';
  END IF;
END $$;

-- Verificar resultado: mostrar Tags3 restantes agrupados por nombre y categoría
-- Si todo está bien, no debería haber duplicados
SELECT 
  LOWER(TRIM(name)) as normalized_name,
  category,
  COUNT(*) as count,
  array_agg(id::text ORDER BY created_at) as tag_ids
FROM public.tags
WHERE level = 3
GROUP BY LOWER(TRIM(name)), category
HAVING COUNT(*) > 1
ORDER BY category, normalized_name;

-- Si la consulta anterior no devuelve filas, significa que no hay duplicados
-- Si devuelve filas, puede haber duplicados que necesiten revisión manual

select pg_notify('pgrst','reload schema');
