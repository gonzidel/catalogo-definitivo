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
| 21 | [[21-CONTEXTO-AGENTE-HARDENING-2026-04]] | Handoff agente: hardening UX/red/auth, index top, carrito `variant_id` |
| 99a | [[99-AUDITORIA-FINAL]] | Verificacion final saneamiento (grep, SQL, cierre vs backlog) |
| 99 | [[99-AUDITORIA-DOCUMENTACION]] | Auditoria meta de la documentacion |

## Workflows e integraciones

| # | Archivo | Contenido |
|---|---|---|
| 20 | [[20-N8N-COMPRAS-TELEGRAM-INGEST]] | Workflow n8n — recepción de pedidos por Telegram (foto/audio/texto → Supabase) |

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
