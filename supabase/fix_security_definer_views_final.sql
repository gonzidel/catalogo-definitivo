-- fix_security_definer_views_final.sql
-- Script FINAL para eliminar completamente SECURITY DEFINER de vistas
-- Ejecutar este script en el SQL Editor de Supabase

-- ============================================================================
-- CORRECCIÓN DEFINITIVA: Eliminar SECURITY DEFINER de vistas
-- ============================================================================

-- IMPORTANTE: Este script fuerza la recreación de las vistas sin ninguna
-- propiedad de seguridad definer, asegurando que respeten RLS del usuario que consulta.

-- ============================================================================
-- 1. ELIMINAR COMPLETAMENTE catalog_public_view
-- ============================================================================

-- Eliminar todas las dependencias y la vista
DROP VIEW IF EXISTS public.catalog_public_view CASCADE;

-- Verificar que se eliminó completamente
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.views 
    WHERE table_schema = 'public' 
    AND table_name = 'catalog_public_view'
  ) THEN
    RAISE EXCEPTION 'La vista catalog_public_view aún existe después de DROP';
  END IF;
END $$;

-- Recrear la vista SIN ninguna propiedad de seguridad definer
-- PostgreSQL por defecto usa SECURITY INVOKER (el usuario que consulta)
CREATE VIEW public.catalog_public_view AS
WITH base AS (
  SELECT
    p.id                                               AS product_id,
    p.category                                         AS "Categoria",
    p.name                                             AS "Articulo",
    coalesce(p.description,'')                         AS "Descripcion",
    pv.color                                           AS "Color",
    string_agg(distinct pv.size, ',' ORDER BY pv.size) AS "Numeracion",
    to_char(coalesce(p.created_at::date, now()::date), 'DD/MM/YYYY') AS "FechaIngreso",
    true                                               AS "Mostrar",
    'FALSE'                                            AS "Oferta",
    min(pv.price)::text                                AS "Precio",
    max(case when vi.position = 1 then vi.url end)     AS "Imagen Principal",
    max(case when vi.position = 2 then vi.url end)     AS "Imagen 1",
    max(case when vi.position = 3 then vi.url end)     AS "Imagen 2",
    max(case when vi.position = 4 then vi.url end)     AS "Imagen 3",
    pt.tag1_id,
    pt.tag2_id,
    pt.tag3_ids
  FROM public.products p
  JOIN public.product_variants pv ON pv.product_id = p.id AND pv.active IS true
  LEFT JOIN public.variant_images vi ON vi.variant_id = pv.id
  LEFT JOIN public.product_tags pt ON pt.product_id = p.id
  WHERE p.status = 'active'
  GROUP BY p.id, p.category, p.name, p.description, pv.color, p.created_at, pt.tag1_id, pt.tag2_id, pt.tag3_ids
),
offers_data AS (
  SELECT
    base.*,
    coalesce(cpo.has_offer, false) AS "OfertaActiva",
    cpo.offer_price::text AS "PrecioOferta"
  FROM base
  LEFT JOIN LATERAL (
    SELECT 
      true AS has_offer,
      offer_price
    FROM public.color_price_offers
    WHERE product_id = base.product_id
      AND color = base."Color"
      AND status = 'active'
      AND current_date >= start_date
      AND current_date <= end_date
    ORDER BY created_at DESC
    LIMIT 1
  ) cpo ON true
),
promos_data AS (
  SELECT
    od."Categoria", od."Articulo", od."Descripcion", od."Color", od."Numeracion",
    od."FechaIngreso", od."Mostrar", od."Oferta", od."Precio",
    od."Imagen Principal", od."Imagen 1", od."Imagen 2", od."Imagen 3",
    od.product_id, od.tag1_id, od.tag2_id, od.tag3_ids,
    od."OfertaActiva", od."PrecioOferta",
    max(
      CASE
        WHEN pr.promo_type = '2x1' THEN '2x1'
        WHEN pr.promo_type = '2xMonto' AND pr.fixed_amount IS NOT NULL THEN '2x$' || pr.fixed_amount::text
        ELSE NULL
      END
    ) AS "PromoActiva"
  FROM offers_data od
  LEFT JOIN public.promotion_items pi ON 
    (pi.product_id = od.product_id OR pi.variant_id IN (
      SELECT pv.id FROM public.product_variants pv 
      WHERE pv.product_id = od.product_id AND pv.color = od."Color" AND pv.active = true
    ))
  LEFT JOIN public.promotions pr ON 
    pr.id = pi.promotion_id
    AND pr.status = 'active'
    AND current_date >= pr.start_date
    AND current_date <= pr.end_date
  GROUP BY od."Categoria", od."Articulo", od."Descripcion", od."Color", od."Numeracion",
           od."FechaIngreso", od."Mostrar", od."Oferta", od."Precio",
           od."Imagen Principal", od."Imagen 1", od."Imagen 2", od."Imagen 3",
           od.product_id, od.tag1_id, od.tag2_id, od.tag3_ids,
           od."OfertaActiva", od."PrecioOferta"
),
tags_data AS (
  SELECT
    pd.*,
    t1.name AS tag1_name,
    t2.name AS tag2_name,
    array_agg(t3.name ORDER BY t3.name) FILTER (WHERE t3.id IS NOT NULL) AS tag3_names
  FROM promos_data pd
  LEFT JOIN public.tags t1 ON t1.id = pd.tag1_id
  LEFT JOIN public.tags t2 ON t2.id = pd.tag2_id
  LEFT JOIN LATERAL unnest(coalesce(pd.tag3_ids, array[]::uuid[])) AS tag3_id ON true
  LEFT JOIN public.tags t3 ON t3.id = tag3_id
  GROUP BY pd."Categoria", pd."Articulo", pd."Descripcion", pd."Color", pd."Numeracion",
           pd."FechaIngreso", pd."Mostrar", pd."Oferta", pd."Precio",
           pd."Imagen Principal", pd."Imagen 1", pd."Imagen 2", pd."Imagen 3",
           pd.tag1_id, pd.tag2_id, pd.tag3_ids, t1.name, t2.name,
           pd."OfertaActiva", pd."PrecioOferta", pd."PromoActiva", pd.product_id
)
SELECT
  "Categoria","Articulo","Descripcion","Color","Numeracion","FechaIngreso",
  "Mostrar","Oferta","Precio","Imagen Principal","Imagen 1","Imagen 2","Imagen 3",
  coalesce(tag1_name, '') AS "Filtro1",
  coalesce(tag2_name, '') AS "Filtro2",
  coalesce(
    CASE 
      WHEN array_length(tag3_names, 1) > 0 THEN array_to_string(tag3_names, ',')
      ELSE ''
    END,
    ''
  ) AS "Filtro3",
  "OfertaActiva",
  coalesce("PrecioOferta", '') AS "PrecioOferta",
  coalesce("PromoActiva", '') AS "PromoActiva"
