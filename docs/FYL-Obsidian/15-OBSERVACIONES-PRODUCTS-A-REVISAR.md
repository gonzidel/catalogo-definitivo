# 15 - Observaciones Products, Stock, Orders, Public Sales y Cliente/Carrito a revisar

Estado: observaciones derivadas de auditoria de codigo, sin cambios aplicados.
Fecha: 2026-04-24.
Modulo: Products + Stock + Orders + Public Sales + Cliente/Carrito.

Escala:

- CRITICA: puede afectar seguridad, costos, stock o datos de negocio.
- ALTA: puede permitir inconsistencias importantes o errores operativos.
- NORMAL: mejora de documentacion, claridad o deuda tecnica sin riesgo inmediato evidente.
- DUDOSO: no se puede confirmar sin consultar Supabase real o datos productivos.

## Observaciones

| Severidad | Observacion | Evidencia | Consecuencia | Recomendacion sin aplicar |
|---|---|---|---|---|
| CRITICA / DUDOSO | No esta confirmado que la proteccion DB de costos este desplegada. | Repo tiene `182_protect_sensitive_product_fields.sql`, con triggers en `products` y `product_variants` (`182...:61-69`). | Si `182` no esta en produccion, un colaborador con permisos amplios podria intentar cambiar costos/margenes desde API/DevTools. | Verificar en Supabase `information_schema.triggers` y probar UPDATE como colaborador no super_admin. |
| CRITICA | RPCs de stock validan "esta en admins", no permiso granular de modulo. | `rpc_set_variant_size_stock_batch` valida `exists public.admins` (`164...:100-112`); `rpc_set_variant_warehouse_stock_batch` igual (`165...:91-103`); `rpc_save_product_variant_initial_stock` igual (`139...:34-40`). | Cualquier colaborador registrado como admin podria invocar RPCs de stock si conoce la llamada, aunque la UI no le muestre la accion. | Evaluar agregar validacion DB de permiso especifico: `products:edit`, `stock:edit` o funcion `has_permission`. |
| ALTA / DUDOSO | RLS/policies reales de `products` y `product_variants` no estan versionadas como estado final verificado. | Hay RLS en `06_public_read_policies.sql`, fixes posteriores y archivos dev/permisivos como `permissive_rls_policies.sql`. | El repo no garantiza por si solo que produccion tenga las policies esperadas. | Documentar dump de `pg_policies` de produccion y fijar "estado final esperado". |
| ALTA | `admin/fyl-products.js` actualiza `product_variants.price` y `active` directo desde frontend. | Updates directos en `admin/fyl-products.js:810`, `834`, `979`. | Si RLS permite a cualquier admin, el control fino queda en frontend/RLS general, no en una RPC con validacion granular. | Revisar si precio/activo deben pasar por RPC con permisos y auditoria. |
| ALTA | `admin/products.js` hace muchas mutaciones directas a tablas del modulo. | Inserta/actualiza `products`, `product_variants`, `variant_images`, `product_tags`, `product_tag_details`, `tags`, `suppliers`, `colors`. | La seguridad depende de RLS/triggers por tabla. Si alguna policy esta permisiva, DevTools puede saltar UI. | Para operaciones sensibles, considerar RPCs con validacion y auditoria. |
| ALTA / DUDOSO | `assign_qr_code_to_variant_size` se llama desde Products pero no fue auditada en detalle. | Llamada en `admin/products.js:1742-1744`. | Si es `SECURITY DEFINER` sin validaciones, podria modificar QR/codigos fuera del flujo previsto. | Auditar definicion SQL, permisos/grants y comportamiento idempotente. |
| NORMAL | La documentacion previa describe bien stock por talle, pero no tenia una vista por modulo. | `04-FLUJO-STOCK.md` y `11-DECISIONES-TECNICAS.md` explican stock; esta nota agrupa Products. | Onboarding dificil: para entender Products habia que cruzar JS, SQL y varias notas. | Mantener esta nota como mapa principal del modulo Products. |
| NORMAL | `products.js` concentra demasiadas responsabilidades. | Alta/edicion, imagenes, tags, suppliers, colores, costos, stock, auto-tags en un unico archivo grande. | No es bug actual, pero aumenta riesgo de cambios futuros. | Si se refactoriza, separar por dominio: costos, stock, tags, imagenes, suppliers. |
| NORMAL / DUDOSO | `recommended_price` aparece como campo sensible, pero su existencia/uso exacto en tabla no quedo confirmado en esta pasada. | `182` lo protege si existe; frontend calcula precio recomendado en `admin/products.js:965-976`. | Puede haber confusion entre precio final de variante y precio recomendado derivado. | Confirmar columnas reales de `products`/`product_variants` y documentar fuente de verdad. |
| NORMAL | `incomplete-products.js` activa producto tras completar stock, pero el flujo exacto con tags depende de otros modulos. | `admin/incomplete-products.js:648-649`; `complete-tags.js` maneja `missing_tags`. | Puede haber estados intermedios no obvios para soporte. | Documentar transiciones de status: `pending_stock`, `missing_tags`, `active`, `archived`. |

