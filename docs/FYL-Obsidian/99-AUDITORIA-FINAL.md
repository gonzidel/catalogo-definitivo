# 99 — Auditoría final (saneamiento FYL, vault)

> Checklist de **verificación** y estado documental. No sustituye ejecución en CI ni revisión de seguridad de red.

## Resumen

| Ámbito | Estado documental en vault |
|--------|----------------------------|
| Modelo canónico y derivados | Cerrado en [[02-MODELO-STOCK-ACTUAL]] + gobernanza |
| RPCs y idempotencia | Cerrado en [[04-RPCS-CRITICAS]], [[05-IDEMPOTENCIA-RPC-OPERATIONS]]; **verificar** firma desplegada con [[13-RPCS-DEPLOY-STATE]] o DB |
| `reserved_qty` y reconcile | Cerrado en [[06-RESERVED-QTY-Y-RECONCILE]]; contrato 176 verificado en SQL |
| Release gate 175 V3 | Cerrado en [[07-RELEASE-GATE-Y-AUDITORIA]] (incl. `reserved_qty_diffs` en go) |
| UI canónica | Cerrado en [[08-UI-CANONICA-Y-FALLBACKS]]; **verificar** con grep writes |
| Carrito / checkout / DOM | Parcial: correcciones documentadas; **pendiente de verificación** de ausencia de `insertBefore` inseguro y de writes directos *residuales* en admin |

## Qué buscar: writes directos críticos (frontend / SQL app)

Búsquedas recomendadas (desde raíz del repo, fuera del vault):

```bash
# Mutaciones a la canónica (ajustar si se usan otras formas)
rg "variant_size_warehouse_stock" admin --glob "*.js" | rg -i "update|insert|upsert|delete"

# RPC de checkout / operation_id
rg "rpc_checkout_cart" client --glob "*.js"
rg "p_operation_id" admin client --glob "*.js"
```

**Pendiente de verificación:** listado exhaustivo de **todas** las líneas aún con `.upsert`/`update` a canónica — puede haber excepciones aprobadas (herramientas one-off) que no estén en `admin/`.

## SQL de chequeo (operativo)

```sql
-- Gate (nota: "health_score" NO existe como columna — corregido 2026-05-04)
SELECT
  go_live_ready,
  release_decision,
  blocking_reasons,
  variant_sizes_diffs,
  reserved_qty_diffs,
  trigger_84_active,
  trigger_145_active
FROM public.vw_stock_audit_release_gate;

-- Drift de reservas
SELECT count(*) FROM public.vw_stock_audit_reserved_qty_diff;

-- Reconcile (revisar JSON antes de true en producción)
SELECT public.rpc_reconcile_stock(false);
```

## Cierre vs backlog

- **Cerrado (diseño):** política de stock, idempotencia en RPCs listadas, gate V3, documentación de operativa.
- **Backlog:** [[10-BACKLOG-NO-CRITICO]].
- **Pendiente de verificación en producción:** versión exacta de cada migración aplicada, concordancia con `supabase/canonical/`.

## Enlaces

- [[00-INDICE]] · [[10-BACKLOG-NO-CRITICO]] · `docs/STOCK_GOVERNANCE.md` · `docs/RUNBOOK.md`
