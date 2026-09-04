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
- [[41-MIGRACION-NEXTJS-NJ-2026-06-08]] — **Migración Next.js 15 App Router en `/nj`**: catálogo, banners, PDP, auth. Ver [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] para banners home y feed 2026-06-09.
- [[44-CATALOGO1-LANZAMIENTO-2026-06-13]] — **Fork `/catalogo1`**: mismo Supabase, sin login/carrito, consulta WhatsApp; dev `:3002`. Cutover desde `/nj` cuando esté listo.
- [[45-GEO-OPTIMIZACION-IA-2026-06-23]] — **GEO (Generative Engine Optimization)**: JSON-LD, sitemap, robots, llms.txt, FAQ schema. Fase 1 implementada; fase 2 pendiente (PDP SSR, landing pages SEO, Product schema).
- [[46-NJ-KANBAN-PEDIDOS-ADMIN-2026-07-15]] — **Kanban `nj/admin/orders`**: cancelados visibles, wizard de reparto picked/espera/falta, columna Espera priorizada, "Volver a apartado", creación manual de pedidos portada de legacy, aviso "¿llevar stock a 0?" (RPC 250), modal Espera legacy compactado y desglosado por unidad, dashboard cliente agrupado, mobile draft mode (Activos + drawer + confirmar cambios).
- [[47-VENCIMIENTO-PEDIDOS-DIA-HABIL-2026-08-01]] — **Vencimiento a día hábil 17:00 Arg**: nueva tabla/panel de feriados (`admin/holidays.html`), `fn_compute_order_deadline` en `rpc_checkout_cart`/`rpc_orders_daily_maintenance` (migración 257). Incluye reactivación crítica de `pg_cron` (migración 255, nunca corría en prod) y el efecto secundario real (3 pedidos vencidos hace meses expiraron y liberaron stock al ejecutar el backfill).
- [[48-AUDITORIA-ESTADOS-PEDIDOS-Y-FIXES-2026-08-01]] — **Auditoría estados pedidos/ítems** (Kanban `nj` + admin legacy + SQL): fix crítico `stock_pending` faltante en `orders_status_check` (migración 259), fix crítico choque `reserved_qty` en vencimiento automático vs trigger 188 (migración 260 + reconciliación histórica de 945 diffs vía `rpc_reconcile_stock(true)`, ambas aplicadas en producción), tipado `closing_soon`/`expired` + guard de estados terminales en `nj/lib/orders/classification.ts` y `nj/hooks/useOrders.ts`, unificación de "pedido abierto" en `admin/order-creator.js` (incluye `stock_pending` con aviso dedicado, sin tocar la regla de negocio de 251), y paridad `expired` en filtros de `admin/orders.js`/`admin/public-sales.js`.
- [[49-REGLAS-UX-FLUJO-COMPRA-CLIENTE-2026-08-10]] — **Reglas UX canónicas del flujo cliente `/nj`**: perfiles de clientas (abastecimiento, toma pedidos, no cliente), journey PDP→carrito→pedido abierto→cerrar→preparación, naming visible, estados internos ocultos (`Reservado`/`Confirmado`), reglas de copy, retiro/envío, onboarding no intrusivo, métricas y checklist obligatoria para agentes antes de tocar UX cliente.
- [[50-AUDITORIA-CLOUDINARY-CONSUMO-2026-08-15]] — **Auditoría consumo Cloudinary** (`dnuedzuzm`): pico ~15 días atribuible a `next/image` srcset (14 anchos) vs vanilla (2–3); 6007 originales; OAuth del plugin pendiente para usage real.
- [[57-GZ-AGENTE-IMPRESION-REEMPLAZO-QZ-2026-08-25]] — **GZ**: agente de impresión local propio (`gz-agent/`), reemplaza QZ Tray por completo en `closed-orders`, `labels`, `public-sales`, `sent-orders`, `stock`, `local-order-edit`. Sin certificados/firma, helper nativo `GZNative.exe` (sin PowerShell), `.exe` único sin ventana, autoarranque con Windows. Incluye fix de desperdicio de etiquetas en "Imprimir Todo".
- [[58-SENT-ORDERS-META-TRANSPORTE-REIMPRESION-2026-08-25]] — **Sent-orders**: chips de transporte / reimpresión / fecha original→nueva en tarjeta del pedido; migración 304 (`original_sent_at`, `sent_transport_id`, `rpc_record_sent_order_label_reprint`).

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

*Actualización 2026-06-13 — Fork `/catalogo1` para lanzamiento público (WhatsApp, sin auth/carrito). Misma base Supabase. Ver [[44-CATALOGO1-LANZAMIENTO-2026-06-13]].*

*Actualización 2026-06-08 — Migración Next.js 15 App Router iniciada en `/nj`: catálogo público solo lectura, banners, PDP, como-comprar, quienes-somos. Ver [[41-MIGRACION-NEXTJS-NJ-2026-06-08]].*

*Actualización 2026-06-23 — GEO fase 1: JSON-LD (Organization, WebSite, FAQPage, CollectionPage, Breadcrumb), sitemap.xml, robots.txt, llms.txt. Score 25→55. Ver [[45-GEO-OPTIMIZACION-IA-2026-06-23]].*

*Actualización 2026-07-15 — Kanban `nj/admin/orders`: ítems cancelados visibles en columna dedicada, wizard de reparto parcial (picked/espera/falta) para ítems multi-unidad, orden de prioridad en Espera + leyenda de colores, "Volver a apartado" en Cerrados, creación manual de pedidos portada desde `admin/orders.html`, aviso de "¿llevar stock a 0?" al marcar sin stock (RPC `rpc_admin_zero_variant_size_stock`, migración 250), modal Espera legacy compactado con desglose por unidad, dashboard cliente con ítems agrupados, y draft mode mobile (solo Activos visible + drawer para el resto + barra de confirmación). Ver [[46-NJ-KANBAN-PEDIDOS-ADMIN-2026-07-15]].*

*Actualización 2026-05-15 — Auditoría escrituras admin stock/pedidos (diagnóstico): [[34-ADMIN-WRITES-STOCK-ORDERS-AUDIT-2026-05-15]]; detalle en `doc/admin-writes-audit-stock-orders-2026-05-15.md`. RFC borrador RPC atómica alta pedido admin: [[35-RFC-RPC-CREATE-ADMIN-ORDER-ATOMIC-2026-05-15]] (`doc/rfc-rpc-create-admin-order-atomic-2026-05-15.md`). Revisión estrés concurrencia (sin SQL): `doc/rfc-create-admin-order-atomic-concurrency-stress-2026-05-15.md`. Contrato idempotencia v1 congelado: `doc/rfc-create-admin-order-atomic-idempotency-contract-v1-2026-05-15.md`. Plan implementación staging: `doc/plan-implementacion-rpc-create-admin-order-atomic-staging-2026-05-15.md`. Catálogo snapshot (refresh operativo web): [[36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]].*

