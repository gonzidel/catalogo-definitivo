# 18 - Auditoria modulo Public Sales

Estado: auditoria de codigo y SQL del repo, sin cambios aplicados.
Fecha: 2026-04-24.
Modulo: Public Sales / Venta al publico.

Nota de contexto: el usuario aclaro que los SQL analizados ya estan cargados y activos en Supabase. Por eso esta nota no marca como duda principal el despliegue de esos SQL, aunque si registra versionado multiple en el repo cuando afecta trazabilidad.

## 1. Alcance

Archivos revisados:

| Archivo | Rol actual |
|---|---|
| `admin/public-sales.js` | Pantalla principal de venta al publico, cajas, clientes, creditos, venta, anulacion, pedidos locales y pendientes. |
| `admin/public-sales.html` | Caja principal. |
| `admin/public-sales-caja2.html` | Caja secundaria que envia compra pendiente a Caja 1. |
| `admin/public-sales-caja3.html` | Caja secundaria que envia compra pendiente a Caja 1. |
| `admin/daily-sales.js` | Consolidado/consulta de ventas diarias. |
| `admin/local-order-edit.js` | Edicion/finalizacion de pedido local como venta publica. |
| `client/profile.js` | Vincula cliente web con cliente de public sales. |
| `client/complete-profile.js` | Vincula cliente web con cliente de public sales al completar perfil. |

SQL relevante:

| SQL | Rol |
|---|---|
| `supabase/canonical/14_public_sales.sql` | Tablas base, RLS, RPCs de clientes, creditos, ventas, historial y pendientes. |
| `supabase/canonical/141_public_sale_stock_trace_and_void.sql` | Traza de stock en venta publica y anulacion. |
| `supabase/canonical/170_rpc_void_public_sale_strong_idempotency.sql` | Wrapper/anulacion con idempotencia fuerte. |
| `supabase/canonical/171_rpc_create_public_sale_strong_idempotency.sql` | Wrapper/creacion con idempotencia fuerte. |
| `supabase/canonical/18_local_orders.sql` | Pedidos locales y RPCs de carga/edicion. |
| `supabase/canonical/22_daily_sales.sql` | Tabla/RPCs de ventas diarias. |
| `supabase/canonical/143_fix_daily_sales_envios_trigger_totals.sql` | Sync de ventas diarias de envios por fecha. |

## 2. Tablas usadas por Public Sales

| Tabla/vista | Uso detectado | Fuente |
|---|---|---|
| `public_sales` | Venta publica registrada, historial y anulacion. | `admin/public-sales.js:5135`, `admin/public-sales.js:8657`; `14_public_sales.sql`. |
| `public_sale_items` | Items de venta publica. | RPCs de `14`, `141`, `170`, `171`. |
| `public_sales_customers` | Clientes de venta publica/local. | `admin/public-sales.js:5103`, `admin/public-sales.js:7171`; `client/profile.js`. |
| `public_sales_customer_credits` | Creditos/saldos de clientes public sales. | RPCs de credito en `14_public_sales.sql`. |
| `pending_sales` | Compras enviadas desde Caja 2/3 hacia Caja 1. | `rpc_create_pending_sale`, `rpc_get_pending_sales`, `rpc_complete_pending_sale`. |
| `local_orders` | Pedidos locales que pueden finalizar como venta publica. | `admin/public-sales.js:5708`, `7158`, `7560`; `local-order-edit.js`. |
| `local_order_items` | Items de pedidos locales. | RPCs de `18_local_orders.sql`. |
| `daily_sales` | Consolidado de ventas diarias. | `admin/daily-sales.js:301`, `497`, `538`; `22_daily_sales.sql`. |
| `products` | Busqueda/lectura de productos vendibles. | `admin/public-sales.js:1074`, `1480`, `7588`, `8476`. |
| `product_variants` | Variante, precio, SKU, color, imagen. | `admin/public-sales.js:1516`, `3122`, `3409`, `8369`. |
| `variant_sizes` | Talles. | `admin/public-sales.js:1544`, `2585`, `8034`. |
| `variant_size_warehouse_stock` | Stock por talle/deposito, especialmente `venta-publico`. | `admin/public-sales.js:1640`, `5334`, `7614`, `7995`. |
| `warehouses` | Resolucion de almacenes. | `admin/public-sales.js:2537`. |
| `color_price_offers` | Ofertas/precios por color. | `admin/public-sales.js:1628`, `4559`. |
| `customers` | Cruce con cliente web/admin en historial/vinculacion. | `admin/public-sales.js:8768`; cliente profile. |
| `order_items` | Interaccion puntual con pedidos admin para status. | `admin/public-sales.js:720`, `904`. |

