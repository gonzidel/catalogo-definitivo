# 10 — Bugs resueltos (registro desde el código y contexto de repo)

> Estas entradas resumen el comportamiento y la solución **según comentarios y lógica actual en el repositorio**, no un ticket de issue tracker externo. Ajustar fechas si se contrasta con el historial de git.

---

## 2026-05-04 — Producción: drift `reserved_qty` al marcar pedido enviado (migración 188)

### Síntoma

- Pedidos en **`sent`** (y otros finales excluidos por la vista 175) seguían con **`order_item_stock_sources.qty > 0`** mientras **`product_variants.reserved_qty`** no bajaba al dejar de contar en `real_reserved_qty`.
- Auditoría: **`reserved_qty_inflated`** («Stock disponible subestimado») y uso recurrente de **`rpc_reconcile_stock(true)`** como parche.

### Causa

Al pasar a estado final, la vista deja de sumar esas fuentes en `real_reserved_qty`, pero no existía ajuste automático de **`reserved_qty`** en la transición.

### Solución

Migración **188** (`supabase/canonical/188_order_reserved_qty_release_on_final_status.sql`): tabla **`order_reserved_qty_released`**, función **`release_reserved_qty_for_order`**, trigger **`trg_orders_release_reserved_qty_on_final_status`** en `orders` (solo **`reserved_qty`**; sin tocar stock físico ni borrar fuentes). Idempotencia por PK **`order_id`**.

Cierre histórico: **`rpc_reconcile_stock(true)` una sola vez** tras deploy; **sin** backfill masivo por pedidos.

### Archivos / SQL

- `supabase/canonical/188_order_reserved_qty_release_on_final_status.sql`
- `supabase/canonical/188_POST_DEPLOY_VERIFICATION.sql`
- `supabase/canonical/188_STAGING_TEST_PLAN_order_reserved_release.md` (pruebas previas)

### Cómo verificar

Ver [[06-RESERVED-QTY-Y-RECONCILE]] §188 y ejecutar queries de `188_POST_DEPLOY_VERIFICATION.sql` (objetos, trigger `tgenabled = O`, prueba `closed` → `sent`, KPI infladas).

---

## 2026-05-04 — products.js: tags de categoría incorrecta al cargar producto existente

### Síntoma

Al buscar y cargar un producto de categoría **Ropa** en `admin/products.html`:
- El selector Tag1 mostraba tags de **Calzado** en lugar de Ropa.
- Los tags ya guardados no aparecían seleccionados (selectores en blanco).
- El panel "Detalles" cargaba Tags3 de la categoría equivocada.

### Causa

En `loadProductById`, el campo `#category` del DOM se actualizaba **después** de llamar a `renderTags1()`, `renderTags2()`, `renderTags3()` y `renderDetailsList()`. Todas esas funciones llaman a `getProductCategory()` que lee el DOM en tiempo real → devolvía la categoría anterior (generalmente "Calzado").

```js
// ANTES (orden incorrecto):
selectedTag1Id = pt.tag1_id;
await renderTags1();                    // ← lee DOM: "Calzado" ❌
await renderDetailsList();              // ← idem ❌
// ...
document.getElementById("category").value = prod.category;  // tarde
```

### Solución

Mover `document.getElementById("category").value = prod.category` al inicio del bloque, antes de cualquier render de tags.

### Archivos

- `admin/products.js`

### Cómo verificar

Cargar un producto con categoría Ropa → Tag1 muestra opciones de Ropa → tag guardado aparece seleccionado → panel Detalles muestra Tags3 de Ropa.

---

## 2026-05-04 — products.js: crear Tag1 no habilita Tag2 inmediatamente

### Síntoma

Al crear un Tag1 nuevo desde el input de `admin/products.html`, el selector Tag2 permanecía deshabilitado ("Primero selecciona Tags1"). El usuario tenía que deseleccionar y volver a elegir Tag1 para activar Tag2.

### Causa

El handler `tag1Create` llamaba solo `renderTags1()` tras crear el tag, pero no `renderTags2()` ni `renderTags3()`. El estado `selectedTag1Id` sí se actualizaba, pero los selectores dependientes no se refrescaban.

### Solución

Agregar `await renderTags2(); await renderTags3();` después de `await renderTags1()` en el handler `tag1Create`.

### Archivos

- `admin/products.js`

### Cómo verificar

Crear un Tag1 nuevo → Tag2 se habilita inmediatamente sin intervención adicional del usuario.

---

## 2026-05-04 — products.js: autocompletado de nombre en categoría Ropa

### Síntoma

Al seleccionar categoría **Ropa** en `admin/products.html`:
- Si el nombre estaba vacío, se auto-rellenaba con `R{número}` (ej. `R142`).
- Si el nombre no empezaba con `R\d`, se anteponía `"R"` automáticamente.
- Comportamiento no práctico para carga real de productos.