## Checks sugeridos para cerrar DUDOSO

Estos checks son propuestas; no fueron ejecutados contra Supabase real en esta auditoria.

```sql
-- Confirmar triggers de costos
select event_object_table, trigger_name
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name in (
    'trg_products_protect_sensitive_fields',
    'trg_product_variants_protect_sensitive_fields'
  );

-- Confirmar funciones criticas y SECURITY DEFINER
select n.nspname, p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'rpc_save_product_variant_initial_stock',
    'rpc_set_variant_size_stock_batch',
    'rpc_set_variant_warehouse_stock_batch',
    'assign_qr_code_to_variant_size',
    'enforce_sensitive_product_fields'
  );

-- Confirmar policies activas de tablas Products
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'products',
    'product_variants',
    'variant_sizes',
    'variant_size_warehouse_stock',
    'variant_warehouse_stock',
    'variant_images',
    'product_tags',
    'product_tag_details'
  )
order by tablename, policyname;
```

## Decision pendiente

Definir si para Products la regla de negocio deseada es:

1. Colaborador con `products:edit` puede editar producto/variantes/tags/imagenes, pero no costos.
2. Colaborador con `stock:edit` puede editar stock, aunque no tenga `products:edit`.
3. Solo `super_admin` puede editar stock desde Products.

Hoy el SQL de RPCs de stock revisadas valida "esta en admins", no esa distincion fina.

## Observaciones Stock