## 3. Flujo actual

### Venta directa en Caja 1

1. `admin/public-sales.js` exige sesion con `requireAuth()` (`admin/public-sales.js:1-10`).
2. La venta se finaliza con `rpc_create_public_sale`, enviando items, cliente, notas, credito, total, `operation_id` y request metadata (`admin/public-sales.js:5613-5622`).
3. El wrapper actual de idempotencia existe con firma extendida y `SECURITY DEFINER` (`171...:23-35`), revoke a `public, anon` y grant a `authenticated, service_role` (`171...:130-133`).
4. Luego se obtiene detalle para ticket con `rpc_get_public_sale_details` (`admin/public-sales.js:5679-5686`).
5. Si la venta viene de `pending_sales`, se completa con `rpc_complete_pending_sale` (`admin/public-sales.js:5689-5694`).

### Caja 2/3 hacia Caja 1

1. Si `PUBLIC_SALES_CAJA` es 2 o 3, se arma `saleData` y se llama `rpc_create_pending_sale` (`admin/public-sales.js:5569-5572`).
2. Caja 1 lista pendientes con `rpc_get_pending_sales` (`admin/public-sales.js:6293`) y marca procesamiento con `rpc_mark_pending_sale_processing` (`admin/public-sales.js:6347`).
3. En `14_public_sales.sql`, las RPCs de pending sales son `SECURITY DEFINER` (`14...:889-895`, `914-925`, `945-950`, `978-984`). En los bloques revisados no se ve check granular de admin para crear/listar/marcar pendientes.

### Pedido local a venta publica

1. `public-sales.js` carga/edita pedidos locales con RPCs (`rpc_get_local_orders`, `rpc_get_local_order_items`, `rpc_update_local_order`, `rpc_load_local_order_to_sale`).
2. Al **crear** (`rpc_create_local_order`, canonical **311**): descuenta stock y espeja a `orders` para Kanban Retiro (`rpc_mirror_local_order_to_retiro` → Apartados). Soft-fail si hay pedido abierto. Link: `local_orders.source_order_id`.
3. Al finalizar, llama `rpc_create_public_sale` con idempotencia.
4. Despues actualiza `local_orders.status = completed` y cierra el espejo con `rpc_close_mirrored_retiro_from_local_order`.
5. `local-order-edit.js` tiene una ruta similar de finalización a venta pública.

### Anulacion

1. Anular venta usa `rpc_void_public_sale` con `sale_id`, `operation_id` y request metadata (`admin/public-sales.js:8793-8797`).
2. El wrapper `170` es `SECURITY DEFINER` (`170...:22-30`) y documenta idempotencia fuerte, lock y no doble restauracion (`170...:289-290`).
3. Tiene revoke a `public, anon` y grant a `authenticated, service_role` (`170...:292-295`).

### Creditos y clientes

1. Busqueda/alta de cliente public sales usa `rpc_search_public_customer` y `rpc_create_public_customer`.
2. Creditos usan `rpc_get_customer_credits`, `rpc_get_customer_total_credit`, `rpc_add_customer_credit`, `rpc_add_return_credit`.
3. Cliente web se vincula a public sales con `rpc_link_public_sales_customer` desde `client/profile.js` y `client/complete-profile.js`.

## 4. RPCs criticas

