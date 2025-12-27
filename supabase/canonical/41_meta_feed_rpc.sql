-- 41_meta_feed_rpc.sql — Función RPC para Meta Catalog Feed
-- Retorna TABLE (no JSON) con datos del feed para Facebook/Instagram Catalog

-- Eliminar función existente si cambia el tipo de retorno
DROP FUNCTION IF EXISTS get_meta_feed();

CREATE OR REPLACE FUNCTION get_meta_feed()
RETURNS TABLE (
  id text,
  item_group_id text,
  title text,
  description text,
  price text,
  availability text,
  condition text,
  brand text,
  image_link text,
  color text,
  size text
) 
LANGUAGE sql STABLE
AS $$
WITH stock_aggregated AS (
  SELECT variant_id, COALESCE(SUM(stock_qty), 0) as total_stock
  FROM variant_warehouse_stock 
  GROUP BY variant_id
),
images_data AS (
  SELECT 
    variant_id, 
    url as image_url,
    ROW_NUMBER() OVER (PARTITION BY variant_id ORDER BY position ASC) as img_rank
  FROM variant_images 
  WHERE url IS NOT NULL AND url != ''
)
SELECT
  pv.sku::text as id,
  p.name::text as item_group_id,
  (p.name || ' - ' || pv.color || ' - Talle ' || pv.size)::text as title,
  COALESCE(p.description, '')::text as description,
  (to_char(pv.price, 'FM999999999.00') || ' ARS')::text as price,
  CASE 
    WHEN (COALESCE(sa.total_stock, 0) - COALESCE(pv.reserved_qty, 0)) > 0 
    THEN 'in stock' 
    ELSE 'out of stock' 
  END::text as availability,
  'new'::text as condition,
  'FYL'::text as brand,
  pv.color::text,
  pv.size::text,
  -- image_link NUNCA vacío: fallback chain
  -- 1. variant_images(position=1) de la variante actual
  -- 2. placeholder Cloudinary fijo (hardcodeado)
  COALESCE(
    (SELECT img.image_url FROM images_data img 
     WHERE img.variant_id = pv.id AND img.img_rank = 1),
    'https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1/meta-placeholder.jpg'
  )::text as image_link
FROM product_variants pv
INNER JOIN products p ON p.id = pv.product_id
LEFT JOIN stock_aggregated sa ON sa.variant_id = pv.id
WHERE pv.active = true 
  AND p.status = 'active' 
  AND pv.sku IS NOT NULL 
  AND pv.sku != ''
ORDER BY p.name, pv.color, pv.size;
$$;

-- Grant execute a anon (para Edge Functions)
GRANT EXECUTE ON FUNCTION get_meta_feed() TO anon;
GRANT EXECUTE ON FUNCTION get_meta_feed() TO authenticated;

-- Notificar a PostgREST para recargar schema
SELECT pg_notify('pgrst', 'reload schema');