| Severidad | Observacion | Evidencia | Consecuencia | Recomendacion sin aplicar |
|---|---|---|---|---|
| CRITICA / DUDOSO | No esta confirmado que las RPCs/triggers canonicos de stock esten desplegados en Supabase real. | Repo tiene `148_guard_derived_stock_writes.sql`, `164_rpc_set_variant_size_stock_batch.sql`, `165_rpc_set_variant_warehouse_stock_batch.sql`, `173_rpc_move_size_stock_strong_idempotency.sql`, `176_rpc_reconcile_stock_reserved_qty.sql`, `166_rpc_apply_order_stock_deduction.sql`, `179_rpc_admin_manual_inject_and_deduct.sql`. | Si produccion tiene una version anterior, el frontend podria creer que stock esta protegido/transaccional, pero la base podria permitir rutas viejas o inconsistentes. | Verificar `pg_proc`, `pg_get_functiondef`, triggers y grants en Supabase real antes de cerrar el riesgo. |
| CRITICA | RPCs criticas de stock usan `SECURITY DEFINER` y validan admin general, no permiso granular. | `rpc_set_variant_size_stock_batch` usa `security definer` y `exists public.admins` (`164...:60`, `164...:100-112`); `rpc_set_variant_warehouse_stock_batch` igual (`165...:55`, `165...:92-102`); `rpc_reconcile_stock` igual (`176...:32`, `176...:74-80`). | Un colaborador que sea admin podria invocar RPCs por DevTools/API aunque la UI no le muestre el boton si no tiene `stock:edit`. | Evaluar validacion DB de permiso granular (`stock:edit` / `stock:reconcile`) dentro de RPCs. |
| ALTA | `admin/stock.js` tambien modifica `product_variants.price` y `active` directo desde frontend. | Updates directos en `admin/stock.js:1861-1863`, `admin/stock.js:1906-1909`, `admin/stock.js:2529`. | El modulo Stock puede cambiar datos de producto/variante que no son stock. Si RLS es amplia, DevTools puede saltar controles de UI. | Definir si precio/activo pertenecen a Stock; si no, mover a flujo/RPC con permiso propio. |
| ALTA | `admin/stock.js` archiva productos y desactiva variantes desde pantalla de stock. | `products.update({ status: "archived", handle })` en `admin/stock.js:2863`; `product_variants.update({ active: false })` en `admin/stock.js:2874`. | Un permiso de stock podria terminar afectando visibilidad/catalogo si la DB no separa permisos. | Revisar regla de negocio: archivar productos debe requerir `products:delete`/`products:archive`, no solo acceso a stock. |
| ALTA | `rpc_reconcile_stock` esta expuesta desde `stock-audit.js` y es una operacion potente. | Llamada JS `supabase.rpc("rpc_reconcile_stock")` en `admin/stock-audit.js:732`; SQL permite admin general (`176...:74-80`) y puede corregir `reserved_qty` con parametro (`176...:291-293`). | Un admin con acceso API podria ejecutar reconciliacion fuera del flujo esperado; con parametros podria alterar `reserved_qty` si la funcion lo permite. | Confirmar grants y limitar a permiso especifico (`stock:audit`/`stock:reconcile`) o super_admin si corresponde. |
| ALTA / DUDOSO | `rpc_move_size_stock` tiene idempotencia fuerte en repo, pero falta confirmar permiso interno exacto y version desplegada. | JS manda `p_operation_id` (`admin/move-stock.js:44-54`); SQL `173` define `rpc_move_size_stock` `SECURITY DEFINER` (`173...:23-35`) y grant a `authenticated, service_role` (`173...:121-125`). | Si la version desplegada no valida permiso o idempotencia correctamente, se podrian duplicar movimientos o mover stock sin permiso granular. | Verificar funcion real en Supabase y probar doble submit con mismo `operation_id`. |
| NORMAL | Buen avance: stock manual ya pasa por RPCs batch en vez de upsert directo. | `admin/stock.js:1810-1813`, `admin/stock.js:1867-1869`, `admin/stock.js:2534-2561`. | Reduce riesgo de drift y mejora historial, siempre que las RPCs canonicas esten desplegadas. | Documentar estas RPCs como camino oficial de escritura de stock manual. |
| NORMAL | Buen avance: `variant_sizes.stock_qty` esta protegido como derivado. | `148...:22-39` bloquea inserts/updates directos; trigger `148...:48-53`. | Evita que alguien escriba stock agregado por talle por fuera de `variant_size_warehouse_stock`. | Confirmar trigger real en produccion. |
| NORMAL / DUDOSO | `stock_history` tiene RLS, pero la lectura depende de politica admin general. | `77...:68-69` habilita RLS; policies admin select/insert `77...:81-107`; `admin/stock.js:2921-2935` lee historial. | Cualquier admin podria ver historial de stock si policy real coincide; puede ser correcto, pero no es granular. | Decidir si historial requiere `stock:view` o basta con estar en `admins`. |
| NORMAL | La documentacion anterior de stock es conceptualmente correcta pero incompleta para operacion diaria. | `04-FLUJO-STOCK.md` describe canonico; esta auditoria detecta llamadas concretas en `stock.js`, `move-stock.js`, `stock-audit.js`, productos y pedidos. | Para mantenimiento, habia que cruzar varias notas y codigo. | Mantener `16-AUDITORIA-MODULO-STOCK.md` como mapa operativo actualizado. |

## Checks sugeridos para cerrar DUDOSO de Stock

Estos checks son propuestas; no fueron ejecutados contra Supabase real en esta auditoria.

```sql
-- Confirmar RPCs criticas de stock, firmas y SECURITY DEFINER
select n.nspname, p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'rpc_set_variant_size_stock_batch',
    'rpc_set_variant_warehouse_stock_batch',
    'rpc_move_size_stock',
    'rpc_reconcile_stock',
    'rpc_apply_order_stock_deduction',
    'rpc_admin_manual_inject_and_deduct',
    'log_stock_change'
  )
order by p.proname, args;

-- Confirmar triggers/guards de stock derivado
select event_object_table, trigger_name, action_timing, event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name in (
    'trg_guard_variant_sizes_stock_qty_writes',
    'trg_guard_variant_warehouse_stock_qty_writes'
  )
order by event_object_table, trigger_name;

-- Confirmar policies reales de tablas de stock
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'variant_sizes',
    'variant_size_warehouse_stock',
    'variant_warehouse_stock',
    'stock_history',
    'stock_movements',
    'warehouses'
  )
order by tablename, policyname;
```

