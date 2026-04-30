# 00 — Índice: saneamiento técnico FYL (stock / pedidos / ventas)

Documentación viva de **cierre y operación** tras los sprints de saneamiento. Complementa (no reemplaza) las notas históricas: [[00-INICIO]], mapas 01–13, auditorías 14–19, [[21-CONTEXTO-AGENTE-HARDENING-2026-04]].

**Fuentes de verdad:** `docs/STOCK_GOVERNANCE.md`, `docs/RUNBOOK.md`, SQL en `supabase/canonical/`, código en `admin/` y `client/`.

---

## Resumen del estado final

| Área | Estado documentado |
|------|--------------------|
| Escritura canónica de stock | `variant_size_warehouse_stock` vía RPCs; derivadas 84/145 |
| Idempotencia operaciones críticas | `rpc_operations` + `operation_id` en checkout, venta pública, movimientos, picked, devolución |
| Auditoría / release gate | Vistas `vw_stock_audit_*`, `go_live_ready` |
| `reserved_qty` | Reconciliación vía `rpc_reconcile_stock(p_fix_reserved_qty)` (ver [[06-RESERVED-QTY-Y-RECONCILE]]) |
| UI | Lectura canónica; fallbacks que inventaban stock eliminados o acotados (ver [[08-UI-CANONICA-Y-FALLBACKS]]) |
| Cliente B2B | Checkout `rpc_checkout_cart(uuid, jsonb)`; `cart_items.variant_id` obligatorio; DOM post-checkout con `safeInsertBefore` |

---

## Navegación (documento del saneamiento)

| Doc | Contenido |
|-----|------------|
| [[01-RESUMEN-EJECUTIVO-SANEAMIENTO]] | Motivación, riesgos, qué se resolvió, estado final |
| [[02-MODELO-STOCK-ACTUAL]] | Tablas canónicas, derivadas, qué no escribir directo |
| [[03-FLUJO-PEDIDOS-Y-STOCK]] | Carrito, pedido activo, estados, venta pública, cancelaciones… |
| [[04-RPCS-CRITICAS]] | RPC, migración, idempotencia, tablas, riesgos |
| [[05-IDEMPOTENCIA-RPC-OPERATIONS]] | `operation_id`, replay, conflictos, patrón frontend |
| [[06-RESERVED-QTY-Y-RECONCILE]] | `reserved_qty`, vistas, `rpc_reconcile_stock` |
| [[07-RELEASE-GATE-Y-AUDITORIA]] | Gate, `blocking_reasons`, SQL útiles |
| [[08-UI-CANONICA-Y-FALLBACKS]] | Pantallas, missing vs manual confirmado, dashboard |
| [[09-RUNBOOK-OPERATIVO]] | Pre/post deploy, smoke, diagnóstico rápido |
| [[10-BACKLOG-NO-CRITICO]] | Deuda priorizada no bloqueante |
| [[11-DECISIONES-TECNICAS]] | Decisiones de producto/ingeniería (incl. saneamiento) |
| [[99-AUDITORIA-FINAL]] | Verificaciones, greps, SQL, cierre vs backlog |
| [[99-AUDITORIA-DOCUMENTACION]] | Meta-auditoría del vault (histórica) |

**Operativa de repo (también en `docs/`):**

- `docs/STOCK_GOVERNANCE.md` — gobernanza detallada
- `docs/RUNBOOK.md` — runbook “fuente”

---

## Checklist: qué se considera **cerrado** (saneamiento)

- [x] Cancelación de ítems y retorno de stock vía RPCs transaccionales (ver SQL canónico y [[03-FLUJO-PEDIDOS-Y-STOCK]])
- [x] Centralización de escrituras de stock en admin hacia RPCs batch / movimiento (`rpc_set_variant_*`, `rpc_move_size_stock`, etc.) — *detalle en [[04-RPCS-CRITICAS]]*
- [x] Idempotencia fuerte: infra `169_rpc_operations_infra.sql` y wrappers en RPCs listadas
- [x] `rpc_reconcile_stock` con parámetro `p_fix_reserved_qty` (`176_rpc_reconcile_stock_reserved_qty.sql`) + vistas de drift
- [x] Release gate y alertas (`144`, `175`, `146`…)
- [x] Documentación operativa `STOCK_GOVERNANCE` + `RUNBOOK`
- [x] UI cliente: reparo `variant_id` en carrito, `safeInsertBefore` en feedback post-checkout (*pendiente re-verificar en entorno* si persiste otra causa)

## Backlog no crítico (resumen)

Ver [[10-BACKLOG-NO-CRITICO]]: columnas legacy, RLS fino, helpers duplicados, `reserved` por talle, etc.

---

## Enlaces a documentación general FYL (vault)

- [[00-INICIO]] — índice histórico del vault
- [[23-CAMBIOS-OPERATIVOS-2026-04-29]] — bitácora consolidada de cambios operativos recientes (incluye reparo PDP banner F&L Originals en catalogo publico)
- [[22-BANNER-FYL-ORIGINALS]] — banner home F&L Originals; navegacion clic → PDP y nota de reparo 2026-04
- [[04-FLUJO-STOCK]] / [[05-FLUJO-PEDIDOS]] — flujos (pueden solaparse con [[03-FLUJO-PEDIDOS-Y-STOCK]]; priorizar notas de saneamiento para decisiones 2024–2026)
- [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] + §11 post-auditoría
- [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] — hardening admin/catálogo

---

*Última actualización: saneamiento (vault); enlaces FYL catalogo/banner revisados 2026-04.*
