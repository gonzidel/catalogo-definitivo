# 26 — Especificación UX: Módulo "Salud de Stock"

Versión: 1.0
Fecha: 2026-05-04
Tipo: especificación de diseño e implementación futura
Estado: pendiente de implementación (FASE 7)

---

## Decisión de diseño

No se crea pantalla nueva. Se evoluciona `admin/stock-audit.html` + `admin/stock-audit.js` como módulo "Salud de stock". El título visible para el operador es **"Salud de stock"**, no "Auditoría".

---

## Objetivo UX

Un operador debe entender en menos de 10 segundos:

1. si el stock está sano,
2. si hay riesgo de sobreventa,
3. qué tareas operativas debe resolver.

---

## Estructura general

```
[ Header de estado ]

[ Bloque 1 — Acciones críticas ]        ← solo si hay críticos
[ Bloque 2 — Problemas de catálogo ]    ← solo si hay atenciones
[ Bloque 3 — Oportunidades operativas ] ← siempre visible si tiene items
[ Bloque 4 — Última revisión ]
```

---

## Bloque 0 — Header de estado general

### Estados posibles


| Estado    | Condición                                            | Color    | Ícono | Texto                                                     |
| --------- | ---------------------------------------------------- | -------- | ----- | --------------------------------------------------------- |
| SALUDABLE | `go_live_ready = true`                               | Verde    | ✓     | "Stock en orden. No hay acciones requeridas."             |
| ATENCIÓN  | `go_live_ready = false` y solo problemas no críticos | Amarillo | ⚠     | "Hay situaciones a revisar. Sin riesgo inmediato."        |
| CRÍTICO   | `go_live_ready = false` y tiene críticos             | Rojo     | ✕     | "Hay riesgo activo de sobreventa o datos inconsistentes." |


### Lógica de clasificación

**CRÍTICO si alguno de:**

- `reserved_qty_diffs > 0` AND hay variantes `deflated` (stock disponible sobreestimado)
- Hay productos visibles en catálogo con stock real = 0 (phantoms)
- `critical_signals > 0`
- `trigger_84_active = false` OR `trigger_145_active = false`

**ATENCIÓN si ninguno de los anteriores y alguno de:**

- `reserved_qty_diffs > 0` (solo inflated — stock subestimado, no genera sobreventa)
- `variant_sizes_diffs > 0`
- `orphan_rows > 0`
- `warning_signals > 0`

**SALUDABLE:** todos los KPIs en 0, triggers activos.

### Componente visual

```
┌─────────────────────────────────────────────────────┐
│  ✓  STOCK EN ORDEN          Actualizado hace 2 min  │
│     Todos los indicadores en cero.                  │
│                                    [Actualizar]     │
└─────────────────────────────────────────────────────┘
```

El botón "Actualizar" recarga los datos sin ejecutar correcciones.

---

## Bloque 1 — Acciones críticas

**Visible solo cuando hay críticos.** No existe si el estado es SALUDABLE o ATENCIÓN.

Cada problema crítico se muestra como una **card roja** con:

- Título del problema (sin terminología técnica)
- Descripción en lenguaje operativo
- Cantidad de afectados
- Botón de acción con confirmación obligatoria

### Cards críticas definidas

---

#### Card C1 — Productos visibles sin stock real

**Fuente de datos:** query equivalente al Bloque 1 de la auditoría (variantes que aparecen en catálogo pero tienen `SUM(variant_size_warehouse_stock) = 0`)

**Texto de la card:**

> **Productos visibles sin stock real**
> N variantes aparecen en el catálogo pero no tienen stock en depósito. Los clientes pueden agregar estos productos al carrito.

**Vista expandida (cards por variante):**

```
[ Producto: JMEEK ]  [ Color: Azul ]  [ SKU: LO-JMEEK-AZ ]
  Talles afectados: 39/40            Stock real: 0 unidades
```

**Acción:** "Corregir stock del catálogo"

- Confirmación: "¿Confirmar? Se actualizarán X talles y desaparecerán del catálogo."
- Llama: `rpc_reconcile_stock(false)`
- Permisos: cualquier admin
- Feedback: spinner → resultado inline

---

#### Card C2 — Reservas sobreestimadas (deflated)

