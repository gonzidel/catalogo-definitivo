# Venta pública FYL: trazabilidad por depósito y talle (migración 141)

Documento de registro: qué había **antes**, qué hay **después**, y cómo encajan `rpc_create_public_sale`, `rpc_void_public_sale`, `rpc_release_public_sale_draft_line` y el admin.

**Migración canónica:** [`supabase/canonical/141_public_sale_stock_trace_and_void.sql`](../supabase/canonical/141_public_sale_stock_trace_and_void.sql)

**Código admin relacionado:** [`admin/public-sales.js`](../admin/public-sales.js) (`removeSaleItem`)

**Trigger de sincronización:** [`supabase/canonical/84_sync_variant_sizes_on_warehouse_stock.sql`](../supabase/canonical/84_sync_variant_sizes_on_warehouse_stock.sql) — función `sync_variant_sizes_stock_from_warehouse` sobre `variant_size_warehouse_stock`.

---

## Los tres archivos SQL creados (`138`, `139`, `140`)

Migraciones en [`supabase/canonical/`](../supabase/canonical/) **distintas** de la **141**. La **141** es el tema central de las secciones siguientes (venta pública, void y borrador); estos tres cubren **notificaciones al cliente**, **stock inicial por talle en admin** y **quitar línea de pedido con devolución de stock**.

### 1. [`138_customer_notifications.sql`](../supabase/canonical/138_customer_notifications.sql)

| | |
|--|--|
| **Qué hace** | Notificaciones in-app para clientes (p. ej. campana en el catálogo). |
| **Tabla** | `public.customer_notifications`: `customer_id`, `order_id` (nullable), `type`, `message`, `payload` (jsonb, default `{}`), `read`, `created_at`, `read_at`. |
| **Índices** | Por `(customer_id, created_at desc)` y parcial de no leídas (`read = false`). |
| **RLS** | Cliente `authenticated`: solo `SELECT` / `UPDATE` de sus filas (`customer_id = auth.uid()`). Admin: política `FOR ALL` si existe en `public.admins`. |
| **Realtime** | Añade la tabla a la publicación `supabase_realtime` si aún no está (bloque `DO` idempotente). |
| **Idempotencia** | `CREATE TABLE IF NOT EXISTS`, políticas creadas solo si no existen. |

### 2. [`139_rpc_save_product_variant_initial_stock.sql`](../supabase/canonical/139_rpc_save_product_variant_initial_stock.sql)

| | |
|--|--|
| **RPC** | `public.rpc_save_product_variant_initial_stock(p_variant_id uuid, p_items jsonb) → json` |
| **Uso** | Admin / productos: guardar stock **por talle** en depósito **general** de forma **atómica**. |
| **Semántica de `p_items`** | Array no vacío (máx. 200 elementos), sin talles duplicados. Cada elemento: `size`, `stock_qty` (obligatorios), `sku` opcional. Equivale a **reemplazo** del stock en **general** para esa variante: se **borran** filas de `variant_size_warehouse_stock` (variante + almacén general) cuyo talle **no** esté en el array; luego cada talle queda con la cantidad **exacta** indicada. |
| **Otras escrituras** | Elimina `variant_sizes` para talles que ya no están en `p_items`; actualiza `sku` en `variant_sizes` por talle; recalcula el total en `variant_warehouse_stock` (variante + general) según la suma en general por talle. |
| **Auditoría** | `log_stock_change` si cambió el total agregado en general o hubo cambio en algún talle. |
| **Trigger 84** | Los cambios en `variant_size_warehouse_stock` mantienen `variant_sizes.stock_qty` como **suma** por talle entre depósitos. |
| **Seguridad** | `SECURITY DEFINER`, `auth.uid()` obligatorio, solo filas en `public.admins`. `GRANT EXECUTE` a `authenticated`. |
| **Respuesta** | JSON con `ok`, `warehouse_id`, `total_qty`, `variant_sizes` (listado ordenado por talle). |

