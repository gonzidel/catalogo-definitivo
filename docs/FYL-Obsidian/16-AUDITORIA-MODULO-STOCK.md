# 16 - Auditoria modulo Stock

Estado: auditoria de codigo y SQL del repo, sin cambios aplicados.
Fecha: 2026-04-24.
Modulo: Stock.

## 1. Alcance

Pantallas y archivos revisados:

| Archivo | Rol actual |
|---|---|
| `admin/stock.js` | Busqueda/edicion manual y masiva de stock, precio y activo. |
| `admin/move-stock.js` | Movimiento de stock entre `general` y `venta-publico`, por talle. |
| `admin/stock-audit.js` | Lectura de vistas de auditoria y ejecucion de reconciliacion. |
| `admin/fyl-products.js` | Alta/edicion de productos FYL con escritura de stock inicial o posterior. |
| `admin/incomplete-products.js` | Completar productos pendientes con stock. |
| `admin/order-creator.js` | Creacion de pedidos admin y descuento/reserva de stock. |
| `admin/STOCK_OPERATIVA.md` | Nota operativa existente del flujo. |

Fuentes SQL principales:

| SQL | Rol |
|---|---|
| `supabase/canonical/77_stock_history.sql` | Tabla `stock_history`, funcion `log_stock_change`, RLS de historial. |
| `supabase/canonical/148_guard_derived_stock_writes.sql` | Guards contra escrituras directas a stock derivado. |
| `supabase/canonical/164_rpc_set_variant_size_stock_batch.sql` | RPC canonica para setear stock absoluto con talle. |
| `supabase/canonical/165_rpc_set_variant_warehouse_stock_batch.sql` | RPC canonica para setear stock absoluto sin talle. |
| `supabase/canonical/166_rpc_apply_order_stock_deduction.sql` | Descuento de stock al crear pedido admin. |
| `supabase/canonical/173_rpc_move_size_stock_strong_idempotency.sql` | Movimiento de stock con idempotencia fuerte. |
| `supabase/canonical/176_rpc_reconcile_stock_reserved_qty.sql` | Reconciliacion/auditoria de stock derivado y `reserved_qty`. |
| `supabase/canonical/179_rpc_admin_manual_inject_and_deduct.sql` | Inyeccion/deduccion manual relacionada a pedidos admin. |

## 2. Modelo de tablas usado por Stock

| Tabla/vista | Uso detectado | Fuente |
|---|---|---|
| `products` | Lectura para catalogo; archive de productos viejos desde stock. | `admin/stock.js:259`, `admin/stock.js:2863`; `admin/move-stock.js:599`. |
| `product_variants` | Lectura de variantes; update directo de `price` y `active`. | `admin/stock.js:298`, `admin/stock.js:1861-1863`, `admin/stock.js:1906-1909`, `admin/stock.js:2529`, `admin/stock.js:2874`. |
| `variant_sizes` | Stock agregado por talle; lectura en stock/move-stock. | `admin/stock.js:647`; `admin/move-stock.js:864-868`. |
| `variant_size_warehouse_stock` | Fuente canonica para stock por talle y deposito. | `admin/stock.js:742`; `admin/move-stock.js:907-911`. |
| `variant_warehouse_stock` | Stock por deposito para variantes sin talle y agregado por variante. | `admin/stock.js:329`, `admin/stock.js:504`. |
| `warehouses` | Resuelve depositos `general` y `venta-publico`. | `admin/stock.js:1783-1786`, `admin/stock.js:2342-2345`, `admin/move-stock.js:886-889`. |
| `stock_history` | Historial de cambios de stock. | `admin/stock.js:2921-2935`; `77_stock_history.sql:4-18`. |
| `stock_movements` | Usada por RPC de movimientos, no como escritura directa del frontend revisado. | `164...:28-31`; `173...` por nombre y rol. |
| `vw_stock_audit_variant_sizes_diff` | Vista de diferencias `variant_sizes` vs suma por deposito. | `admin/stock-audit.js:242-245`. |
| `vw_stock_audit_variant_warehouse_diff` | Vista de diferencias `variant_warehouse_stock` vs suma por talle/deposito. | `admin/stock-audit.js:250-253`. |
| `vw_stock_audit_orphan_size_rows` | Vista de filas huerfanas de stock por talle. | `admin/stock-audit.js:258-260`. |
| `vw_stock_audit_snapshot` | Snapshot general de auditoria. | `admin/stock-audit.js:423`. |
| `vw_stock_audit_reference_signals` | Senales/referencias para auditoria. | `admin/stock-audit.js:491`, `admin/stock-audit.js:679`. |
| `vw_stock_audit_release_gate` | Gate de salud antes de release. | `admin/stock-audit.js:749-753`. |
| `vw_stock_audit_health_score` | Fallback de score de salud. | `admin/stock-audit.js:756-760`. |

## 3. Flujo actual de escritura de stock

### Stock manual en `admin/stock.js`