## Observaciones Orders y cruces entre modulos

| Severidad | Observacion | Evidencia | Consecuencia | Recomendacion sin aplicar |
|---|---|---|---|---|
| CRITICA / DUDOSO | RPCs criticas de Orders tienen multiples `CREATE OR REPLACE FUNCTION`; no queda claro por repo cual version esta desplegada. | `rpc_checkout_cart` tiene 9 definiciones; `rpc_close_order` 6; `rpc_cancel_order_item` 3; `rpc_create_public_sale` 6; `rpc_void_public_sale` 5. | El comportamiento real de checkout, cierre, devolucion de stock e idempotencia puede diferir de lo que lee el frontend. | Confirmar `pg_get_functiondef` en Supabase real y documentar version vigente por RPC. |
| CRITICA | Cliente dashboard tiene escrituras directas/fallbacks a `orders` y `order_items`. | `client/dashboard-instant.js:6100` borra `orders`; `6130` actualiza `orders.status`; `6142-6146` borra `orders`/`order_items`. | Si RLS real permite mas de lo esperado, un cliente podria saltar RPCs y romper trazabilidad de stock/fuentes. | Reemplazar o encapsular esas rutas en RPCs controladas; hasta entonces verificar RLS real con usuario cliente. |
| CRITICA / CRUCE STOCK | La creacion admin de pedidos no es una unica transaccion DB end-to-end. | `order-creator.js` inserta `orders` (`3363-3373`), inserta `order_items` (`3416-3419`) y despues descuenta stock con RPCs (`3430-3438`). | Si falla el descuento, queda rollback manual o `stock_pending`; puede haber ventanas de inconsistencia entre Orders y Stock. | Evaluar RPC transaccional para crear/editar pedido admin con items, descuento y fuentes en una sola operacion. |
| ALTA / CRUCE STOCK | Cancelar/remover items depende de RPCs que restauran stock y fuentes; cualquier delete directo puede romper esa trazabilidad. | Admin usa `rpc_remove_order_item_restore_stock` (`orders.js:1318-1320`, `6466-6468`); cliente tiene deletes directos en cancelacion completa (`dashboard-instant.js:6145-6146`). | Stock puede quedar descontado o fuentes (`order_item_stock_sources`) desalineadas si una ruta borra directo. | Auditar y eliminar rutas directas que no pasen por RPC de restauracion de stock. |
| ALTA | RPCs admin de Orders/Stock validan admin general, no permiso granular DB. | `orders_admin_manage` permite todo a cualquier admin (`10_checkout_flow.sql:219-222`); RPCs revisadas consultan `public.admins`; no se detecto `admin_permissions`. | Un colaborador admin podria invocar RPCs de pedidos/stock por DevTools aunque la UI oculte acciones por `orders:edit/delete`. | Agregar check DB granular: `orders:edit`, `orders:delete`, `stock:edit`, `shipping:edit` segun accion. |
| ALTA / DUDOSO | `rpc_send_order_to_local` y RPCs de local/public sale tienen versionado delicado y cruzan ventas publicas/locales. | `rpc_send_order_to_local` tiene 2 definiciones; `rpc_create_public_sale` 6; `local-order-edit.js:415` crea venta publica desde pedido local. | Un cambio en Public Sales puede afectar stock/pedidos locales sin quedar claro en Orders. | Documentar contrato entre Orders, Local Orders y Public Sales; confirmar funciones reales desplegadas. |
| ALTA / CRUCE CUSTOMERS | Orders modifica transporte/notificaciones/cliente desde varias pantallas. | `closed-orders.js` llama `rpc_update_customer_transport`; `sent-orders.js` tambien; `orders.js` escribe `customer_notifications` (`6116-6124`). | Permisos de Customers/Orders pueden mezclarse; un operador de pedidos podria modificar datos de cliente/transporte mas alla de su rol. | Definir permisos separados para `customers:edit_transport`, `orders:notify`, `shipping:edit`. |
| NORMAL | RLS base de `orders`/`order_items` esta bien encaminada conceptualmente. | `10_checkout_flow.sql:194-195` habilita RLS; self-select cliente `205-207` y `234-243`; admin manage `219-222` y `255-258`. | Buen punto de partida, pero admin manage es amplio. | Mantener owner checks para cliente y granularizar admin en DB. |
| NORMAL / DUDOSO | `order_item_stock_sources` tiene RLS admin manage, pero su integridad depende de RPCs. | `151_fix_security_linter_alerts.sql:30-42` habilita RLS y policy admin; comentario indica escritura por RPCs SECURITY DEFINER (`151...:20-23`). | Si alguna ruta no registra fuentes, auditoria de stock/pedido queda incompleta. | Agregar check operativo: cada item picked/descontado debe tener fuentes o razon explicita. |
| NORMAL | La documentacion `05-FLUJO-PEDIDOS.md` es correcta como resumen, pero incompleta como mapa operativo. | La auditoria encontro mas pantallas y RPCs que las descritas alli. | Mantenimiento dificil cuando Orders cambia Stock, Customers, Local Orders y Public Sales. | Usar `17-AUDITORIA-MODULO-ORDERS.md` como mapa operativo y actualizar `05` con enlaces/resumen. |