### 3. [`140_rpc_remove_order_item_restore_stock.sql`](../supabase/canonical/140_rpc_remove_order_item_restore_stock.sql)

| | |
|--|--|
| **RPC** | `public.rpc_remove_order_item_restore_stock(p_order_item_id uuid) → json` |
| **Uso** | Admin (p. ej. flujo **orders2**): eliminar una línea de `order_items` en una sola transacción con **devolución de stock**, totales y limpieza del pedido. |
| **Stock con trazas** | Si hay filas en `order_item_stock_sources`, devuelve cantidades a `variant_size_warehouse_stock` por `warehouse_id` y talle (normalizado como en el resto del sistema), con `log_stock_change`. |
| **Fallback sin fuentes** | Para `variant_id` + talle y estados `picked`, `reserved` o `waiting` (y no `missing`), devolución al depósito **general** por talle; si no hay fila en depósito, puede apoyarse en `variant_sizes` para fijar cantidad al insertar/actualizar en general. **No** duplica devolución general + venta-público en el mismo flujo. |
| **Reservas** | Si el ítem está `reserved` o `waiting`, reduce `product_variants.reserved_qty`. |
| **Pedido** | `DELETE` del `order_item`; resta `line_total` de `orders.total_amount`; si no quedan ítems no cancelados, ejecuta `rpc_delete_empty_order`. |
| **variant_sizes** | Coherencia vía trigger sobre `variant_size_warehouse_stock` (migración **84**), sin doble escritura manual en ese camino. |
| **Seguridad** | `SECURITY DEFINER`, solo admins. `GRANT EXECUTE` a `authenticated`. |
| **Respuesta** | JSON con `ok`, `order_id`, `order_deleted`. |

### Relación con la migración **141**

[`141_public_sale_stock_trace_and_void.sql`](../supabase/canonical/141_public_sale_stock_trace_and_void.sql) **no** está incluida en el bloque de tres anteriores: documenta **venta pública** (`public_sale_items`, `rpc_create_public_sale`, `rpc_void_public_sale`, `rpc_release_public_sale_draft_line`). Para desplegar todo el paquete reciente, ejecutá en orden **138 → 139 → 140 → 141** (o el orden que imponga tu pipeline), siempre **solo SQL puro** en el editor de Supabase (sin pegar scripts bash u otros lenguajes).

---

## Objetivo

1. **Registrar en cada línea de venta** cuánto se descontó de **venta-publico** y de **general** cuando el movimiento es por **talle** (`variant_size_warehouse_stock`), para poder **anular** devolviendo stock al mismo desglose y talle.
2. **Guardar el talle normalizado** usado al vender, para que la anulación no dependa solo de `product_variants.size` (que puede no coincidir con la clave usada en depósitos).
3. **Liberar stock por talle** al quitar del borrador una línea que viene de **pedido local** (`fromLocalOrder`), vía RPC en servidor (no upsert directo a `variant_warehouse_stock`).
4. Mantener **compatibilidad** con ventas **antiguas** sin columnas de desglose (comportamiento tipo migración [`79_void_public_sale.sql`](../supabase/canonical/79_void_public_sale.sql)).

---

## Cómo era antes (registro histórico)

### Tabla `public_sale_items`

- Solo había lo esencial: `sale_id`, `variant_id`, `qty`, `price_snapshot`, `is_return`, extras con `product_name` / sin `variant_id`, etc.
- **No** se guardaba cuánto salió de **venta-publico** vs **general**.
- **No** se guardaba el **talle** usado en la línea.

### `rpc_create_public_sale` (evolución previa, p. ej. [`14_public_sales_fix_complete.sql`](../supabase/canonical/14_public_sales_fix_complete.sql))

- Con ítem con **`size`** en `p_items`, el descuento iba a **`variant_size_warehouse_stock`** (general / venta-publico según lógica y `source` opcional).
- En la **rama fallback** (sin filas en depósitos pero sí stock en **`variant_sizes`**): se creaba/actualizaba **`variant_size_warehouse_stock`** para **general** y además se hacía un **`UPDATE` manual a `variant_sizes`**. Eso convivía mal con el trigger **`sync_variant_sizes_stock_from_warehouse`**, que ya recalcula `variant_sizes.stock_qty` como **suma** de `variant_size_warehouse_stock` por `(variant_id, size)`: riesgo de **doble efecto** o totales incoherentes.

