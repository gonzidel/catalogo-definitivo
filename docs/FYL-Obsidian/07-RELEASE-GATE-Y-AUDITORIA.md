# 07 — Release gate y auditoría de stock

> Definición `vw_stock_audit_release_gate`: `supabase/canonical/146_rpc_reconcile_stock.sql` (bloque CTE) + ajustes `175_*` (KPI `reserved_qty_diffs`, etc.). **Confirmar** en el archivo activo de mayor número si el entorno tuvo parches adicionales.

## `vw_stock_audit_release_gate`

- Basada en `vw_stock_audit_health_score` (146; extendida 175+).
- **`go_live_ready`:** `true` solo si, en conjunto (versión 146):
  - `variant_sizes_diffs = 0`
  - `variant_warehouse_diffs = 0`
  - `orphan_rows = 0`
  - `critical_signals = 0`
  - Triggers 84 y 145 **activos**

Tras `175`, **`go_live_ready`** exige también `hs.reserved_qty_diffs = 0` (además de diffs 0, sin críticos, oráfanos 0, triggers 84/145 activos). Ver `175_stock_audit_bloque2_gate_reserved_qty.sql` líneas ~221–228.

- **`release_decision`:** `go` | `no-go` (sincronizado con `go_live_ready`).
- **`blocking_reasons`:** array de códigos (`variant_sizes_diffs`, `orphan_rows`, `trigger_84_inactive`, …).

## `go_live_ready` y `blocking_reasons` (chequeo rápido)

```sql
SELECT
  go_live_ready,
  release_decision,
  blocking_reasons,
  health_score
FROM public.vw_stock_audit_release_gate;
```

## Alertas: `vw_stock_audit_alerts_current`

- Unión de alertas **critical** (gate bloqueado), **warning** (señales warning), **review** (revisión manual) — 146/146+.

```sql
SELECT * FROM public.vw_stock_audit_alerts_current
ORDER BY severity, measured_at;
```

## Uso en deploy (antes / después)

1. **Antes:** exigir `go_live_ready` y criterio de `health_score` (RUNBOOK: típicamente ≥ 95 — ver `docs/RUNBOOK.md` §5).
2. **Después:** reconsultar `release_gate` y `alerts` tras migración SQL o carga masiva.
3. Si `no-go`: [[06-RESERVED-QTY-Y-RECONCILE]] + inspección de orígenes (órphan variants, señales `vw_stock_audit_reference_signals`).

**UI:** `admin/stock-audit.html` (mencionado en `STOCK_GOVERNANCE`).

## Enlaces

- [[06-RESERVED-QTY-Y-RECONCILE]] · [[09-RUNBOOK-OPERATIVO]] · `docs/RUNBOOK.md` §1–3
