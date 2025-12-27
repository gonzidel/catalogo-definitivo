-- 09_tag_navigation.sql — Funciones de navegación de tags jerárquicos

-- Función: Obtener tipos (Tags1) por categoría
CREATE OR REPLACE FUNCTION get_types_by_category(cat text)
RETURNS TABLE(id uuid, name text) AS $$
  SELECT t.id, t.name
  FROM tags t
  WHERE t.category = cat
    AND t.level = 1
    AND t.parent_id IS NULL
  ORDER BY t.name;
$$ LANGUAGE sql STABLE;

-- Función: Obtener atributos (Tags2) por tipo (Tags1)
CREATE OR REPLACE FUNCTION get_attributes_by_type(type_id uuid)
RETURNS TABLE(id uuid, name text) AS $$
  SELECT t.id, t.name
  FROM tags t
  WHERE t.parent_id = type_id
    AND t.level = 2
  ORDER BY t.name;
$$ LANGUAGE sql STABLE;

-- Función: Obtener detalles (Tags3) de un producto (TODOS, sin límite, desde product_tag_details)
CREATE OR REPLACE FUNCTION get_product_details(product_id uuid)
RETURNS TABLE(id uuid, name text) AS $$
  SELECT t.id, t.name
  FROM public.product_tag_details ptd
  JOIN public.tags t ON t.id = ptd.tag3_id
  WHERE ptd.product_id = get_product_details.product_id
    AND t.level = 3
  ORDER BY t.name;
$$ LANGUAGE sql STABLE;

-- Función: Obtener highlights (máx 2, desde product_tags.tag3_ids)
CREATE OR REPLACE FUNCTION get_product_highlights(product_id uuid)
RETURNS TABLE(id uuid, name text) AS $$
  SELECT t.id, t.name
  FROM public.product_tags pt
  JOIN LATERAL unnest(coalesce(pt.tag3_ids, array[]::uuid[])) AS tag3_id ON true
  JOIN public.tags t ON t.id = tag3_id
  WHERE pt.product_id = get_product_highlights.product_id
    AND t.level = 3
  ORDER BY t.name
  LIMIT 2;
$$ LANGUAGE sql STABLE;

select pg_notify('pgrst','reload schema');