## Checks sugeridos para cerrar DUDOSO de Orders

Estos checks son propuestas; no fueron ejecutados contra Supabase real en esta auditoria.

```sql
-- Confirmar funciones criticas de Orders, versiones reales y SECURITY DEFINER
select n.nspname, p.proname, p.prosecdef, pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'rpc_checkout_cart',
    'rpc_close_order',
    'rpc_cancel_order_item',
    'rpc_cancel_order_full',
    'rpc_remove_order_item_restore_stock',
    'rpc_update_order_item_status',
    'rpc_split_order_item_status',
    'rpc_apply_order_stock_deduction',
    'rpc_admin_manual_inject_and_deduct',
    'rpc_send_order_to_local',
    'rpc_create_public_sale',
    'rpc_void_public_sale'
  )
order by p.proname, args;

-- Confirmar policies reales de pedidos y fuentes de stock
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'orders',
    'order_items',
    'order_item_stock_sources',
    'customer_notifications',
    'local_orders'
  )
order by tablename, policyname;
```

## Observaciones Public Sales y cruces entre modulos

Nota: el usuario aclaro que los SQL analizados ya estan cargados y activos en Supabase. Las observaciones no asumen falta de deploy; cuando se menciona versionado multiple es por trazabilidad del repo y mantenimiento.

