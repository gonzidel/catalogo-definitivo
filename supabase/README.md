# Supabase SQL — versión canónica

Esta carpeta contiene los scripts idempotentes que definen el backend del catálogo, clientes y pedidos. Ejecutalos en este orden (en SQL Editor → New query → Run):

0. `canonical/00_products_timestamps.sql`
   - Agrega `created_at` y `updated_at` a `public.products` + trigger `updated_at`
1. `canonical/01_customers.sql`
   - Tabla `public.customers` + RLS (cada usuario ve/modifica su perfil)
2. `canonical/02_tags.sql`
   - Tabla `public.tags` + `public.product_tags` + RLS y semillas
3. `canonical/03_colors.sql` (opcional)
   - Tabla `public.colors` + RLS y semillas
4. `canonical/04_catalog_public_view.sql`
   - Vista pública `catalog_public_view` (incluye Tags mapeados a Filtro1/2/3)
5. `canonical/05_orders.sql`
   - Carrito (`carts`, `cart_items`) + RLS + RPC (`rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart`, `rpc_admin_set_item_status`, `rpc_close_cart`)
6. `canonical/99_reload_api.sql`
   - Recarga el esquema del API REST

## Notas

- Los scripts son idempotentes: podés ejecutarlos más de una vez sin romper nada.
- La carpeta `supabase/archive/` (si la creás) puede contener versiones antiguas; no afectan al proyecto.
- Si agregás nuevas RPC o tablas, seguí este formato: crear tabla/columnas → triggers → RLS → RPC → `pg_notify`.