**Fuente de datos:** `vw_stock_audit_reserved_qty_diff WHERE anomaly_type = 'reserved_qty_deflated'`

**Texto de la card:**

> **Riesgo de sobreventa**
> N variantes tienen más unidades reservadas en pedidos/carritos de lo que el sistema registra. El stock disponible visible es mayor al real.

**Vista expandida:**

```
[ Producto: 332 ]  [ Color: Rosa ]  [ SKU: C2-332-RS ]
  En carritos: 3    Reserved registrado: 0    Diferencia: +3
```

**Acción:** "Corregir reservas"

- Confirmación explícita: "Esta acción actualiza el campo reserved_qty para N variantes. Solo super_admin puede ejecutarla."
- Llama: `rpc_reconcile_stock(true)`
- **Permisos: solo super_admin** (verificar `isSuperAdmin()` en JS + validación en RPC)
- Si el usuario no es super_admin: botón deshabilitado con tooltip "Requiere super_admin"

---

#### Card C3 — Triggers de sincronización inactivos

**Fuente de datos:** `trigger_84_active`, `trigger_145_active` del gate

**Texto de la card:**

> **Sincronización automática desactivada**
> Los triggers que mantienen el catálogo sincronizado con el stock real están inactivos. Los cambios de stock no se reflejan automáticamente.

**Acción:** "Ver documentación técnica" (link a nota del vault o runbook, sin acción automática)

- No hay corrección automática desde UI. Requiere intervención técnica en DB.

---

### Si no hay críticos, este bloque no se renderiza

```js
if (criticals.length === 0) return; // no renderizar el bloque
```

---

## Bloque 2 — Problemas que afectan catálogo

**Visible cuando hay atenciones** (no críticos). Color amarillo/naranja. No generan acción inmediata obligatoria pero deben resolverse.

### Cards de atención definidas

---

#### Card A1 — Reservas subestimadas (inflated)

**Fuente de datos:** `vw_stock_audit_reserved_qty_diff WHERE anomaly_type = 'reserved_qty_inflated'`

**Texto:**

> **Stock disponible subestimado**
> N variantes muestran menos stock disponible del real. Los clientes pueden ver "sin stock" cuando en realidad hay unidades libres.

**Vista expandida:**

```
[ Producto: AD ]  [ Color: Blanco ]  [ SKU: FYL-AD-BLA ]
  Reserved registrado: 12    Reservas reales: 0    Diferencia: 12
```

**Acción:** "Corregir reservas"

- Solo super_admin
- Misma confirmación que C2
- Llama: `rpc_reconcile_stock(true)`

**Nota UX:** Si hay tanto deflated (C2) como inflated (A1), C2 toma prioridad. La corrección de C2 resuelve A1 también (misma acción).

---

#### Card A2 — Diffs en stock por talle

**Fuente de datos:** `vw_stock_audit_variant_sizes_diff` (rows con delta ≠ 0 y stock real > 0)

**Texto:**

> **Stock por talle desalineado**
> N talles tienen diferencias entre el stock declarado y el real en depósitos.

Vista simplificada, sin detalle expansivo en la mayoría de los casos. Solo muestra el count y un enlace a vista detalle.

**Acción:** "Sincronizar stock visible"
- Confirmación: "Esto va a sincronizar el stock visible del catálogo con el stock real de depósitos. Los talles sin stock real dejarán de mostrarse."
- Llama: `rpc_reconcile_stock(false)`
- **Permisos: solo super_admin o stock_manager**

---

#### Card A3 — Filas huérfanas

**Fuente de datos:** `vw_stock_audit_orphan_size_rows`

**Texto:**

> **Stock en depósito no visible en catálogo**
> N talles tienen unidades en depósito pero no están registrados como disponibles.

**Acción:** "Sincronizar stock visible"
- Confirmación: "Esto va a sincronizar el stock visible del catálogo con el stock real de depósitos. Los talles sin stock real dejarán de mostrarse."
- Llama: `rpc_reconcile_stock(false)`
- **Permisos: solo super_admin o stock_manager**

---

## Bloque 3 — Oportunidades operativas

**No son errores. Son tareas pendientes del flujo de alta de productos.**
Color neutro (gris/azul). No tienen urgencia pero sí impacto en ventas.

### Cards operativas definidas

---

#### Card O1 — Variantes activas sin imágenes