| Severidad | Observacion | Evidencia | Consecuencia | Recomendacion sin aplicar |
|---|---|---|---|---|
| ALTA | `public-sales.js` exige sesion, pero no se detecto permiso frontend granular tipo `public-sales:create/void/credit`. | `admin/public-sales.js:1-10` usa `requireAuth()`; no se detecto `can("public-sales", ...)` en el archivo. | Cualquier admin autenticado con acceso a la pagina podria operar caja si la DB/RPC tambien valida solo admin general. | Agregar control frontend y DB granular para caja, anulacion, creditos y local orders. |
| ALTA | Varias RPCs auxiliares `SECURITY DEFINER` no muestran check admin interno en los bloques revisados. | `rpc_create_pending_sale` (`14...:889-895`), `rpc_get_pending_sales` (`14...:914-925`), `rpc_mark_pending_sale_processing` (`14...:945-950`), `rpc_create_public_customer` y busqueda cliente aparecen como security definer sin admin check detectado. | Si los grants permiten ejecucion amplia, un usuario autenticado podria leer/crear pendientes o datos auxiliares fuera de caja. | Revisar grants reales y agregar validacion interna por permiso especifico. |
| ALTA / CRUCE LOCAL | Finalizar pedido local crea venta por RPC y luego marca `local_orders.completed` directo desde JS. | `admin/public-sales.js:7522-7530` llama `rpc_create_public_sale`; `admin/public-sales.js:7560` actualiza `local_orders`; `local-order-edit.js:415/425` hace flujo similar. | Si la venta se crea pero falla el update directo, el pedido local puede quedar abierto aunque ya exista venta/stock descontado. | Encapsular crear venta + completar local order en una RPC transaccional. |
| ALTA / CRUCE STOCK | Venta/anulacion modifica stock de venta publica; consistencia depende de RPCs `170/171/141`. | Crear venta usa `rpc_create_public_sale` con `operation_id` (`public-sales.js:5613-5622`); anular usa `rpc_void_public_sale` (`8793-8797`); `170` documenta lock/no doble restauracion (`170...:289-290`). | Un bug en rutas de venta/anulacion afecta stock disponible en caja y auditoria de stock. | Mantener todas las mutaciones de stock por RPC; evitar writes directos de stock desde caja. |
| ALTA / CRUCE CREDITOS | Si una venta negativa se registra y luego falla `rpc_add_return_credit`, queda desalineacion venta/credito. | Tras `rpc_create_public_sale`, si `finalTotal < 0`, se llama `rpc_add_return_credit` por separado (`public-sales.js:5655-5664`). | La venta puede quedar registrada sin credito al cliente, afectando saldo y atencion. | Evaluar que credito por devolucion forme parte de la misma RPC/transaccion de venta. |
| MEDIA / ALTA | RLS tiene policies publicas `using (true)` para lectura de ventas/items/clientes/creditos. | `14_public_sales.sql:805-823` crea select para `anon, authenticated` con `using (true)`. | Puede exponer mas datos de venta/cliente/credito de lo deseado si las tablas son consultables por REST. | Confirmar grants REST reales y acotar policies si QR/RPC no requiere lectura publica directa. |
| MEDIA | `rpc_create_public_sale` y `rpc_void_public_sale` tienen multiples definiciones historicas en repo, aunque el SQL activo ya esta cargado. | `rpc_create_public_sale` aparece 6 veces; `rpc_void_public_sale` 5 veces; wrappers `171` y `170` agregan idempotencia y grants. | Mantenimiento riesgoso: un dev puede leer una version vieja y asumir comportamiento incorrecto. | Documentar en `13-RPCS-DEPLOY-STATE.md` que firmas activas son las de `170/171`. |
| MEDIA / CRUCE CUSTOMERS | Cliente web se vincula a cliente Public Sales por RPC. | `client/profile.js:517`, `client/complete-profile.js:369` llaman `rpc_link_public_sales_customer`. | El vinculo puede mezclar datos cliente web/public sales; importante controlar matching y privacidad. | Documentar contrato de vinculacion y datos permitidos. |
| NORMAL | Buen avance: crear/anular venta usa `operation_id` e idempotencia fuerte. | `public-sales.js:5613-5622`, `8793-8797`; wrappers `171...:127-133` y `170...:289-295`. | Reduce riesgo de doble venta o doble restauracion si hay doble click/retry. | Mantener este patron para local orders y pending sales. |

## Checks sugeridos para cerrar riesgos de Public Sales

Estos checks son propuestas; no fueron ejecutados contra Supabase real en esta auditoria.

```sql
-- Confirmar grants reales de RPCs Public Sales
select routine_schema, routine_name, specific_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'rpc_create_public_sale',
    'rpc_void_public_sale',
    'rpc_create_pending_sale',
    'rpc_get_pending_sales',
    'rpc_mark_pending_sale_processing',
    'rpc_complete_pending_sale',
    'rpc_create_public_customer',
    'rpc_search_public_customer',
    'rpc_add_return_credit',
    'rpc_add_customer_credit',
    'rpc_get_public_sale_details'
  )
order by routine_name, specific_name;

-- Confirmar policies reales de tablas de Public Sales
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'public_sales',
    'public_sale_items',
    'public_sales_customers',
    'public_sales_customer_credits',
    'pending_sales',
    'local_orders',
    'local_order_items',
    'daily_sales'
  )
order by tablename, policyname;
```

## Observaciones Cliente/Carrito y cruces entre modulos

