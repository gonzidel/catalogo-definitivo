# Plan de prueba — 188 `order_reserved_qty_release_on_final_status`

**Alcance:** staging o base local **solo después** de aplicar el SQL `188_order_reserved_qty_release_on_final_status.sql` en ese entorno.  
**No ejecutar en producción** hasta cerrar este checklist.

**Prerrequisitos**

- Migración `188` aplicada en el entorno de prueba.
- Usuario con permisos de admin (para `rpc_mark_order_as_sent` / `rpc_mark_order_as_devolucion` según flujo).
- Anotar `order_id` de prueba y no usar pedidos reales críticos si podés usar datos de staging.

---

## 0) Snapshot global de auditoría (opcional pero útil)

```sql
SELECT count(*) AS inflated_rows
FROM public.vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_inflated';

SELECT coalesce(sum(delta), 0) AS total_delta_units
FROM public.vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_inflated';
```

Guardá los dos números como **baseline_inflated** para el paso 8.

---

## 1) Elegir un pedido `closed` con fuentes positivas

```sql
SELECT o.id AS order_id,
       o.order_number,
       o.status,
       o.updated_at
FROM public.orders o
WHERE o.status = 'closed'
  AND EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
    WHERE oi.order_id = o.id
      AND COALESCE(s.qty, 0) > 0
  )
ORDER BY o.updated_at DESC
LIMIT 10;
```

Elegí una fila y reemplazá en todas las queries el marcador `'<UUID_DEL_PEDIDO>'::uuid` por el id real (SQL Editor de Supabase no usa variables `:order_id` de psql).

**Validación rápida de fuentes por variante del pedido:**

```sql
SELECT oi.variant_id,
       oi.id AS order_item_id,
       SUM(COALESCE(s.qty, 0))::int AS oiss_units
FROM public.order_items oi
JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
WHERE oi.order_id = '<UUID_DEL_PEDIDO>'::uuid
  AND COALESCE(oi.status, '') <> 'cancelled'
GROUP BY oi.variant_id, oi.id
HAVING SUM(COALESCE(s.qty, 0)) > 0
ORDER BY oi.variant_id;
```

---

## 2) Medir `reserved_qty` por variante **antes** de marcar enviado

```sql
SELECT pv.id AS variant_id,
       pv.sku,
       pv.color,
       pv.reserved_qty AS reserved_qty_before
FROM public.product_variants pv
WHERE pv.id IN (
  SELECT DISTINCT oi.variant_id
  FROM public.order_items oi
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id
  WHERE oi.order_id = '<UUID_DEL_PEDIDO>'::uuid
    AND oi.variant_id IS NOT NULL
    AND COALESCE(s.qty, 0) > 0
)
ORDER BY pv.id;
```

Exportá el resultado (CSV o captura) como **antes_sent**.

---

## 3) Pasar el pedido a `sent`

Desde la UI admin (pedidos cerrados / envío) o SQL si en staging tenés la misma RPC:

```sql
SELECT public.rpc_mark_order_as_sent('<UUID_DEL_PEDIDO>'::uuid);
```

**Nota:** la RPC canónica exige `status = 'closed'`. Si falla, confirmá el estado con:

```sql
SELECT id, order_number, status FROM public.orders WHERE id = '<UUID_DEL_PEDIDO>'::uuid;
```

---

## 4) Medir `reserved_qty` por variante **después**

Repetí la misma query del paso 2 y guardala como **después_sent**.

**Esperado:** para cada variante afectada por el pedido,  
`reserved_qty_after <= reserved_qty_before` y en lo posible  
`reserved_qty_before - reserved_qty_after = sum(oiss)` agregada por esa variante en el pedido (salvo otros pedidos/carritos afectando la misma variante en paralelo).

---

## 5) Verificar fila en `order_reserved_qty_released`

```sql
SELECT *
FROM public.order_reserved_qty_released
WHERE order_id = '<UUID_DEL_PEDIDO>'::uuid;
```

**Esperado:** una fila con `old_status` coherente (p. ej. `closed`) y `new_status = 'sent'`.

---

## 6) Idempotencia — “repetir” transición a `sent`

Ejecutá un `UPDATE` que intente mantener o reafirmar `sent` (no debe volver a restar):

```sql
UPDATE public.orders
SET status = 'sent',
    updated_at = now()
WHERE id = '<UUID_DEL_PEDIDO>'::uuid;
```

**Verificaciones:**

