-- 41_meta_feed_rpc.sql — Función RPC para Meta Catalog Feed
-- Retorna TABLE (no JSON) con datos del feed para Facebook/Instagram Catalog
-- Usa EXCLUSIVAMENTE public.variant_size_warehouse_stock (tabla vigente)

-- Eliminar función existente si cambia el tipo de retorno
-- Nota: Si falla por dependencias, ejecutar manualmente: DROP FUNCTION IF EXISTS public.get_meta_feed() CASCADE;
DROP FUNCTION IF EXISTS public.get_meta_feed();

CREATE OR REPLACE FUNCTION public.get_meta_feed()
RETURNS TABLE (
  id text,
  item_group_id text,
  title text,
  description text,
  price text,
  availability text,
  condition text,
  brand text,
  link text,
  image_link text,
  color text,
  size text
) 
LANGUAGE sql STABLE
AS $$
WITH stock_aggregated AS (
  SELECT variant_id, COALESCE(SUM(stock_qty), 0) as total_stock
  FROM public.variant_size_warehouse_stock
  GROUP BY variant_id
),
images_data AS (
  SELECT 
    variant_id, 
    url as image_url,
    ROW_NUMBER() OVER (PARTITION BY variant_id ORDER BY position ASC) as img_rank
  FROM public.variant_images 
  WHERE url IS NOT NULL AND url != ''
)
SELECT
  pv.sku::text as id,
  p.name::text as item_group_id,
  (p.name || ' - ' || pv.color || ' - Talle ' || pv.size)::text as title,
  COALESCE(p.description, '')::text as description,
  (to_char(pv.price, 'FM999999999.00') || ' ARS')::text as price,
  CASE 
    WHEN GREATEST(0, COALESCE(sa.total_stock, 0) - COALESCE(pv.reserved_qty, 0)) > 0 
    THEN 'in stock' 
    ELSE 'out of stock' 
  END::text as availability,
  'new'::text as condition,
  'FYL'::text as brand,
  ('https://fylmoda.com.ar/index.html?sku=' || pv.sku::text)::text as link,
  COALESCE(
    (SELECT img.image_url FROM images_data img 
     WHERE img.variant_id = pv.id AND img.img_rank = 1),
    'https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1/meta-placeholder.jpg'
  )::text as image_link,
  pv.color::text,
  pv.size::text
FROM public.product_variants pv
INNER JOIN public.products p ON p.id = pv.product_id
LEFT JOIN stock_aggregated sa ON sa.variant_id = pv.id
WHERE pv.active = true 
  AND p.status = 'active' 
  AND pv.sku IS NOT NULL 
  AND pv.sku != ''
ORDER BY p.name, pv.color, pv.size;
$$;

-- Grant execute a anon y authenticated (para Edge Functions y admin/meta-feed.js)
GRANT EXECUTE ON FUNCTION public.get_meta_feed() TO anon;
GRANT EXECUTE ON FUNCTION public.get_meta_feed() TO authenticated;

-- Notificar a PostgREST para recargar schema
-- Nota: Si falla por permisos, eliminar esta línea (no es crítica para RPC desde Edge)
SELECT pg_notify('pgrst', 'reload schema');

