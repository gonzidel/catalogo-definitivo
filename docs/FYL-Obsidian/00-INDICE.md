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
| `reserved_qty` | Transición a final: migración **188** (trigger + ledger); reconciliación vía `rpc_reconcile_stock(p_fix_reserved_qty)` para drift histórico (ver [[06-RESERVED-QTY-Y-RECONCILE]]) |
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
- `docs/RUNBOOK.md` — runbook "fuente"

---

## Checklist: qué se considera **cerrado** (saneamiento)

- [x] Cancelación de ítems y retorno de stock vía RPCs transaccionales (ver SQL canónico y [[03-FLUJO-PEDIDOS-Y-STOCK]])
- [x] Centralización de escrituras de stock en admin hacia RPCs batch / movimiento (`rpc_set_variant_*`, `rpc_move_size_stock`, etc.) — *detalle en [[04-RPCS-CRITICAS]]*
- [x] Idempotencia fuerte: infra `169_rpc_operations_infra.sql` y wrappers en RPCs listadas
- [x] `rpc_reconcile_stock` con parámetro `p_fix_reserved_qty` (`176_rpc_reconcile_stock_reserved_qty.sql`) + vistas de drift
- [x] Liberación al estado final del pedido: **188** `order_reserved_qty_released` + trigger en `orders` (producción; ver [[06-RESERVED-QTY-Y-RECONCILE]] §188)
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
- [[36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]] — refresh `catalog_public_snapshot` (botón Acciones rápidas + plan `doc/plan-catalogo-publico-snapshot-banner-2026-05-15.md`)
- [[24-CURATED-BANNER-V1-SCHEMA]] — Fase 1 schema Curated Banner v1.1 (`product_variant_id`, `variant_id` en vista/snapshot)
- [[37-CURATED-BANNER-FRONTEND-OPERATIVO-2026-05-18]] — **Banner curado OK en index** (flag, loader, admin, diagnóstico)
- [[38-META-FEED-ENRICHMENT-2026-05-23]] — Meta Catalog Feed enriquecido (spec 3 fases; canónico `doc/meta-feed/`)
- [[39-LISTA-ENVIOS-SENT-AT-2026-05-26]] — Lista de envíos (`sent_at` al finalizar; migración 227; sin backfill histórico)
- [[40-PAU-PANEL-ATENCION-UNIFICADO]] — PAU: panel móvil pedidos/WhatsApp (QR, borrador, cerrar); canónico `doc/pau/README.md`

---

## Auditorías de stock ejecutadas

| Fecha | Doc | Resultado |
|-------|-----|-----------|
| 2026-05-04 | [[24-AUDITORIA-STOCK-2026-05-04]] | no-go: 782 diffs reserved_qty (4 deflated), 10 diffs variant_sizes, 7 filas huérfanas. Triggers OK. Plan de corrección incluido. |
| 2026-05-04 | [[25-AUDITORIA-CATALOGO-2026-05-04]] | 3 variantes visibles sin stock real (JMEEK, 72), 5 talles fantasma por talle (incl. LIKO talle 37), 25 variantes sin imágenes (~276u bloqueadas), Bloque 4 OK. |

## Estado del roadmap de saneamiento

| Fase | Descripción | Estado |
|------|-------------|--------|
| FASE 0 | Diagnóstico congelado | COMPLETADO 2026-05-04 |
| FASE 1 | Correcciones del vault | COMPLETADO 2026-05-04 |
| FASE 2 | Decisiones de negocio | COMPLETADO 2026-05-04 |
| FASE 3 | Auditoría catálogo (SQL read-only) | COMPLETADO 2026-05-04 |
| FASE 4 | Verificación técnica (pg_proc / pg_trigger) | COMPLETADO 2026-05-04 (F4-3 pendiente reintentar) |
| FASE 5 | Reparación de datos (rpc_reconcile_stock) | COMPLETADO 2026-05-04 — gate: go |
| FASE 6 | Diseño módulo admin de stock | COMPLETADO 2026-05-04 — ver [[26-SPEC-MODULO-ADMIN-STOCK]] |
| FASE 7 | Implementación módulo admin | COMPLETADO 2026-05-04 — admin/stock-audit.html + admin/stock-audit.js |
| FASE 7b | Integración con pantallas legacy | COMPLETADO 2026-05-04 — ver [[10-BUGS-RESUELTOS]] (4 entradas 2026-05-04) |
| FASE 8 | Fixes críticos admin/products.js | COMPLETADO 2026-05-04 — ver [[10-BUGS-RESUELTOS]] (3 entradas, tags + autocompletado) |
| FASE 9 | Inteligencia operativa stock-audit | COMPLETADO 2026-05-04 — ver [[27-MODULO-COMPORTAMIENTO-PRODUCTOS]] (verificación operativa OK 2026-05-04) |

*Última actualización: 2026-05-04 — 188 producción + cierre histórico `reserved_qty` documentado en [[06-RESERVED-QTY-Y-RECONCILE]]; FASE 9 verificada en [[27-MODULO-COMPORTAMIENTO-PRODUCTOS]].*

*Actualización 2026-05-08 — boot crítico de Supabase blindado contra Safari iOS: bundle IIFE same-origin, eliminación de `import()` dinámico, SW tombstone network-only, kill switch remoto. Detalle en [[10-BUGS-RESUELTOS]] §2026-05-08 y nuevas decisiones 13–16 en [[11-DECISIONES-TECNICAS]] §B.*

*Actualización 2026-05-15 — Fase A grants PostgREST (compras + publicación): [[33-FASE-A-GRANTS-COMPRAS-PUBLICACION-2026-05-15]]; bitácora en `doc/hardening-fase-a-grants-2026-05-15.md`.*

*Actualización 2026-05-15 — Auditoría escrituras admin stock/pedidos (diagnóstico): [[34-ADMIN-WRITES-STOCK-ORDERS-AUDIT-2026-05-15]]; detalle en `doc/admin-writes-audit-stock-orders-2026-05-15.md`. RFC borrador RPC atómica alta pedido admin: [[35-RFC-RPC-CREATE-ADMIN-ORDER-ATOMIC-2026-05-15]] (`doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md`). Revisión estrés concurrencia (sin SQL): `doc/rfc-create-admin-order-atomic-concurrency-stress-2026-05-15.md`. Contrato idempotencia v1 congelado: `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`. Plan implementación staging: `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`. Catálogo snapshot (refresh operativo web): [[36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]].*

