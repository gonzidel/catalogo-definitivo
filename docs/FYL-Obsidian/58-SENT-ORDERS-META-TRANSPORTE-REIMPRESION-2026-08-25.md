# Sent-orders — meta de transporte / reimpresión / fecha (2026-08-25)

## Problema

En `admin/sent-orders.html`, al abrir un cliente, la tarjeta del pedido no mostraba:

- con qué transporte se envió
- si se reimprimió el rótulo
- si en la reimpresión se cambió de transporte
- si se reprogramó la fecha (original → nueva)

Además, `rpc_reschedule_sent_order` sobrescribía `sent_at` sin guardar la fecha original.

## Solución

Migración: `supabase/canonical/304_sent_order_shipping_meta.sql`

| Pieza | Rol |
|-------|-----|
| `orders.original_sent_at` | Primera fecha de envío; se preserva al reprogramar |
| `orders.sent_transport_id` | Transporte del envío original |
| `orders.last_label_transport_id` | Transporte de la última impresión/reimpresión |
| `orders.labels_reprinted` / `last_reprinted_at` | Marca de reimpresión |
| `rpc_mark_order_as_sent` | Snapshot de fecha + transporte al finalizar |
| `rpc_reschedule_sent_order` | Conserva `original_sent_at` |
| `rpc_record_sent_order_label_reprint` | Registra reimpresión + transporte usado |

Frontend (`admin/sent-orders.js` / `.html`):

- Chips en la tarjeta del pedido (transporte, reimpreso, cambio de fecha)
- Al reimprimir rótulos: opción de cambiar transporte + registro vía RPC
- Fallback de carga si la migración 304 aún no está aplicada

## Backfill

Pedidos ya `sent`/`devolución`: `original_sent_at = sent_at` y transporte desde `orders.transport_id` / `customers.transport_id`. **No recupera** fechas originales de reprogramaciones históricas previas al deploy.

## Verificación

1. Aplicar 304 en `fyl-core` (aprobación explícita).
2. Abrir un cliente en sent-orders → chip de transporte visible.
3. Reimprimir rótulo (con o sin cambio de transporte / fecha) → chips `Reimpreso` y/o `Fecha: dd/mm → dd/mm`.
4. Nuevo pedido marcado como sent desde closed-orders → `original_sent_at` y `sent_transport_id` seteados.

## Rollback

- Frontend: revertir chips / llamadas a `rpc_record_sent_order_label_reprint`.
- SQL: restaurar `rpc_mark_order_as_sent` (227) y `rpc_reschedule_sent_order` (19); las columnas nuevas pueden quedar (nullable, sin impacto).

## Riesgo

Bajo. Additive columns + RPCs admin-only. Trigger `daily_sales` sigue disparándose por cambio de status en mark-as-sent.
