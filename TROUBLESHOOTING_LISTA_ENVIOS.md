# Lista de envíos (Imprimir Lista de Envíos)

## Flujo de datos

1. **orders** — Pedidos con `status = 'sent'` y fecha de envío (sent_at, closed_at o updated_at) en hora Argentina.
2. **daily_sales** — Se alimenta por trigger desde `orders` cuando un pedido pasa a `sent`; registra una fila por envío con `sale_type = 'envios'` y `sale_date` en hora Argentina. La tarjeta "VENTAS ENVIOS" en `daily-sales.html` usa esta tabla vía `get_daily_sales_summary`.
3. **Lista de envíos en closed-orders** — Ya no consulta directamente la tabla `orders` (que estaba limitada por PostgREST a ~24 filas). Usa la RPC **rpc_get_shipping_orders(p_date, p_transport_id)** que corre en el servidor y devuelve todos los pedidos del día para el transporte indicado, sin límite de filas.

## Archivos relevantes

- **SQL:** `supabase/canonical/81_rpc_get_shipping_orders.sql` — Define `rpc_get_shipping_orders` (lista por día + transporte) y `rpc_get_shipping_orders_range` (rango de fechas para Excel).
- **Frontend:** `admin/closed-orders.js` — `loadOrdersForList()` llama a `rpc_get_shipping_orders`; `loadOrdersForExtract()` llama a `rpc_get_shipping_orders_range`.

## Cómo aplicar el cambio en Supabase

Ejecutar el script SQL en el proyecto de Supabase (Dashboard → SQL Editor o migraciones):

```bash
# Contenido de supabase/canonical/81_rpc_get_shipping_orders.sql
```

Tras ejecutarlo, la lista "Imprimir Lista de Envíos" y la extracción a Excel usarán estas RPC y mostrarán todos los envíos del día/rango, no solo las primeras 24 filas.

## Si la lista no coincide con daily-sales

- **Conteo distinto:** La lista usa `orders.status = 'sent'` y la fecha en hora Argentina. Si un pedido está en `daily_sales` pero no en la lista, revisar que el pedido tenga `status = 'sent'` y que `sent_at` (o closed_at/updated_at) en hora Argentina sea la fecha del día.
- **Transporte:** La lista filtra por `order.transport_id` o `customer.transport_id`. Si falta un pedido, comprobar que ese pedido o su cliente tengan asignado el transporte seleccionado.
