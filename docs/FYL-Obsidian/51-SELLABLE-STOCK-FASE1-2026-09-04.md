# 51 — Sellable stock canónico (Fase 1) — 2026-09-04

## Qué cambió

Se estableció la fuente canónica de disponibilidad pública:

`sellable_qty = stock físico web libre restante` en `variant_size_warehouse_stock` para `general` + `venta-publico`.

Migración: `supabase/canonical/330_sellable_stock_canonical.sql`  
Rollback: `supabase/canonical/330_ROLLBACK_sellable_stock_canonical.sql`  
Tests read-only: `supabase/canonical/330_sellable_stock_canonical_readonly_tests.sql`

Objetos nuevos:

- `fn_norm_size(text)` IMMUTABLE
- `fn_sellable_qty(uuid, text)` STABLE SECURITY INVOKER
- `fn_sellable_stock_batch(uuid[])` STABLE SECURITY INVOKER (máx 500)

`catalog_public_available_view` dejó de restar OISS y `cart_items`. El contrato de columnas (28 cols, tipos, orden) se preservó.

## Por qué

Checkout/commit ya descuentan `stock_qty` al comprometer. OISS es trazabilidad para devolver en cancel/expire. Restarlo otra vez double-count (5 − 2 checkout → físico 3; 3 − OISS 2 → 1, incorrecto).

## Qué NO se tocó

- `rpc_checkout_cart` (sigue gatedo con `reserved_qty`)
- Flujo 309 / `awaiting_apartado`
- PDP, CartTab, Zustand, `addItem`
- Snapshot refresh / cron
- Limpieza de zombies / reconcile de `reserved_qty`
- Vanilla, banners, FyL Originals, curated, buscador, CatalogShell

## Snapshot

330 **no** llama `rpc_refresh_catalog_public_snapshot()`. El index NJ puede seguir mostrando la copia previa hasta un refresh admin explícito. Validar contra la vista live.

## Aplicado en fyl-core

Migraciones MCP (sin refresh de snapshot, sin tocar checkout):

- `330_sellable_stock_canonical_fns`
- `330_sellable_stock_canonical_view`

Fingerprint `rpc_checkout_cart()` sin cambio: `e93d0348c6b9655f1100eff803d0c825`.

Vista live 1309 filas = snapshot 1309; 0 diffs de `variant_id` / `Numeracion` en este corte. Motivo: no hay talles con físico web > 0 y (OISS+cart) ≥ físico (el double-count sigue tapado). No se refrescó el snapshot.

## Evidencia de producción al implementar

- Warehouses reales: solo `general` y `venta-publico`.
- No existe talle `35.0` en `variant_size_warehouse_stock`.
- 28 grupos OISS abiertos, todos con físico web 0 (double-count tapado).
- `order_items.status` no incluye `awaiting_apartado` en este corte (0 filas).
- RLS: `anon`/`authenticated` tienen SELECT en stock y warehouses; las funciones son INVOKER y no escriben.

## Fase 2 (2026-09-04) — PDP + CartTab

Helper único: `nj/lib/stock/sellable-stock.ts` → `fn_sellable_stock_batch`.

- PDP (`PdpLoader` / `PdpSizePicker`): talle comprable ⇔ `sellable_qty > 0`. Color `hasStock` ⇔ algún talle de esa variante con sellable > 0.
- CartTab: eliminada `min(físico, variant − reserved_qty)`. Misma RPC/SWR key `sellable-stock`.
- Revalidación: `revalidateOnFocus` + `revalidateOnReconnect`, dedupe 8s. CartTab reconsulta otra vez antes de «Hacer pedido».
- `addItem` sigue siendo solo local. No reserva.
- `rpc_checkout_cart` no se tocó en Fase 2. El gate `reserved_qty` se alineó en Fase 3. Ver [[52-SELLABLE-STOCK-FASE3-2026-09-04]].

## Fase 3 (2026-09-04)

Checkout normal: el gate `get_total_stock − reserved_qty` se eliminó. La autoridad es el físico web del talle bajo `FOR UPDATE`. `reserved_qty` se sigue escribiendo. 309 intacto. Ver [[52-SELLABLE-STOCK-FASE3-2026-09-04]].

## Fase 4 (2026-09-04)

Listados públicos (home, categorías, ofertas, FyL, banners, buscador, cards) usan la señal sellable del snapshot/vista. El enrich ya no gobierna `hasStock` con `variant_sizes.stock_qty`. Ver [[53-SELLABLE-STOCK-FASE4-2026-09-04]].

## Fase 5 (2026-09-04)

Snapshot dirty + cron 5 min + `change_revision`. Ver [[54-SELLABLE-STOCK-FASE5-2026-09-04]].
