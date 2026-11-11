# Aprobaciones — Buscador premium

Actualizado 2026-11-11 tras autorización explícita.

## 1) Migración 409 — `product_search_profiles` — APLICADA

- **SQL:** `supabase/canonical/409_product_search_profiles.sql`
- **Proyecto:** `fyl-core` (`dtfznewwvsadkorxwzft`)
- **Verificación:** `profiles_count=0`, vista pública vacía
- **Rollback:** `409_ROLLBACK_product_search_profiles.sql`

## 2) Deploy Edge Function `search_profile_ai` — DESPLEGADA v2

- Función ACTIVE **v2**, `verify_jwt=true` + `rejectIfNotAdmin`
- **Modelo default prod:** `gpt-6-luna` (visión + `detail:high`)
- **Secrets:** reutiliza `OPENAI_API_KEY` y `ANTHROPIC_API_KEY`
- **Redeploy:** 2026-11-11 (OK explícito)

## 3) Migración 410 — `search_events.result_mode` — APLICADA

- Columna `result_mode text` presente
- Frontend: activar con `NEXT_PUBLIC_SEARCH_EVENTS_MODE=1` (Preview primero)
- **Rollback:** `410_ROLLBACK_search_events_result_mode.sql`

## 4) Publicación frontend NJ — en curso (sin promote)

- **PR:** https://github.com/gonzidel/catalogo-definitivo/pull/4 (`feat/nj-buscador-premium` → `nj-main`)
- **Commits:** `b1e4133` (buscador v2) + `ca28e7f` (fix `keepSuggestion` tipo `combo` para build TS)
- **Preview READY:** `dpl_BJzvXZwcnsTS9uxfixjAznncVUjV` → alias `nj-git-feat-nj-buscador-premium-gonzidel.vercel.app`
- **Smoke (2026-11-11):** `sandalias`→157; `nude`→1 (chip Nude); `38`→227 (chip Talle 38); `jeans elastico`→1 (chips Jeans+Elastico)
- Promote a www / production: **NO** hasta QA mobile + OK explícito

## 5) Auto-perfil IA — implementado en código (rama)

- Gate: `tag1`+`tag2` + ≥1 talle + ≥1 foto; solo si **no** hay fila en `product_search_profiles`.
- Resultado: siempre `draft` (revisión humana en `/nj/admin/search/profiles`).
- Call sites NJ: `saveProductTags`, `saveVariantSizes`, `uploadVariantImage`, `loadImagesFromUrls`.
- Call sites legacy: `admin/products.js`, `variant-image-upload.js`, `missing-images.js`.
- Backfill: botón **Generar faltantes (20)** en la cola admin.
- Helper: `nj/lib/products/search-profile-auto.ts` + `admin/search-profile-auto.js`.

## Estado del código (2026-11-11)

- Motor + UI + golden (82 consultas, selftests OK) en rama `feat/nj-buscador-premium`.
- Cola admin `/admin/search/profiles`, hook `useSearchProfiles`, candidatos de sinónimos en admin.
- Auto-perfil + backfill en código; falta redeploy Edge con `gpt-6-luna` + merge/promote frontend.
- Baseline `search_events`: SQL en `nj/lib/search/search-events-baseline.ts`.
- Release gate: `docs/FE_RELEASE_BUSCADOR_PREMIUM_2026-11-11.md`.
