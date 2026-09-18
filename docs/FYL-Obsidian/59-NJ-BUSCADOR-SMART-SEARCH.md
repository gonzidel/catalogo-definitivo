# 59 — Buscador `/nj` (Smart Search)

> Hub vivo del buscador Next.js. Fuente de operación para agentes. El detalle de código también está en `doc/nj/smart-search.md`.
>
> **Estado (2026-09-04):** Fases 1–5 hechas en `fyl-core` (`dtfznewwvsadkorxwzft`). Tags **no** se tocan.
>
> Regla de producto: **analytics sugiere · administrador decide · buscador ejecuta.** Nada se agrega solo al vocabulario.

## Dónde vive

El buscador canónico del catálogo mayorista es **`/nj`**, no `scripts/search-manager.js` (vanilla/legacy). Ver [[06-FLUJO-CATALOGO]] y [[41-MIGRACION-NEXTJS-NJ-2026-06-08]].

Admin del vocabulario: `/nj/admin/search`. Registro de apply: [[41-SEARCH-ADMIN-FASE5-2026-09-03]].

## Fases

| Fase | Qué | Migración | Estado |
|------|-----|-----------|--------|
| 1 | Flujo unificado: un solo commit textual | — | Hecha |
| 2 | Resolver + keywords/aliases | `327_search_keywords_aliases.sql` | Hecha / live |
| 3 | Ranking / relevancia | — | Hecha |
| 4 | Analytics híbrido GA4 + `search_events` | `328_search_events.sql` | Hecha / live |
| 5 | Admin de vocabulario + oportunidades | `329_search_admin.sql` | Hecha / live |
| — | Limpieza de tags duplicados | — | **No hacer todavía** |
| — | Ranking por clicks reales | — | Pendiente |
| — | Dashboard tipo GA | — | No. Esta herramienta es de vocabulario |

## Flujo de una búsqueda

```
INPUT visible (nunca se reescribe)
  → normalizeText          lower + NFD + sin tildes + -_/ → espacio
  → aliases de frase       greedy, más largos primero   pantu bota → pantubota
  → aliases por token      zapatillas → zapatilla
  → resolvedQuery          interno
  → searchProducts()       AND (¿coincide?) + score (¿qué tan relevante?)
  → RESULTADOS
```

`pantubotas` se **ve** `pantubotas` y **busca** `pantubota`.

`commitSearch(raw)` en `nj/components/search/SearchBar.tsx` es el único commit textual → `/?q=`. El debounce (280 ms) solo arma sugerencias. Enter: highlight → `applySuggestion`; si no → `commitSearch`. Tags del autocomplete → `commitSearch`, nunca `/tags/...`. Productos → PDP `/producto/{Articulo}`. Recarga y `?q=` directo **no** cuentan como analytics.

## Archivos

| Capa | Archivo |
|------|---------|
| Normalizar | `nj/lib/search/normalize.ts` |
| Resolver | `nj/lib/search/search-resolver.ts` |
| Diccionario | `nj/lib/search/dictionary.ts`, `dictionary-store.ts`, `hooks/useSearchDictionary.ts` |
| Ranking | `nj/lib/search/match-quality.ts`, `search-score.ts` |
| Motor UI | `nj/lib/utils/search.ts` (`searchProducts`, autocomplete) |
| Commit | `nj/components/search/SearchBar.tsx` |
| Resultados | `nj/components/catalog/CatalogShell.tsx` |
| Analytics | `nj/lib/search/search-analytics.ts`, `search-analytics-pending.ts`, `nj/lib/analytics/ga.ts` |
| Admin | `nj/lib/admin/search-admin.ts`, `search-admin-actions.ts`, `search-admin-validate.ts` |
| Admin UI | `nj/app/admin/search/`, `nj/components/admin-search/` |

## Persistencia (fyl-core)

| Objeto | Rol | Quién lee / escribe |
|--------|-----|---------------------|
| `search_keywords` | Concepto canónico (`canonical` UNIQUE, `kind`, `active`) | Anon SELECT activos. Write `is_admin()` |
| `search_aliases` | Equivalencia (`alias_normalized` UNIQUE global) | Igual. FK keyword, cascade |
| `search_dictionary_public` | Vista `k.active AND a.active` | Anon/authenticated SELECT |
| `search_events` | Inteligencia operativa (sin PII, sin session_id) | Anon INSERT only. SELECT `is_admin()` |
| `search_ignored_terms` | “Ya revisé, no lo propongan como alias” | Solo admin. **No** es vocabulario |

Tras INSERT de keyword, trigger crea alias identidad (`kind` NULL, `alias_normalized = canonical`). En el admin ese alias se oculta / no se edita.

`alias_normalized` no puede ser canonical de **otra** keyword. Un canonical no puede ser alias de otra.

**Opción C (tags):** los nombres de tag se resuelven como texto. La taxonomía `tags` no se limpia en estas fases. Pantubota/Pantubotas en tags es deuda aparte.

### Seed actual

`pantubota`, `zapatilla` (+ zapa/zapas), `borcego`, `ojota`, `chinela`, `deportivo`, `negro`. Ver `327` y `nj/lib/search/seed-data.ts`.

