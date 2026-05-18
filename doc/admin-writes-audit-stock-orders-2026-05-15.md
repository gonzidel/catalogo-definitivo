# Auditoría — Escrituras admin directas vs stock / pedidos / reservas

**Fecha:** 2026-05-15  
**Alcance:** diagnóstico consolidado en repo (sin cambios de código ni SQL).  
**Objetivo:** mapa de mutaciones PostgREST desde `admin/`, clasificación de riesgo, orden sugerido de migración incremental hacia RPC centralizadas **sin** refactor masivo ni romper panel mobile-first.

**Obsidian (resumen + enlaces):** `docs/FYL-Obsidian/34-ADMIN-WRITES-STOCK-ORDERS-AUDIT-2026-05-15.md`  
**RFC diseño (sin implementación):** `doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md` — `rpc_create_admin_order_atomic()` reemplazo atómico de `createNewOrder` en `order-creator.js`.  
**Estrés concurrencia / simulación fallos (sin SQL):** `doc/rfc-create-admin-order-atomic-concurrency-stress-2026-05-15.md`  
**Contrato idempotencia v1 (congelado):** `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`  
**Plan implementación staging:** `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`  
**Contexto reservas / reconciliación:** `docs/FYL-Obsidian/06-RESERVED-QTY-Y-RECONCILE.md`, `doc/stock/stock-arquitectura.md`

---

## 1. Resumen ejecutivo

- **Pedidos / cancelación / ítems operativos:** la mayoría de caminos críticos en `orders.js` ya pasan por **RPC** (`rpc_cancel_order_full`, `rpc_remove_order_item_restore_stock`, `rpc_close_order`, `rpc_apply_order_stock_deduction` indirecto vía `order-creator`, etc.).
- **Stock por talle / depósito (canónico):** `stock.js`, `import-export.js`, `incomplete-products.js` y flujos alineados usan **`rpc_set_variant_size_stock_batch`** / **`rpc_set_variant_warehouse_stock_batch`** (y variantes de guardado inicial en `products.js`).
- **Riesgo residual principal:** secuencias **multi-request** (insert `orders` + `order_items` + varias RPC) **sin transacción envolvente en el cliente**; rollbacks manuales en `order-creator.js` si el descuento falla; **imports masivos** que mezclan muchos `.update` a `product_variants` + batches RPC (fallo a mitad = estado parcial); escrituras **directas** a `orders` (notas, `dismantle_at`, `payment_method`, estados puntuales) que no mueven stock pero sí **coherencia operativa**.
- **`reserved_qty`:** no hay updates directos frecuentes desde estos archivos; la variante agregada se alinea vía **`rpc_reconcile_stock`** en `stock-audit.js` (operación explícita admin). El flujo vivo viene de **triggers / RPC checkout / fuentes** (ver nota 06).

---

## 2. Mapa de escrituras (archivos prioritarios + otros)

Leyenda **riesgo:** **A** crítico (stock, reservas, pedidos, void masivo), **B** medio, **C** bajo.

### 2.1 `admin/orders.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Cancelación pedido | `rpc_cancel_order_full` | **A** (centralizado) | `cancelOrder` + `cancelOrderInFlight` anti doble click. Idempotencia vía respuesta RPC (`idempotent_noop`). |
| Quitar ítem / restaurar stock | `rpc_remove_order_item_restore_stock` | **A** | Varios call sites. |
| Estados ítems / split / cierre | `rpc_update_order_item_status`, `rpc_split_order_item_status`, `rpc_close_order`, `rpc_mark_order_as_sent`, `rpc_send_order_to_local`, `rpc_mark_order_items_picked` | **A** | Operaciones distribuidas en UI; dependen de `operation_id` en picked. |
| Notas pedido | `.from("orders").update({ notes })` | **B** | Dos helpers (lectura previa + merge JSON). Sin stock; riesgo de pisar `notes` si concurrencia. |
| Habilitar 24h / dismantle | `.from("orders").update({ dismantle_at, notes, … })` | **B** | Afecta caducidad cliente; no stock directo. |
| Resolver stock pending | `.from("orders").update({ status: "active", notes })` | **B** | Tras limpieza de ítems (flujo relacionado RPC). |
| Notificaciones | `customer_notifications` insert/delete | **C** | Metadatos cliente. |

**Patrones:** muchas lecturas `order_items` / `orders`; realtime suscrito a `order_items`. **No** hay `update` directo masivo a `variant_size_warehouse_stock` en este archivo.

### 2.2 `admin/stock.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Guardado grilla stock | `rpc_set_variant_size_stock_batch` + `rpc_set_variant_warehouse_stock_batch` | **A** (bien encaminado) | Reemplaza upserts directos duplicados; `Promise.all` de `product_variants.update` (precio/activo) en paralelo con RPC. |
| Precio / activo variante | `.from("product_variants").update` | **B** | No es stock físico pero afecta venta. |
| Archivar producto | `.from("products").update` + desactivar variantes | **B** | Impacto catálogo / disponibilidad. |

**Paralelismo:** `variantUpdates` + RPC en misma función de guardado — si RPC OK y `product_variants` falla, posible **inconsistencia** UI vs servidor (mitigar con orden estricto o RPC única en fases futuras).

