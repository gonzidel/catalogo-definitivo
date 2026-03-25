# Resumen Final: Conflictos variant_sizes

## Archivos SIN problemas (NO TOCAR) ✅

1. **admin/stock.js** - Ya usa `variant_sizes` correctamente
2. **admin/publications.js** - Ya fue reparado recientemente  
3. **admin/meta-feed.js** - Usa Edge Functions, no consulta directamente
4. **admin/statistics.js** - Usa RPC functions, no consulta directamente

## Archivos CRÍTICOS a reparar 🔴

### 1. admin/import-export.js
**Problemas:**
- Línea 108: Exporta `size` y `stock_qty` desde `product_variants`
- Línea 294: Exporta inventario con `size` y `stock_qty`
- Línea 904: Actualiza `stock_qty` en `product_variants` durante importación

**Cambios necesarios:**
- Cambiar exportación para obtener talles desde `variant_sizes`
- Cambiar importación para actualizar `variant_sizes.stock_qty`

---

### 2. admin/order-creator.js ⚠️ CUIDADO ESPECIAL
**Estado:** PARCIALMENTE REPARADO - Ya funciona correctamente en varias partes

**Ya funciona correctamente (NO TOCAR):**
- ✅ Líneas 1119-1132: Lee talles desde `variant_sizes`
- ✅ Líneas 2318-2331: Verifica talles en `variant_sizes` al crear pedido
- ✅ Líneas 2506-2519: Verifica talles en `variant_sizes` al pickear
- ✅ Líneas 2414-2442: Actualiza `variant_size_warehouse_stock` correctamente al confirmar
- ✅ Líneas 2650-2680: Actualiza `variant_size_warehouse_stock` correctamente al pickear

**Problema (ELIMINAR estas líneas):**
- ❌ Líneas 2445-2470: Intenta actualizar `product_variants.stock_qty` (redundante)
- ❌ Líneas 2681-2707: Similar, intenta actualizar `product_variants.stock_qty` (redundante)

**Solución:**
- ELIMINAR o comentar el bloque que actualiza `product_variants.stock_qty`
- El stock real ya se actualiza correctamente en `variant_size_warehouse_stock`
- Este código es legacy/redundante

---

### 3. admin/orders.js
**Problemas:**
- Línea 2973: Lee `stock_qty` y `reserved_qty` desde `product_variants`
- Línea 2979: Actualiza `stock_qty` en `product_variants`

**Cambios necesarios:**
- Cambiar lógica para usar `variant_sizes.stock_qty` en lugar de `product_variants.stock_qty`
- **Mantener** `reserved_qty` en `product_variants` (está solo ahí, no en variant_sizes)
- Solo cambiar la parte de `stock_qty`

---

## Archivos NO CRÍTICOS 🟡

### 4. admin/offers.js
- Solo lee `size` desde `product_variants` para mostrar (no actualiza)
- Líneas: 202, 943, 1373, 1642
- **Prioridad:** Baja (solo lectura, no causa errores)

### 5. admin/search.js  
- Solo lee `size` desde `product_variants` para lista de talles
- Línea: 58
- **Prioridad:** Baja (solo lectura, no causa errores)

---

## Prioridad de Reparación

1. **ALTA PRIORIDAD:**
   - import-export.js (funcionalidad crítica)
   - order-creator.js (solo eliminar código redundante, NO tocar lo que funciona)
   - orders.js (funcionalidad crítica)

2. **BAJA PRIORIDAD:**
   - offers.js (solo lectura)
   - search.js (solo lectura)