| RPC | Llamada en JS | Definiciones SQL detectadas | SECURITY DEFINER | Modifica | Riesgo |
|---|---:|---:|---:|---|---|
| `rpc_create_public_sale` | Si | 6 | Si | Venta, items, stock, creditos, trazas. | ALTA: versionado multiple en repo; estado activo existe pero conviene documentar firma vigente. |
| `rpc_void_public_sale` | Si | 5 | Si | Anulacion, stock, creditos/trazas. | ALTA: operacion critica; wrapper idempotente cargado, grant a authenticated. |
| `rpc_get_public_sale_details` | Si | 3 | Si | Lectura de venta/detalle/stock breakdown. | MEDIA: versionado multiple y posible exposicion de datos si grants son amplios. |
| `rpc_get_public_sales_history` | Si | 2 | Si | Lectura historica. | MEDIA: lectura amplia de ventas. |
| `rpc_create_pending_sale` | Si | 1 | Si | `pending_sales`. | ALTA: en bloque revisado no se ve check admin interno. |
| `rpc_get_pending_sales` | Si | 1 | Si | Lee `pending_sales`. | ALTA: en bloque revisado no se ve check admin interno. |
| `rpc_mark_pending_sale_processing` | Si | 1 | Si | Marca pending como processing. | ALTA: en bloque revisado no se ve check admin interno. |
| `rpc_complete_pending_sale` | Si | 1 | Si | Completa pending con venta. | ALTA: usa `auth.uid()` para processed_by, revisar grants. |
| `rpc_create_public_customer` | Si | 1 | Si | Cliente public sales. | MEDIA: no se detecto auth/admin en bloque inicial. |
| `rpc_search_public_customer` | Si | 1 | Si | Busqueda cliente public sales. | MEDIA/ALTA: datos de clientes; revisar exposicion por grants. |
| `rpc_add_return_credit` | Si | 1 | Si | Credito por devolucion. | ALTA: se llama tras venta negativa; si falla queda venta sin credito. |
| `rpc_add_customer_credit` | Si | 1 | Si | Credito manual. | ALTA: requiere permiso granular de caja/credito. |
| `rpc_update_local_order` | Si | 1 | Si | Pedido local y stock. | ALTA: cruza Local Orders y Stock. |
| `rpc_create_local_order` | Si | 1 | Si | Pedido local. | ALTA: cruza Local Orders y Stock. |
| `rpc_load_local_order_to_sale` | Si | 1 | Si | Carga local order a venta. | MEDIA/ALTA: flujo previo a venta. |
| `rpc_sync_daily_sales_envios_by_date` | Si | 1 | Si | Consolidado `daily_sales`. | MEDIA: reparacion/consolidacion diaria. |

## 5. RLS y permisos detectados

| Area | Detectado | Comentario |
|---|---|---|
| `public_sales_customers` RLS | Si | `14...:774`; policy admin all `14...:781-783`; tambien select publico `14...:805-808`. |
| `public_sales_customer_credits` RLS | Si | `14...:775`; admin all `14...:787-789`; tambien select publico `14...:810-813`. |
| `public_sales` RLS | Si | `14...:776`; admin all `14...:793-795`; tambien select publico `14...:815-818`. |
| `public_sale_items` RLS | Si | `14...:777`; admin all `14...:799-801`; tambien select publico `14...:820-823`. |
| `local_orders` / `local_order_items` RLS | Si | `18...:879-901`, admin manage por `admins`. |
| `daily_sales` RLS | Si | `22...:33`, policy admin all `22...:46-49`. |
| Permiso frontend granular | Parcial/no detectado en `public-sales.js` | Se ve `requireAuth()` pero no se detecto uso de `can("public-sales", ...)` en el archivo. |
| Permiso DB granular por `admin_permissions` | No detectado en RPCs principales revisadas | Predomina `admins` o ausencia de check interno en algunas RPCs auxiliares. |

## 6. Cruces con otros modulos

