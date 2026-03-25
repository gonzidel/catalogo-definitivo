# Tabla de Conflictos: Estructura Antigua (product_variants.size/stock_qty) en Admin

## Resumen Ejecutivo

Esta tabla identifica todos los módulos del admin que pueden tener problemas relacionados con el uso de la estructura antigua `product_variants.size` y `product_variants.stock_qty` en lugar de la nueva estructura `variant_sizes` y `variant_size_warehouse_stock`.

---

## Archivos SIN Problemas (Ya Corregidos o No Afectados)

| Módulo | Archivo | URL | Estado | Notas |
|--------|---------|-----|--------|-------|
| **Stock** | `admin/stock.js` | `/admin/stock.html` | ✅ CORREGIDO | Ya usa `variant_sizes` y `variant_size_warehouse_stock`. Se agregó fallback para casos sin stock por warehouse. |
| **Publicaciones** | `admin/publications.js` | `/admin/publications.html` | ✅ CORREGIDO | Ya fue reparado recientemente, usa `variant_sizes` correctamente. |
| **Meta Feed** | `admin/meta-feed.js` | `/admin/meta-feed.html` | ✅ NO AFECTADO | Usa Edge Functions, no consulta directamente `product_variants`. |
| **Estadísticas** | `admin/statistics.js` | `/admin/statistics.html` | ✅ NO AFECTADO | Usa RPC functions, no consulta directamente `product_variants`. |
| **Etiquetas** | `admin/labels.js` | `/admin/labels.html` | ✅ CORRECTO | Ya usa `variant_sizes` y `variant_size_warehouse_stock` correctamente. |
| **Productos Incompletos** | `admin/incomplete-products.js` | `/admin/incomplete-products.html` | ✅ CORRECTO | Ya usa `variant_sizes` y `variant_size_warehouse_stock` correctamente. |
| **Venta al Público** | `admin/public-sales.js` | `/admin/public-sales.html` | ✅ CORRECTO | Ya usa `variant_sizes` y `variant_size_warehouse_stock` correctamente. |
| **Productos FYL** | `admin/fyl-products.js` | `/admin/fyl-products.html` | ✅ CORRECTO | Ya usa `variant_sizes` y `variant_size_warehouse_stock` correctamente. |
| **Productos** | `admin/products.js` | `/admin/products.html` | ✅ CORRECTO | Ya usa `variant_sizes` correctamente (líneas 1200, 1259, 1532, 4952, 5583). |
| **Imágenes Faltantes** | `admin/missing-images.js` | `/admin/missing-images.html` | ✅ NO AFECTADO | No consulta `product_variants.size` o `stock_qty`. |
| **Pedidos Cerrados** | `admin/closed-orders.js` | `/admin/closed-orders.html` | ✅ NO AFECTADO | No consulta `product_variants.size` o `stock_qty`. |
| **Ventas Diarias** | `admin/daily-sales.js` | `/admin/daily-sales.html` | ✅ NO AFECTADO | No consulta `product_variants.size` o `stock_qty`. |

---

## Archivos CON Problemas (Requieren Reparación)

### 🔴 CRÍTICOS (Causan errores o datos incorrectos)

| Módulo | Archivo | URL | Problema | Líneas Afectadas | Prioridad |
|--------|---------|-----|----------|------------------|-----------|
| **Importar/Exportar** | `admin/import-export.js` | `/admin/import-export.html` | Exporta y actualiza `size` y `stock_qty` desde `product_variants` | 108, 294, 904 | 🔴 ALTA |
| **Creador de Pedidos** | `admin/order-creator.js` | `/admin/order-creator.html` | Intenta actualizar `product_variants.stock_qty` (código redundante) | 2445-2470, 2681-2707 | 🔴 ALTA ⚠️ |
| **Pedidos** | `admin/orders.js` | `/admin/orders.html` | Lee y actualiza `stock_qty` desde `product_variants` al cambiar estado | 2973-2979 | 🔴 ALTA |
| **Pedidos Enviados** | `admin/sent-orders.js` | `/admin/sent-orders.html` | Devuelve stock usando `variant_warehouse_stock` sin considerar `size` del item | 1198-1244 | 🔴 ALTA |

