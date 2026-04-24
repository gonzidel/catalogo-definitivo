# 04 - Flujo de stock

Para la auditoria real del modulo, ver [[16-AUDITORIA-MODULO-STOCK]].

## Fuente de verdad

- Con talle: `variant_size_warehouse_stock`.
- Derivados/agregados: `variant_sizes.stock_qty` y, segun caso, `variant_warehouse_stock`.
- Depositos clave: `general` y `venta-publico`.
- Triggers/migraciones relevantes: `84`, `145`, `148`.

## Escritura segura

No escribir a mano stock derivado. Usar RPCs:

| Caso | RPC/flujo |
|---|---|
| Alta/stock inicial producto | `rpc_save_product_variant_initial_stock` |
| Ajuste con talle | `rpc_set_variant_size_stock_batch` |
| Ajuste sin talle | `rpc_set_variant_warehouse_stock_batch` |
| Mover stock | `rpc_move_size_stock` |
| Pedido admin | `rpc_apply_order_stock_deduction` |
| Manual/faltante admin | `rpc_admin_manual_inject_and_deduct` |
| Checkout cliente | `rpc_checkout_cart(uuid,jsonb)` -> `rpc_checkout_cart()` interna |
| Venta publica | `rpc_create_public_sale`, `rpc_void_public_sale` |
| Restaurar item pedido | `rpc_remove_order_item_restore_stock` |

## Cruces

| Origen | Impacto stock | Nota |
|---|---|---|
| Products | Alta/edicion inicial de variantes y talles | [[14-AUDITORIA-MODULO-PRODUCTS]] |
| Orders | Descuento/restauracion de pedidos | [[17-AUDITORIA-MODULO-ORDERS]] |
| Cliente/Carrito | Checkout descuenta y vacia carrito | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |
| Public Sales | Venta/anulacion de caja modifica stock | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |

## Estados especiales

- `admin_confirmed_missing` no es sinonimo exclusivo de `status = missing`.
- Tambien aparece con `picked` para "Apartado manual".
- Ver [[17-AUDITORIA-MODULO-ORDERS]].

## Riesgos

- Modificar `variant_sizes.stock_qty` directo.
- Permitir RPCs `SECURITY DEFINER` sin permiso granular.
- Desalinear stock entre Orders, Public Sales y Cliente checkout.
- Confundir `price_snapshot`/carrito con precio real de DB.

## Enlaces

- [[16-AUDITORIA-MODULO-STOCK]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[03-MAPA-DE-RPCS]]
- [[13-RPCS-DEPLOY-STATE]]