Auditoria relacionada: [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

Nota: el usuario aclaro que los SQL analizados ya estan cargados y activos en Supabase. Las observaciones no asumen falta de deploy; cuando se menciona versionado multiple es por trazabilidad del repo y mantenimiento.

| Severidad | Observacion | Evidencia | Consecuencia | Recomendacion sin aplicar |
|---|---|---|---|---|
| ALTA | `price_snapshot` se escribe desde frontend en `cart_items` y la RPC canonica 124 puede usarlo si no es cero. | `scripts/cart-persistent.js:1027-1035`, `1391-1395`, `1466-1474`; `supabase/canonical/124_rpc_checkout_cart_deduct_by_size.sql:241-242`. | Un cliente podria intentar manipular precio por DevTools/API si RLS permite update/insert de su item. | Recalcular precio siempre desde DB durante checkout y tratar `price_snapshot` como dato visual/no confiable. |
| ALTA / CRUCE STOCK | El frontend valida stock antes de agregar, pero un usuario puede saltar esa validacion y escribir `cart_items` directo si RLS lo permite. | `scripts/cart-persistent.js:1504-1599`; writes directos en `scripts/cart-persistent.js:1391`, `1424`, `1466`; checkout DB en `174`/`124`. | Carritos con cantidades/talles manipulados; la barrera real debe estar en `rpc_checkout_cart()`. | Mantener validacion fuerte en `rpc_checkout_cart()` y auditar que no haya ruta alternativa que cierre carrito sin validar stock. |
| ALTA | Existen funciones legacy `SECURITY DEFINER` de carrito que no aparecen en el flujo vivo: `get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item`. | `supabase/canonical/08_cart_items_flexible_fixed.sql:119`, `137`, `166`, `174`. | Si conservan grants amplios, podrian saltarse RLS o permitir leer/limpiar/agregar items fuera del flujo actual. | Revisar grants reales y revocar ejecucion si no se usan. |
| MEDIA / ALTA | `client/cart.html` carga `client/cart.js`; su checkout solo cambia `carts.status` a `pending`, no llama `rpc_checkout_cart`. | `client/cart.html:249`; `client/cart.js:313-325`. | Ruta divergente: carrito marcado como pending sin crear/descontar pedido como el dashboard. | Definir si `client/cart.html` sigue activo. Si queda legacy, documentarlo y evitar flujo alternativo de checkout. |
| MEDIA | El flujo vivo usa direct writes sobre `carts/cart_items` y RLS `for all` para owner. | RLS detectado en `supabase/canonical/05_orders.sql:48-71`; writes en `scripts/cart-persistent.js` y `client/dashboard-instant.js`. | Correcto si ownership esta bien, pero cualquier campo permitido puede ser manipulado por el usuario sobre su carrito. | Revisar `WITH CHECK` exacto y validar columnas sensibles en DB/triggers/RPC checkout. |
| MEDIA | `03-MAPA-DE-RPCS.md` documenta RPCs de carrito (`rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart`) que no aparecen llamadas en el flujo vivo. | `docs/FYL-Obsidian/03-MAPA-DE-RPCS.md:76-82`; busquedas JS no muestran esas llamadas en flujo vivo. | Confusion futura: se puede auditar o tocar una ruta que ya no gobierna el sistema. | Actualizar mapa de RPCs para marcar esas RPCs como legacy/no usadas o confirmar si existen rutas ocultas. |
| NORMAL | El checkout actual desde dashboard usa `operation_id`, `p_request`, fingerprint y wrapper idempotente con lock del carrito. | `client/dashboard-instant.js:2838-2853`; `supabase/canonical/174_rpc_checkout_cart_strong_idempotency.sql:33-97`. | Reduce riesgo de doble pedido/retry por red. | Mantener este patron como canonico para cualquier checkout futuro. |

## Checks sugeridos para cerrar riesgos de Cliente/Carrito

Estos checks son propuestas; no fueron ejecutados contra Supabase real en esta auditoria.

```sql
-- Confirmar grants reales de funciones/RPCs de carrito
select routine_schema, routine_name, specific_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'rpc_checkout_cart',
    'get_user_cart',
    'get_cart_items_simple',
    'clear_cart_items',
    'add_cart_item',
    'rpc_get_or_create_cart',
    'rpc_reserve_item',
    'rpc_submit_cart',
    'rpc_update_cart_item_quantity'
  )
order by routine_name, specific_name;

-- Confirmar policies reales de carrito
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('carts', 'cart_items')
order by tablename, policyname;
```