| Cruce | Riesgo |
|---|---|
| Public Sales + Stock | Venta/anulacion modifica stock `venta-publico` y puede tocar `general` segun trazas. Si se vende sin stock o devolucion, la consistencia depende de RPCs `141/170/171`. |
| Public Sales + Orders | `public-sales.js` llama `rpc_update_order_item_status` y maneja pedidos locales; cualquier cambio en Orders puede afectar venta local. |
| Public Sales + Local Orders | Finalizar pedido local crea venta por RPC, pero luego marca `local_orders.completed` directo desde JS. Si esa escritura falla, venta y local order pueden quedar desalineados. |
| Public Sales + Customers | Clientes public sales se vinculan con clientes web desde `profile.js`/`complete-profile.js`; exposicion de datos depende de RPCs y policies publicas. |
| Public Sales + Daily Sales | `daily_sales` parece consolidado/reporte; editar/borrar `daily_sales` directo no deberia afectar venta/stock real, pero puede alterar reportes. |
| Public Sales + Products | Lee productos/variantes/precios/promos/stock; cambios de Products o promociones impactan caja. |

## 7. Documentacion vs codigo

| Documento | Estado | Comentario |
|---|---|---|
| `03-MAPA-DE-RPCS.md` | Parcial | Lista RPCs destacadas, pero Public Sales tiene muchas RPCs auxiliares no mapeadas por flujo. |
| `04-FLUJO-STOCK.md` | Confiable para concepto | Debe enlazar que venta publica consume/restaura stock de `venta-publico`. |
| `09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY.md` | Util | Ya menciona campos dudosos de `public_sales`; esta nota agrega flujo operativo. |
| `13-RPCS-DEPLOY-STATE.md` | Importante | Debe reflejar que `170/171` estan activos segun aclaracion del usuario. |
| `17-AUDITORIA-MODULO-ORDERS.md` | Complementaria | Public Sales y Orders se cruzan por Local Orders y ventas publicas. |

## 8. Riesgos prioritarios

1. ALTA: `public-sales.js` no muestra validacion frontend granular de `public-sales:*`; depende de `requireAuth` y de la DB/RPC.
2. ALTA: varias RPCs auxiliares `SECURITY DEFINER` de pending sales/clientes/creditos no muestran check admin interno en los bloques revisados; el riesgo real depende de grants activos.
3. ALTA / CRUCE LOCAL: finalizar pedido local crea venta por RPC y luego actualiza `local_orders.status` directo desde JS.
4. ALTA / CRUCE STOCK: venta/anulacion toca stock y creditos; si `rpc_add_return_credit` falla tras venta negativa, queda venta registrada sin credito.
5. MEDIA/ALTA: RLS publica de select en `public_sales`, `public_sale_items`, clientes y creditos usa `using (true)`; fue disenada para RPC/QR, pero conviene validar exposicion de datos.

## 9. Propuestas sin aplicar

1. Documentar en `13-RPCS-DEPLOY-STATE.md` la firma activa de `rpc_create_public_sale` y `rpc_void_public_sale` con `operation_id`.
2. Revisar grants reales de RPCs auxiliares (`pending_sales`, clientes, creditos, detalles/historial) y limitar a `authenticated`/roles necesarios.
3. Agregar check DB granular para acciones de caja: `public-sales:view`, `public-sales:create`, `public-sales:void`, `public-sales:credit`, `public-sales:local-orders`.
4. Encapsular la finalizacion de local order en una RPC unica: crear venta + marcar local order completed en una transaccion.
5. Revisar si las policies publicas `using (true)` pueden acotarse sin romper QR/RPCs.

## 10. Actualizacion 2026-07-23 - Bug fix critico: promos 2x1/2xMonto no se aplicaban al finalizar venta (dinero real)

**Hallazgo:** el handler de `finalizeSaleBtn` (click en "Finalizar Venta", `admin/public-sales.js`) armaba el `subtotal`/`p_total_amount` enviado a `rpc_create_public_sale` sumando `item.totalValue` de cada producto (precio de lista/oferta por color * cantidad), **sin aplicar el descuento de promociones 2x1/2xMonto**. Esa logica de descuento solo vivia dentro de `calculateTotals()` (usada unicamente para pintar el total en pantalla) y se descartaba al confirmar. Consecuencia: el total efectivamente guardado en `public_sales.total_amount` (y por lo tanto el ticket impreso, via `rpc_get_public_sale_details` -> `price_snapshot` por linea) no reflejaba la promo aplicada; cada producto quedaba a su precio individual y el total real registrado era mayor al que se le mostro al cajero antes de confirmar.