**Fuente de datos:** query del Bloque 3 de auditoría (variantes activas, producto activo, stock > 0, sin imágenes)

**Texto:**

> **N variantes con stock pero sin imágenes**
> Estas variantes tienen mercadería disponible pero no aparecen en el catálogo porque les faltan imágenes.

**Vista expandida (cards por variante):**

```
[ Producto: TOP ]  [ Color: NegNeg ]  [ SKU: RO-TOP-NN ]  [ Stock: 72 ]
```

**Acción:** "Ver producto" → link directo a `admin/products.html?id=<product_id>`

- No acción automática. Requiere cargar imágenes manualmente.
- Sin confirmación.

**Priorización interna:** ordenar por `stock_real_depositos DESC` para mostrar primero los de mayor impacto.

---

#### Card O2 — Productos con alta de stock pendiente

**Fuente de datos:** query de productos `draft` o `missing_tags` con `stock_real_depositos > 10`

**Texto:**

> **N productos con stock cargado pero alta incompleta**
> Estos productos tienen mercadería pero aún no están activos en el catálogo.

**Vista expandida:**

```
[ Producto: R2107 ]  [ Estado: draft ]  [ Stock aprox: 72 ]  [ Categoría: Ropa ]
```

**Acción:** "Completar alta" → link a `admin/incomplete-products.html` o `admin/complete-tags.html` según el estado.

---

#### Card O3 — Variantes inactivas con stock significativo

**Fuente de datos:** variantes con `active = false`, producto activo, `stock_real_depositos > 5`

**Texto:**

> **N variantes inactivas con stock**
> Estos colores/variantes están desactivados pero tienen unidades en depósito. Decidir si reactivar o aceptar como discontinuados.

**Vista expandida:**

```
[ Producto: ALP ]  [ Color: Rojo ]  [ SKU: FYL-ALP-RO ]  [ Stock: 28 ]
```

**Acción:** ninguna automática. Solo información para toma de decisión.

---

## Bloque 4 — Última revisión

Texto de pie de pantalla, sin panel ni bloque expandible. Muestra únicamente cuándo fue la última vez que se consultó el gate.

```
Última revisión: hoy 11:00  —  Estado: en orden
```

**Fuente de datos:** `vw_stock_audit_release_gate.measured_at` + `release_decision`

**Formato:** texto en gris claro, una sola línea, debajo del último bloque visible.

### v2 — Historial completo (fuera del alcance de v1)

Un historial real requiere una tabla `stock_audit_log` que registre cada corrección ejecutada (timestamp, acción, resultado, usuario). No existe actualmente. Queda documentado como deuda técnica para v2.

---

## Reglas de visualización

### Qué NO mostrar en vista principal

- UUIDs de ningún tipo (ni variant_id, ni product_id)
- Nombres de columnas de DB (`reserved_qty`, `variant_sizes_qty`)
- Mensajes técnicos de error de SQL
- Señales warning históricas (5884 detectadas) — no deben aparecer como errores activos

### Qué SÍ mostrar por variante

- Nombre del producto
- Color
- SKU
- Stock relevante (real, en carritos, diferencia)
- Problema en lenguaje operativo

### Jerarquía de severidad visual


| Nivel     | Color              | Uso                                                  |
| --------- | ------------------ | ---------------------------------------------------- |
| CRÍTICO   | Rojo `#DC2626`     | Riesgo de sobreventa, phantom stock, triggers caídos |
| ATENCIÓN  | Amarillo `#D97706` | Drift menor, inflated reserved_qty                   |
| OPERATIVO | Azul `#2563EB`     | Imágenes faltantes, altas pendientes                 |
| SALUDABLE | Verde `#16A34A`    | Gate en go                                           |


### Confirmaciones obligatorias

Toda acción que llame `rpc_reconcile_stock` requiere un modal de confirmación con:
- Descripción clara de qué va a cambiar
- Cantidad de registros afectados
- Botón "Cancelar" (default focus) y botón "Confirmar"

**Matriz de permisos y copies:**

