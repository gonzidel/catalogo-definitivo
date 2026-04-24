# 19 - Auditoria modulo Cliente / Carrito

Fecha: 2026-04-24

Alcance: cliente web, carrito persistente, checkout desde dashboard y cruces con stock, pedidos, productos y clientes.

Regla de esta auditoria: solo lectura del codigo y SQL. No se modificaron archivos JS, SQL ni migraciones.

Nota de contexto: el usuario aclaro que los SQL analizados ya estan cargados y activados en Supabase. Por lo tanto, los riesgos de versionado se documentan como mantenimiento/documentacion, no como duda principal de despliegue.

## 1. Archivos principales

| Archivo | Rol detectado | Evidencia |
|---|---|---|
| `index.html` | Catalogo publico. Carga carrito persistente. | `index.html:1155` carga `scripts/cart-persistent.js`. |
| `scripts/cart-persistent.js` | Motor vivo del carrito en catalogo/sticky cart. Maneja localStorage, login merge, creacion de carrito, insert/update/upsert de `cart_items`, validacion previa de stock y exposicion `window.addToCart`. | `scripts/cart-persistent.js:342`, `398`, `934`, `1504`, `1860`. |
| `client/dashboard.html` | Dashboard cliente. Carga `cart-persistent` y `dashboard-instant`. Contiene seccion bolsa/carrito y boton de pedido. | `client/dashboard.html:579`, `700`, `701`. |
| `client/dashboard-instant.js` | Vista principal de carrito/pedidos del cliente. Ejecuta checkout por RPC, carga carrito, limpia items, actualiza cantidades y cancela pedidos/items. | `client/dashboard-instant.js:2850`, `3433`, `3623`, `3682`, `3712`. |
| `client/cart.html` | Pantalla separada de carrito. Carga `client/cart.js`. Parece ruta secundaria/legacy frente al dashboard actual. | `client/cart.html:249`. |
| `client/cart.js` | Carrito simple. Lee `carts/cart_items`, actualiza cantidades y borra items directo; su checkout solo marca `carts.status = pending`. | `client/cart.js:67`, `81`, `237`, `270`, `313`. |
| `client/cart-fixed.js` | Variante corregida de `client/cart.js`, pero no se detecto cargada por `client/cart.html`. | `client/cart-fixed.js:1`, `120`, `325`, `368`. |
| `scripts/cart-manager.js`, `scripts/cart-sync.js`, `scripts/cart.js` | Scripts antiguos/alternativos de carrito. | Referencias a `localStorage`, `carts`, `cart_items` y RPCs legacy en busquedas. |

## 2. Tablas usadas

| Tabla | Uso actual detectado | Comentario |
|---|---|---|
| `carts` | Carrito abierto por `customer_id = auth.uid()`. Se crea desde frontend via insert directo en `scripts/cart-persistent.js`. | `scripts/cart-persistent.js:398-425`. RLS base detectado en `supabase/canonical/05_orders.sql:48`. |
| `cart_items` | Lineas del carrito. Insert/update/upsert/delete desde frontend; se vacia en checkout desde RPC. | `scripts/cart-persistent.js:961`, `1041`, `1067`, `1078`, `1108`, `1391`, `1466`; `client/dashboard-instant.js:2665`, `3483`, `3581`, `3603`, `3712`. |
| `products` | Busqueda por nombre cuando no hay `variant_id`. | `scripts/cart-persistent.js:528-532`. |
| `product_variants` | Precio, `reserved_qty`, `variant_id`, color y estado activo. | `scripts/cart-persistent.js:518-545`; checkout base usa `product_variants.reserved_qty`. |
| `variant_sizes` | Stock por talle para validar disponibilidad antes de agregar. | `scripts/cart-persistent.js:549-556`. |
| `variant_size_warehouse_stock` | Stock real por talle y deposito (`general`, `venta-publico`), usado en frontend y en checkout. | `scripts/cart-persistent.js:565-572`; `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:136-196`. |
| `variant_warehouse_stock` | Fallback legacy cuando no hay talle. | `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:200-234`. |
| `orders` | Checkout crea o reutiliza pedido activo/closing_soon; dashboard lee y cancela pedidos. | `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:52-93`; `client/dashboard-instant.js:6100`, `6130`. |
| `order_items` | Checkout inserta lineas por deposito; dashboard cliente cancela items. | `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:246-258`; `client/dashboard-instant.js:3201`, `4978`, `6116`. |
| `order_item_stock_sources` | Trazabilidad de stock descontado por warehouse. | `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:249-258`. |
| `customers` | Vinculacion/creacion de cliente al iniciar/sincronizar carrito. | `scripts/cart-persistent.js:342-390` llama `rpc_link_or_create_customer`. |
| `warehouses` | Resolucion de `general` y `venta-publico`. | `scripts/cart-persistent.js:145-150`; `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:95-96`. |

