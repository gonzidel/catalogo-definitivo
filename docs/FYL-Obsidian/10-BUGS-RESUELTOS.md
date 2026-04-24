# 10 — Bugs resueltos (registro desde el código y contexto de repo)

> Estas entradas resumen el comportamiento y la solución **según comentarios y lógica actual en el repositorio**, no un ticket de issue tracker externo. Ajustar fechas si se contrasta con el historial de git.

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

## Enlaces

- [[11-DECISIONES-TECNICAS]] · [[12-CHECKLIST-CAMBIOS-FUTUROS]] · [[99-AUDITORIA-DOCUMENTACION]]

## VALIDACIÓN

- ✔ **Confirmado por código:** entradas de split y costos contrastadas con `admin/order-creator.js` y `admin/products.js` (comentarios y lógica presentes).  
- ⚠️ **Dudoso:** fechas “2024–2025 (aprox.)” no verificadas contra `git log`.  
- ❌ No aplica marcar como incorrectas las historias de bug; **sí** hubo **error de documentación en otra nota** sobre `admin_confirmed_missing` (corregido en [[04-FLUJO-STOCK]] y [[05-FLUJO-PEDIDOS]], no en las entradas históricas de este archivo).