**Nota sobre order-creator.js:** Este archivo está PARCIALMENTE REPARADO. Ya usa `variant_sizes` y `variant_size_warehouse_stock` correctamente en varias partes. Solo necesita eliminar el código redundante que intenta actualizar `product_variants.stock_qty`.

### 🟡 NO CRÍTICOS (Solo lectura, no causan errores pero deben actualizarse)

| Módulo | Archivo | URL | Problema | Líneas Afectadas | Prioridad |
|--------|---------|-----|----------|------------------|-----------|
| **Ofertas** | `admin/offers.js` | `/admin/offers.html` | Consulta `size` desde `product_variants` para mostrar | 202, 943, 1373, 1642 | 🟡 BAJA |
| **Búsqueda** | `admin/search.js` | `/admin/search.html` | Obtiene talles únicos desde `product_variants.size` | 58 | 🟡 BAJA |
| **Mover Stock** | `admin/move-stock.js` | `/admin/move-stock.html` | Consulta `size` desde `product_variants` en búsqueda | 61, 74, 78, 149, 284 | 🟡 MEDIA |


---

## Detalles por Archivo

### 1. admin/import-export.js 🔴 CRÍTICO

**Problemas:**
- `exportVariants()`: Exporta `size` y `stock_qty` desde `product_variants` (línea 108)
- `exportInventory()`: Exporta inventario con `size` y `stock_qty` desde `product_variants` (línea 294)
- `importInventory()`: Actualiza `stock_qty` directamente en `product_variants` durante importación (línea 904)

**Impacto:** La importación/exportación no funciona correctamente con la nueva estructura.

**Estado:** ⚠️ PENDIENTE DE REPARACIÓN

---

### 2. admin/order-creator.js 🔴 CRÍTICO - ⚠️ CUIDADO ESPECIAL

**Estado:** PARCIALMENTE REPARADO

**Ya funciona correctamente (NO TOCAR):**
- ✅ Líneas 1119-1132: Lee talles desde `variant_sizes` con fallback
- ✅ Líneas 2318-2331: Verifica talles en `variant_sizes` al crear pedido
- ✅ Líneas 2506-2519: Verifica talles en `variant_sizes` al pickear
- ✅ Líneas 2414-2442: Actualiza `variant_size_warehouse_stock` correctamente al confirmar pedido
- ✅ Líneas 2650-2680: Actualiza `variant_size_warehouse_stock` correctamente al pickear

**Problema (ELIMINAR código redundante):**
- ❌ Líneas 2445-2470: Bloque que intenta actualizar `product_variants.stock_qty` después de actualizar `variant_size_warehouse_stock`
- ❌ Líneas 2681-2707: Similar, intenta actualizar `product_variants.stock_qty` al marcar como "picked"

**Solución:** Eliminar o comentar completamente el bloque de código que actualiza `product_variants.stock_qty` (es redundante, el stock real ya se actualiza en `variant_size_warehouse_stock`).

**Estado:** ⚠️ PENDIENTE DE REPARACIÓN (solo eliminar código redundante)

---

### 3. admin/orders.js 🔴 CRÍTICO

**Problemas:**
- Líneas 2973-2979: Lee y actualiza `stock_qty` desde `product_variants` al cambiar estado de pedido
- También maneja `reserved_qty` (debe mantenerse en `product_variants`)

**Cambios requeridos:**
- Cambiar lógica para usar `variant_size_warehouse_stock` en lugar de `product_variants.stock_qty`
- **MANTENER** la lógica de `reserved_qty` en `product_variants` (esta columna no existe en `variant_sizes`)

**Estado:** ⚠️ PENDIENTE DE REPARACIÓN

---

### 5. admin/offers.js 🟡 NO CRÍTICO

**Problemas:**
- Líneas 202, 943, 1373, 1642: Consulta `size` desde `product_variants` (solo lectura para mostrar)

**Impacto:** Muestra datos incorrectos o incompletos (no causa errores pero debe corregirse).

