# FYL /nj — Buscador Inteligente

> Última actualización: 2026-06-08

## Archivos

| Archivo | Rol |
|---------|-----|
| `lib/utils/search.ts` | Lógica de scoring, normalización, levenshtein |
| `components/search/SearchBar.tsx` | UI con autocomplete dropdown |
| `components/catalog/CatalogShell.tsx` | Expone `window.__fylProducts` |

---

## Algoritmo (`lib/utils/search.ts`)

### 1. Normalización NFD

```typescript
function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
```

Convierte "Remera" → "remera", "Ñoño" → "nono", maneja acentos y caracteres especiales.

### 2. Tokenización y AND multi-token

La búsqueda "campera azul" divide en tokens `["campera", "azul"]` y requiere que **todos** aparezcan en el producto (lógica AND).

### 3. Levenshtein (tolerancia a errores)

```typescript
function levenshtein(a: string, b: string): number { ... }
```

- Tolerancia: `Math.floor(token.length / 4)` (1 error cada 4 caracteres)
- "canpera" matchea "campera" (distancia 1, tolerancia 1)
- "sandaliz" matchea "sandalias" (distancia 2, tolerancia 2)

### 4. Scoring

Prioridad de campos:
1. Match exacto en nombre del artículo → `score + 100`
2. Match en nombre → `score + 50`
3. Match en tags → `score + 30`
4. Match en categoría → `score + 20`
5. Match en color → `score + 10`
6. Match fuzzy → `score + 5`

### 5. Autocomplete (`buildSuggestions`)

Devuelve hasta 8 sugerencias en 3 categorías:
- `product`: nombre de artículo
- `tag`: etiqueta específica
- `categoria`: categoría de producto

Cada sugerencia tiene `score` para ordenamiento y `displayText`.

---

## UI (`SearchBar.tsx`)

- Debounce 200ms para generar sugerencias
- Navegación con ↑↓ + Enter + Escape
- Highlight del texto que matchea (negrita)
- Opción fallback: "Buscar 'término' en todo el catálogo"
- Cierra dropdown al hacer clic fuera (useEffect con document.mousedown)
- Lee productos de `window.__fylProducts` (expuesto por `CatalogShell`)

---

## Exposición de productos al cliente

En `CatalogShell.tsx`:

```typescript
useEffect(() => {
  if (baseProducts.length > 0) {
    (window as any).__fylProducts = baseProducts;
  }
}, [baseProducts]);
```

`baseProducts` son todos los productos cargados vía SWR infinite, agrupados y mergeados por artículo.
