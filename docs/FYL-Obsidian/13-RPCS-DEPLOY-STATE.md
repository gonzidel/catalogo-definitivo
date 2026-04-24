# 13 - RPCs Deploy State

Registro de estado/versionado de RPCs criticas.

Nota de contexto: el usuario confirmo el 2026-04-24 que los SQL analizados ya estan cargados y activos en Supabase. Aun asi, este archivo mantiene campos de verificacion tecnica porque no se consulto `pg_get_functiondef` directamente desde la base durante la auditoria.

Estados usados:

- ACTIVO SEGUN ACLARACION: el SQL analizado esta cargado/activo segun confirmacion del usuario.
- VERIFICACION TECNICA PENDIENTE: falta registrar salida real de `pg_proc`, `pg_get_functiondef`, grants o policies.
- LEGACY / HISTORICO: existe en repo pero no gobierna el flujo principal detectado.

## Estado por RPC critica

| RPC | Ultima migracion/archivo relevante en repo | Estado | Nota |
|---|---|---|---|
| `rpc_checkout_cart(uuid,jsonb)` | `174_rpc_checkout_cart_strong_idempotency.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Wrapper idempotente usado por `client/dashboard-instant.js`. |
| `rpc_checkout_cart()` | `124_rpc_checkout_cart_deduct_by_size.sql` + historial `149/86/82/13/10` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Firma interna delegada por wrapper; descuenta stock y crea pedido. |
| `rpc_apply_order_stock_deduction` | `166_rpc_apply_order_stock_deduction.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Critica para orders/admin. |
| `rpc_admin_manual_inject_and_deduct` | `179_rpc_admin_manual_inject_and_deduct.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Critica para faltantes/manual. |
| `rpc_remove_order_item_restore_stock` | `140_rpc_remove_order_item_restore_stock.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Restauracion stock. |
| `rpc_save_product_variant_initial_stock` | `139_rpc_save_product_variant_initial_stock.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Products/stock inicial. |
| `rpc_set_variant_size_stock_batch` | `164_rpc_set_variant_size_stock_batch.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Stock por talle. |
| `rpc_set_variant_warehouse_stock_batch` | `165_rpc_set_variant_warehouse_stock_batch.sql` | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Stock sin talle. |
| `rpc_create_public_sale` | `171_rpc_create_public_sale_strong_idempotency.sql` + historicos | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Venta publica idempotente. |
| `rpc_void_public_sale` | `170_rpc_void_public_sale_strong_idempotency.sql` + historicos | ACTIVO SEGUN ACLARACION + VERIFICACION TECNICA PENDIENTE | Anulacion/reversion. |
| `rpc_update_cart_item_quantity` | `124_rpc_update_cart_item_quantity.sql` | DUDOSA EN FLUJO JS | Existe en SQL; no llamada en flujo vivo auditado. |
| `get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item` | `08_cart_items_flexible_fixed.sql` | LEGACY / REVISAR GRANTS | Funciones `SECURITY DEFINER` de carrito no usadas por flujo vivo. |

## Checks sugeridos

```sql
select n.nspname as schema,
       p.proname as function_name,
       pg_get_function_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as returns,
       p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'rpc_checkout_cart',
    'rpc_create_public_sale',
    'rpc_void_public_sale',
    'rpc_apply_order_stock_deduction',
    'rpc_admin_manual_inject_and_deduct',
    'rpc_set_variant_size_stock_batch',
    'rpc_set_variant_warehouse_stock_batch'
  )
order by p.proname, args;
```

## Enlaces

- [[03-MAPA-DE-RPCS]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[99-AUDITORIA-DOCUMENTACION]]
