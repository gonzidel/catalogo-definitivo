# COD — Auditoría pago complementario (2026-08-22)

**Estado:** SOLO AUDITORÍA. Sin SQL aplicado. Sin mutación de A54946. Sin implementación UI/RPC.

## Caso fixture (lectura)

| Campo | Valor |
|---|---|
| Pedido | A54946 · BENTANCURT MARIELA |
| expected | $160.700 (`orders.total_amount`) |
| Primera fila | $144.000 · `confirmed_with_irregularity` |
| Irreg | `open` · expected 160700 · reported 144000 · amount_diff **-16700** |
| Segunda fila (otra planilla) | $16.700 · hoy unassigned / “ya vinculado” informativo |

Hoy **imposible** confirmar la 2ª fila al mismo `matched_order_id` por `uq_cod_rows_matched_order_active`.

## Bloqueo actual

```sql
UNIQUE (matched_order_id)
WHERE row_status IN ('confirmed_matched','confirmed_with_irregularity')
```

`approved_pending_confirmation` y `void` quedan fuera.

## Semántica actual de irregularidad

En confirmación (280/291):

- `expected_amount` = total del pedido (snapshot)
- `reported_amount` = `parsed_amount` de **esa** fila
- `amount_diff` = reported − expected

Una irregularidad = diferencia de **una** conciliación primaria, no saldo acumulado multi-pago.

Patrón 287: `open`/`in_review` → `superseded` + posible nueva `open`.  
285: resolve manual **sin** tocar filas/montos.

## Arquitectura recomendada (no aplicada)

Ver detalle en el informe de chat: rol `primary`/`supplementary` + índice único solo primary + RPC `rpc_cod_apply_complementary_payment` + supersede/resolve irreg + eventos nuevos.

**No** eliminar el unique. **No** pagos parciales en matching normal.