### Causa

La función `updateNamePrefix()` ejecutaba esta lógica para Ropa disparada por el evento `category.change`.

### Solución

`updateNamePrefix()` retorna inmediatamente para categoría Ropa (`return` early). La lógica de limpieza para otras categorías (quitar prefijo `R\d` si se cambia desde Ropa) permanece intacta.

### Archivos

- `admin/products.js`

### Cómo verificar

- Seleccionar Ropa → campo nombre queda vacío, sin auto-rellenar.
- Cambiar a Calzado → si el nombre tenía prefijo `R\d`, se limpia.

---

## 2026-05-04 — complete-tags: producto queda en `missing_tags` para siempre

### Síntoma

Al guardar tags en `admin/complete-tags.html`, el mensaje decía "El estado del producto se actualizará automáticamente", pero el producto permanecía con `status = 'missing_tags'` indefinidamente y nunca aparecía en el catálogo.

### Causa

No existía ningún trigger DB que realizara la transición `missing_tags → active` al guardar en `product_tags` o `product_tag_details`. Confirmado con:

```sql
SELECT trigger_name, event_object_table
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND (trigger_name ILIKE '%missing_tags%' OR trigger_name ILIKE '%product_status%');
-- Resultado: Success. No rows returned
```

### Solución aplicada

En `admin/complete-tags.js`, tras guardar exitosamente tags y details, se ejecuta explícitamente:

```js
await supabase.from("products").update({ status: "active" }).eq("id", currentProductId)
```

Si el update falla, se muestra aviso visible en lugar de silenciarlo. El mensaje de éxito ya no dice "automáticamente".

### Archivos

- `admin/complete-tags.js`

### Cómo verificar

1. Tomar un producto con `status = 'missing_tags'`.
2. Completar Tags1, Tags2 y al menos un detalle. Guardar.
3. Verificar en Supabase: `SELECT status FROM products WHERE id = '<id>'` → debe ser `active`.
4. El producto debe desaparecer de la lista en `complete-tags.html`.

---

## 2026-05-04 — complete-tags: errores de carga silenciosos en pantalla

### Síntoma

Si la query a Supabase fallaba al cargar productos `missing_tags` (error de red, RLS, etc.), no se mostraba nada en pantalla. `showStatus()` era una función vacía que solo hacía `console.log`.

### Causa

`showStatus` tenía implementación intencionalmente pendiente:
```js
function showStatus(message, type = "info") {
  // Esta función se puede implementar si se necesita...
  console.log(`[${type}] ${message}`);
}
```

### Solución aplicada

`showStatus` con `type === "error"` ahora inyecta un bloque rojo visible en el `productsContainer` además de logguear en consola.

### Archivos

- `admin/complete-tags.js`

---

## 2026-05-04 — stock-audit: links del card O2 no diferenciaban por estado

### Síntoma

El card "Altas de producto pendientes" en `admin/stock-audit.html` mostraba dos links genéricos en el footer ("Alta incompleta" y "Tags"), independientemente del `status` de cada producto. Un producto `pending_stock` podía enviarse a `complete-tags.html` y viceversa.

### Causa

El footer era estático; no usaba el campo `status` de cada producto para determinar el destino.

### Solución aplicada

Se agregó `getLinkForStatus(status)` en `admin/stock-audit.js`. Cada fila del card muestra ahora un link "Completar →" que apunta a:

| `status` | Destino |
|---|---|
| `pending_stock` | `incomplete-products.html` |
| `missing_tags` | `complete-tags.html` |
| `draft` | `products.html` |

### Archivos

- `admin/stock-audit.js`

---

## 2026-05-04 — incomplete-products: categoría "Otros" ignorada + sin estado vacío

### Síntoma

Productos con categorías distintas de "Calzado" o "Ropa" (ej. accesorios) con `status = 'pending_stock'` no aparecían en `admin/incomplete-products.html`. Además, si no había ningún producto pendiente, la pantalla quedaba en blanco sin ningún mensaje.

### Causa

`refreshProducts()` solo filtraba `Calzado` y `Ropa`. No había container HTML para otras categorías ni manejo del array vacío total.

### Solución aplicada

- Agregada sección `<section id="others-section">` con `#others-container` en el HTML (oculta por defecto; visible solo si hay productos).
- `refreshProducts()` ahora filtra también `others` y los renderiza.
- Si `incompleteProducts.length === 0`, se muestra "✅ No hay productos pendientes de stock."

### Archivos

- `admin/incomplete-products.html`
- `admin/incomplete-products.js`

---

## 2026-04-29 — Orders admin: stock insuficiente al fusionar 2 unidades del mismo SKU

