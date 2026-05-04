# 25 — Auditoría de catálogo 2026-05-04

Fecha: 2026-05-04
Tipo: auditoría de visibilidad y stock (read-only)
Queries ejecutados: Bloques 1, 2, 3, 4 y 5

---

## Nota sobre la interpretación del Bloque 2

El Bloque 2 devuelve **todas** las variantes con stock real en depósitos, junto con el diagnóstico de por qué podrían estar ocultas. El motivo `"Verificar manualmente"` indica que la variante tiene todas las condiciones cumplidas para aparecer en el catálogo (producto activo, variante activa, imágenes presentes, `variant_sizes.stock_qty > 0`). Esas entradas **no son errores** — son stock visible en catálogo. Solo son accionables los registros con otros motivos.

---

## Resumen ejecutivo

| Categoría | Variantes afectadas | Unidades impactadas | Prioridad |
|-----------|--------------------|--------------------|-----------|
| Stock fantasma visible (Bloque 1) | 3 | 7 | ALTA |
| Talles con drift stock fantasma (Bloque 5) | 5 | 8 | ALTA |
| Variantes activas sin imágenes (Bloque 3) | 25 | ~330 | MEDIA |
| Variante inactiva con stock real significativo | 4 (ALP) | 73 | MEDIA |
| Productos draft con stock elevado | varios | >600 | MEDIA/BAJA |
| Talles con drift menor (±1 unidad) | 3 | — | BAJA |
| Productos activos sin variantes activas (Bloque 4) | 0 | — | OK |

---

## BLOQUE 1 — Productos visibles en catálogo sin stock real

**Resultado: 3 variantes de 2 productos. Son las más urgentes — el cliente puede ver y agregar al carrito pero no hay stock físico.**

| Producto | Color | SKU | Stock variant_sizes | Stock real depósitos | Impacto |
|---------|-------|-----|--------------------|--------------------|---------|
| 72 | NegroBla | PI-72-NB | 1 | 0 | Aparece en catálogo con talle 36 sin stock real |
| JMEEK | Azul | LO-JMEEK-AZ | 2 | 0 | Aparece en catálogo sin stock real |
| JMEEK | Gris | LO-JMEEK-GR | 4 | 0 | Aparece en catálogo sin stock real |

**Diagnóstico:** `variant_sizes.stock_qty > 0` pero `SUM(variant_size_warehouse_stock) = 0`. Los triggers 84/145 están activos pero no reconciliaron este drift. Esto coincide con los 10 diffs detectados en el dashboard general (PASO 0).

**Corrección disponible:** `rpc_reconcile_stock(false)` pone `variant_sizes.stock_qty = 0` para estas variantes. Una vez a 0, desaparecen del catálogo automáticamente (cumple con la decisión D1).

---

## BLOQUE 2 — Stock real no visible (bloqueado)

El query devuelve ~700 filas. La gran mayoría son `"Verificar manualmente"` (stock visible en catálogo, ver nota superior). Los casos accionables son los siguientes:

### 2A. Variantes con stock real pero SIN imágenes (producto activo)

Estos no aparecen en catálogo aunque estén activos con stock. Son los mismos que Bloque 3 (ver sección siguiente).

### 2B. Variante inactiva con stock real — ALP (impacto: 73 unidades)

Producto ALP (Calzado) tiene 4 colores con `product_variants.active = false` pero stock real en depósitos:

| Color | SKU | Stock real |
|-------|-----|-----------|
| Gris | FYL-ALP-GR | 19 |
| Multicolor | FYL-ALP-MU | 15 |
| Rojo | FYL-ALP-RO | 28 |
| Rosa | FYL-ALP-RS | 11 |

**Total: 73 unidades bloqueadas.** Decisión requerida: ¿activar estas variantes o aceptar que están discontinuadas (decisión D3)?

### 2C. Productos en draft o pending_stock con stock elevado

Productos no activos (`draft`, `pending_stock`, `missing_tags`) que tienen stock real considerable. Representan stock comprado que no llegó al catálogo por falta de completar el flujo de alta.

**Casos con ≥ 10 unidades bloqueadas:**

| Producto | Estado | Total unidades (aprox) | Causa |
|---------|--------|----------------------|-------|
| R2107 (Gris Blanco) | draft | 72 | Sin imágenes, draft |
| R2140 (Negro) | draft | 64 | Sin imágenes, draft |
| R2146 (Negro) | draft | 47 | Sin imágenes, draft |
| R2155 (Negro) | draft | 33 | Sin imágenes, draft |
| R2153 (Negro) | draft | 24 | Sin imágenes, draft |
| R2152 (Negro) | draft | 30 | Sin imágenes, draft |
| R2142 (Negro) | draft | 32 | Sin imágenes, draft |
| R2143 (Negro) | draft | 32 | Sin imágenes, draft |
| AMIR (Negro) | draft | 52 | Sin imágenes, draft |
| HRAK2 (Negro) | draft | 48 | Sin imágenes, draft |
| L1964 (Blanco/Negro/Rojo) | draft | 57 | Sin imágenes, draft |
| R1755 (Negro/Verde) | missing_tags | 50 | Faltan tags |
| R2076 (3 colores) | missing_tags | 33 | Faltan tags |
| R2108 (4 colores) | missing_tags | 29 | Faltan tags |
| R2141 (Negro) | draft | 16 | Sin imágenes, draft |
| 1100 (Negro) | draft | 36 | Sin imágenes, draft |
| 8600 (Negro) | draft | 20 | Sin imágenes, draft |
| R1816 (4 colores) | missing_tags | 19 | Faltan tags |

