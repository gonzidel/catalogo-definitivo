# FYL - Documentacion tecnica viva

Esta carpeta es la boveda de conocimiento del catalogo y operaciones FYL. Describe el comportamiento observado en codigo, HTML y SQL del repo. No reemplaza el codigo: ayuda a navegarlo sin romper stock, pedidos, permisos, costos, carrito ni ventas.

Fuentes de verdad, en orden:

1. Codigo JS/HTML actual.
2. SQL en `supabase/canonical/`.
3. Auditorias modulares 14-19.
4. Mapas generales 01-13.
5. Documentacion historica o comentarios sueltos.

**Saneamiento stock/pedidos/ventas (índice dedicado):** [[00-INDICE]] (notas `01-` a `10-`, `99-AUDITORIA-FINAL`); complementa los mapas `01-13` y no sustituye `docs/STOCK_GOVERNANCE.md` / `docs/RUNBOOK.md` en el repo.

Nota importante: el usuario confirmo que los SQL analizados ya estan cargados y activos en Supabase. Cuando se menciona riesgo de versionado, se refiere a mantenimiento/documentacion futura, no a una afirmacion de falta de deploy.

## Indice principal

| # | Archivo | Contenido |
|---|---|---|
| 0 | [[00-INDICE]] | Saneamiento técnico: resumen, checklist, enlaces 01-11, 99 final |
| 1 | [[01-ARQUITECTURA-GENERAL]] | Estructura del repo, hosting, entradas |
| 2 | [[02-MAPA-DE-TABLAS]] | Tablas clave, riesgo y referencias |
| 3 | [[03-MAPA-DE-RPCS]] | RPCs y funciones SQL llamadas o historicas |
| 4 | [[04-FLUJO-STOCK]] | Stock, depositos, derivados y restricciones |
| 5 | [[05-FLUJO-PEDIDOS]] | Cliente, admin, estados y RPCs |
| 6 | [[06-FLUJO-CATALOGO]] | Catalogo, vistas, filtros, PDP y carrito |
| 7 | [[07-FLUJO-ADMIN-PRODUCTOS]] | CRUD productos, variantes, costos y stock |
| 8 | [[08-PERMISOS-Y-ROLES]] | `admins`, `admin_permissions`, `super_admin` |
| 9 | [[09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY]] | Candidatos legacy/dudosos |
| 10 | [[10-BUGS-RESUELTOS]] | Bugs documentados |
| 11 | [[11-DECISIONES-TECNICAS]] | Decisiones tecnicas registradas |
| 12 | [[12-CHECKLIST-CAMBIOS-FUTUROS]] | Checklist para cambios |
| 13 | [[13-RPCS-DEPLOY-STATE]] | Registro de version/firma activa de RPCs |
| 22 | [[22-BANNER-FYL-ORIGINALS]] | Funcionamiento tecnico del banner FYL Originals en home (curaduria, slot diario, fallbacks) |
| 23 | [[23-CAMBIOS-OPERATIVOS-2026-04-29]] | Registro consolidado de cambios: stock/move-stock lector QR y búsquedas de clientes/pedidos |
| 21 | [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] | Handoff agente: hardening UX/red/auth, index top, carrito `variant_id` |
| 99a | [[99-AUDITORIA-FINAL]] | Verificacion final saneamiento (grep, SQL, cierre vs backlog) |
| 99 | [[99-AUDITORIA-DOCUMENTACION]] | Auditoria meta de la documentacion |

## Workflows e integraciones

| # | Archivo | Contenido |
|---|---|---|
| 20 | [[20-N8N-COMPRAS-TELEGRAM-INGEST]] | Workflow n8n — recepción de pedidos por Telegram (foto/audio/texto → Supabase) |
| 38 | [[38-META-FEED-ENRICHMENT-2026-05-23]] | Meta Catalog Feed — auditoría, enriquecimiento por fases (spec en `doc/meta-feed/`) |
| 39 | [[39-LISTA-ENVIOS-SENT-AT-2026-05-26]] | Lista de envíos: fecha por finalización (`sent_at`), deploy 227 |
| 40 | [[40-PAU-PANEL-ATENCION-UNIFICADO]] | PAU — panel móvil admin: buscar clienta, QR/manual, agregar pedido, cerrar (canónico `doc/pau/`) |
| 41 | [[41-MIGRACION-NEXTJS-NJ-2026-06-08]] | Migración Next.js 15 App Router en `/nj` |
| 42 | [[42-HOME-BANNERS-FEED-NJ-2026-06-09]] | Home NJ: banners (Nuevos ingresos, especial, curado), reingreso admin, orden feed |
| 44 | [[44-CATALOGO1-LANZAMIENTO-2026-06-13]] | Fork `/catalogo1`: mismo Supabase, sin auth/carrito, WhatsApp; dev `:3002` |
| 57 | [[57-GZ-AGENTE-IMPRESION-REEMPLAZO-QZ-2026-08-25]] | GZ — agente de impresión local propio, reemplaza QZ Tray en las 6 páginas del admin que imprimen (sin certificados, sin popups) |

## Auditorias modulares

Estas notas son la referencia mas reciente por modulo:

| Modulo | Nota |
|---|---|
| Products | [[14-AUDITORIA-MODULO-PRODUCTS]] |
| Observaciones transversales | [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] |
| Stock | [[16-AUDITORIA-MODULO-STOCK]] |
| Orders | [[17-AUDITORIA-MODULO-ORDERS]] |
| Public Sales | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| Cliente/Carrito | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |

**Contexto operativo (2026-04):** [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] resume cambios de código y trampas comunes (no sustituye auditorias 14-19; las complementa cuando hubo refactor en el mismo periodo).

## Regla de lectura

Si un mapa general contradice una auditoria modular, tomar como referencia la auditoria modular y actualizar el mapa general.

Antes de cambiar logica importante, revisar [[12-CHECKLIST-CAMBIOS-FUTUROS]].
