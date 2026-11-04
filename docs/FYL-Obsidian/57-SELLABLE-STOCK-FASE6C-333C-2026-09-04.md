# 57 — Fase 6C / 333C seguridad de writes — 2026-09-04

Apply **solo 333C**. No se tocó `reserved_qty`, `cart_items`, 330/331/332, 309 ni ColorHex. No se sincronizó `catalogo1/`.

Proyecto: fyl-core (`dtfznewwvsadkorxwzft`). Migración: `333c_revoke_insecure_catalog_writes`.

Contexto de prioridad: `nj/` es la arquitectura objetivo y próxima producción. `catalogo1/` es temporal. Vanilla público residual no justifica agujeros. Admin vanilla sigue operativo.

---

## Reinterpretación de Fase 6

| Tema | Antes | Ahora |
|---|---|---|
| Vanilla residual lee `reserved_qty` | Motivo para no tocar 6A | **No** justifica conservar el modelo. 6A sigue pendiente por **admin vanilla** (stock-audit / reconcile), no por URLs viejas. |
| `cart_items` | Irrelevante en `/catalogo` | **Sí** importa: staging de checkout NJ. No limpiar ni recortar grants. |
| Grants | Pensados también para catalogo1 | catalogo1 solo necesita SELECT hasta el cutover. NJ authenticated necesita carts + checkout RPC, no write de productos/VSS. |
| 6C | Propuesto, no aplicado | **Aplicado.** |

Admin vanilla **sí depende** de la columna `reserved_qty` para `admin/stock-audit.js` (`vw_stock_audit_reserved_qty_diff` + `rpc_reconcile_stock(p_fix_reserved_qty)`). `order-creator.js` la selecciona. Por eso 333A / DROP COLUMN siguen fuera de este bloque.

---

## Qué se aplicó

SQL: `supabase/canonical/333C_revoke_insecure_catalog_writes.sql`  
Rollback: `supabase/canonical/333C_ROLLBACK_revoke_insecure_catalog_writes.sql`  
Tests: `supabase/canonical/333C_revoke_insecure_catalog_writes_tests.sql`

1. **DROP** `product_variants_all_access` (y la familia `*_all_access` del mismo origen: products, variant_images, colors, tags, product_tags).
2. **CREATE** `products_admin_manage` y `variant_images_admin_manage` (las otras tablas ya tenían policy admin).
3. **REVOKE** I/U/D/TRUNCATE de `anon` en catálogo/stock.
4. **REVOKE** TRUNCATE de `authenticated` en esas tablas.
5. **REVOKE** I/U/D de `warehouses` también a `authenticated` (admin y NJ solo SELECT; no había policy write).
6. **KEEP** SELECT anon+auth (catalogo1 + NJ).
7. **KEEP** I/U/D authenticated en variants/products/images/colors/tags/VSS/sizes (admin JWT + RLS `admins`).
8. **KEEP** EXECUTE anon de `rpc_get_variant_size_reserved` (vanilla residual ~2 días). Retirar post-cutover.
9. **KEEP** carts / cart_items / checkout authenticated.

`variants_admin_manage` ya existía. El DROP no dejó al admin sin write.

---

## Evidencia

Agujero pre-apply: `product_variants_all_access` = `FOR ALL` si `auth.role()='authenticated'`. Cualquier clienta logueada podía UPDATE variantes/productos.

Post-apply (SQL, 2026-09-04):

| Check | Resultado |
|---|---|
| Policies `*_all_access` | 0 |
| `variants_admin_manage` / `products_admin_manage` / `variant_images_admin_manage` | presentes |
| anon UPDATE variants / VSS / INSERT warehouses | false |
| anon SELECT snapshot / variants / VSS | true |
| authenticated UPDATE variants / VSS | true (GRANT; RLS solo admin) |
| authenticated INSERT warehouses / TRUNCATE variants | false |
| authenticated INSERT cart_items | true |
| anon EXECUTE reserved-by-size | true (temporal) |
| anon EXECUTE `rpc_checkout_cart()` | false |
| authenticated EXECUTE `rpc_checkout_cart()` | true |
| service_role refresh 332 | true; authenticated false |
| `rpc_checkout_cart()` md5 | `9901c2cf5a32fc2ecad95c30c247b77e` (igual) |
| 309 `fn_commit_deferred_order_item_stock(uuid)` | presente |
| Cron `catalog-snapshot-refresh-if-dirty` | `*/5`, active |
| Snapshot | 1309 filas |

RLS en transacción + ROLLBACK: customer authenticated → 0 filas en UPDATE variants/products/VSS. Admin → UPDATE no-op permitido.

UI login/carrito/checkout **no** se clickeó en esta sesión (sin credenciales de clienta). La matriz de permisos cubre el contrato.

Probe pre-apply (`sku=sku`) marcó dirty 332. Cron activo; no se forzó rebuild.

---

## Qué no se hizo

- 333A / 333B
- Revocar `rpc_get_variant_size_reserved` a anon
- Portar Fase 4 a catalogo1
- Cambiar deploy / `catalogo1/`
- Tocar ColorHex

---

## PRE-LAUNCH NJ BLOCKERS

Lista viva: [[58-NJ-PRELAUNCH-CUTOVER-2026-09-04]] §P.

`ignoreBuildErrors` cerrado. Guard staff en `/admin` cerrado. Cutover no ejecutado.