Estos son stocks bloqueados por flujo de trabajo incompleto, no por error de datos. Para hacerlos visibles, deben completar el proceso normal (completar tags con `complete-tags.js` o imágenes con `products.js`).

---

## BLOQUE 3 — Variantes activas con stock pero sin imágenes

**Resultado: 25 variantes con stock real mayor a 0, producto activo, variante activa, pero SIN imágenes. Nunca aparecerán en catálogo hasta que se carguen imágenes.**

| Producto | Color | SKU | Stock variant_sizes | Stock real depósitos |
|---------|-------|-----|--------------------|--------------------|
| 330 | Negro | DO-330-NEG | 9 | 9 |
| AIRN | NegroBla | PA-AIRN-NB | 3 | 3 |
| CHAVE | Blanco | CM-CHAVE-BLA | 25 | 25 |
| ECO | Beige | RO-ECO-BEI | 12 | 12 |
| J25 | Gris | AD-J25-GR | 2 | 2 |
| PANU02 | Varios1 | PANU02-V1 | 4 | 4 |
| PANU02 | Varios7 | PANU02-V7 | 2 | 2 |
| PANU03 | Var13 | ROP-PANU03-V13 | 1 | 1 |
| R1782 | Marron | RO-R1782-MAR | 7 | 7 |
| R1784 | Rojo | R1784-RO | 8 | 8 |
| R1789 | Amarillo | R1789-AMA | 2 | 2 |
| R1801 | Marron | RO-1801-MAR | 2 | 2 |
| R1801 | Negro | RO-1801-NEG | 2 | 2 |
| R1808 | Varios | OH-R1808-VA | 41 | 41 |
| R1958 | Beige | RO-R1958-BEI | 9 | 9 |
| R2129 | Gris | R2129-GR | 14 | 14 |
| R2130 | Negro | R2130-NEG | 14 | 14 |
| R2131 | Gris | R2131-GR | 15 | 15 |
| R2132 | Azul | R2132-AZ | 6 | 6 |
| RB673 | Gris | RO-RB673-GR | 1 | 1 |
| RRHFW8 | Negro | RRHFW8-NEG | 17 | 17 |
| RYM3292 | Blanco | ROP-RYM3292-BLA | 3 | 3 |
| RYM3292 | Marron | ROP-RYM3292-MAR | 4 | 4 |
| TOP | NegNeg | RO-TOP-NN | 72 | 72 |
| VANS | Azul | PA-VANS-AZ | 2 | 2 |

**Total aproximado: ~276 unidades bloqueadas por falta de imágenes.**

**Nota importante:** En estos casos `stock_variant_sizes = stock_real_depositos` — no hay drift. El stock es real y está correctamente registrado. El único problema es la ausencia de imágenes. La corrección es operativa (cargar imágenes), no de stock.

**Casos de mayor impacto por volumen:**
- TOP NegNeg: 72 unidades — color entero sin imágenes
- R1808 Varios: 41 unidades
- CHAVE Blanco: 25 unidades
- R2131 Gris: 15 unidades
- R2130 Negro: 14 unidades

---

## BLOQUE 4 — Productos activos sin variantes activas

**Resultado: 0 filas. No hay productos activos sin al menos una variante activa. OK.**

---

## BLOQUE 5 — Talles con drift entre `variant_sizes` y stock real por talle

**Resultado: 8 filas en 3 categorías.**

### 5A. Stock fantasma confirmado por talle (stock_real_depositos = 0)

Estos talles aparecen visibles en el catálogo pero no tienen respaldo en ningún depósito. Son los más peligrosos porque un cliente puede ver el talle y agregarlo al carrito.

| Producto | Color | SKU | Talle | Declarado | Real | Diferencia |
|---------|-------|-----|-------|-----------|------|-----------|
| JMEEK | Azul | LO-JMEEK-AZ | 39/40 | 2 | 0 | 2 |
| JMEEK | Gris | LO-JMEEK-GR | 43/44 | 2 | 0 | 2 |
| JMEEK | Gris | LO-JMEEK-GR | 45/46 | 2 | 0 | 2 |
| 72 | NegroBla | PI-72-NB | 36 | 1 | 0 | 1 |
| LIKO | Dorado | GM-LIKO-DO | 37 | 1 | 0 | 1 |

**Nota sobre LIKO Dorado talle 37:** Este talle aparece aquí pero NO en Bloque 1. Razón: la variante LIKO Dorado tiene otros talles con stock real en depósitos, por lo que la variante completa sí aparece en catálogo. Solo el talle 37 específicamente es un fantasma (está en `variant_sizes` pero no en `variant_size_warehouse_stock`). El cliente ve el talle 37 como disponible cuando no lo es.

