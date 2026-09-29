# Retiro local

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Dos conceptos distintos

Estado: Vigente en código  
Fuente: Dominio de pedidos, tablero Retiro y SQL  
Última revisión: 2026-09-23

No deben tratarse como sinónimos:

- **Retira Local común:** método de entrega de un pedido normal. El pedido usa el circuito normal de stock, pero el cierre puede esperar la venta/cobro presencial.
- **`local_deferred_pickup`:** modalidad diferida. Checkout crea líneas `awaiting_apartado` y evita el compromiso normal inmediato de stock; luego el equipo resuelve el apartado desde el flujo administrativo.

### Superficie administrativa

- Ruta Next.js: `/admin/retiro`.
- Usa la misma lógica base de clasificación que pedidos, con alcance de retiro.
- Contempla activos, apartados, espera, cerrados, stock pendiente, cancelados y vencidos según estado e ítems.
- Migraciones 311-317 mantienen un espejo `local_orders`/retiro y textos operativos asociados.

### Finalización de venta presencial

Para retiro común, la solicitud de cierre del cliente puede dejar el pedido abierto hasta que se complete la venta/cobro. La acción administrativa `finalizeRetiroOrderSale` llama a `rpc_finalize_local_order_to_public_sale`:

1. valida el pedido y su elegibilidad;
2. crea o vincula una `public_sale`;
3. registra `public_sales.local_order_id`;
4. cierra el pedido/espejo de retiro de forma coherente;
5. conserva la trazabilidad necesaria de stock y cobro.

La RPC tiene protección contra duplicación y pruebas SQL dedicadas en la migración 334.

### Stock diferido

Las líneas `awaiting_apartado` no deben interpretarse como unidades ya descontadas por el checkout normal. Las operaciones posteriores de apartado, espera, faltante o cancelación tienen reglas propias y deben mantener el vínculo con las fuentes cuando exista consumo físico.

## CONTEXTO CONFIRMADO POR EL NEGOCIO

Estado: Vigente como regla deliberada  
Fuente: Contexto confirmado por responsable del negocio; coincidencia parcial con código  
Última revisión: 2026-09-23

- **CANÓNICA:** en `local_deferred_pickup`, crear el pedido no descuenta ni reserva stock inmediatamente. El personal del local verifica físicamente y solo después confirma/aparta, marca listo y avisa.
- **CANÓNICA:** antes de esa confirmación no se debe comunicar que el producto está reservado. Después de confirmar y comprometer físicamente el stock, puede comunicarse como reservado y listo para retirar.
- **NEGOCIO CONFIRMADO:** si el pedido utiliza `local_deferred_pickup`, no aplica el mínimo general web de 4 productos. La ubicación puede habilitar la modalidad, pero no es la definición comercial de la excepción.
- **CANÓNICA:** una vez que un pedido de retiro local fue preparado y se comunicó como **listo para retirar**, el cliente dispone de **36 horas**. El plazo comienza con esa confirmación/comunicación, no con la creación del pedido.
- **CANÓNICA:** cumplidas las 36 horas sin retiro, el pedido puede desarmarse y los productos dejan de mantenerse reservados para ese cliente.
- **HISTÓRICA:** las referencias de 24 horas, 24–36 horas, 48 horas y frases como "hasta mañana 15:00" quedan reemplazadas por la regla de 36 horas para retiro local.
- El lugar de retiro utilizado es **Av. Alberdi 1099**, presentando nombre o número de pedido. Esto está también en `customer-status-message.ts`; no se documenta aquí como domicilio legal.

### Cambios en el local físico

**Clasificación: NEGOCIO CONFIRMADO.** Fuente: Contexto confirmado por responsable del negocio.

- Para compras o retiros atendidos en el local, el cliente puede acercarse a realizar un cambio.
- En calzado, el producto debe encontrarse en condiciones adecuadas.
- La política confirmada es principalmente de cambio; no se debe prometer automáticamente una devolución de dinero.
- Plazo máximo, empaque, comprobante, excepciones por uso/deterioro y tratamiento de categorías distintas del calzado continúan pendientes.