## 3. Flujo actual detectado

### Agregar producto al carrito

1. `index.html` carga `scripts/cart-persistent.js`.
2. `scripts/cart-persistent.js` expone `window.addToCart` en `scripts/cart-persistent.js:1860`.
3. `addToCart(productData)` valida stock antes de persistir (`scripts/cart-persistent.js:1504-1599`).
4. Si hay usuario logueado:
   - aplica actualizacion optimista local;
   - asegura cliente con `rpc_link_or_create_customer`;
   - busca/crea carrito abierto en `carts`;
   - inserta/actualiza/upsertea `cart_items`.
5. Si no hay usuario usa `localStorage` (`fyl_cart`) y luego sincroniza cuando hay sesion.

### Sincronizacion localStorage a Supabase

1. `syncCartWithSupabase` usa lock cross-tab para evitar carreras entre pestanas (`scripts/cart-persistent.js:934-956`).
2. Normaliza items y evita doble conteo en merge local+remoto (`scripts/cart-persistent.js:987-990`).
3. Escribe `cart_items` con `upsert` por `cart_id,variant_id,size` cuando existe `variant_id`.
4. El indice unico asociado esta documentado en `supabase/canonical/150_cart_items_idempotent_uniques.sql:44` y `49`.

### Dashboard cliente

1. `client/dashboard.html` carga `scripts/cart-persistent.js` y `client/dashboard-instant.js`.
2. `loadCart(userId)` busca `carts` abierto y luego `cart_items` (`client/dashboard-instant.js:3623`, `3682`, `3712`).
3. El dashboard puede limpiar carrito, actualizar cantidad, consolidar duplicados y enviar pedido por `rpc_checkout_cart`.

### Checkout

1. Frontend genera/reutiliza `operation_id` y envia `p_request` con fingerprint (`client/dashboard-instant.js:2838-2853`).
2. Llama `rpc_checkout_cart(p_operation_id, p_request)`.
3. La firma nueva esta en `supabase/canonical/174_rpc_checkout_cart_strong_idempotency.sql:33-40`, es `SECURITY DEFINER`, exige usuario autenticado (`60-63`), usa idempotencia fuerte y lock del carrito (`71-97`).
4. La firma nueva delega en `public.rpc_checkout_cart()` legacy/canonica (`174...:105-107`).
5. La logica de dominio de checkout por talle esta en `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:7-10`.
6. Esa funcion descuenta de `variant_size_warehouse_stock` por talle y de `general`/`venta-publico` (`124...:133-196`), inserta `order_items` y `order_item_stock_sources` (`124...:246-258`), y luego vacia carrito.

## 4. RLS y permisos

| Tabla | RLS detectado | Politicas detectadas | Riesgo | Comentario |
|---|---|---|---|---|
| `carts` | Si | `carts_self_access`, `carts_admin_access` | Medio | Detectado en `supabase/canonical/05_orders.sql:48`, `56`, `66`. Permite al cliente operar su carrito segun `customer_id = auth.uid()`. |
| `cart_items` | Si | `cart_items_self_access`, `cart_items_admin_access` | Medio/Alto | Detectado en `supabase/canonical/05_orders.sql:49`, `61`, `71`. Al ser `for all`, el cliente puede escribir sus items si el cart le pertenece. |
| `orders` | Si | `orders_self_select`, `orders_admin_manage` | Medio | `10_checkout_flow.sql:194-222`. El cliente lee sus pedidos; admin maneja. Algunas acciones cliente se hacen por RPC. |
| `order_items` | Si | `order_items_self_select`, `order_items_admin_manage` | Medio | `10_checkout_flow.sql:195`, `234-258`. Cliente selecciona items de sus pedidos; writes se concentran en RPCs/admin. |
| `variant_size_warehouse_stock` | Ver auditoria Stock | N/A en esta nota | Alto por impacto | Checkout lo modifica via `SECURITY DEFINER`. La proteccion real depende de RPCs y grants. |
| `product_variants` | Ver auditoria Products/Stock | N/A en esta nota | Alto por impacto | Frontend lee precio/reserved/stock; checkout actualiza `reserved_qty`. |

