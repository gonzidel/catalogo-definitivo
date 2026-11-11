# Release gate — Buscador premium `/nj`

Rama: `feat/nj-buscador-premium` (base `nj-main`).

## Preflight (antes de PR)

- [x] Selftests: `search-golden`, `search-score`, `search-resolver`
- [x] Bandera `NEXT_PUBLIC_SEARCH_V2` (default ON; apagar con `0`)
- [ ] Preview Vercel NJ + QA mobile 360–430 px (iPhone/Android)
- [ ] `git fetch origin` y `git rev-list --count origin/nj-main..HEAD` sin commits ajenos
- [ ] Leer `docs/12_PENDIENTES.md`, notas Obsidian 72/75/73

## PR

- Base: **`nj-main`** (nunca `main`)
- Una PR por fase si el diff es grande; o una PR «buscador premium» si se prefiere

## Producción (solo con autorización explícita)

1. `vercel deploy --prod --skip-domain` (proyecto NJ)
2. Smoke en URL de deploy
3. `vercel promote`
4. Confirmar que solo `www` / alias NJ cambia

## Post-lanzamiento

- Tasa de cero resultados
- CTR top 5 / posición media del clic
- Refinamientos por sesión
- Tiempo hasta primer clic