### 5B. Talles sobreestimados (variant_sizes > real — +1 unidad)

| Producto | Color | SKU | Talle | Declarado | Real | Delta |
|---------|-------|-----|-------|-----------|------|-------|
| 195 | GriFuc | C2-195-GF | 27 | 7 | 6 | +1 |
| XH69 | suela | RA-XH69-SU | 40 | 4 | 3 | +1 |

Impacto bajo: 1 unidad de diferencia. No genera problemas operativos inmediatos.

### 5C. Talles subestimados (variant_sizes < real — real es mayor)

| Producto | Color | SKU | Talle | Declarado | Real | Delta |
|---------|-------|-----|-------|-----------|------|-------|
| XH69 | suela | RA-XH69-SU | 39 | 5 | 6 | -1 |

Impacto bajo: hay 1 unidad más en depósito que la que muestra el catálogo. No es peligroso (no genera sobreventa).

---

## Conclusiones del catálogo

### Lo que está bien

- **Bloque 4 = 0**: Todos los productos activos tienen al menos una variante activa. El catálogo no tiene "fantasmas de producto" sin color/variante.
- **Bloque 3**: El stock de las 25 variantes sin imágenes es correcto (no hay drift). El problema es solo operativo.
- **El catálogo es mayormente consistente.** Los problemas estructurales son acotados (3 variantes fantasma en Bloque 1, 5 talles fantasma en Bloque 5).

### Problemas que requieren acción

**Prioridad ALTA — Corregir antes del próximo ciclo:**
1. JMEEK (Azul y Gris) + 72 (NegroBla): aparecen en catálogo con stock 0 real. Se corrigen con `rpc_reconcile_stock(false)`.
2. LIKO Dorado talle 37: talle visible sin stock real. Se corrige con `rpc_reconcile_stock(false)`.

**Prioridad MEDIA — Acción operativa:**
3. 25 variantes sin imágenes (TOP NegNeg 72u, R1808 Varios 41u, CHAVE Blanco 25u, etc.): cargar imágenes desde admin.
4. ALP 4 colores inactivos (73u): decidir si se reactivan o se acepta como discontinuación (decisión D3 ya tomada).

**Prioridad MEDIA/BAJA — Flujo de trabajo pendiente:**
5. Productos draft con stock elevado (AMIR 52u, HRAK2 48u, R2107 72u, R2140 64u, etc.): completar alta de producto (imágenes + tags + activación).
6. Productos missing_tags (R1755 50u, R2076 33u, R1816 19u): completar tags con `complete-tags.js`.

### Hallazgo sobre Bloque 2

El query de Bloque 2 devuelve todas las variantes con stock real. Las que dicen `"Verificar manualmente"` SON visibles en el catálogo y no son errores. Para futuros diagnósticos, el Bloque 2 debe incluir un NOT EXISTS contra las condiciones del catálogo para filtrar solo lo realmente oculto.

---

## Plan de corrección (orden seguro)

1. Ejecutar `rpc_reconcile_stock(false)` → corrige drift de `variant_sizes` y elimina stock fantasma del catálogo (JMEEK, 72, LIKO talle 37, y los 10 diffs detectados en PASO 0).
2. Ejecutar `rpc_reconcile_stock(true)` → adicionalmente corrige los 782 diffs de `reserved_qty` (ver [[24-AUDITORIA-STOCK-2026-05-04]]).
3. Cargar imágenes faltantes para las 25 variantes del Bloque 3 (operativo, desde admin/products.js).
4. Completar flujo de alta para productos en draft/missing_tags con stock elevado.
5. Decidir sobre ALP 4 colores (reactivar vs aceptar como discontinuado).

---

## Estado post-corrección esperado

Después de ejecutar pasos 1 y 2:
- JMEEK y 72 desaparecen del catálogo (stock_qty → 0, se ocultan automáticamente).
- Los 10 diffs de variant_sizes → 0.
- Los 782 diffs de reserved_qty → 0.
- El gate debería pasar a `go_live_ready = true`.

---

## Notas para documentación futura

- El query de Bloque 2 genera falsos positivos para entradas visibles. En futuras auditorías, agregar un NOT EXISTS contra las condiciones del catálogo.
- LIKO Dorado talle 37 es un caso especial: el Bloque 1 no lo detecta (porque otros talles de esa variante tienen stock) pero Bloque 5 sí lo captura. Esto confirma que Bloque 5 es más granular que Bloque 1 para detectar talles fantasma individuales.

## Enlaces

- [[24-AUDITORIA-STOCK-2026-05-04]] — auditoría de stock (PASO 0, reserved_qty)
- [[06-RESERVED-QTY-Y-RECONCILE]] — procedimiento de corrección
- [[02-MODELO-STOCK-ACTUAL]] — modelo de tablas
- [[11-DECISIONES-TECNICAS]] — decisiones D1, D2, D3 relevantes