```sql
-- Sigue habiendo una sola fila (PK order_id)
SELECT count(*) FROM public.order_reserved_qty_released WHERE order_id = '<UUID_DEL_PEDIDO>'::uuid;

-- reserved_qty igual que al final del paso 4 (comparar manualmente con después_sent)
SELECT pv.id, pv.reserved_qty
FROM public.product_variants pv
WHERE pv.id IN (
  SELECT DISTINCT oi.variant_id FROM public.order_items oi
  WHERE oi.order_id = '<UUID_DEL_PEDIDO>'::uuid AND oi.variant_id IS NOT NULL
);
```

**Esperado:** el trigger `WHEN` no aplica segunda liberación (OLD ya es `sent`); **no** segunda resta de `reserved_qty`.

---

## 7) `sent` → `devolución` — no debe restar otra vez

**Solo si** el entorno permite marcar devolución sobre este pedido (RPC admin).

Desde UI `sent-orders` o la RPC que tenga staging activa. La firma legacy es `rpc_mark_order_as_devolucion(uuid)`; si solo está desplegada la de idempotencia, usá  
`rpc_mark_order_as_devolucion(p_order_id, p_operation_id, p_request)` con un `p_operation_id` único (p. ej. `gen_random_uuid()`).

```sql
-- Si existe solo la firma de un argumento:
SELECT public.rpc_mark_order_as_devolucion('<UUID_DEL_PEDIDO>'::uuid);
```

**Verificaciones después:**

```sql
SELECT id, order_number, status FROM public.orders WHERE id = '<UUID_DEL_PEDIDO>'::uuid;

-- Sigue siendo una sola fila en ledger (no se duplica por devolución)
SELECT * FROM public.order_reserved_qty_released WHERE order_id = '<UUID_DEL_PEDIDO>'::uuid;

-- reserved_qty no debe haber bajado de nuevo por el mismo mecanismo 188
-- (161 restaura stock físico; 188 no debe haber disparado de sent→devolución)
SELECT pv.id, pv.reserved_qty
FROM public.product_variants pv
WHERE pv.id IN (
  SELECT DISTINCT oi.variant_id FROM public.order_items oi
  WHERE oi.order_id = '<UUID_DEL_PEDIDO>'::uuid AND oi.variant_id IS NOT NULL
);
```

**Esperado:** `status = 'devolución'`; ledger **sin** segunda entrada (misma PK); `reserved_qty` respecto al paso 4 solo cambia si **otra** lógica (no 188) lo tocó — para 188, **sin segunda resta**.

---

## 8) `vw_stock_audit_reserved_qty_diff` — infladas antes / después

Repetí el query del paso 0:

```sql
SELECT count(*) AS inflated_rows
FROM public.vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_inflated';

SELECT coalesce(sum(delta), 0) AS total_delta_units
FROM public.vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_inflated';
```

**Interpretación**

- En un solo pedido de prueba, el **total global** puede casi no moverse (227 pedidos históricos siguen con drift).
- Lo importante: las variantes del **pedido de prueba** deberían acercarse a alineación respecto a `real_reserved_qty`, o al menos mostrar **menor delta** que antes en esas filas:

```sql
SELECT *
FROM public.vw_stock_audit_reserved_qty_diff
WHERE variant_id IN (
  SELECT DISTINCT oi.variant_id FROM public.order_items oi
  WHERE oi.order_id = '<UUID_DEL_PEDIDO>'::uuid AND oi.variant_id IS NOT NULL
);
```

---

## Criterios de aceptación del plan


| #   | Criterio                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pedido elegido `closed` con `oiss.qty > 0`.                                                                                 |
| 2–4 | `reserved_qty` baja (por variante) de forma coherente con sumas de fuentes del pedido, salvo interferencia de otros flujos. |
| 5   | Existe fila en `order_reserved_qty_released` para ese `order_id`.                                                           |
| 6   | Segundo `UPDATE` a `sent` no duplica descuento; una sola fila ledger.                                                       |
| 7   | `sent` → `devolución` no dispara segunda liberación 188 (ledger intacto en conteo).                                         |
| 8   | Variantes del pedido en la vista muestran mejor alineación o desaparecen de infladas si era el único origen del drift.      |


---

## Notas

- **Expiración (`expired`):** no cubierta en este script de prueba manual; el caso 147 queda documentado en `188_*.sql`. Si probás expiración, hacelo en staging con un pedido de prueba y revisá si las fuentes ya están en 0 antes del cambio de estado.
- **Producción:** no aplicar `188` ni este plan hasta validar staging y definir backfill (`188` comentarios finales del SQL).

