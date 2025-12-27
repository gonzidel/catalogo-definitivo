-- 07_uniques_and_indexes.sql — Unicidad e índices útiles

-- Unicidad
create unique index if not exists ux_products_handle on public.products(handle);
create unique index if not exists ux_variants_sku on public.product_variants(sku);
create unique index if not exists ux_variants_product_color_size on public.product_variants(product_id, color, size);

-- Índices de búsqueda / joins
create index if not exists ix_variants_product on public.product_variants(product_id);
create index if not exists ix_variants_color_size on public.product_variants(color, size);
create index if not exists ix_product_tags_product on public.product_tags(product_id);
create index if not exists ix_product_tags_tag on public.product_tags(tag_id);
create index if not exists ix_variant_images_variant_pos on public.variant_images(variant_id, position);

select pg_notify('pgrst','reload schema');

