-- 10_product_similarity.sql — Funciones de similitud entre productos

-- Función: Calcular similitud entre productos (CORREGIDA)
CREATE OR REPLACE FUNCTION compute_similarity(
  source_product_id uuid,
  target_product_id uuid
) RETURNS integer AS $$
DECLARE
  score integer := 0;
  source_tag1_id uuid;
  source_tag2_id uuid;
  target_tag1_id uuid;
  target_tag2_id uuid;
  common_details_count integer;
BEGIN
  -- Obtener tags del producto origen
  SELECT pt.tag1_id, pt.tag2_id
  INTO source_tag1_id, source_tag2_id
  FROM product_tags pt
  WHERE pt.product_id = source_product_id;
  
  -- Obtener tags del producto destino
  SELECT pt.tag1_id, pt.tag2_id
  INTO target_tag1_id, target_tag2_id
  FROM product_tags pt
  WHERE pt.product_id = target_product_id;
  
  -- +50 si coincide type (tag1)
  IF source_tag1_id = target_tag1_id AND source_tag1_id IS NOT NULL THEN
    score := score + 50;
  END IF;
  
  -- +30 si coincide attribute_level2 (tag2)
  IF source_tag2_id = target_tag2_id AND source_tag2_id IS NOT NULL THEN
    score := score + 30;
  END IF;
  
  -- +5 por cada detail coincidente (max 15) - CORREGIDO usando INTERSECT
  SELECT COUNT(*)
  INTO common_details_count
  FROM (
    SELECT tag3_id FROM product_tag_details WHERE product_id = source_product_id
    INTERSECT
    SELECT tag3_id FROM product_tag_details WHERE product_id = target_product_id
  ) common;
  
  score := score + LEAST(common_details_count * 5, 15);
  
  RETURN score;
END;
$$ LANGUAGE plpgsql STABLE;

-- Función: Buscar productos similares (OPTIMIZADA - filtra por tag1/tag2 antes de compute_similarity)
CREATE OR REPLACE FUNCTION find_similar_products(
  source_product_id uuid,
  size_filter text DEFAULT NULL,
  limit_count integer DEFAULT 6
) RETURNS TABLE(
  product_id uuid,
  similarity_score integer,
  name text,
  category text,
  price numeric,
  color text,
  available_sizes text[]
) AS $$
BEGIN
  RETURN QUERY
  WITH source_product AS (
    SELECT p.id, p.category, pt.tag1_id, pt.tag2_id
    FROM products p
    LEFT JOIN product_tags pt ON pt.product_id = p.id
    WHERE p.id = source_product_id
  ),
  -- Filtrar candidatos por categoría y tag1/tag2 antes de calcular similitud
  -- Esto reduce significativamente las llamadas a compute_similarity
  filtered_candidates AS (
    SELECT 
      p.id as product_id,
      p.name,
      p.category,
      pt.tag1_id,
      pt.tag2_id
    FROM products p
    LEFT JOIN product_tags pt ON pt.product_id = p.id
    CROSS JOIN source_product sp
    WHERE p.id != sp.id
      AND p.status = 'active'
      AND p.category = sp.category
      -- Pre-filtrar: solo productos con mismo tag1 o tag2 (o ambos)
      -- Esto evita calcular similitud para productos completamente diferentes
      AND (
        pt.tag1_id = sp.tag1_id OR 
        pt.tag2_id = sp.tag2_id OR
        (sp.tag1_id IS NULL AND sp.tag2_id IS NULL) -- Si source no tiene tags, incluir todos
      )
  ),
  -- Calcular score solo para candidatos pre-filtrados
  candidates_with_score AS (
    SELECT 
      fc.product_id,
      fc.name,
      fc.category,
      compute_similarity(source_product_id, fc.product_id) as similarity_score
    FROM filtered_candidates fc
  ),
  -- Filtrar solo los que tienen score > 0
  valid_candidates AS (
    SELECT *
    FROM candidates_with_score
    WHERE similarity_score > 0
  ),
  variants_with_stock AS (
    SELECT 
      pv.product_id,
      pv.color,
      pv.size,
      pv.price,
      COALESCE(vws.stock_qty, 0) - COALESCE(vws.reserved_qty, 0) as available_stock
    FROM product_variants pv
    LEFT JOIN variant_warehouse_stock vws ON vws.variant_id = pv.id
    LEFT JOIN warehouses w ON w.id = vws.warehouse_id AND w.code = 'general'
    WHERE pv.active = true
      AND (size_filter IS NULL OR pv.size = size_filter)
      AND (COALESCE(vws.stock_qty, 0) - COALESCE(vws.reserved_qty, 0) > 0)
  )
  SELECT 
    c.product_id,
    c.similarity_score,
    c.name,
    c.category,
    MIN(v.price) as price,
    v.color,
    array_agg(DISTINCT v.size ORDER BY v.size) FILTER (WHERE v.size IS NOT NULL) as available_sizes
  FROM valid_candidates c
  INNER JOIN variants_with_stock v ON v.product_id = c.product_id
  GROUP BY c.product_id, c.similarity_score, c.name, c.category, v.color
  ORDER BY c.similarity_score DESC, c.name
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql STABLE;

select pg_notify('pgrst','reload schema');

