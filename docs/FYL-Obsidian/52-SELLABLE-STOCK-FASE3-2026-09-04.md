# 52 — Sellable stock: Fase 3 checkout normal — 2026-09-04

## Qué cambió

La rama **normal** de `rpc_checkout_cart()` dejó de rechazar por:

`qty > get_total_stock(variant) - reserved_qty`

La autoridad es el físico web del talle, **después** de `FOR UPDATE` sobre `variant_size_warehouse_stock` (`general` + `venta-publico`, `ORDER BY warehouse_id`).

Misma semántica que `fn_sellable_qty`. No se llama `fn_sellable_qty()` antes del lock.

Migración: `supabase/canonical/331_rpc_checkout_cart_sellable_gate.sql`  
Rollback: `supabase/canonical/331_ROLLBACK_rpc_checkout_cart_sellable_gate.sql`  
Tests: `supabase/canonical/331_rpc_checkout_cart_sellable_gate_tests.sql`

## Qué NO se tocó

- Wrapper `rpc_checkout_cart(uuid, jsonb)` (idempotencia, lock de `carts`)
- Rama 309 / `awaiting_apartado` / `fn_commit_deferred_order_item_stock`
- Split general → venta-publico
- OISS (trazabilidad)
- Cancel / expire / restore
- PDP, CartTab, snapshot, home, banners, buscador
- `rpc_reconcile_stock` / zombies

## reserved_qty

- **Lectura como gate:** eliminada.
- **Write legacy:** `reserved_qty = greatest(reserved_qty - qty, 0)` se mantiene.
- Limpieza definitiva: Fase 6.

## Locks (orden vigente, sin deadlock nuevo)

1. Wrapper: `carts` `FOR UPDATE`
2. Por línea de carrito: `product_variants` `FOR UPDATE` (serializa la variante)
3. Filas de talle: `variant_size_warehouse_stock` `FOR UPDATE` `ORDER BY warehouse_id`  
   En prod: `venta-publico` (id menor) → `general`
4. Recién ahí se compara sellable vs qty y se descuenta

## Rechazo válido vs inválido

- Válido: el físico del talle cambió entre la UI y el lock.
- Inválido (ya no): `reserved_qty` inflado.

## MD5

| Objeto | Antes | Después |
|---|---|---|
| `rpc_checkout_cart()` | `e93d0348c6b9655f1100eff803d0c825` | `9901c2cf5a32fc2ecad95c30c247b77e` |
| `rpc_checkout_cart(uuid, jsonb)` | `2bd85c8f59a82692e6cd92293f561459` | sin cambio |
| `fn_commit_deferred_order_item_stock` | `7b3b7795da94d2a43e2f8f6ac2c8342f` | sin cambio |

## Próximo (Fase 4) — hecho

Home / categorías / buscador / banners / FyL Originals alineados a sellable. Enrich ya no usa `variant_sizes`. Ver [[53-SELLABLE-STOCK-FASE4-2026-09-04]].