## 5. RPCs y funciones relevantes

| RPC/Funcion | Llamada en JS | Definida en SQL | SECURITY DEFINER | Modifica stock/pedidos/carrito | Riesgo |
|---|---:|---:|---:|---|---|
| `rpc_checkout_cart(uuid,jsonb)` | Si, `client/dashboard-instant.js:2850` | Si, `174_rpc_checkout_cart_strong_idempotency.sql:33` | Si | Checkout idempotente, delega dominio | Medio. Bien orientada por idempotencia, pero depende de firma vieja. |
| `rpc_checkout_cart()` | No directo en JS actual del dashboard | Si, varias versiones; version fuerte documenta delegacion a 124/149 | Si | Crea/reusa pedido, descuenta stock, inserta items, vacia carrito | Alto por criticidad y multiples versiones historicas. |
| `rpc_link_or_create_customer` | Si, `scripts/cart-persistent.js:357`; tambien profile/complete-profile | Si, segun auditorias previas | Si/DUDOSO segun version | Crea/vincula cliente | Medio/Alto: confirmar grants y ownership. |
| `rpc_cancel_order_item` | Si, dashboard cliente | Si, varias versiones | Si | Cancela item; puede restaurar/notificar segun estado/version | Alto por cruce cliente/orders/stock. |
| `rpc_cancel_order_item_units` | Si, `client/dashboard-instant.js:4978` | Si | Si | Cancela unidades parciales | Alto por stock/order_items. |
| `rpc_delete_empty_order` | Si, `client/dashboard-instant.js:3243` | Si | Si | Borra pedido vacio | Medio/Alto. |
| `get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item` | No detectadas como llamadas por flujo vivo | Si, `08_cart_items_flexible_fixed.sql:119`, `137`, `166`, `174` | Si | Lectura/escritura carrito | Medio: funciones legacy `SECURITY DEFINER`; revisar grants si siguen expuestas. |
| `rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart` | Documentadas | No detectadas llamadas en JS vivo | DUDOSO | Carrito legacy/documentacion | Bajo/Medio: documentacion desactualizada. |

## 6. Cruces con otros modulos

| Cruce | Estado detectado | Comentario |
|---|---|---|
| Cliente/Carrito + Products | El carrito resuelve `products`, `product_variants`, `variant_sizes` para stock/precio/variant. | Si `price_snapshot` llega manipulado desde frontend, el checkout canonico 124 intenta usar precio de DB cuando `price_snapshot` es 0, pero conserva `price_snapshot` no nulo. Revisar si debe ignorarse precio enviado por cliente. |
| Cliente/Carrito + Stock | Frontend valida stock, pero la validacion real importante esta en RPC checkout. | Correcto que la barrera final sea DB. La validacion frontend es UX, no seguridad. |
| Cliente/Carrito + Orders | Checkout convierte carrito en pedido activo/closing_soon. | Hay coherencia general con Orders. El cliente tambien puede cancelar items/pedido via RPCs. |
| Cliente/Carrito + Customers | Antes de persistir carrito logueado se llama `rpc_link_or_create_customer`. | Revisar que la RPC no permita vincular clientes ajenos por email/telefono/DNI manipulados. |
| Cliente/Carrito + Public Sales | No comparte venta publica, pero comparte productos, stock y customers. | Si stock por talle se descuenta en ambos modulos, las reglas deben mantenerse alineadas. |

## 7. Observaciones de seguridad

