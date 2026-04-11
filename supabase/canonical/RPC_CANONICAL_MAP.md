# RPC Canonical Map (Plan 3)

Este documento define la fuente única de verdad para las RPC críticas consolidadas.

## Estado canónico actual

| RPC | Versión canónica efectiva | Fuente |
|---|---|---|
| `public.rpc_checkout_cart()` | `canonical:124` | `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql` + reafirmada en `149_consolidate_critical_rpcs.sql` |
| `public.rpc_close_order(uuid, text)` | `canonical:83` | `supabase/canonical/83_rpc_close_order_no_stock_deduction.sql` + reafirmada en `149_consolidate_critical_rpcs.sql` |
| `public.rpc_void_public_sale(uuid)` | `canonical:141` | `supabase/canonical/141_public_sale_stock_trace_and_void.sql` + reafirmada en `149_consolidate_critical_rpcs.sql` |

## Whitelist de redefiniciones históricas/autorizadas

Solo estos archivos pueden contener `CREATE OR REPLACE FUNCTION` para las RPC críticas:

- `public.rpc_checkout_cart()`
  - `supabase/canonical/10_checkout_flow.sql`
  - `supabase/canonical/13_warehouses.sql`
  - `supabase/canonical/82_rpc_checkout_cart_deduct_by_size.sql`
  - `supabase/canonical/86_rpc_checkout_cart_ensure_deduct_by_size.sql`
  - `supabase/canonical/122_checkout_return_order_number.sql`
  - `supabase/canonical/123_order_expiry_and_notifications.sql`
  - `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql`
  - `supabase/canonical/149_consolidate_critical_rpcs.sql`

- `public.rpc_close_order(uuid, text)`
  - `supabase/canonical/10_checkout_flow.sql`
  - `supabase/canonical/10_checkout_flow_restore.sql`
  - `supabase/canonical/52_add_closed_at_to_orders.sql`
  - `supabase/canonical/83_rpc_close_order_no_stock_deduction.sql`
  - `supabase/canonical/123_order_expiry_and_notifications.sql`
  - `supabase/canonical/149_consolidate_critical_rpcs.sql`

- `public.rpc_void_public_sale(uuid)`
  - `supabase/canonical/79_void_public_sale.sql`
  - `supabase/canonical/141_public_sale_stock_trace_and_void.sql`
  - `supabase/canonical/149_consolidate_critical_rpcs.sql`

## Política de mantenimiento

1. Cualquier ajuste futuro de estas RPC debe salir desde una nueva migración explícita de consolidación.
2. Esa migración debe actualizar este mapa y preservar los comentarios `canonical:*` en funciones.
3. El guard SQL (`150_guard_critical_rpc_versions.sql`) y el check de whitelist en CI deben pasar obligatoriamente.