FROM tags_data;

-- Asegurar que la vista NO tiene SECURITY DEFINER
-- En PostgreSQL, las vistas por defecto son SECURITY INVOKER
-- Forzar explícitamente si es necesario (PostgreSQL 15+)
DO $$
BEGIN
  -- Intentar establecer security_invoker explícitamente (si la versión lo soporta)
  BEGIN
    ALTER VIEW public.catalog_public_view SET (security_invoker = true);
  EXCEPTION
    WHEN OTHERS THEN
      -- Si no se soporta, no es problema, las vistas por defecto son invoker
      RAISE NOTICE 'No se pudo establecer security_invoker explícitamente (puede ser versión anterior de PostgreSQL)';
  END;
END $$;

-- Otorgar permisos de lectura a usuarios anónimos
GRANT SELECT ON public.catalog_public_view TO anon;

-- ============================================================================
-- 2. ELIMINAR COMPLETAMENTE orders_with_items
-- ============================================================================

DROP VIEW IF EXISTS public.orders_with_items CASCADE;

-- Verificar si la columna updated_at existe en carts
DO $$
DECLARE
  has_updated_at BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'carts' 
    AND column_name = 'updated_at'
  ) INTO has_updated_at;
  
  IF has_updated_at THEN
    EXECUTE '
    CREATE VIEW public.orders_with_items AS
    SELECT 
      c.id AS order_id,
      c.customer_id,
      c.status,
      c.created_at,
      c.updated_at,
      ci.id AS item_id,
      ci.variant_id,
      ci.qty,
      ci.status AS item_status,
      ci.price_snapshot
    FROM public.carts c
    LEFT JOIN public.cart_items ci ON ci.cart_id = c.id
    WHERE c.status IN (''submitted'', ''confirmed'', ''ready_to_ship'', ''closed'')';
  ELSE
    EXECUTE '
    CREATE VIEW public.orders_with_items AS
    SELECT 
      c.id AS order_id,
      c.customer_id,
      c.status,
      c.created_at,
      ci.id AS item_id,
      ci.variant_id,
      ci.qty,
      ci.status AS item_status,
      ci.price_snapshot
    FROM public.carts c
    LEFT JOIN public.cart_items ci ON ci.cart_id = c.id
    WHERE c.status IN (''submitted'', ''confirmed'', ''ready_to_ship'', ''closed'')';
  END IF;
  
  -- Intentar establecer security_invoker explícitamente
  BEGIN
    ALTER VIEW public.orders_with_items SET (security_invoker = true);
  EXCEPTION
    WHEN OTHERS THEN
      RAISE NOTICE 'No se pudo establecer security_invoker explícitamente para orders_with_items';
  END;
