# Lista de envíos — deploy `227_shipping_list_sent_at_only`

## Estado deploy

**Aplicado en prod** (`dtfznewwvsadkorxwzft`) — migración `227_shipping_list_sent_at_only` — **2026-05-26**, sin backfill histórico.

---

## Informe de auditoría (prod `fyl-core` / `dtfznewwvsadkorxwzft`)

**Fecha informe:** 2026-05-26

### Hallazgos

| Verificación | Resultado |
|--------------|-----------|
| `rpc_mark_order_as_sent` escribe `sent_at` | **NO** — solo `status = 'sent'` y `updated_at` |
| `rpc_get_shipping_orders` usa fallback `closed_at` | **SÍ** |
| Pedidos `sent` sin `sent_at` | **1.409** |
| Pedidos `sent` con `sent_at` | **1.695** |
| Cierre y finalización en días distintos (`closed_at` BA ≠ `updated_at` BA, `sent_at` null) | **20** |
| Patrón sábado cierre → lun/mar finalización (aprox.) | **20** |
| Ejemplo sáb 23/05 → lun 26/05 | **8** pedidos (ej. A53263, A53265) |

### Causa

Al finalizar, prod no guarda `sent_at`. La lista usa `closed_at` cuando `sent_at` es null → pedidos finalizados el lunes aparecen en la lista del **sábado** (día de cierre), no del lunes.

### Cambio propuesto

Archivo: `supabase/canonical/227_shipping_list_sent_at_only.sql`

1. `rpc_mark_order_as_sent`: agregar `sent_at = now()`.
2. `rpc_get_shipping_orders` / `_range`: filtrar **solo** por `sent_at` (Argentina).
3. **Sin backfill** — pedidos históricos sin `sent_at` no se corrigen; solo aplica a finalizaciones desde el deploy.

**No** se reemplaza la RPC por la versión `67` (evita tocar trigger `register_envio_to_daily_sales`).

### Riesgo

| Nivel | Detalle |
|-------|---------|
| Bajo | Solo cambia comportamiento de nuevas finalizaciones y filtro de listas. |
| Info | ~1.409 pedidos `sent` viejos sin `sent_at` no aparecerán en listas por fecha hasta reprogramar manualmente si hiciera falta. |

### Rollback

Restaurar las 3 funciones desde backup de `pg_get_functiondef` previo al deploy. El backfill de `sent_at` es reversible solo si se exportó backup de filas afectadas antes del `UPDATE`.

### Verificación post-deploy

```sql
SELECT COUNT(*) FROM orders WHERE status = 'sent' AND sent_at IS NULL;
-- esperado: 0

SELECT order_number,
  (sent_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS dia_lista
FROM orders
WHERE order_number IN ('A53263', 'A53265');
-- esperado: 2026-05-26
```

UI: `admin/closed-orders.html` → Imprimir lista → SEDE → 2026-05-26 → deben aparecer pedidos finalizados ese día aunque se hayan cerrado el sábado.

---

## Documentación relacionada

| Ubicación | Contenido |
|-----------|-----------|
| `docs/FYL-Obsidian/39-LISTA-ENVIOS-SENT-AT-2026-05-26.md` | Nota Obsidian (regla de negocio, flujo, verificación) |
| `docs/FYL-Obsidian/05-FLUJO-PEDIDOS.md` | Sección «Pedidos cerrados y lista de envíos» |
| `docs/FYL-Obsidian/00-INICIO.md` | Índice entrada #39 |
| `TROUBLESHOOTING_LISTA_ENVIOS.md` | Troubleshooting lista de envíos |