1. La UI carga permisos con `can("stock", "view")`, `can("stock", "edit")` y `can("stock", "delete")` (`admin/stock.js:17-23`).
2. Si no hay `stock:edit`, deshabilita inputs y botones en frontend (`admin/stock.js:49-69`).
3. Para variantes con talle, guarda stock con `rpc_set_variant_size_stock_batch` (`admin/stock.js:1832-1835`, `admin/stock.js:2537-2540`).
4. Para variantes sin talle, guarda stock con `rpc_set_variant_warehouse_stock_batch` (`admin/stock.js:1885-1888`, `admin/stock.js:2559-2561`).
5. La escritura de `price` y `active` de `product_variants` queda como update directo, separada de las RPCs de stock (`admin/stock.js:1857-1863`, `admin/stock.js:1904-1909`, `admin/stock.js:2522-2530`).

Lectura: el modulo consulta `products`, `product_variants`, `variant_sizes`, `variant_size_warehouse_stock`, `variant_warehouse_stock`, `warehouses` y `stock_history`.

### Movimiento entre depositos en `admin/move-stock.js`

1. Lee talles desde `variant_sizes` (`admin/move-stock.js:864-868`).
2. Lee stock por deposito desde `variant_size_warehouse_stock` (`admin/move-stock.js:907-911`).
3. Mueve stock con `rpc_move_size_stock`, agregando `p_operation_id` y metadata de request (`admin/move-stock.js:44-54`).
4. La UI valida cantidad mayor a cero y `quantity <= maxStock` (`admin/move-stock.js:1187-1198`), pero la proteccion real debe estar en la RPC.
5. El movimiento masivo procesa lotes de 5 (`admin/move-stock.js:1468-1471`).

### Auditoria/reconciliacion en `admin/stock-audit.js`

1. Lee vistas `vw_stock_audit_*` para detectar diferencias (`admin/stock-audit.js:238-263`).
2. Ejecuta `rpc_reconcile_stock` desde UI si `state.canEdit` es true (`admin/stock-audit.js:725-733`).
3. El archivo SQL `176` declara que por defecto reporta drift y con `p_fix_reserved_qty=true` corrige `product_variants.reserved_qty` (`176...:291-293`). La llamada JS actual no envia parametro, por lo que usa default.

### Productos y pedidos que tocan stock

| Modulo | Accion |
|---|---|
| `admin/products.js` | Alta inicial de stock via `rpc_save_product_variant_initial_stock`; asignacion QR via `assign_qr_code_to_variant_size`. |
| `admin/fyl-products.js` | Usa `rpc_set_variant_size_stock_batch` y `rpc_set_variant_warehouse_stock_batch` para stock inicial/edicion. |
| `admin/incomplete-products.js` | Usa las mismas RPCs de stock y activa el producto al completar stock. |
| `admin/order-creator.js` | Usa `rpc_apply_order_stock_deduction` y `rpc_admin_manual_inject_and_deduct` para pedidos admin. |

## 4. RPCs criticas

| RPC | Llamada en JS | Definida en SQL | SECURITY DEFINER | Modifica | Riesgo |
|---|---:|---:|---:|---|---|
| `rpc_set_variant_size_stock_batch` | Si, `stock.js`, `fyl-products.js`, `incomplete-products.js` | Si, `164...:54` | Si, `164...:60` | `variant_size_warehouse_stock`, `stock_history`; deriva agregados por triggers. | ALTA: valida admin general, no permiso granular `stock:edit`. |
| `rpc_set_variant_warehouse_stock_batch` | Si, `stock.js`, `fyl-products.js`, `incomplete-products.js` | Si, `165...:49` | Si, `165...:55` | `variant_warehouse_stock`, `stock_history`. | ALTA: valida admin general, no permiso granular `stock:edit`. |
| `rpc_move_size_stock` | Si, `move-stock.js:50` | Si, `173...:23` | Si, `173...:35` | Movimiento entre depositos, stock por talle, historial/movimientos. | ALTA/DUDOSO: execute a `authenticated`; falta confirmar validacion granular en la version desplegada. |
| `rpc_reconcile_stock` | Si, `stock-audit.js:732` | Si, `176...:27` | Si, `176...:32` | Reconciliacion de agregados y opcionalmente `reserved_qty`. | ALTA: operacion potente; SQL valida solo admin general (`176...:74-80`). |
| `rpc_apply_order_stock_deduction` | Si, `order-creator.js` | Si, `166...:30` | Si, `166...:37` | Stock y fuentes de stock de pedido. | ALTA: descuenta stock; valida admin general (`166...:74-84`). |
| `rpc_admin_manual_inject_and_deduct` | Si, `order-creator.js` | Si, `179...:22` | Si, `179...:28` | Stock/pedido para flujo manual. | ALTA: valida admin general (`179...:50-55`). |
| `log_stock_change` | No directa desde JS | Si, `77...:28` | Si, `77...:42` | Inserta `stock_history`. | MEDIA: helper interno; revisar grants si quedo ejecutable por cliente. |