### 2.3 `admin/import-export.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Import inventario CSV | Batches `rpc_set_variant_size_stock_batch` (`p_source: import_inventory`) | **A** | Tamaño batch 200; **no** transacción global: muchas llamadas RPC secuenciales. |
| Por fila | `.from("product_variants").update({ price, active })` | **A/B** | Si falla a mitad del CSV, **precio/activo** pueden quedar adelantados respecto al stock del mismo SKU. |
| Import productos / imágenes / tags | múltiples `insert`/`update`/`delete` en `products`, `product_variants`, `variant_images`, `product_tags`, `colors` | **B** | Volumen alto; riesgo de duplicados / FK si se interrumpe. |
| `reserved_qty: 0` en payloads | solo en objetos de construcción hacia tablas | revisar contexto | Asegurar que no escriba `reserved_qty` inconsistente fuera de RPC (líneas ~790, ~1401: campos en payload hacia variantes — validar en siguiente iteración contra esquema). |

### 2.4 `admin/fyl-products.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Stock / precio rápido | `rpc_set_variant_size_stock` / `rpc_set_variant_warehouse_stock` (y batches según líneas ~849–950) | **A** | Centralizado. |
| Toggle activo producto | `.from("products").update({ active })` | **B** | Visibilidad catálogo. |

### 2.5 `admin/incomplete-products.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Completar stock pendiente | `rpc_set_variant_size_stock_batch` + `rpc_set_variant_warehouse_stock_batch` | **A** | Comentarios explícitos sobre triggers **84** / **145**. |
| Activar producto | `.from("products").update({ status: "active" })` | **B** | Tras stock. |
| Tags | `insert` tag raíz | **C** | Bajo riesgo stock. |

### 2.6 `admin/order-creator.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Crear pedido | `insert` en `orders` luego `insert` en `order_items` | **A** | **No** hay `BEGIN` en cliente: si falla `updateStockBatch` después, **rollback manual** `delete order_items` + `delete orders` (líneas ~3793–3818). Si rollback falla → **pedido huérfano o ítems sin stock descontado** (riesgo operativo). |
| Stock | `rpc_admin_manual_inject_and_deduct`, `rpc_apply_order_stock_deduction` vía `updateStockBatch` | **A** | Bien delegado post-insert. |
| Concurrencia pedido abierto | `23505` manejado en mensaje | **B** | UX; no sustituye RPC única “crear pedido + ítems + stock”. |

### 2.7 `admin/public-sales.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Venta / void | `rpc_create_public_sale`, `rpc_void_public_sale`, créditos, pending sale RPCs | **A** | Núcleo ya RPC. |
| `order_items` | select / join en UI | **C** lectura | Línea ~585: verificar que no sea mutación (grep mezcla select). |
| Pedido local completado | `.from("local_orders").update({ status: "completed" })` | **B** | Tras `rpc_create_public_sale`; si RPC OK y update local falla, **desalineación** local vs venta (ya logueado). |
| Otro path | `local_orders` update línea ~7355 | **B** | Mismo patrón. |

### 2.8 `admin/stock-audit.js`

| Área | Mecanismo | Clasificación | Notas |
|------|-----------|---------------|--------|
| Reconciliar `reserved_qty` + stock | `rpc_reconcile_stock` con `p_fix_reserved_qty` | **A** | Acción consciente admin; debe seguir siendo **auditable** y preferible **una RPC** (ya lo es). |
| Archivar desde auditoría | `.update({ status: "archived" })` | **B** | Producto. |

### 2.9 `admin/products.js` (alcance parcial)

- **Stock inicial / talles:** `rpc_save_product_variant_initial_stock`, `assign_qr_code_to_variant_size` — **A** bien centralizado.
- **Gran volumen** `insert`/`update`/`delete` catálogo (productos, variantes, imágenes, tags, suppliers): **B** (no siempre stock, pero transaccionalidad débil entre pasos del guardado largo en UI).

### 2.10 Otros admin con mutaciones relevantes

| Archivo | Mutaciones | Clasificación |
|---------|------------|---------------|
| `move-stock.js` | `rpc_move_size_stock` | **A** (RPC) |
| `closed-orders.js` | `orders.update`, RPC transporte / etiquetas / revert picked | **A/B** mezcla |
| `sent-orders.js` | `orders.update` payment_method; RPC devolución / reprogramar | **B** + **A** RPC |
| `publications.js` | `products`/`publication_events` updates, inserts | **B** (publicación / precio) |
| `daily-sales.js` | updates / deletes | **B** (operación diaria) |
| `offers.js`, `quick-actions.js`, `compras-proveedores.js`, `collaborators.js`, `customers.js` | diversas | **B/C** según tabla |
| `test_connection.js` | insert/delete test | **C** (solo test) |

---

## 3. Flujo real de `reserved_qty` (simplificado)