### `rpc_void_public_sale` (p. ej. [`79_void_public_sale.sql`](../supabase/canonical/79_void_public_sale.sql))

- Solo restauraba stock en **`variant_warehouse_stock`** del almacén **venta-publico**, sumando o restando según `is_return`, **sin** mirar desglose por **general** ni por **talle**.
- Correcto para el modelo **solo agregado por variante en venta-publico**, pero **incorrecto** si la venta real había descontado **`variant_size_warehouse_stock`** en **general** y/o **venta-publico**: al anular no se devolvía al lugar correcto.

### Admin: quitar ítem de pedido local en borrador (`removeSaleItem`)

- Si el ítem tenía `fromLocalOrder` y tallas, el front hacía **`upsert`** en **`variant_warehouse_stock`** (venta-publico a nivel **variante**, sin talle).
- El stock “real” del mostrador suele estar en **`variant_size_warehouse_stock`** por talle: esa liberación podía **no** coincidir con dónde se había descontado el pedido.

---

## Cómo es después (nuevo funcionamiento)

### Columnas nuevas en `public_sale_items`

| Columna | Tipo | Significado |
|--------|------|-------------|
| `qty_venta_publico` | `integer NULL` | Unidades descontadas de depósito **venta-publico** en esa línea. `NULL` = línea **legacy** o extra sin trazado por depósito. |
| `qty_general` | `integer NULL` | Unidades descontadas de depósito **general**. Misma regla de `NULL`. |
| `sold_size_normalized` | `text NULL` | Talle **normalizado** (misma lógica que en create: trim, enteros sin parte decimal) usado como clave en `variant_size_warehouse_stock`. `NULL` = sin rama por talle / legacy / extra. |

**Invariante:** `qty_venta_publico` y `qty_general` deben ser **las dos NULL** o **las dos NOT NULL**. Si una es NULL y la otra no, `rpc_void_public_sale` lanza excepción.

### `rpc_create_public_sale`

1. **Tabla temporal `tmp_psi_deduction`** (misma sesión), alineada al **orden** de `p_items` (`idx` 1..n):
   - `qty_venta_publico`, `qty_general`, `sold_size_normalized`.
2. Por cada elemento del array:
   - **Extras** (sin `variant_id` válido): fila en temp con `(NULL, NULL, NULL)`; no toca stock por variante/talle.
   - **Venta normal con talle** (`size` en JSON, depósitos resueltos): descuenta en `variant_size_warehouse_stock`; persiste en temp los importes VP/general y el talle normalizado.
   - **`from_local_order`**: no vuelve a descontar stock; persiste `(0, 0)` y, si hay `size` en el ítem, **`sold_size_normalized`** para trazabilidad/anulación coherente.
   - **Devolución con talle**: suma en VP por talle; persiste trazas acordes (p. ej. VP = cantidad devuelta).
   - **Rama legacy sin talle**: `variant_warehouse_stock`; en temp el desglose puede ser numérico según lógica previa y **`sold_size_normalized` NULL**.
3. **Inserción final de líneas** con `WITH ORDINALITY` sobre `p_items`: cada `INSERT` en `public_sale_items` toma de `tmp_psi_deduction` la fila con `idx = ord`, de modo que **no se desalineen** extras e ítems normales.
4. **Fallback desde `variant_sizes`:** si no hay filas en depósitos pero sí stock en `variant_sizes`, solo se escribe **`variant_size_warehouse_stock` (general)** con el saldo tras el descuento. **Ya no** se hace `UPDATE` manual a `variant_sizes`: el trigger **`sync_variant_sizes_stock_from_warehouse`** deja `variant_sizes.stock_qty` = **SUM** por talle sobre todos los almacenes.