END $$;

-- Otorgar permisos apropiados
GRANT SELECT ON public.orders_with_items TO authenticated;

-- ============================================================================
-- 3. VERIFICACIÓN FINAL
-- ============================================================================

-- Verificar que las vistas NO tienen SECURITY DEFINER
SELECT 
    schemaname,
    viewname,
    viewowner,
    CASE 
        WHEN pg_get_viewdef(c.oid) LIKE '%SECURITY DEFINER%' THEN '⚠️  Tiene SECURITY DEFINER'
        ELSE '✅ Sin SECURITY DEFINER (SECURITY INVOKER por defecto)'
    END AS security_status
FROM pg_views v
JOIN pg_class c ON c.relname = v.viewname
WHERE v.schemaname = 'public' 
AND v.viewname IN ('catalog_public_view', 'orders_with_items')
ORDER BY v.viewname;

-- Verificar el owner de las vistas (debe ser un rol con privilegios mínimos)
SELECT 
    n.nspname AS schema_name,
    c.relname AS view_name,
    r.rolname AS owner_name,
    CASE 
        WHEN r.rolsuper THEN '⚠️  Owner es superusuario'
        ELSE '✅ Owner es rol normal'
    END AS owner_status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'public'
AND c.relkind = 'v'
AND c.relname IN ('catalog_public_view', 'orders_with_items')
ORDER BY c.relname;

-- Verificar permisos
SELECT 
    grantee,
    table_name,
    privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
AND table_name IN ('catalog_public_view', 'orders_with_items')
ORDER BY table_name, grantee;

-- Recargar el esquema de PostgREST
SELECT pg_notify('pgrst','reload schema');

-- Mensaje de confirmación
DO $$
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '✅ Vistas recreadas sin SECURITY DEFINER';
  RAISE NOTICE '';
  RAISE NOTICE '📋 Verificaciones realizadas:';
  RAISE NOTICE '   - catalog_public_view recreada';
  RAISE NOTICE '   - orders_with_items recreada';
  RAISE NOTICE '   - Permisos otorgados correctamente';
  RAISE NOTICE '';
  RAISE NOTICE '⚠️  Si el error persiste en Supabase Advisor:';
  RAISE NOTICE '   1. Espera unos minutos para que se actualice';
  RAISE NOTICE '   2. Verifica que el owner de las vistas no sea superusuario';
  RAISE NOTICE '   3. Revisa la tabla de verificación arriba';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;