**Fix aplicado:**
- Se extrajo la logica de agrupacion de promos a una funcion unica `computeSalePromoGrouping(saleItems)` (fuente de verdad compartida) que devuelve `{ subtotal, promoLines, unitOverrides }`. La usan tanto `calculateTotals()` (vista previa) como el handler de `finalizeSaleBtn` (venta real), para que ambos coincidan siempre.
- Al armar `p_items` para `rpc_create_public_sale`, las unidades que completan un grupo 2x (2x1 o 2xMonto) se envian a precio `0` (su valor ya esta representado por una linea sintetica `is_special_extra` con `product_name` = `"N ofertas 2x$MONTO"` o `"N ofertas 2x1"` y `price` = el monto correspondiente). Las unidades que no completan pareja (remainder) se cobran a precio normal, en su propia linea — mismo criterio que el fix previo de 2026-07-21 para el bug del remainder impar.
- El split se hace por linea producto+color+talle preservando el reparto de stock `venta_publico`/`general` (no cambia cuanto stock se descuenta, solo como se reparte el precio entre las 2 sub-lineas).
- `buildEscposTicket`, el fallback HTML de `printDirectly` y `showPrintModal` ahora filtran (`isPromoAbsorbedTicketLine`) las lineas de producto absorbidas por una promo (precio 0 con variante real) para no imprimir un producto en "$0"; en su lugar se ve la linea sintetica de la oferta, como pidio el usuario ("1 oferta 2x... / 2 ofertas 2x...", con su monto, como si fuese un producto mas).
- Cache-busting de `public-sales.js` subido a `?v=m260723` en `public-sales.html`, `public-sales-caja2.html`, `public-sales-caja3.html`.

**Alcance del fix:** aplica a Caja 1 (venta directa), y a Caja 2/3 (el payload que mandan a `pending_sales` ya sale bien armado, pero la creacion real de la venta ocurre cuando Caja 1 carga la pendiente en el formulario y vuelve a confirmar "Finalizar Venta", ejecutando el mismo handler corregido). Tambien beneficia la reimpresion desde el historial (`reprintHistorySale` -> `printDirectly`), que usa el mismo helper de filtro.

**Riesgo/deuda pendiente:** el fix corrige lo hacia adelante; las ventas ya registradas antes de este cambio con promos 2x en `public_sales`/`public_sale_items` quedaron con el total sin descuento (dinero de mas registrado, no necesariamente cobrado de mas si el cajero se guio por el total en pantalla al dar el cambio). No se hizo backfill retroactivo — evaluar si hace falta una auditoria de ventas historicas con promos activas.

## 11. Actualizacion 2026-08-01 - Bug fix critico: Modo Devoluciones en "Editar pedido" sumaba en vez de restar

**Hallazgo:** en el modal "Editar pedido" (`admin/public-sales.js`, `openOrderEditModal` / `order-edit-manual-add-btn`), al activar el checkbox "Modo Devoluciones" (`order-edit-return-mode`) y agregar un producto, el item se guardaba correctamente con `price_snapshot` negativo (`isReturnMode ? -unitPrice : unitPrice`, linea ~8553). El problema estaba en la funcion compartida `resolveOrderItemUnitPrice(priceSnapshot, variantPrice)` (`scripts/utils/price.js`), usada tanto para pintar el total en el modal (`getEditOrderUnitPrice`) como para armar el payload real enviado a `rpc_update_local_order` (`buildEditOrderPayload`):

```js
if (snap <= 0) return pv; // BUG: snap negativo (devolucion) tambien entraba aca
```

