-- 99_fix_duplicate_tags.sql — Identificar y limpiar tags duplicados

-- Esta función identifica tags duplicados (mismo name, category, level, parent_id)
-- y sugiere cuáles mantener/eliminar

-- Ver duplicados de Tags1 (level=1, parent_id=null)
SELECT 
  name,
  category,
  level,
  parent_id,
  COUNT(*) as duplicate_count,
  array_agg(id ORDER BY created_at) as tag_ids,
  array_agg(created_at ORDER BY created_at) as created_dates
FROM public.tags
WHERE level = 1
  AND parent_id IS NULL
GROUP BY name, category, level, parent_id
HAVING COUNT(*) > 1
ORDER BY category, name;

-- Ver duplicados de Tags2 (level=2)
SELECT 
  name,
  category,
  level,
  parent_id,
  COUNT(*) as duplicate_count,
  array_agg(id ORDER BY created_at) as tag_ids,
  array_agg(created_at ORDER BY created_at) as created_dates
FROM public.tags
WHERE level = 2
GROUP BY name, category, level, parent_id
HAVING COUNT(*) > 1
ORDER BY category, name;

-- Ver duplicados de Tags3 (level=3)
SELECT 
  name,
  category,
  level,
  parent_id,
  COUNT(*) as duplicate_count,
  array_agg(id ORDER BY created_at) as tag_ids,
  array_agg(created_at ORDER BY created_at) as created_dates
FROM public.tags
WHERE level = 3
GROUP BY name, category, level, parent_id
HAVING COUNT(*) > 1
ORDER BY category, name;

-- Función helper para limpiar duplicados (mantiene el más antiguo)
-- USAR CON PRECAUCIÓN: Revisar primero qué productos usan cada tag antes de eliminar
CREATE OR REPLACE FUNCTION find_tags_to_cleanup()
RETURNS TABLE(
  tag_id uuid,
  tag_name text,
  tag_category text,
  tag_level integer,
  tag_parent_id uuid,
  keep_id uuid,
  products_using_count bigint
) AS $$
BEGIN
  RETURN QUERY
  WITH duplicates AS (
    SELECT 
      name,
      category,
      level,
      parent_id,
      array_agg(id ORDER BY created_at) as tag_ids
    FROM public.tags
    GROUP BY name, category, level, parent_id
    HAVING COUNT(*) > 1
  ),
  tags_to_remove AS (
    SELECT 
      unnest(d.tag_ids[2:]) as tag_id,  -- Todos excepto el primero (más antiguo)
      d.name,
      d.category,
      d.level,
      d.parent_id,
      d.tag_ids[1] as keep_id  -- El primero (más antiguo) se mantiene
    FROM duplicates d
  )
  SELECT 
    ttr.tag_id,
    ttr.name,
    ttr.category,
    ttr.level,
    ttr.parent_id,
    ttr.keep_id,
    COUNT(DISTINCT pt.product_id) as products_using_count
  FROM tags_to_remove ttr
  LEFT JOIN public.product_tags pt ON pt.tag1_id = ttr.tag_id 
    OR pt.tag2_id = ttr.tag_id
    OR ttr.tag_id = ANY(pt.tag3_ids)
  GROUP BY ttr.tag_id, ttr.name, ttr.category, ttr.level, ttr.parent_id, ttr.keep_id
  ORDER BY ttr.category, ttr.level, ttr.name;
END;
$$ LANGUAGE plpgsql;

-- Para ver qué tags se eliminarían y cuántos productos los usan:
-- SELECT * FROM find_tags_to_cleanup();

-- IMPORTANTE: Antes de eliminar, actualizar product_tags para usar el tag que se mantiene
-- Esto requiere un script más complejo que actualice todas las referencias

select pg_notify('pgrst','reload schema');