## 5. Protecciones detectadas

| Proteccion | Detectada | Comentario |
|---|---|---|
| Permisos frontend `stock:view/edit/delete` | Si | `admin/stock.js:17-23` controla UI; no es barrera suficiente contra DevTools. |
| RPCs transaccionales para stock manual | Si | `164` y `165` reemplazan escrituras directas y registran historial. |
| Validacion `stock_qty >= 0` en RPCs | Si | Descripta en comentarios de `164...:15-24` y `165...:14-22`; debe confirmarse en deploy. |
| `FOR UPDATE` en RPCs | Si | Descripto en `164...:23` y `165...:21`. |
| Historial centralizado | Si | `stock_history` y `log_stock_change` en `77`. |
| RLS en `stock_history` | Si | `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` (`77...:68-69`), policies admin select/insert (`77...:81-107`). |
| Guard contra escritura directa a `variant_sizes.stock_qty` | Si | `148...:22-39` y trigger `148...:48-53`. |
| Guard contra escritura directa a `variant_warehouse_stock.stock_qty` para variantes con talle | Si | `148...:73-109` y trigger `148...:118-123`. |
| Validacion granular DB por `admin_permissions` | No detectada en RPCs criticas revisadas | Las RPCs revisadas consultan `public.admins`, no `admin_permissions`. |

## 6. Documentacion vs codigo

| Documento | Estado | Comentario |
|---|---|---|
| `04-FLUJO-STOCK.md` | Confiable en lo general | Describe la fuente canonica `variant_size_warehouse_stock` y los riesgos de drift. Falta detalle actualizado de pantallas/RPCs actuales. |
| `03-MAPA-DE-RPCS.md` | Parcial | Incluye RPCs criticas de stock, pero no reemplaza una matriz por modulo con llamadas JS y SQL. |
| `11-DECISIONES-TECNICAS.md` | Confiable en decision tecnica | Refuerza no editar `variant_sizes.stock_qty` directo y usar guards. |
| `99-AUDITORIA-DOCUMENTACION.md` | Confiable como auditoria general | Marca stock como area sensible; no tiene mapa operativo detallado por pantalla. |
| `13-RPCS-DEPLOY-STATE.md` | Importante pero DUDOSO | Ayuda a controlar despliegue, pero esta auditoria no confirma Supabase real. |

## 7. Riesgos prioritarios

1. CRITICA / DUDOSO: no se confirmo que las versiones canonicas `148`, `164`, `165`, `173`, `176`, `166`, `179` esten efectivamente desplegadas en Supabase.
2. ALTA: las RPCs criticas revisadas son `SECURITY DEFINER` y validan "existe en admins"; no se detecto validacion DB granular de `stock:edit`.
3. ALTA: `admin/stock.js` no solo edita stock; tambien actualiza directo `product_variants.price`, `product_variants.active`, archiva `products` y desactiva variantes.
4. ALTA: `rpc_reconcile_stock` es operacion potente expuesta en UI; por SQL revisado puede ejecutarla cualquier admin si tiene execute y pasa el check interno.
5. NORMAL / DUDOSO: la documentacion previa es buena conceptualmente, pero no tenia un mapa operativo actualizado por modulo/pantalla.

## 8. Propuestas sin aplicar

1. Confirmar en Supabase real las firmas, `SECURITY DEFINER`, grants y `pg_get_functiondef` de RPCs criticas de stock.
2. Confirmar triggers reales de `148_guard_derived_stock_writes.sql` y triggers de sync `84`/`145`.
3. Evaluar helper DB `has_admin_permission('stock','edit')` o equivalente, y usarlo dentro de RPCs de stock en lugar de solo `exists public.admins`.
4. Separar, en una futura etapa, la edicion de `price`/`active` que hoy ocurre en `admin/stock.js` hacia una RPC o flujo documentado con permiso propio.
5. Mantener `04-FLUJO-STOCK.md` como flujo conceptual y esta nota como mapa operativo auditado.

## 9. Alerta stock inmovilizado en `admin/stock.html` (2026-06-03)

Implementado en repo (requiere deploy migracion `231_stock_immobile_variants.sql`):

| Pieza | Ubicacion |
|---|---|
| Vista 14d por variante | `vw_stock_immobile_variants` — fuentes: `stock_history`, `stock_movements`, `orders`, `public_sale_items` |
| Postergacion estacional | `stock_immobile_snooze` + `rpc_stock_immobile_snooze(p_variant_id, p_season)` |
| UI campana + modal | `admin/stock.html`, `admin/stock.js` |
| Rearqueo | Reutiliza wizard mobile QR (`openMobileRearqueoWizard`) |
| Sin stock | RPC 164/165 qty=0 + `product_variants.active=false` (solo variante) |

Distinto de `vw_stock_dead_products` (184): 90 dias, nivel producto, bloque stock-audit.

Verificacion post-deploy:

```sql
SELECT count(*) FROM public.vw_stock_immobile_variants;
```
