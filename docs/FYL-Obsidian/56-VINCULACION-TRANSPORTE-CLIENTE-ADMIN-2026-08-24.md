# Vinculación transporte cliente NJ ↔ admin closed-orders (2026-08-24)

## Problema

- Admin (`closed-orders`) guardaba en `customers.transport_id` vía `rpc_update_customer_transport`.
- NJ (perfil / confirmación de cierre) solo usaba `localStorage` (`fyl_transporte_*`) y **no** escribía en BD.
- Al cerrar, NJ no llamaba `rpc_set_transport_before_close_order` (sí lo hacía el dashboard legacy).

Resultado: el transporte del cliente y el del admin podían diferir.

## Solución

Migración: `supabase/canonical/303_rpc_customer_transport_link.sql`

| Pieza | Rol |
|-------|-----|
| `resolve_transport_id(name)` | Match canónico (Retira/Retiro Local, Snaider, etc.) |
| `rpc_set_my_transport(name)` | Cliente guarda preferencia → `customers` + pedidos `active`/`closing_soon`/`closed` |
| `rpc_set_transport_before_close_order` | Mejorado: match canónico + permite `closing_soon` |
| `rpc_update_customer_transport` | Admin: además sincroniza esos pedidos |

Frontend NJ:

- `ProfileShippingBlock` → `rpc_set_my_transport`
- `ActiveOrderTab` (confirmación + antes de cerrar) → `rpc_set_transport_before_close_order`
- Header/dashboard prioriza nombre desde BD sobre geo/localStorage
- El header **no** lee `localStorage` en el primer paint (SSR + hidratación). `getTransporte()` solo corre después de montar; si no, el server pinta Correo Argentino y el cliente Credifin (u otra elección guardada).

## Fuente de verdad

`customers.transport_id` (y `orders.transport_id` en pedidos operativos). Lectura admin: `COALESCE(order.transport_id, customer.transport_id)` como antes.

## Verificación

1. ~~Aplicar 303 en `fyl-core` (aprobación explícita).~~ **Aplicada 2026-09-02** en `fyl-core` (`dtfznewwvsadkorxwzft`) — antes faltaba `rpc_set_my_transport` (404 en perfil NJ).
2. Cliente cambia transporte en perfil → aparece el mismo UUID/nombre en closed-orders.
3. Admin cambia transporte → al refrescar dashboard NJ se ve el mismo.
4. Cerrar pedido desde NJ → `customers.transport_id` y `orders.transport_id` del pedido quedan seteados.

## Patch 322 (2026-09-02)

`rpc_set_my_transport` / `rpc_update_customer_transport` **no actualizan** pedidos `closed` ya cumplidos (`labels_printed` o `notes.local_pickup_fulfilled_at`). Un cambio de localidad/transporte en perfil no debe hacer que Mi pedido muestre otra vez "en preparación".

UI: `isLocalPickupOrderFulfilled` prioriza `local_pickup_fulfilled_at` aunque el transporte del perfil ya no sea retiro local.

## Rollback

Re-aplicar versiones anteriores de las tres funciones desde `16_closed_orders_transport.sql` + `134_rpc_set_transport_before_close.sql`; dropear `rpc_set_my_transport` y `resolve_transport_id` si hace falta.

## Deuda

Duplicados en `transports` (`Retira Local` + `Retiro de Local`): `resolve_transport_id` elige preferencia, pero conviene unificar filas en una limpieza futura.

## Regla Corrientes Capital (2026-09-01)

Aunque Credifin / Snaider / Via Cargo listan la ciudad en sus coberturas Excel, en **Corrientes Capital** el cliente solo puede elegir:

1. `Retira local`
2. `MyM`

Implementado en `getTransportesDisponibles` (exclusivo) y reforzado en `resolveShippingOptions`. El copy de MyM habla de envío a domicilio (no “sede más cercana”).