Como casi todas las variantes tienen precio de catalogo (`pv > 0`), cualquier `price_snapshot` negativo (devolucion) quedaba atrapado en `snap <= 0` y la funcion devolvia `pv` (precio de catalogo, siempre positivo), **invirtiendo el signo**. Efecto en cascada:
- El modal mostraba el item de devolucion como venta normal (sin tag `[DEV]`, sin `-` en el monto) y el total del pedido sumaba en vez de restar.
- `buildEditOrderPayload()` mandaba `price_snapshot` positivo a `rpc_update_local_order`, que decide si una linea es devolucion exclusivamente por el signo de `price_snapshot` (`78_rpc_update_local_order.sql:131` `if price_snapshot < 0 then continue` para no tocar stock). Con el signo invertido, la RPC trataba la devolucion como una venta nueva y **descontaba stock** en vez de reingresarlo.
- En el handler de "Finalizar pedido" (`order-edit-finalize-btn`), `isReturn = rawPrice < 0` tambien se evaluaba sobre el payload ya corrompido (siempre positivo), asi que al finalizar como venta publica la linea de devolucion se enviaba a `rpc_create_public_sale` con `is_return: false` y `from_local_order: true`, sumando el monto al total cobrado y sin reingresar stock.

Esto coincide exactamente con el reporte de usuario: "cuando el modo devolucion esta activado en los pedidos, el monto no se esta descontando sino que se esta sumando".

**Fix aplicado (`scripts/utils/price.js`, `resolveOrderItemUnitPrice`):** se preserva el signo del snapshot y solo se corrige la magnitud (para el caso legacy de snapshot corrupto tipo `18` en vez de `18000`), nunca se fuerza a positivo:

```js
export function resolveOrderItemUnitPrice(priceSnapshot, variantPrice) {
  const snap = parseARSNumber(priceSnapshot);
  const pv = parseARSNumber(variantPrice);
  if (pv <= 0) return snap;
  if (snap === 0) return pv;
  const sign = snap < 0 ? -1 : 1;
  const absSnap = Math.abs(snap);
  if (absSnap >= 1000) return snap;
  const MIN_VARIANT_TO_TRUST = 1500;
  const MIN_RATIO = 75;
  if (pv >= MIN_VARIANT_TO_TRUST && absSnap < 1000 && pv >= absSnap * MIN_RATIO) return sign * pv;
  return snap;
}
```

`resolveOrderItemUnitPrice` es compartida por `admin/public-sales.js`, `admin/closed-orders.js`, `admin/sent-orders.js` y `client/dashboard-instant.js`, asi que el fix corrige el mismo riesgo de signo en todos esos consumidores (vistas de pedidos cerrados/enviados y dashboard de cliente), no solo en "Editar pedido".

**Riesgo/deuda pendiente:** el fix corrige lo hacia adelante. Si hubo pedidos locales editados con "Modo Devoluciones" antes de este fix, sus `local_order_items.price_snapshot` pueden haber quedado guardados en positivo (tratados como venta) y el stock ya pudo haberse descontado en vez de reingresado — requiere auditoria puntual (lectura, sin mutar) de `local_order_items` con sospecha de devolucion antes de decidir si hace falta correccion manual de stock/monto.

## 12. Hallazgo adicional 2026-08-01 - Emojis corruptos ("??") en las 3 pantallas de Caja

**Hallazgo:** `admin/public-sales.html`, `admin/public-sales-caja2.html` y `admin/public-sales-caja3.html` tenian varios emojis guardados como `?`/`??`/`???` literales (titulo de pestaña, boton "Pedidos", aviso de "Modo Devoluciones activado", label "Monto ($)", modal "Producto Sin Stock", "Pedidos Locales" y "Editar pedido"). Se confirmo via `git show` de un commit previo (`adf657cc`) que el archivo tenia los emojis correctos (`🛍️`, `📦`, `⚠️`, `💵`, `✏️`) y se corrompieron en un guardado posterior (probablemente por un editor/encoding no-UTF8). Se restauraron los emojis originales en las 3 vistas.

**Hallazgo relacionado, no corregido:** `admin/admin-auth.js` (cargado por `public-sales.html` para el login) tiene una corrupcion mas profunda y **preexistente desde el commit inicial del repo** — no solo emojis (`??`) sino tambien acentos (`�` en palabras como "administracion", "sesion", "pagina"). La misma corrupcion de acentos existe en `scripts/curated-banner.js` y `admin/argentina-cities-data.js`. No se toco en esta pasada porque requiere reconstruir manualmente cada palabra corrompida (no hay una version limpia en el historial de git para diffear) y es un problema mas amplio que el modulo de venta publica — se recomienda una tarea dedicada para ese cleanup.
