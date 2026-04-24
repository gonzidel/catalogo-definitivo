# 11 - Decisiones tecnicas registradas

## Decisiones vigentes

1. Stock con talle vive en `variant_size_warehouse_stock`.
2. `variant_sizes.stock_qty` es derivado/agregado y no debe ser canal primario de escritura.
3. Pedidos admin usan split `qty_from_general` / `qty_from_venta` cuando aplica.
4. `admin_confirmed_missing` no significa solo `status = missing`; tambien participa en `picked` manual.
5. Checkout cliente usa `rpc_checkout_cart(uuid,jsonb)` con `operation_id` e idempotencia fuerte.
6. Venta publica y anulacion deben pasar por RPCs idempotentes (`rpc_create_public_sale`, `rpc_void_public_sale`).
7. Costos y margenes se consideran sensibles: UI solo para `super_admin`, y DB debe validarse aparte.
8. La documentacion viva se actualiza junto con cambios de logica.

## Decisiones documentales 2026-04-24

- Las auditorias modulares 14-19 son la referencia mas reciente por modulo.
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] concentra riesgos transversales.
- [[13-RPCS-DEPLOY-STATE]] registra version/firma activa de RPCs criticas.
- Si un mapa general contradice una auditoria modular, se corrige el mapa.

## Enlaces

- [[14-AUDITORIA-MODULO-PRODUCTS]]
- [[16-AUDITORIA-MODULO-STOCK]]
- [[17-AUDITORIA-MODULO-ORDERS]]
- [[18-AUDITORIA-MODULO-PUBLIC-SALES]]
- [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
- [[99-AUDITORIA-DOCUMENTACION]]
