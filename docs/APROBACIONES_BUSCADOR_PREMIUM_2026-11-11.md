# Aprobaciones — Buscador premium

Actualizado 2026-11-11 tras autorización explícita.

## 1) Migración 409 — `product_search_profiles` — APLICADA

- **SQL:** `supabase/canonical/409_product_search_profiles.sql`
- **Proyecto:** `fyl-core` (`dtfznewwvsadkorxwzft`)
- **Verificación:** `profiles_count=0`, vista pública vacía
- **Rollback:** `409_ROLLBACK_product_search_profiles.sql`

## 2) Deploy Edge Function `search_profile_ai` — DESPLEGADA

- Función ACTIVE v1, `verify_jwt=true` + `rejectIfNotAdmin`
- **Verificación:** anon POST → **401** «Sesión inválida»
- **Secrets:** reutiliza `OPENAI_API_KEY` y `ANTHROPIC_API_KEY`

## 3) Migración 410 — `search_events.result_mode` — APLICADA

- Columna `result_mode text` presente
- Frontend: activar con `NEXT_PUBLIC_SEARCH_EVENTS_MODE=1` (Preview primero)
- **Rollback:** `410_ROLLBACK_search_events_result_mode.sql`

## 4) Publicación frontend NJ — en curso (sin promote)

- Commit + PR a `nj-main` → Preview QA mobile → promote solo tras smoke OK

## Estado del código (2026-11-11)

- Motor + UI + golden (82 consultas, selftests OK) en rama `feat/nj-buscador-premium`.
- Cola admin `/admin/search/profiles`, hook `useSearchProfiles`, candidatos de sinónimos en admin.
- Piloto: strata + rúbrica + `pilot-run.ts --dry-run` (live requiere ítems 1–2).
- Baseline `search_events`: SQL en `nj/lib/search/search-events-baseline.ts` (MCP caído).
- Release gate: `docs/FE_RELEASE_BUSCADOR_PREMIUM_2026-11-11.md`.

Responder en el chat qué ítems (1–4) se aprueban para ejecutarlos.
