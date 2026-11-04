# 66 — Auditoría profunda: RPCs de pedidos, duplicados y carreras (2026-09-17)

Relacionado: [[03-MAPA-DE-RPCS]], [[05-FLUJO-PEDIDOS]], [[13-RPCS-DEPLOY-STATE]], [[17-AUDITORIA-MODULO-ORDERS]], [[59-NJ-CHECKOUT-IDEMPOTENCY-ROOT-PREP-2026-09-04]], [[65-AUDITORIA-PEDIDOS-EXPIRED-INVISIBLES-Y-STOCK-FANTASMA-2026-09-15]].

## Alcance y evidencia

- Flujos cliente NJ y legacy: cancelación completa/parcial, checkout y replay local.
- Flujos admin NJ y legacy: alta sobre pedido existente, confirmación, desarmado y reapertura.
- Todas las redefiniciones locales de las RPC críticas y sus rollback.
- Definiciones, comentarios, hashes y ACL vigentes en Supabase producción.
- Fixtures PostgreSQL locales sobre dump de esquema productivo, sin datos reales.
- Prueba concurrente con dos sesiones para checkout vs. cancelación.

No se ejecutaron fixtures ni cambios de datos en producción.

## Estado de la reparación prioritaria

La migración `346_fix_customer_cancel_verified_terminal_order.sql` fue:

1. compilada sobre esquema productivo local;
2. validada con `346_customer_cancel_runtime_tests.sql`;
3. revertida con su rollback y reaplicada;
4. probada con dos sesiones concurrentes;
5. aprobada explícitamente;
6. aplicada a producción;
7. verificada por `SELECT`.

Estado live:

- `customer_order_cancellation_audit` existe y quedó con 0 filas tras el deploy;
- `order_items_reject_cancelled_parent` es constraint trigger diferido;
- `rpc_customer_cancel_order(uuid)` contiene contrato `verified` y escritura de auditoría;
- `anon` no puede ejecutarla;
- `authenticated` sí puede;
- el deploy no modificó pedidos ni stock.

Frontend preparado, todavía no publicado:

- NJ valida el JSON terminal y limpia la operación checkout previa;
- una operación `completed` ya no se reutiliza como una compra nueva por fingerprint;
- dashboard legacy usa la RPC atómica en vez de loops/direct CRUD;
- Cancelados muestra todas las líneas del pedido terminal.

`npm run build` de NJ y 29 pruebas focalizadas pasan. `tsc --noEmit` conserva únicamente dos errores preexistentes de fixtures en `lib/orders/board-scope.test.ts`.

## Hallazgos críticos

### P0-1 — Alta admin puede resucitar pedidos terminales

`nj/lib/supabase/order-edit.ts::addItemsToExistingOrder`:

- lee el estado;
- inserta líneas en una llamada independiente;
- luego fuerza `status='active'` para cualquier estado distinto de closed/sent/devolución.

Por lo tanto incluye `cancelled`, `expired` y estados futuros no previstos.

`admin/order-creator.js::addItemsToExistingOrder` repite el patrón. Hace una segunda lectura, pero sigue siendo TOCTOU y también puede forzar `active`.

Impacto:

- reapertura silenciosa de un pedido cancelado;
- líneas insertadas aunque el cambio posterior falle;
- stock aplicado parcialmente por llamadas posteriores;
- total, estado, fuentes y reservas sin una transacción común.

Remediación requerida: nueva RPC admin atómica con `FOR UPDATE`, allowlist cerrada de estados editables, inserción, stock, fuentes, total y estado en una transacción. NJ y legacy deben dejar de hacer esta composición por REST.

### P0-2 — Canonicalidad declarada no coincide con producción

`supabase/canonical/RPC_CANONICAL_MAP.md` y `150_guard_critical_rpc_versions.sql` siguen declarando:

- checkout `canonical:124`;
- cierre `canonical:83`.

Producción demuestra:

- `rpc_checkout_cart()` = comentario `canonical:335`, precio efectivo y reglas modernas;
- `rpc_close_order(uuid,text)` conserva checks modernos de 261/309/320 y notificaciones, aunque su comentario sigue diciendo 83;
- `rpc_customer_cancel_order(uuid)` = 346.

El guard actual puede rechazar un despliegue correcto y aceptar/reafirmar una versión obsoleta.

### P0-3 — SQL históricos ejecutables pueden producir downgrades