| Acción | Texto del botón | Permiso requerido | Copy de confirmación |
|--------|----------------|-------------------|---------------------|
| `rpc_reconcile_stock(false)` | "Sincronizar stock visible" | super_admin o stock_manager | "Esto va a sincronizar el stock visible del catálogo con el stock real de depósitos. Los talles sin stock real dejarán de mostrarse." |
| `rpc_reconcile_stock(true)` | "Corregir reservas" | solo super_admin | "Esta acción corrige las reservas activas para X variantes. El stock disponible visible puede cambiar. No puede deshacerse automáticamente." |

Si el usuario no tiene el permiso requerido: botón deshabilitado con tooltip que indica el permiso necesario.

---

## Fuentes de datos por bloque


| Bloque                   | Query / Vista                                                                   |
| ------------------------ | ------------------------------------------------------------------------------- |
| Header                   | `vw_stock_audit_release_gate`                                                   |
| C1 — Phantom stock       | Query ad-hoc equivalente a Bloque 1 de auditoría                                |
| C2 — Deflated            | `vw_stock_audit_reserved_qty_diff WHERE anomaly_type = 'reserved_qty_deflated'` |
| C3 — Triggers            | `vw_stock_audit_release_gate.trigger_84_active / trigger_145_active`            |
| A1 — Inflated            | `vw_stock_audit_reserved_qty_diff WHERE anomaly_type = 'reserved_qty_inflated'` |
| A2 — Diffs talle         | `vw_stock_audit_variant_sizes_diff`                                             |
| A3 — Huérfanas           | `vw_stock_audit_orphan_size_rows`                                               |
| O1 — Sin imágenes        | Query ad-hoc Bloque 3 auditoría                                                 |
| O2 — Alta pendiente      | `products WHERE status IN ('draft', 'missing_tags')` + JOIN stock               |
| O3 — Variantes inactivas | `product_variants WHERE active = false` + JOIN stock                            |
| Última revisión (v1)     | `vw_stock_audit_release_gate.measured_at` + `release_decision`                  |


---

## Gaps técnicos a resolver en implementación

1. **No existe vista para "productos visibles sin stock real" (C1).** La query existe en la auditoría pero no está materializada como vista. Crear `vw_stock_catalog_phantom` o ejecutar la query inline.
2. **No existe vista para "variantes sin imágenes con stock" (O1).** Ídem — crear `vw_stock_catalog_no_images` o query inline.
3. **Historial completo es v2.** La v1 muestra solo `measured_at` del gate. Para historial real se necesita tabla `stock_audit_log` (deuda técnica documentada).
4. **La query de C1 puede ser costosa** si el catálogo es grande. Evaluar si conviene materialized view o query con LIMIT.
5. **Permisos para reconcile(false): super_admin o stock_manager.** Verificar con `isSuperAdmin() || hasPermission('stock', 'reconcile')` en JS. La RPC actualmente solo valida `exists in admins` — la validación granular en DB está pendiente (ver decisión D6 en [[11-DECISIONES-TECNICAS]]).
6. **Permisos para reconcile(true): solo super_admin.** Misma situación que punto 5 — la barrera definitiva es JS hasta que se implemente la validación DB.

---

## Comportamiento en carga

1. Al abrir la pantalla: mostrar skeleton loader mientras carga el gate.
2. Una vez cargado el gate: renderizar header inmediatamente.
3. Cargar los bloques en paralelo (un request por fuente de datos).
4. Si un bloque falla: mostrar mensaje de error inline sin bloquear los demás.
5. Botón "Actualizar": recarga todos los bloques sin recargar la página.

---

## Relación con código existente


| Archivo                       | Relación                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `admin/stock-audit.html`      | Reemplaza estructura actual con los 4 bloques                                  |
| `admin/stock-audit.js`        | Evoluciona: añade funciones de render por bloque, mantiene lógica de reconcile |
| `admin/permissions-helper.js` | Usa `isSuperAdmin()` para controlar reconcile(true)                            |
| `styles.css`                  | Reutiliza clases existentes de cards y badges                                  |


---

## Referencias

- [[11-DECISIONES-TECNICAS]] §D6 (permisos reconcile)
- [[06-RESERVED-QTY-Y-RECONCILE]] (comportamiento del reconcile)
- [[24-AUDITORIA-STOCK-2026-05-04]] (datos reales de la auditoría)
- [[25-AUDITORIA-CATALOGO-2026-05-04]] (datos de catálogo)
- [[16-AUDITORIA-MODULO-STOCK]] (arquitectura del módulo actual)

