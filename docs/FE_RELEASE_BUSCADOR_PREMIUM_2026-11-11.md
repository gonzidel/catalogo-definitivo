# Release gate — Buscador premium `/nj`

Rama: `feat/nj-buscador-premium` (base `nj-main`).

## Preflight (antes de PR)

- [x] Selftests: `search-golden`, `search-score`, `search-resolver`
- [x] Bandera `NEXT_PUBLIC_SEARCH_V2` (default ON; apagar con `0`)
- [x] Backend prod: 409 + 410 + Edge `search_profile_ai` (anon→401)
- [x] Env Preview Vercel: `NEXT_PUBLIC_SEARCH_V2=1`, `NEXT_PUBLIC_SEARCH_EVENTS_MODE=1`
- [x] Push `feat/nj-buscador-premium` (incl. fix build `combo`)
- [x] PR abierto: https://github.com/gonzidel/catalogo-definitivo/pull/4
- [x] Preview Vercel NJ READY (`dpl_BJzvXZwcnsTS9uxfixjAznncVUjV`, commit `ca28e7f`)
- [x] Smoke Preview desktop: sandalias (157) / nude (1+chip) / 38 (227+Talle) / jeans elastico (1+chips)
- [ ] QA mobile 360–430 px (iPhone/Android) — pendiente humano
- [x] Redeploy Edge `search_profile_ai` v2 con modelo `gpt-6-luna`
- [ ] Auto-perfil + «Generar faltantes» en Preview/prod tras merge de este código
- [ ] Revisar/aprobar drafts en `/nj/admin/search/profiles`

## PR

- Base: **`nj-main`** (nunca `main`)
- URL: https://github.com/gonzidel/catalogo-definitivo/pull/4
- Commits: `a1f290b` (auto_tags) + `b1e4133` (buscador v2) + `ca28e7f` (fix `combo` en `keepSuggestion`)
- Alias Preview esperado: `nj-git-feat-nj-buscador-premium-gonzidel.vercel.app`
- Nota: fallos Cloudflare / Preview de `catalogo-definitivo` no bloquean el app NJ

## Producción frontend (NO hecho — falta QA Preview)

1. `vercel deploy --prod --skip-domain` (proyecto NJ)
2. Smoke en URL de deploy
3. `vercel promote`
4. Confirmar que solo `www` / alias NJ cambia
5. Luego setear `NEXT_PUBLIC_SEARCH_EVENTS_MODE=1` también en Production

## Post-lanzamiento

- Tasa de cero resultados
- CTR top 5 / posición media del clic
- Refinamientos por sesión
- Tiempo hasta primer clic