### Sintoma

Al cargar o editar pedido en admin, podia aparecer:

- `rpc_apply_order_stock_deduction: stock insuficiente ... disponible=1, solicitado=2`

incluso cuando el stock total del SKU parecia suficiente entre depositos.

### Causa

- La linea fusionada acumulaba `qty_from_venta`/`qty_from_general` por suma historica en lugar de recalcular split por deposito segun cantidad total.
- Caso tipico: stock partido (`venta=1`, `general=1`) y dos altas priorizando venta terminaban como `qty_from_venta=2`, lo que fuerza a la RPC a descontar 2 en un solo `warehouse_id`.

### Solucion aplicada (en codigo)

- Se agrego `computeWarehouseQtySplitForOrderItem(quantity, stockGeneral, stockVenta)` en `admin/order-creator.js`.
- En `addProductToOrder`, al obtener stock por talle en `variant_size_warehouse_stock`, se guarda snapshot para split (`fetchedStockForSplit`).
- Al fusionar lineas iguales:
  - si hay snapshot de stock, ya no se suman ciegamente `qty_from_general` y `qty_from_venta`;
  - se recalcula el split final del item afectado segun su `quantity` total y stock por deposito.
- Se mantiene fallback previo (suma original) si falla la lectura de stock.

### Archivos tocados (referencia)

- `admin/order-creator.js`

### Como verificar

- Preparar un SKU con stock partido (ejemplo: `venta=1`, `general=1`) para el mismo talle.
- Agregar 2 unidades del mismo SKU en admin (incluyendo caso de fusion de linea).
- Verificar en consola que el item final quede con split `1+1` (no `2+0` todo en venta).
- Guardar pedido y confirmar que no aparece el error `stock insuficiente ... solicitado=2` para un solo deposito.

---

## 2024–2025 (aprox.) — Stock insuficiente en admin por split inconsistente

### Síntoma

Al confirmar un pedido admin, el descuento de stock fallaba o no aplicaba correctamente si las cantidades `qty_from_general` + `qty_from_venta` no coincidían con `quantity`, o luego de un “reset” del split (comportamiento relato en comentarios de `admin/order-creator.js`).

### Causa

- Un **fallback** previo reasignaba toda la cantidad a un depósito de forma que la validación de `rpc_apply_order_stock_deduction` no coincidía con el stock real por almacén.  
- Código explícito: comentario en `itemQualifiesForApplyOrderStockDeduction` que menciona *“bug del fallback que pedía toda la venta a un depósito”* (paráfrasis).

### Solución aplicada (en código)

- Criterio estricto: `g + v === q` (general + venta = cantidad) y excluir `status === "missing"` y `admin_confirmed_missing` del camino de `rpc_apply_order_stock_deduction`. Construcción de `deductions` **solo** desde `qty_from_general` y `qty_from_venta` alineados. Ver `itemQualifiesForApplyOrderStockDeduction` y `updateStockBatch` en `admin/order-creator.js`.

### Archivos tocados (referencia)

- `admin/order-creator.js` (lógica de `updateStockBatch` / `itemQualifiesForApplyOrderStockDeduction`).

### Riesgo futuro

- Cualquier cambio que reintroduzca fallback a un solo depósito o permita `g+v≠quantity` reabre el fallo.  
- Integraciones que inserten `order_items` sin respetar el split.

### Cómo verificar

- Casos con cantidad partida entre general y venta pública; forzar `g+v` ≠ `quantity` y constatar que el ítem **no** pasa a deducción automática (logs `console` en el mismo flujo).  
- Pedidos puramente con `admin_confirmed_missing` deben ir por `rpc_admin_manual_inject_and_deduct`, no por `apply_order_stock_deduction`.

---

## 2024–2025 (aprox.) — Fallback que reasignaba cantidades a depósito

### Síntoma

Relacionado con el bug anterior: descuentos o mensajes de stock incorrectos al enviar toda la cantidad a un almacén.

### Causa

- Asignación automática a un depósito único (detalle en comentarios alrededor de `itemQualifiesForApplyOrderStockDeduction` y del bloque “sin fallback” en `updateStockBatch`).

### Solución

- Misma lógica estricta de split; eliminado el reintento a un solo almacén (según comentarios y ausencia de fallback en el bloque auditado de `updateStockBatch`).

### Archivos

- `admin/order-creator.js`

### Riesgo futuro

- Copiar/pegat flujos de otra rama o de documentación desactualizada.  
- Modificar `updateStockBatch` sin tests con dos depósitos.

### Cómo verificar

- Pruebas manuales con `console.table` de `itemsForStockDeduction` y `itemsSkippedFromStockDeduction` (ya loguea el script).  
- Límites: stock 1 en general, 0 en venta y viceversa.

