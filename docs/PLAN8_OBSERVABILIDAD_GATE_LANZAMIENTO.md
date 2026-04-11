# Plan 8 - Observabilidad final y gate de lanzamiento

Este runbook define la salida a produccion para stock con criterios verificables, reconcile controlado y alertas por severidad.

## 1) KPIs y thresholds concretos de salida

Fuente de consulta principal: `public.vw_stock_audit_release_gate`.

KPIs bloqueantes (Go/No-Go):

- `variant_sizes_diffs = 0`
- `variant_warehouse_diffs = 0`
- `orphan_rows = 0`
- `critical_signals = 0`
- `trigger_84_active = true`
- `trigger_145_active = true`

Threshold de salida:

- `go_live_ready = true` y `release_decision = 'go'`
- `blocking_reasons` debe estar vacio

KPIs de seguimiento (no bloqueantes, requieren revision):

- `warning_signals > 0` => warning operativo
- `review_signals > 0` => review funcional/auditoria
- `affected_variants` para dimensionar impacto en soporte

Query de gate:

```sql
select
  measured_at,
  release_decision,
  go_live_ready,
  blocking_reasons,
  variant_sizes_diffs,
  variant_warehouse_diffs,
  orphan_rows,
  critical_signals,
  warning_signals,
  review_signals,
  trigger_84_active,
  trigger_145_active
from public.vw_stock_audit_release_gate;
```

## 2) Runbook operativo paso a paso (deploy + reconcile + validacion)

### Fase A - Pre-deploy

1. Confirmar migraciones aplicadas:
   - `144_stock_audit_readonly_views.sql`
   - `146_rpc_reconcile_stock.sql`
   - `148_guard_derived_stock_writes.sql`
2. Confirmar permisos:
   - usuarios admin en `public.admins`
   - ejecucion de `rpc_reconcile_stock()` habilitada para `authenticated` y `service_role`
3. Snapshot inicial de salud:

```sql
select * from public.vw_stock_audit_release_gate;
select severity, count(*) from public.vw_stock_audit_alerts_current group by 1;
```

### Fase B - Reconcile controlado

4. Ejecutar reconcile una sola vez en ventana controlada:

```sql
select public.rpc_reconcile_stock();
```

5. Verificar respuesta JSON:
   - `ok = true`
   - `after.variant_sizes_diffs = 0`
   - `after.variant_warehouse_diffs = 0`
   - `after.orphan_rows = 0`
6. Si quedan inconsistencias, repetir una segunda corrida solo si hubo cambios de datos entre corridas. Si persiste, activar rollback operativo (no lanzar).

### Fase C - Validacion de salida

7. Validar gate final:

```sql
select release_decision, go_live_ready, blocking_reasons
from public.vw_stock_audit_release_gate;
```

8. Validar alertas activas:

```sql
select severity, alert_key, status, message, measured_at
from public.vw_stock_audit_alerts_current
order by
  case severity when 'critical' then 1 when 'warning' then 2 else 3 end,
  measured_at desc;
```

9. Validar UI admin (`admin/stock-audit.js`):
   - banner en estado `Gate GO`
   - boton reconcile oculto cuando no hay inconsistencias estructurales
   - KPIs en cero para bloqueantes

### Fase D - Post-deploy (24h)

10. Monitoreo cada 15 min primera hora, luego cada 60 min:
    - `vw_stock_audit_release_gate`
    - `vw_stock_audit_alerts_current`
11. Si aparece `critical`, detener nuevas operaciones de alto riesgo de stock y ejecutar protocolo de incidente.

## 3) Plan de alertas automaticas

Fuente: `public.vw_stock_audit_alerts_current`.

Criticas (accion inmediata):

- `release_gate_blocked` (severidad `critical`): bloquea salida

Warning (revisar antes de siguiente ventana):

- `warning_signals_detected`

Review (backlog operativo):

- `review_signals_detected`

Reglas recomendadas de notificacion:

- `critical`: pagina inmediata (on-call) + canal incidente
- `warning`: notificacion a canal ops con SLA < 4h
- `review`: reporte diario consolidado

Integracion minima:

- Job programado (cron / edge function) que consulte `vw_stock_audit_alerts_current`.
- Si no hay filas, estado verde.
- Si hay filas, enrutar segun severidad.

## 4) Riesgos operativos y mitigaciones

- Riesgo: reconcile masivo en horario de alta carga.
  - Mitigacion: ventana de baja actividad y una sola corrida controlada.
- Riesgo: datos base inconsistentes en `variant_size_warehouse_stock`.
  - Mitigacion: no lanzar si `blocking_reasons` no vacio; investigar variante afectada.
- Riesgo: escrituras directas indebidas a tablas derivadas.
  - Mitigacion: triggers guard + monitoreo de excepciones de guard (detalle/hint en error).
- Riesgo: falsa sensacion de completitud por señales `review`.
  - Mitigacion: tratar `review` como deuda explicitada, con owner y fecha.
- Riesgo: drift post-lanzamiento.
  - Mitigacion: chequeo programado continuo sobre `vw_stock_audit_release_gate`.

## 5) Criterio de done verificable

Se considera completado cuando se cumplen todos:

1. `vw_stock_audit_release_gate` devuelve `go_live_ready = true`.
2. `blocking_reasons` vacio.
3. `vw_stock_audit_alerts_current` sin alertas `critical`.
4. Reconcile ejecutado y validado (`rpc_reconcile_stock()` con `ok = true`).
5. UI `admin/stock-audit.js` muestra `Gate GO` y sin inconsistencias estructurales.
6. Existe evidencia de verificacion (captura/registro SQL de la corrida final).