**Estado:** ⚠️ PENDIENTE DE ACTUALIZACIÓN (baja prioridad)

---

### 6. admin/search.js 🟡 NO CRÍTICO

**Problemas:**
- Línea 58: Obtiene talles únicos desde `product_variants.size`

**Impacto:** Lista de talles para búsqueda está incompleta.

**Estado:** ⚠️ PENDIENTE DE ACTUALIZACIÓN (baja prioridad)

---

### 7. admin/move-stock.js 🟡 NO CRÍTICO

**Problemas:**
- Líneas 61, 74, 78: Consulta `size` desde `product_variants` en la búsqueda de variantes
- Líneas 149, 284: Muestra `variant.size` que viene de la consulta anterior

**Impacto:** La búsqueda por talle no funcionará correctamente porque `product_variants.size` ya no existe. La búsqueda fallará silenciosamente o no encontrará resultados.

**Solución:** 
- Eliminar `size` del select de `product_variants`
- Obtener talles desde `variant_sizes` después de obtener las variantes
- Combinar resultados en memoria
- Actualizar la búsqueda para buscar en `variant_sizes` en lugar de `product_variants.size`

**Nota:** El stock se obtiene correctamente vía RPC `get_variant_stock_by_warehouse`, así que esa parte está bien.

**Estado:** ⚠️ PENDIENTE DE ACTUALIZACIÓN (prioridad media)

---

### 4. admin/sent-orders.js 🔴 CRÍTICO

**Problemas:**
- Líneas 1198-1244: Cuando se elimina un item de un pedido enviado, devuelve el stock usando `variant_warehouse_stock` (stock total por variante)
- No considera el `size` del item (línea 194: los items tienen `size`)
- Debería devolver el stock al talle específico en `variant_size_warehouse_stock`

**Impacto:** Al eliminar items de pedidos enviados, el stock se devuelve incorrectamente al stock general de la variante en lugar del talle específico, causando inconsistencias en el inventario.

**Cambios requeridos:**
- Verificar si el item tiene `size`
- Si tiene `size`, actualizar `variant_size_warehouse_stock` para ese `variant_id`, `size` y `warehouse_id` específicos
- Si no tiene `size`, mantener el comportamiento actual con `variant_warehouse_stock` (para compatibilidad con items antiguos)

**Estado:** ⚠️ PENDIENTE DE REPARACIÓN

---

## Prioridad de Reparación

### Fase 1: CRÍTICOS (Alta Prioridad)
1. `admin/import-export.js` - Funcionalidad crítica de importación/exportación
2. `admin/order-creator.js` - Solo eliminar código redundante (muy cuidadoso)
3. `admin/orders.js` - Funcionalidad crítica de actualización de pedidos
4. `admin/sent-orders.js` - Devuelve stock incorrectamente (no considera talle)

### Fase 2: NO CRÍTICOS (Baja/Media Prioridad)
5. `admin/move-stock.js` - Búsqueda por talle no funciona (prioridad media)
6. `admin/offers.js` - Solo lectura (prioridad baja)
7. `admin/search.js` - Solo lectura (prioridad baja)

---

## Notas Importantes

1. **reserved_qty:** Esta columna solo existe en `product_variants`, NO en `variant_sizes`. Mantener toda la lógica relacionada con `reserved_qty` en `product_variants`.

2. **variant_size_warehouse_stock:** El stock real se almacena en esta tabla, que relaciona `variant_id`, `size`, `warehouse_id` y `stock_qty`. Esta es la fuente de verdad para el stock.

3. **order-creator.js:** El código ya actualiza `variant_size_warehouse_stock` correctamente. Solo se debe eliminar el código redundante que intenta actualizar `product_variants.stock_qty`.

4. **stock.js:** Recientemente corregido para usar fallback de `variant_sizes.stock_qty` cuando no hay stock en `variant_size_warehouse_stock`.

---

## Total de Archivos

- **Archivos SIN problemas:** 11
- **Archivos CON problemas CRÍTICOS:** 4
- **Archivos CON problemas NO CRÍTICOS:** 3

**Total de archivos a modificar:** 7 (4 críticos + 3 no críticos)
