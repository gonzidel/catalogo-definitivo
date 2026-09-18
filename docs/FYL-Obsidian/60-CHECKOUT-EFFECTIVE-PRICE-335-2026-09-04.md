# 60 — Checkout: autoridad de precio `get_effective_price` — 2026-09-04

Complementa [[07-FLUJO-ADMIN-PRODUCTOS]] y [[59-NJ-CHECKOUT-IDEMPOTENCY-ROOT-PREP-2026-09-04]].

**No es lanzamiento.** No se tocó routing `www`, cutover, SEO, stock architecture, 309, 330–333C.

Backend live: **fyl-core** (`dtfznewwvsadkorxwzft`). Migración `335_rpc_checkout_cart_effective_price`.

## Qué cambió

Dominio live `rpc_checkout_cart()` (sin args, oid previo 198907):

Antes:

```sql
SELECT price INTO v_item_price FROM product_variants WHERE id = r.variant_id;
v_item_price := COALESCE(NULLIF(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0);
```

Ahora (rama normal y rama 309):

```sql
v_item_price := public.get_effective_price(r.variant_id);
-- aborta si NULL o <= 0
```

`order_items.price_snapshot` y `orders.total_amount` usan ese valor (promos 2x siguen sobre líneas ya persistidas).

Wrapper `rpc_checkout_cart(uuid, jsonb)` **no** se modificó (md5 `2bd85c8f59a82692e6cd92293f561459`). Replay de `operation_id` completed no recalcula.

## Case sensitivity (pre-deploy)

- Ofertas `status=active` en ventana: **219**
- Mismatch exacto color oferta vs variante: **0**
- Mismatch solo case / trim: **0**

## Snapshot 8000 suela

2 filas en `catalog_public_snapshot` / 1 `variant_id`. `get_effective_price` = 20000. No se arregló en 335.

## Frontend

No hay aviso `price_snapshot != effective` antes de “Hacer pedido”. Recomendación (fase UI): comparar snapshots del carrito vs snapshot/RPC y toast corto si cambió; no bloquear 335.

## Tests runtime (cuenta `771a9a9c-…`)

VSS físico restaurado exacto. `reserved_qty` bajó (semántica 331 preexistente, no se tocó). Pedidos de prueba cancelados/borrados.

## Rollback

`supabase/canonical/335_ROLLBACK_rpc_checkout_cart_effective_price.sql` restaura canonical 331.