---

## 2024–2025 (aprox.) — Campos de costo visibles a colaboradores

### Síntoma

Quien no debería ver costo/margen/logístico accedía a esos campos o veían prefilled.

### Causa

- Faltante de gating estricto por **rol `super_admin`** a nivel de UI (frente a solo `products: can_edit`).

### Solución

- Uso de `isSuperAdmin()` y control de `disabled`/vacío de inputs para no volcar `cost`/`logistic` al DOM para colaboradores. Ver `admin/products.js` (líneas de comentario y carga cerca de “Populate pricing fields (solo super_admin)…”).

### Archivos

- `admin/products.js`  
- `admin/permissions-helper.js` (`isSuperAdmin`)

### Riesgo futuro

- Añadir nuevos formularios de producto que expongan costos sin `isSuperAdmin()`.  
- RLS/BD: la documentación de este repo no audita en profundidad políticas; **DUDOSO** a nivel de DB.

### Cómo verificar

- Probar con usuario colaborador: campos de costo vacíos o deshabilitados; con `super_admin`, visibles.  
- Revisar `console` por advertencias al resolver `isSuperAdmin()`.

---

## 2026-04 (aprox.) — Checkout falla: item sin variante asociada (`variant_id` null)

### Sintoma

Al hacer pedido desde el dashboard, `rpc_checkout_cart` devuelve un error cuyo mensaje indica que el item (UUID) no tiene variante asociada (ver texto exacto en `10_checkout_flow.sql` / RPC).

### Causa

- Filas en `public.cart_items` con **`variant_id` NULL** (merge desde `localStorage`, consolidacion de duplicados, sync previo, o legacy).
- La RPC itera `cart_items` y exige variante; ver flujo en `supabase/canonical/10_checkout_flow.sql` y cuerpo en `124_*`.

### Solucion aplicada (en codigo)

- `syncCartWithSupabase`: resolver variante con `fetchVariantInfo`; **no** persistir lineas sin `variant_id` resuelto.
- `repairCartItemsMissingVariantIds` al cargar carrito en dashboard.
- `cleanupDuplicateCartItems`: no insertar duplicado sin variante.
- `submitCurrentCart`: validacion previa y mensaje amigable; manejo de error RPC.

### Archivos (referencia)

- `scripts/cart-persistent.js`, `client/dashboard-instant.js`

### Riesgo futuro

- Cualquier nuevo camino que escriba `cart_items` sin `variant_id` reabre el fallo.  
- Documentacion o SQL de diagnostico que asuman columna `sku` en `cart_items` (no existe en el esquema actual).

### Como verificar

- Consulta `select ... from cart_items where variant_id is null`.  
- Flujo: agregar con sesion, duplicar lineas, merge post-login, checkout.

**Nota de contexto ampliada:** [[21-CONTEXTO-AGENTE-HARDENING-2026-04]].

---

## 2026-04 (aprox.) — Index: loader y texto “Cargando destacados…” mal posicionado / persistente

### Sintoma

En mobile u orden de carga, el area superior (F&L, banners) “salta” o queda un loader/etiqueta de carga visible de forma confusa.

### Causa

- Layout sin reserva de altura en el bloque superior; uso del loader global bajo filtros en lugar de estado local al slot; overlay de boot vs carga de extras de home desalineados.

### Solucion aplicada (en codigo y CSS)

- Contenedor `#home-top-dynamic-slot` con clases de estado, `min-height` y `syncHomeTopSlotState` en `scripts/main-supabase.js`.  
- Loader local `#home-top-dynamic-loader` con atributo `hidden` y reglas en `styles.css` para no dejar texto visible al terminar.

### Archivos (referencia)

- `index.html`, `styles.css`, `scripts/main-supabase.js`

**Nota de contexto ampliada:** [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] (seccion 3.2).

---

## Enlaces

- [[11-DECISIONES-TECNICAS]] · [[12-CHECKLIST-CAMBIOS-FUTUROS]] · [[99-AUDITORIA-DOCUMENTACION]] · [[21-CONTEXTO-AGENTE-HARDENING-2026-04]]

## VALIDACIÓN

- ✔ **Confirmado por código:** entradas de split y costos contrastadas con `admin/order-creator.js` y `admin/products.js` (comentarios y lógica presentes).  
- ⚠️ **Dudoso:** fechas “2024–2025 (aprox.)” no verificadas contra `git log`.  
- ❌ No aplica marcar como incorrectas las historias de bug; **sí** hubo **error de documentación en otra nota** sobre `admin_confirmed_missing` (corregido en [[04-FLUJO-STOCK]] y [[05-FLUJO-PEDIDOS]], no en las entradas históricas de este archivo).