### Implementación actual a distinguir

- **TÉCNICA VERIFICADA:** el plazo corto se implementa como 36 horas ajustadas a las 15:00 según zona/fecha para el flujo diferido identificado por el código.
- **CONTRADICCIÓN:** en la migración 309, `fn_start_local_pickup_timer_if_needed` inicia el contador cuando aparece el primer ítem `picked`, no necesariamente cuando todo el pedido está preparado y se comunica como listo. La regla comercial exige que las 36 horas comiencen con esa confirmación/comunicación final.
- **CONTRADICCIÓN:** `ActiveOrderTab.tsx` todavía muestra una guía de 24 horas y también contiene un estado final con 48 horas; `shipping-helpers.ts` y el fallback de `customer-status-message.ts` usan 48 horas. Esos textos contradicen la regla canónica de 36 horas. El retiro común también debe alinearse al plazo comercial confirmado cuando se comunique que está listo.
- **TÉCNICA VERIFICADA:** `getOrderCloseMinimumUnits` devuelve 1 en localidades de retiro corto basándose en provincia/ciudad. La regla comercial depende de `local_deferred_pickup`; el posible acoplamiento queda en `11_PROBLEMAS_Y_FIXES.md`.

### Reglas importantes

| Regla | Estado | Fuente | Revisión |
|---|---|---|---|
| Retiro común y retiro diferido son flujos diferentes | Verificado | Código y migraciones 307-320 | 2026-09-23 |
| Retiro común puede esperar venta/cobro antes del cierre | Verificado | `rpc_customer_request_close` y dominio admin | 2026-09-23 |
| La finalización presencial vincula pedido y venta pública | Verificado | Migración 334 | 2026-09-23 |
| `awaiting_apartado` no equivale a stock físico ya consumido | Verificado | Checkout diferido | 2026-09-23 |
| La excepción al mínimo normal es por `local_deferred_pickup` | NEGOCIO CONFIRMADO | Contexto del responsable | 2026-09-23 |
| El retiro local listo dispone de 36 horas desde su comunicación | CANÓNICA | Contexto del responsable + implementación parcial | 2026-09-23 |
| Tras 36 horas sin retiro puede desarmarse y liberarse la reserva | CANÓNICA | Contexto del responsable | 2026-09-23 |
| Av. Alberdi 1099 es el lugar usado en mensajes de retiro | Confirmado por negocio y código | Contexto + `customer-status-message.ts` | 2026-09-23 |

## Tablas y RPCs clave

- Tablas: `orders`, `order_items`, `local_orders`, `public_sales`, `order_item_stock_sources`.
- RPCs: `rpc_customer_request_close`, `rpc_finalize_local_order_to_public_sale`, RPCs de apartado, espera, faltante y cancelación.

## Archivos clave

- `nj/app/admin/retiro/page.tsx`
- `nj/lib/orders/domain.ts`
- `nj/lib/orders/classification.ts`
- `nj/lib/orders/retiro-finalize-sale.ts`
- `nj/lib/orders/retiro-deposit-waiting.ts`
- `supabase/canonical/309_local_deferred_pickup_flow.sql`
- `supabase/canonical/311_mirror_local_order_to_retiro.sql`
- `supabase/canonical/312_retiro_zona_espera_deferred_stock.sql`
- `supabase/canonical/334_finalize_local_order_to_public_sale.sql`

## INFERIDO / DESCONOCIDO

- **Inferido:** el tablero separado busca adaptar la operación física del local sin duplicar por completo el dominio de pedidos.
- **Desconocido:** criterio comercial para ofrecer retiro común versus diferido a cada cliente.
- **Desconocido:** política de señas, penalidades y procedimiento operativo exacto de desarme/liberación después de las 36 horas.
- **Desconocido:** quién cobra, quién confirma el apartado y qué controles físicos acompañan cada transición.
- **Desconocido:** plazo máximo, empaque, comprobante, excepciones por uso/deterioro y reglas para cambios de categorías distintas del calzado.
- **Desconocido:** si las migraciones locales más recientes del flujo están desplegadas en producción.