Los archivos no son snapshots pasivos: contienen `CREATE OR REPLACE FUNCTION` y algunos `DROP FUNCTION`.

Casos de mayor riesgo:

- reaplicar 119 después de 319/344 puede borrar pedidos con cancelados y stock pendiente;
- reaplicar checkout anterior a 331/335 pierde gate físico, precio efectivo o reglas de retiro;
- reaplicar cierre 10/52 puede descontar stock por segunda vez;
- reaplicar 137/269 después de 312 pierde `deferred_stock_pending`;
- reaplicar 234/235 cambia el contrato de cancelación;
- ejecutar rollback por glob puede instalar deliberadamente una versión vieja.

### P0-4 — Falsos éxitos frontend

Corregidos localmente, pendientes de publicación:

- NJ aceptaba cancelación solo por `error=null`;
- legacy cancelaba línea por línea, ignoraba fallos y hacía UPDATE/DELETE directos;
- NJ trataba una operación checkout `completed` con fingerprint igual como compra exitosa sin sync ni RPC.

## Inventario de duplicados y canon efectivo

### Checkout

- Al menos 16 cuerpos completos de `rpc_checkout_cart()` entre migraciones y rollback.
- Firma fuerte `(uuid,jsonb)` de 174 delega en la firma base.
- Canon live: base 335 + wrapper 174.
- El comentario del wrapper todavía dice “canonical:124 vía 149”.

### Cierre

- Ocho familias de definiciones históricas.
- Canon de comportamiento live: 320, aunque el comentario visible dice 83.

### Cancelación completa cliente

- 234, 235, 318 y ahora 346.
- Canon live: 346.

### Cancelación por línea/unidades

- 10/85/126/269/312 para línea; 137/269/312 para unidades.
- 312 redefine cada firma dos veces dentro del mismo archivo; la segunda pisa la primera.
- Semántica efectiva: último cuerpo de 312 + trigger 344.

### Borrado de pedido vacío

- `maint_try_delete_order_if_eligible`: cuerpo 119.
- `order_eligible_for_empty_deletion`: redefinición 319.
- helper de fuentes canceladas: redefinición final 344.
- Esta composición no está representada correctamente como una unidad canónica.

### Reapertura

- 125/270/323/339.
- Canon live probable y confirmado por marcadores: 339.

## Hallazgos altos

### P1-1 — Confirmación múltiple no atómica

`confirmAllCancelledItems` ejecuta una RPC por ítem. Si falla la tercera, las anteriores ya quedaron persistidas; el rollback del store solo restaura una fotografía visual hasta el próximo refresh.

Remediación: RPC batch transaccional que devuelva resultados por ítem solo después del commit.

### P1-2 — Edición rápida de cantidad ignora error lógico

El camino rápido de `ActiveOrderTab` espera `rpc_cancel_order_item_units`, pero no valida su `{error}` antes de cerrar/refrescar.

Remediación: wrapper tipado con validación `applied`, error visible y refresh confirmado.

### P1-3 — Grants anónimos innecesarios

Producción aún permite `EXECUTE` a `anon` para:

- `rpc_cancel_order_item_units(uuid,integer)`;
- `rpc_customer_reopen_order_for_editing(uuid)`.

Ambas contienen controles internos de identidad, por lo que no se confirmó bypass, pero la exposición es innecesaria y aumenta superficie.

### P1-4 — Staging no es reproducible

La rama Supabase temporal falló porque el historial remoto solo registra cinco migraciones tardías de hardening. La base preview nació sin `orders`.

Remediación: baseline versionado del esquema, migraciones incrementales reales y CI que cree una base vacía hasta HEAD.

## Hallazgos medios

- Algunos callers legacy de `rpc_remove_order_item_restore_stock` validan error HTTP pero no `data.ok`.
- Comentarios de 269, 83 y 124 ya no representan la implementación efectiva.
- `rpc_cancel_order_full` mantiene idempotencia débil y depende del audit de borrado.
- Los helpers de elegibilidad siguen ejecutables para `PUBLIC/anon`; no se confirmó impacto de datos por ser `SECURITY INVOKER`, pero deben entrar en una revisión de grants por allowlist.
- Los rollback están junto a migraciones normales y necesitan exclusión mecánica.

## Plan de remediación

### Fase 0 — Publicar frontend 346

