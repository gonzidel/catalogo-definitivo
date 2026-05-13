# Checkout Concurrency Runbook

Objetivo: validar idempotencia, locks y prevención de overselling sin tocar stock
real.

## Requisitos

- Staging o fixtures aislados.
- Cliente de prueba autenticado.
- Carrito de prueba con un item de stock controlado.
- Producto/variante/talle creado para auditoría, no usado por ventas reales.

## Script

Archivo: `scripts/checkout-concurrency-smoke.mjs`.

Variables requeridas:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `FYL_TEST_ACCESS_TOKEN`
- `FYL_TEST_CART_ID`

En producción, el script se niega a correr salvo que se agregue
`FYL_CONCURRENCY_ALLOW_PROD_FIXTURES=1`.

## Escenarios Cubiertos

- Mismo `operation_id` repetido: debe responder replay o conflicto controlado,
  sin duplicar pedido ni descuento.
- Dos `operation_id` distintos sobre el mismo carrito: solo una operación debe
  cerrar el carrito.

## Verificaciones SQL Posteriores

```sql
select stock_qty
from public.variant_size_warehouse_stock
where variant_id = '<variant_id>' and size = '<size>' and warehouse_id = '<warehouse_id>';

select order_id, count(*)
from public.order_items
where variant_id = '<variant_id>' and size = '<size>'
group by order_id;

select *
from public.order_item_stock_sources
where order_item_id in (
  select id from public.order_items
  where variant_id = '<variant_id>' and size = '<size>'
);
```

## Gate

No modificar lógica de checkout/stock si alguno de estos checks falla:

- Stock físico negativo.
- `reserved_qty` desalineado.
- Doble `order_item` para el mismo carrito cerrado.
- Carrito vacío después de checkout fallido.
