-- 233_curated_special_banner_rpc.sql
-- Incluye banners __curated_special__ en resolución pública por slug.

CREATE OR REPLACE FUNCTION public.rpc_get_public_curated_banner_by_slug(p_slug text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_slug text := lower(trim(p_slug));
  v_banner public.custom_product_banners%ROWTYPE;
  v_items json;
BEGIN
  IF v_slug IS NULL OR v_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT b.*
  INTO v_banner
  FROM public.custom_product_banners b
  WHERE b.slug = v_slug
    AND b.tag_value IN ('__curated__', '__curated_special__')
  ORDER BY b.sort_order ASC, b.created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(
    json_agg(
      json_build_object(
        'product_variant_id', i.product_variant_id,
        'position', i.position
      )
      ORDER BY i.position ASC
    ),
    '[]'::json
  )
  INTO v_items
  FROM public.custom_product_banner_items i
  WHERE i.banner_id = v_banner.id;

  IF json_array_length(v_items) = 0 THEN
    RETURN NULL;
  END IF;

  RETURN json_build_object(
    'id', v_banner.id,
    'title', v_banner.title,
    'name', v_banner.name,
    'slug', v_banner.slug,
    'description', v_banner.description,
    'enabled', v_banner.enabled,
    'sort_order', v_banner.sort_order,
    'tag_value', v_banner.tag_value,
    'custom_product_banner_items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_public_curated_banner_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_get_public_curated_banner_by_slug(text) TO anon, authenticated, service_role;

SELECT pg_notify('pgrst', 'reload schema');