Responsable: usuario. Publicar NJ después del backend ya instalado. El legacy puede desplegarse en su siguiente release de Firebase.

### Fase 1 — Migración 347: alta admin atómica

- RPC nueva con lock de pedido.
- Allowlist explícita de estados.
- Idempotencia por `operation_id`.
- Líneas, stock, fuentes, total y estado en una transacción.
- Migrar callers NJ y legacy.
- Fixtures de carrera: modal abierto, cancelación en otra sesión, confirmación posterior.

### Fase 2 — Consolidar canon

- Actualizar `RPC_CANONICAL_MAP.md`.
- Reemplazar el guard 150 por fingerprints modernos.
- Incorporar checkout 335, cierre 320, cancelación 346, item 312+344 y reapertura 339.
- Añadir CI que falle si un archivo nuevo redefine una firma crítica sin registrar sucesor.
- Separar rollback de la carpeta ejecutable.

### Fase 3 — Atomicidad y permisos

- RPC batch para confirmación de cancelados.
- Wrapper de cancelación parcial con contrato.
- Revocar `anon` en RPCs autenticadas.
- Validar `data.ok/applied` en todos los callers legacy.

### Fase 4 — Staging reproducible

- Baseline completo.
- Reconstrucción desde cero en CI.
- Fixtures de checkout/stock/cancelación en cada cambio crítico.

## Rollback y deuda

El rollback de 346 restaura comportamiento 318/319 y elimina el trigger concurrente, pero conserva deliberadamente `customer_order_cancellation_audit` para no destruir evidencia.

Deuda principal restante: el alta/edición admin sigue fuera de una transacción. Debe ser el siguiente fix antes de ampliar funcionalidades de pedidos.

## Avance Fase 1 — 347 preparado localmente

Estado al 2026-09-17: **implementado en repositorio y validado localmente; no aplicado
a producción**.

Archivos:

- `supabase/canonical/347_rpc_admin_add_order_items_atomic.sql`
- `supabase/canonical/347_ROLLBACK_rpc_admin_add_order_items_atomic.sql`
- `supabase/canonical/347_admin_add_order_items_atomic_runtime_tests.sql`

La RPC `rpc_admin_add_order_items_atomic(uuid,jsonb,uuid)`:

- bloquea la fila de `orders` con `FOR UPDATE`;
- exige que el estado observado por el cliente siga siendo el actual;
- rechaza `cancelled`, `expired`, `stock_pending` y cualquier estado fuera de la
  allowlist;
- inserta líneas, aplica inyección manual/deducción real, actualiza stock,
  `reserved_qty`, total, notas y estado en una sola transacción;
+- escribe `order_item_stock_sources` también para deducciones normales
+  (166 no las crea por sí sola);
 - excluye líneas `cancelled/expired` al recalcular el total;
-- conserva `closed`, `sent` y `devolución`; solo normaliza
-  `active/closing_soon` a `active`;
+- allowlist: `active`, `closing_soon`, `closed`; rechaza `sent`,
+  `devolución`, `cancelled`, `expired` y `stock_pending`;
+- conserva `closed`; solo normaliza `active/closing_soon` a `active`;
 - usa una clave UUID persistida en `localStorage` por pedido + fingerprint del
   intento, de modo que un timeout pueda repetir la misma operación sin duplicar.

**Update 2026-09-18 (350):** allowlist vuelve a incluir `sent` para
`admin/sent-orders.html` (agregar ítems a pedido ya enviado sin reabrir).
Sigue bloqueado: `devolución`, `cancelled`, `expired`, `stock_pending`.
El `UPDATE` preserva `sent` (no fuerza `active`).

Callers migrados localmente:

- NJ: `OrderCreateModal`, `OrderEditModal` y
  `nj/lib/supabase/order-edit.ts`;
- legacy: `admin/order-creator.js`.

Evidencia local:

- fixture de éxito, total, extra especial y exclusión de línea cancelada: OK;
- replay con la misma clave: misma línea y stock sin duplicar;
- stock insuficiente: rollback de línea, stock y dedupe;
- pedido cancelado: rechazo sin línea ni dedupe residual;
- dos sesiones con la misma clave: una ejecución y un replay;
- cambio concurrente de `active` a `cancelled`: `ORDER_STATE_CHANGED`, sin
  inserción.

Antes de producción falta la revisión crítica final y presentar el SQL exacto,
riesgo, rollback y verificación para aprobación explícita.
