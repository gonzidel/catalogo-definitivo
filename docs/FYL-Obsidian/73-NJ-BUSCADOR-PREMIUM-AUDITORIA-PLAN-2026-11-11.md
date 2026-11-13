# 73 — Buscador premium `/nj` (auditoría + plan 2026-11-11)

> Estado: **en implementación** en rama `feat/nj-buscador-premium` (worktree `E:\PROYECTOS\fyl-buscador-premium`).
> Hub previo: [[59-NJ-BUSCADOR-SMART-SEARCH]].

## Evidencia (línea base)

- Catálogo público: 614 artículos / 1.249 filas snapshot.
- 72 consultas golden: 11 sin resultados; fallos `nude`→nudo, `38`→SKU 380, `talle 38`=0.
- 41% artículos con ≤3 palabras buscables; 184 indistinguibles por desc+tags.
- Vocabulario live: 7 keywords (seed). Tags tabla 746 / 245 sin uso en snapshot.
- `auto_tags` era invocable con anon key (400 de validación, no 401).

## Fase 0 (hecha en producción)

- Deploy `auto_tags` con `rejectIfNotAdmin` (patrón qz-sign).
- Verificado: anon → **401** «Sesión inválida».
- Commit local: `a1f290b fix(search): restringir auto_tags a admins y preservar tag3 al aplicar IA`.
- AutoTagsButton conserva `tag3Ids` existentes al aplicar.
- Rollback: copia en agent store `rollback_auto_tags` + redeploy desde `origin/nj-main`.

## Decisiones (CANÓNICA / TÉCNICA)

| Tema | Decisión |
|------|----------|
| Descripción pública | **No se toca.** IA escribe solo `product_search_profiles`. |
| Proveedor IA perfiles | Comparar OpenAI vs Claude en piloto 40. |
| Stemming ES | Reemplaza «sin stemming general» de nota 59 (ver `docs/10_DECISIONES.md`). |
| Productos OOS en búsqueda | No listar; stub `searchProductsIncludingOutOfStock` (visibilidad canónica). |
| Shape snapshot | No cambia. Perfiles en tabla aparte. |

## Implementado en rama (código)

- Motor: `stem-es`, `color-families`, `size-intent`, `cascade`, `search-index`, fuzzy más estricto, bonus stock.
- UI: input 16px, autocomplete con nombre/precio/thumb, recientes, chips de intención, orden Relevancia/Novedades, empty state con alternativas, aviso cascade.
- Golden: `lib/search/search-golden.selftest.ts` + fixture (~72 consultas). Selftests score/resolver OK.
- Bandera: `NEXT_PUBLIC_SEARCH_V2` (default ON; `0` apaga).
- SQL listo (sin aplicar): `409_product_search_profiles.sql`, `410_search_events_result_mode.sql`.
- Edge Function lista (sin deploy): `search_profile_ai`.
- Admin cola: `/nj/admin/search/profiles` + candidatos iniciales de sinónimos en `/admin/search`.
- Hook `useSearchProfiles` + integración ranking.
- Piloto: `pilot-40.ts` + `pilot-run.ts` (dry-run; live tras approve).
- Baseline `search_events`: SQL en `search-events-baseline.ts` (MCP caído; requiere JWT admin).

## Auto-perfil IA (2026-11-11 noche)

- Disparo al completar tags + talles + foto (primera vez, sin fila previa).
- Default OpenAI: **`gpt-6-luna`** (visión). Claude Haiku queda como provider opcional.
- Drafts → revisión en `/nj/admin/search/profiles` → solo `approved` al buscador.
- Backfill: «Generar faltantes (20)».
- **Prod:** Edge **search_profile_ai v2** con `gpt-6-luna` (redeploy 2026-11-11). Falta merge/deploy frontend de auto-perfil + backfill UI.

## Pendiente de aprobación producción

1. ~~Aplicar migración **409**~~ (hecha).
2. ~~Redeploy Edge **search_profile_ai** con `gpt-6-luna`~~ (v2 ACTIVE).
3. ~~Migración **410**~~ (hecha); env Preview `SEARCH_EVENTS_MODE` según FE release.
4. Commit/push frontend auto-perfil → Preview → backfill drafts vía admin «Generar faltantes» → revisión humana.
5. QA mobile Preview → merge/promote con OK explícito.

## Riesgo / rollback

- Código frontend: revertir commits / bandera OFF.
- `auto_tags`: redeploy versión anterior.
- 409: `409_ROLLBACK_product_search_profiles.sql`.
- 410: `410_ROLLBACK_search_events_result_mode.sql`.

## Deuda

- Leer `search_events` live (admin) para priorizar aliases.
- Verificar botón Auto-tags con sesión admin en UI (no automatizable aquí).
- Revisar panel OpenAI por abuso previo al harden.
- `feat/product-season` no estaba ahead de nj-main; no hay conflicto de season en perfiles.
