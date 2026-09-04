# FYL /nj — Buscador

> Última actualización: 2026-09-03 (Fase 5 — admin de vocabulario)

## Flujo

```
INPUT (visible, sin mutar)
  ↓
normalizeText          lower + NFD + sin tildes + guiones→espacio
  ↓
aliases de frase       greedy, más largos primero  (pantu bota → pantubota)
  ↓
aliases por token      zapatillas → zapatilla
  ↓
resolvedQuery          interno
  ↓
searchProducts()       AND (¿coincide?) + best-match score (¿qué tan relevante?)
  ↓
RESULTADOS
```

El input **nunca** se reescribe. `pantubotas` se ve `pantubotas` y busca `pantubota`.

---

## Archivos

| Archivo | Rol |
|---------|-----|
| `lib/search/normalize.ts` | `normalizeText` unificado |
| `lib/search/search-resolver.ts` | `resolveSearchQuery` |
| `lib/search/dictionary.ts` + `dictionary-store.ts` | Diccionario en memoria + fetch único |
| `hooks/useSearchDictionary.ts` | SWR, 60s, una consulta a `search_dictionary_public` |
| `lib/search/match-quality.ts` | `exact \| prefix \| substring \| fuzzy1 \| fuzzy2` |
| `lib/search/search-score.ts` | `scoreProductSearch` + ranking explicable |
| `lib/utils/search.ts` | `searchProducts` + autocomplete |
| `lib/utils/catalog.ts` | `DetallesSimilitud` en SELECT + merge al agrupar |
| `components/search/SearchBar.tsx` | Fase 1 + diccionario en sugerencias |
| `components/catalog/CatalogShell.tsx` | `searchProducts(..., dictionary)` |

---

## Persistencia

Tablas `search_keywords` y `search_aliases` (migración `327_search_keywords_aliases.sql`).

Los **tags no se tocan**. Opción C: los nombres de tag se resuelven como alias por texto. Mismo nombre bajo distintos padres no rompe el admin; la búsqueda es por vocabulario, no por `tag.id`.

`alias_normalized` es único. Un alias no puede apuntar a dos keywords. Un canonical no puede chocar con el alias de otra keyword.

---

## Normalización

- lowercase, NFD, sin tildes, trim, espacios colapsados
- `-` `_` `/` → espacio → `pantu-bota` = `pantu bota` → alias de frase `pantubota`
- sin stemming general

---

## Confirmación (Fase 1, intacta)

`commitSearch` sigue siendo el único commit textual. El debounce solo arma sugerencias.

---

## Autocomplete

Hasta 7 sugerencias. Tags se agrupan por keyword canónica. Label = `display_label` (Pantubota, no Pantubotas). Productos siguen yendo al PDP.

---

## Motor (`searchProducts`)

Recibe `resolvedQuery` (tokens canónicos). Dos decisiones separadas:

1. **Match (AND):** cada token de contenido debe tener un `MatchQuality !== none`.
2. **Score:** `bestMatchForToken` (un campo por token) + bonuses de frase. Sin inflación multi-campo.

`DetallesSimilitud` es searchable. **No** entra `SupplierCode`.

Stock (`hasAnyStock`) y recencia (`FechaPublicacion` / `FechaIngreso`) son **tie-breakers**, no score.

### Escala (exacto)

| Campo | Exact | Prefix | Substring | Fuzzy1 | Fuzzy2 |
|---|---:|---:|---:|---:|---:|
| Articulo | 2000 | 1440 | — | — | — |
| Nombre (`Descripcion` corta) | 1600 | 1152 | 608 | 224 | 112 |
| Filtro1 | 1000 | 720 | 380 | 140 | 70 |
| Filtro2 | 720 | 518 | 274 | 101 | 50 |
| Filtro3 | 620 | 446 | 236 | 87 | 43 |
| Color | 560 | 403 | 213 | 78 | 39 |
| Categoría | 420 | 302 | 160 | 59 | 29 |
| Details | 360 | 259 | 137 | 50 | 25 |
| Descripción larga | 200 | 144 | 76 | 28 | 14 |

SKU: solo exact/prefix, case-insensitive, `PANT-2` = `PANT2`.  
Tokens de 1–3 letras: solo exact/prefix (`eco` ⊄ `escolar`, `bota` ⊄ `pantubota`).

```
npx tsx lib/search/search-score.selftest.ts
```

```ts
import { scoreProductSearch } from "@/lib/utils/search";
scoreProductSearch(product, resolveSearchQuery("zapatilla negra", dict));
```

---

## Seed

Ver `327_search_keywords_aliases.sql` y `lib/search/seed-data.ts`.

## Debug

```
npx tsx lib/search/search-resolver.selftest.ts
npx tsx lib/search/search-score.selftest.ts
```

```ts
import { resolveSearchQuery } from "@/lib/search/search-resolver";
import { scoreProductSearch } from "@/lib/utils/search";
const resolved = resolveSearchQuery("zapatillas negras", dict);
scoreProductSearch(product, resolved, undefined, dict);
```

No hay `console.log` en el cliente.

---

## Analytics (Fase 4)

Híbrido: **GA4** (`G-2JDYZW1KD6`, mismo ID que `scripts/analytics.js`) para comportamiento; **`search_events`** para aliases / zero-results.

`commitSearch()` marca un pending en sessionStorage y dispara `search` en GA. **No espera SQL.** CatalogShell inserta `search_committed` una sola vez cuando `!isEnriching && !isSearchExtrasPending`. Recarga y `?q=` directo **no** cuentan.

```
npx tsx lib/search/search-analytics.selftest.ts
```

---

## Admin de vocabulario (Fase 5)

Ruta: `/nj/admin/search`. Solo `is_admin()` / permiso `search`. Analytics sugiere; el admin decide; el buscador ejecuta. **No hay alta automática de aliases.**

- Capa: `nj/lib/admin/search-admin.ts` + `search-admin-actions.ts`
- UI: `nj/app/admin/search` + `nj/components/admin-search/`
- Términos descartados (restaurables): `search_ignored_terms`
- Agregaciones en PostgreSQL: `search_admin_dashboard_stats`, `search_admin_grouped_queries`, `search_admin_resolution_usage`, `search_admin_resolved_usage`
- Uso por keyword: `resolutions` JSON + identity (`resolutions=[]` y `query_resolved = canonical`). No se parte `query_resolved`.
- Tras guardar: `publishSearchDictionaryChange()` bustea el cache de módulo + SWR (no espera 60s)
- Desactivar > borrar. Tags no se tocan.

```
npx tsx lib/admin/search-admin.selftest.ts
```

Eventos de prueba ya en live (no borrar sin avisar): `xyzabc`, commits de `pantubotas` / `Pantubota` / `pantu` de desarrollo (2026-09-04). Se pueden excluir por `query_normalized` o por `created_at` anterior al go-live. No hay environments separados.

Alias de prueba de Fase 5: `fyltestalias` → pantubota, **inactivo**. No entra en `search_dictionary_public`. No toca tags.

## Deuda

- Limpieza de tags duplicados (Pantubota/Pantubotas, etc.): fase aparte
- Ranking por clicks reales
- Dashboard tipo GA: no. Esta herramienta es de vocabulario
- Duplicados Baja/Bajas, lisa/liso, Corta/Corto, Alta/Altas: no sembrar hasta revisión
- `hasAnyStock` solo existe tras el enriquecimiento; si falta, no se inventa stock
- Categorías reales: Calzado, Ropa, Otros (Lenceria/Marroquineria viven en Filtro1)