La función sigue siendo **`SECURITY DEFINER`**; valida admin vía `auth.uid()` y tabla `admins` (como antes).

### `rpc_void_public_sale`

1. Carga depósitos **venta-publico** y **general**.
2. Por cada `public_sale_items` con `variant_id`:

   - **Ambas columnas de desglose NULL** → mismo criterio que **antes** (79): solo **`variant_warehouse_stock`** en **venta-publico** (venta suma, devolución resta en VP).

   - **Desglose presente** (ambas NOT NULL):
     - Resuelve talle: **primero** `sold_size_normalized` de la línea; si falta, **respaldo** con `product_variants.size` (misma normalización numérica).
     - Si **aún** no hay talle → fallback **legacy** otra vez por **`variant_warehouse_stock`** en VP (equivalente a no poder ubicar filas por talle).
     - **No devolución:** suma `qty_venta_publico` en VP por talle y `qty_general` en general por talle.
     - **Devolución:** resta en VP por talle según `qty_venta_publico` (modelo de devolución que incrementó VP al crear).

3. Crédito: si había `credit_used`, se llama a `rpc_add_customer_credit` como antes.
4. Marca `public_sales.voided_at`.

### `rpc_release_public_sale_draft_line`

- **Parámetros:** `p_variant_id`, `p_size`, `p_qty`.
- **Quién:** usuario autenticado y fila en **`admins`**.
- **Qué hace:** normaliza `p_size` como en el resto del flujo e incrementa **`variant_size_warehouse_stock`** en **venta-publico** (`ON CONFLICT DO UPDATE`).
- **Permisos:** `GRANT EXECUTE ... TO authenticated` (el cliente admin usa sesión autenticada).

Sirve para reemplazar la lógica del front que tocaba **`variant_warehouse_stock`** al sacar una línea **fromLocalOrder** del borrador.

### Admin (`removeSaleItem`)

- Antes: consulta `warehouses` + lectura/escritura **`variant_warehouse_stock`** (upsert).
- Ahora: por cada talle con `variantId` y cantidad &gt; 0, **`supabase.rpc('rpc_release_public_sale_draft_line', { p_variant_id, p_size, p_qty })`**.

---

## Compatibilidad con datos antiguos

- Líneas **previas** a la migración: `qty_venta_publico`, `qty_general` y `sold_size_normalized` en **NULL** → el void sigue el camino **legacy** solo VP / `variant_warehouse_stock`, alineado con cómo se registraban esas ventas.
- Líneas **nuevas** con desglose: void usa **`variant_size_warehouse_stock`** y el talle **persistido** en la línea cuando existe.

---

## Referencias rápidas en el repo

| Tema | Archivo |
|------|---------|
| Migración única 141 | `supabase/canonical/141_public_sale_stock_trace_and_void.sql` |
| Void histórico solo VP | `supabase/canonical/79_void_public_sale.sql` |
| Create público extendido (base evolutiva) | `supabase/canonical/14_public_sales_fix_complete.sql` |
| Trigger suma → `variant_sizes` | `supabase/canonical/84_sync_variant_sizes_on_warehouse_stock.sql` |

---

## Despliegue

1. Ejecutar en Supabase, en orden sugerido: **`138_customer_notifications.sql`**, **`139_rpc_save_product_variant_initial_stock.sql`**, **`140_rpc_remove_order_item_restore_stock.sql`**, **`141_public_sale_stock_trace_and_void.sql`** (o el pipeline de migraciones del proyecto).
2. Desplegar el **`admin/public-sales.js`** que llama a `rpc_release_public_sale_draft_line` (y el front que consuma notificaciones / RPC de 139–140 si aplica).
3. Probar: notificaciones y RLS (138); guardado de stock por talle en productos (139); quitar ítem de pedido con stock (140); venta mixta VP/general por talle → anular; quitar línea **fromLocalOrder** en borrador; anular venta **antigua** sin columnas de desglose (141).

---

*Última actualización: incluye los tres SQL 138–140 y la migración 141; admin `removeSaleItem` para release de borrador.*