No sembrar todavía: Baja/Bajas, lisa/liso, Corta/Corto, Alta/Altas.

## Normalización

Misma función en TS (`normalizeText`) y SQL (`search_normalize_text()`):

- lowercase, NFD, sin tildes, trim, espacios colapsados
- `-` `_` `/` → espacio → `pantu-bota` = `pantu bota` → alias de frase `pantubota`
- sin stemming general

## Ranking (Fase 3)

Match (AND) separado de score. `bestMatchForToken` + `MatchQuality` (`exact|prefix|substring|fuzzy1|fuzzy2|none`).

- Tokens 1–3 letras: solo exact/prefix (`eco` ⊄ `escolar`, `bota` ⊄ `pantubota`)
- SKU: exact/prefix, `PANT-2` = `PANT2`. **PANT2 es Pantufla, no Pantubota.**
- `DetallesSimilitud` entra al haystack. `SupplierCode` no.
- Stock (`hasAnyStock`) y recencia son **tie-breakers**, no score.
- Categorías reales: Calzado, Ropa, Otros (Lencería/Marroquinería viven en Filtro1).

Escala exacta: `doc/nj/smart-search.md`.

## Analytics (Fase 4)

Híbrido:

| Evento | Dónde |
|--------|--------|
| `search` (término + resolved) | GA4 + (commit en SB) |
| `search_committed` + resolutions + `result_count` | Supabase. GA `search` en el commit |
| `suggestion_selected` | Ambos |
| Autocomplete producto | GA only (`select_item` / `search_autocomplete`) |
| Click resultado | Ambos (`select_item` + `result_click`) |
| Teclas / debounce / `?q=` directo / recarga | Ninguno |

GA4: `G-2JDYZW1KD6` (mismo ID que `scripts/analytics.js`).

Flush: `commitSearch()` → `noteUiSearchCommit()` (sessionStorage, no espera SQL) → CatalogShell inserta `search_committed` **una vez** cuando `!isEnriching && !isSearchExtrasPending`. `result_count` = `searched.length` (antes del filtro de talle).

## Admin (Fase 5)

Detalle de apply, tests y rollback: [[41-SEARCH-ADMIN-FASE5-2026-09-03]].

- Ruta `/admin/search` y `/admin/search/[canonical]`
- Permiso UI `search` + `is_admin()` en DB. Super admin pasa todo.
- Cards 7d/30d, zero-results, % alias, keywords/aliases activos
- Oportunidades: zero-results, candidatos (`normalized = resolved` y `resolutions = []`), pocos resultados (1–2, sección aparte)
- Ignorar candidato → `search_ignored_terms` (restaurable). No es alias.
- Alta de alias: humano elige keyword destino. Conflictos **antes** de guardar. Sin `force`.
- Desactivar > DELETE físico
- Uso 30d: `resolutions` JSON. `zapatillas negras` suma 1 a zapatilla y 1 a negro. No partir `query_resolved`.
- Identity: `resolutions = []` y `query_resolved = canonical` cuenta para esa keyword.
- Tras mutar: `publishSearchDictionaryChange()` (módulo + `localStorage fyl_search_dict_rev` + evento + SWR mutate). No esperar 60s.

## Cache del diccionario

SWR key `fyl-search-dictionary`, `dedupingInterval` 60s, `revalidateOnFocus: false`. Lectura pública de `search_dictionary_public`. Fallback a seed si falla la red.

Invalidación limpia: `bustSearchDictionaryCache()` + `publishSearchDictionaryChange()`.

## Tests

```
npx tsx lib/search/search-resolver.selftest.ts
npx tsx lib/search/search-score.selftest.ts
npx tsx lib/search/search-analytics.selftest.ts
npx tsx lib/admin/search-admin.selftest.ts
```

(desde `nj/`)

## Datos de prueba en live (no borrar sin avisar)

Eventos 2026-09-04:

- `search_committed` `pantubotas` → `pantubota`, count=4, resolution plural
- `search_committed` `xyzabc`, count=0 (candidato / zero-result)
- `suggestion_selected` `pantu`
- `search_committed` `Pantubota`, count=4, identity
- `result_click` Pantubota / 122 / position=3

Alias de test Fase 5: `fyltestalias` → pantubota, **inactivo** (fuera de la vista pública). Tags no tocados.

Antes de producción real: excluir por `query_normalized` o por `created_at` anterior al go-live. No hay environments.

## Lo que no hay que hacer

- No agregar aliases automáticamente
- No partir `query_resolved` para atribuir uso
- No `SELECT * FROM search_events` al browser
- No mezclar `search_ignored_terms` con `search_aliases`
- No limpiar `tags` en esta línea de trabajo
- No inventar FTS ni dashboard tipo Google Analytics
- No usar Google Sheets como fuente

## Enlaces

- `doc/nj/smart-search.md`
- [[41-SEARCH-ADMIN-FASE5-2026-09-03]]
- [[06-FLUJO-CATALOGO]]
- [[08-PERMISOS-Y-ROLES]]
- [[29-ALLOWLIST-ANON-PUBLIC-SURFACE]]
- [[03-MAPA-DE-RPCS]]
- [[02-MAPA-DE-TABLAS]]