1. **Reserva operativa:** carritos abiertos (`cart_items` reservados) + pedidos no finales vía **`order_item_stock_sources`** (y estados de `order_items` / `orders`) — ver `doc/stock/stock-arquitectura.md` y [[06-RESERVED-QTY-Y-RECONCILE]].
2. **Columna agregada** `product_variants.reserved_qty`: mantenida por **lógica servidor** (triggers / RPC checkout / reconciliación); el **admin no la edita campo a campo** en los archivos auditados salvo reconciliación global.
3. **Corrección admin:** `stock-audit.js` → `rpc_reconcile_stock` (opción fix reserved) — punto único sensible de **escritura consciente** sobre drift.

**Triggers / RPC citados en código (referencia, no exhaustivo):** 84 (sync variant_sizes), 145 (variant_warehouse), 166 `rpc_apply_order_stock_deduction`, 188 ledger reservas, `rpc_cancel_order_full`, batches 164/165.

---

## 4. Detección de riesgos (preguntas del encargo)

| Riesgo | Dónde / evidencia |
|--------|-------------------|
| Writes **no idempotentes** | Import CSV (misma fila dos veces puede acumular efectos según lógica de negocio); `order-creator` depende de rollback manual, no idempotency key en insert orden. |
| Updates **distribuidos** | `stock.js`: N updates `product_variants` + M batches RPC; `import-export` producto masivo multi-tabla. |
| Sin **transacción** única | Todo flujo PostgREST multi-paso desde el navegador; única atomicidad real = **RPC server-side** o procedimiento almacenado envolvente. |
| Escrituras **paralelas** | `Promise.all(variantUpdates)` en `stock.js`; doble click mitigado con sets `InFlight` en orders/stock. |
| Frontend modifica **stock** directo | **Reducido:** talles vía RPC batch; riesgo residual en **imports/legacy** si reaparece escritura directa a `variant_size_warehouse_stock` (no vista en grep de escritura directa en los 5 archivos foco; `public-sales` solo **select** en VSW salvo flujos legacy comentados). |

---

## 5. Priorización solicitada (estado actual)

| Prioridad | Estado actual | Siguiente mejora incremental (sin big-bang) |
|-----------|---------------|-------------------------------------------|
| **cancelOrder** | Ya **RPC** `rpc_cancel_order_full` | Documentar contrato + test integración; opcional RPC “única” que incluya notificaciones si se quiere atomicidad. |
| **rpc_void_public_sale** | Ya **RPC** en `public-sales.js` | Misma línea: tests + manejo errores UI. |
| **reserved_qty** | Reconciliación vía **`rpc_reconcile_stock`** | Evitar cualquier nuevo `update` directo a `product_variants.reserved_qty` desde JS; cualquier nueva UI → misma RPC. |
| **Imports masivos** | Stock por **RPC batch**; precio por **update** directo | **1ª meta tangible:** envolver “precio + stock” del import inventario en **una RPC** idempotente con `p_batch_id` / staging table, o orden estricto “primero stock RPC, luego precio” con compensación documentada. |

---

## 6. Plan incremental (admin → RPC) — por etapas

**Etapa 0 (ahora):** congelar comportamiento; solo observabilidad (logs, métricas de error RPC) y tests manuales checklist.

**Etapa 1 — “Un solo round-trip” donde más duela:**  
- `import-export.js` inventario: RPC `rpc_import_inventory_row` o batch server con payload completo (SKU, precio, active, stock, size) **transaccional**.  
- Opcional: `order-creator` → RPC `rpc_create_admin_order` que inserte orden + ítems + aplique stock (reemplaza rollback manual).

**Etapa 2 — Coalescer updates de `orders` no stock:**  
- RPC pequeña `rpc_patch_order_notes` / `rpc_enable_order_24h` con validación server-side JSON — reduce carreras en `notes`.

**Etapa 3 — `products.js` guardado largo:**  
- Sin reescribir todo el UI: RPC “commit product draft” por etapas o tabla staging ya usada en otros módulos.

**Etapa 4 — Cierre de deuda lectura/escritura:**  
- Revisar `public-sales` `local_orders` update tras venta: RPC `rpc_complete_local_order_after_sale` para alinear con venta.

**Principios:** mantener PostgREST, **no** romper mobile-first; cada etapa **reversible** con feature flag o ruta dual (RPC + fallback) durante 1 release si hace falta.

---

## 7. Riesgo operativo global

| Nivel | Descripción |
|-------|---------------|
| **Alto** | Fallo a mitad de import o rollback `order-creator` incompleto → datos parciales. |
| **Medio** | Paralelismo `Promise.all` + RPC en `stock.js`; updates `orders` concurrentes sobre `notes`. |
| **Bajo** | Mutaciones catálogo puras sin tocar stock canónico. |

---

## 8. Qué **no** se hace en esta auditoría

- Refactor masivo, nuevas Edge Functions obligatorias, ni revocar PostgREST a `admin`.  
- Cambios en `catalog_public_available_view` / cliente dashboard.

---

## 9. Próximo paso recomendado (único)

Elegir **un** flujo de Etapa 1 (recomendado: **import inventario** o **create admin order**) y redactar RFC corto: firma RPC, idempotencia, rollback SQL, pruebas `scripts/` — **antes** de tocar producción (alineado a reglas FYL Supabase production safety).
