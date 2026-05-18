-- 220_ROLLBACK_curated_product_banners_schema.sql
-- Revierte 220_curated_product_banners_schema.sql (orden inverso).
--
-- ATENCIÓN: elimina datos de custom_product_banner_items.
-- custom_product_banners conserva columnas title/slug/... (opcional limpiar abajo).
-- Ejecutar solo en staging o con backup.

-- Políticas ítems
drop policy if exists admin_write_custom_product_banner_items
  on public.custom_product_banner_items;
drop policy if exists authenticated_select_custom_product_banner_items
  on public.custom_product_banner_items;
drop policy if exists anon_select_custom_product_banner_items
  on public.custom_product_banner_items;

-- Triggers + funciones dedicadas
drop trigger if exists trg_custom_product_banner_items_max_20
  on public.custom_product_banner_items;
drop trigger if exists trg_custom_product_banner_items_sync_product
  on public.custom_product_banner_items;

drop function if exists public.fyl_enforce_banner_items_max_20();
drop function if exists public.fyl_banner_item_sync_product_id();

-- Tabla ítems (CASCADE solo a sí misma)
drop table if exists public.custom_product_banner_items cascade;

-- Índices / columnas nuevas en banners
drop index if exists public.idx_custom_product_banners_enabled_sort;
drop index if exists public.uq_custom_product_banners_slug;

alter table public.custom_product_banners
  drop column if exists sort_order,
  drop column if exists cover_image,
  drop column if exists description,
  drop column if exists slug,
  drop column if exists title;

select pg_notify('pgrst', 'reload schema');
