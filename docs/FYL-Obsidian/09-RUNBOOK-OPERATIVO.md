# 09 — Runbook operativo (FYL)

> Este vault resume la operativa. La copia de trabajo en el repo es **`docs/RUNBOOK.md`** — en caso de divergencia, **priorizar** el archivo bajo `docs/` si se actualizó más recientemente, y alinear luego el vault.

## Pre-deploy (extracto)

- `git` limpio, migraciones en `supabase/canonical/` con numeración consecutiva.
- Gate (tras migraciones 175+):

```sql
SELECT go_live_ready, health_score, blocking_reasons
FROM public.vw_stock_audit_release_gate;
```

## Deploy SQL

- Aplicar archivos canónicos **en orden numérico** (SQL editor o CLI).
- Cuidar `DROP VIEW ... CASCADE` cuando alteren columnas de vistas dependientes (comentado en 175).

## Deploy frontend

- Publicar rama; sitio estático; **admin:** hard reload si hay caché agresivo.

## Post-deploy (extracto)

- Re-ejecutar `vw_stock_audit_release_gate` y `vw_stock_audit_alerts_current`.
- Smoke: home, PDP, carrito, checkout de prueba, `admin/stock-audit`, `admin/orders` sin errores de consola (ver `docs/RUNBOOK.md` §3).

## Diagnóstico rápido (síntoma → acción)

| Síntoma | Acción / referencia |
|---------|----------------------|
| Gate `no-go` | [[07-RELEASE-GATE-Y-AUDITORIA]], `blocking_reasons`; luego [[06-RESERVED-QTY-Y-RECONCILE]] |
| `variant_id` nulo en checkout | `cart_items` y `client/dashboard-instant` / `scripts/cart-persistent.js` (ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] §11) |
| `operation_id_conflict` | Mismo `operation_id` con carrito/ payload distinto — regenerar id al cambiar intención ([[05-IDEMPOTENCIA-RPC-OPERATIONS]], `docs/RUNBOOK.md` §4) |
| `conflict_in_progress` | Esperar y reconsultar; no re-disparar con otro id sin necesidad |
| Dashboard *“Error cargando pedidos activos”* + `insertBefore` | DOM: `safeInsertBefore` en `client/dashboard-instant.js`; **pendiente re-ver** si otra inserción dispara aún (consola) |
| Stock no coincide con realidad | `vw_stock_audit_*` + `rpc_reconcile_stock` + lectura con UUID de bodega (no string de código) |

## Logs SQL útiles (RPC recientes)

```sql
SELECT operation_id, operation_kind, request_json->>'action', status, started_at
FROM public.rpc_operations
ORDER BY started_at DESC
LIMIT 30;
```

## Enlaces

- `docs/RUNBOOK.md` (fuente extendida) · [[00-INDICE]] · [[99-AUDITORIA-FINAL]]