1. La proteccion real del checkout esta en DB, no en frontend. Esto es correcto: `rpc_checkout_cart(uuid,jsonb)` valida `auth.uid()`, bloquea carrito y delega a checkout por talle.
2. El carrito permite writes directos desde frontend sobre `carts` y `cart_items`. Esto puede ser aceptable si RLS esta bien, pero implica que DevTools puede modificar `quantity`, `price_snapshot`, `variant_id`, `size` y `cart_id` dentro de lo que permitan las policies.
3. Como `cart_items_self_access` es `for all`, la seguridad depende de que la policy obligue ownership del cart en `USING` y `WITH CHECK`.
4. El frontend valida stock con `variant_size_warehouse_stock`, pero un usuario podria saltar esa validacion y escribir `cart_items` directo. La barrera real debe ser `rpc_checkout_cart()`.
5. El precio enviado al carrito (`price_snapshot`) merece revision: en la version 124, el precio final usa `COALESCE(NULLIF(r.price_snapshot, 0), v_item_price, r.price_snapshot, 0)`. Si el cliente logra guardar un `price_snapshot` menor que el real y distinto de 0, podria impactar total/linea salvo que exista otra barrera posterior.
6. Existen funciones legacy `SECURITY DEFINER` de carrito (`get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item`) que no aparecen en el flujo vivo. Si conservan grants amplios, pueden saltarse RLS.
7. `client/cart.js` y `client/cart-fixed.js` tienen flujo separado: actualizan/borran `cart_items` directo y su checkout marca `carts.status = pending`, no llama `rpc_checkout_cart`. Si `client/cart.html` sigue accesible, puede ser ruta funcional divergente respecto al dashboard.

## 8. Documentacion vs codigo

| Documento | Estado | Comentario |
|---|---|---|
| `03-MAPA-DE-RPCS.md` | Parcial/desactualizado | Documenta RPCs de carrito (`rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart`) que no aparecen llamadas en el flujo vivo; el flujo vivo usa direct writes + `rpc_checkout_cart(uuid,jsonb)`. |
| `04-FLUJO-STOCK.md` | Bastante confiable | Indica checkout cliente por `rpc_checkout_cart`. Falta dejar mas claro la firma nueva idempotente y la delegacion a la firma vieja. |
| `05-FLUJO-PEDIDOS.md` | Bastante confiable | Ya refleja checkout cliente y `operation_id`, pero podria incorporar la parte de carrito persistente/localStorage y las rutas legacy. |
| `06-FLUJO-CATALOGO.md` | Confiable en diagnostico general | Ya advierte que `client/cart.html` no parece ser el flujo principal. Ahora puede ampliarse con evidencia de `cart-persistent`. |
| `99-AUDITORIA-DOCUMENTACION.md` | Confiable | Ya marca rutas de carrito multiples como riesgo documental. |

## 9. Riesgos prioritarios

1. ALTA: `price_snapshot` editable desde cliente podria ser usado por checkout si no hay barrera adicional de precio en DB.
2. ALTA: funciones legacy `SECURITY DEFINER` de carrito pueden quedar expuestas si los grants no fueron revocados.
3. ALTA / CRUCE STOCK: el usuario puede manipular `cart_items` por API/DevTools; la defensa final debe estar 100% en `rpc_checkout_cart()`.
4. MEDIA / CRUCE ORDERS: `client/cart.html` usa flujo divergente y no llama `rpc_checkout_cart`, puede generar estados `pending` si sigue accesible.
5. MEDIA: documentacion de RPCs de carrito no refleja el flujo vivo actual.

## 10. Propuestas sin aplicar

1. Confirmar grants de funciones legacy de carrito y revocar `EXECUTE` a `anon/authenticated` si no se usan.
2. En checkout, recalcular siempre precio desde DB (`product_variants.price` o fuente canonica de precio) y tratar `price_snapshot` del cliente solo como referencia visual.
3. Documentar oficialmente que el flujo vivo es `scripts/cart-persistent.js` + `client/dashboard-instant.js` + `rpc_checkout_cart(uuid,jsonb)`.
4. Decidir si `client/cart.html` queda como ruta activa o legacy; si queda legacy, documentarlo claramente y evitar que el checkout alternativo marque estados divergentes.
5. Mantener `cart_items` con unique indexes activos por `cart_id,variant_id,size` para sostener idempotencia ante doble click/retry.
