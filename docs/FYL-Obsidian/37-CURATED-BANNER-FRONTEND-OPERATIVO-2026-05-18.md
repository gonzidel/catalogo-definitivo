# 37 — Curated Banner — Frontend operativo (validado)

**Estado:** ✅ **Funciona en index** (staging/local, 2026-05-18)  
**Relacionado:** [[24-CURATED-BANNER-V1-SCHEMA]], admin `curated-banner-admin.js`, `scripts/curated-banner.js`

---

## Resumen

El **banner curado (por variante)** se muestra en home cuando:

1. **Flag de runtime:** `window.FYL_CURATED_BANNER_V1 === true`
2. **Admin:** banner curado con toggle **Habilitado**, ítems (`product_variant_id`) y `tag_value = '__curated__'`
3. **Vista:** Inicio (`#/`), sin búsqueda/filtros/colección FYL; catálogo con al menos 4 cards (slot inline)

El **banner personalizado (legacy por tags)** es un pipeline **separado**: no corre a la vez que el curado.

---

## Activación en catálogo

| Método | Acción |
|--------|--------|
| **Por defecto (prod)** | `FYL_CURATED_BANNER_V1 === true` en `index.html` / `catalogo.html` (banner home con `tag_value = '__curated__'`) |
| Forzar ON | `?curated_banner=1` → persiste `localStorage` `"1"` |
| Opt-out legacy | `?curated_banner=0` o `localStorage.setItem('FYL_CURATED_BANNER_V1', '0')` |
| Comprobar | `window.FYL_CURATED_BANNER_V1 === true` |

Admin: banner **Habilitado** + ítems + `tag_value = '__curated__'`. Sin ítems visibles el carrusel no pinta (no es fallo del flag).

---

## Separación física de scripts (Fase 3 cerrada)

| Flag | `index.html` / `catalogo.html` |
|------|--------------------------------|
| `FYL_CURATED_BANNER_V1 === true` | **No** se descarga `custom-banner.js` |
| Flag ausente / false | `fyl-legacy-banner-loader.js` importa `custom-banner.js` |
| Siempre | `curated-banner.js` |

Archivos:

- `scripts/fyl-legacy-banner-loader.js` — import condicional legacy
- `scripts/curated-banner.js` — config por `variant_id`, carrusel, `#/banner/{slug}`
- `scripts/main-supabase.js` — `fylLoadHomeProductBanner()` → solo `loadAndShowCuratedBanner` si flag ON

Bootstrap inline (antes de modules): URL `?curated_banner=1` + `localStorage.FYL_CURATED_BANNER_V1 === '1'`.

---

## UX en home (igual shell que legacy)

1. Tras la **4.ª card** del grid: clon `#custom-banner-container` → `#custom-banner-container-inline`
2. `loadAndShowCuratedBanner()` pinta cards desde `catalog_public_*` por `variant_id`
3. Título: `title` del banner (admin)
4. **Ver todo** → `#/banner/{slug}` — grilla con **cards normales** del catálogo (`renderizarProductosPagina`: colores, talles, precio mayorista, carrito)
5. Click card → PDP (misma interacción que index)

---

## Query config (sin 406)

`loadCuratedBannerConfig()` (home):

```javascript
.eq("enabled", true)
.eq("tag_value", "__curated__")
.order("sort_order", { ascending: true })
.limit(1)
.maybeSingle()
```

- 0 banners → `null`, sin crash
- Varios enabled → menor `sort_order`

Legacy `loadCustomBannerConfig()` (solo si carga `custom-banner.js`):

- `.neq("tag_value", "__curated__")` + `.maybeSingle()` (evita 406 con 0 filas legacy)

---

## Admin Quick Actions

| Sección | Sistema | Runtime |
|---------|---------|---------|
| **Banner Personalizado de Productos** | Tags (`tag_value`) | `custom-banner.js` |
| **Banner curado (por variante)** | Variantes + slug | `curated-banner.js` |

Pie admin: *"Banner legacy por tags (no editado acá): …"* — otro registro legacy.

---

## Diagnóstico rápido

### Consola — modo curado OK

- `typeof loadAndShowCuratedBanner === "function"`
- `typeof loadAndShowCustomBanner === "undefined"`
- Network: **sin** `custom-banner.js`
- Opcional: `await fylAuditCuratedBanner()` con `?debug=banner`

### Consola — sigue en legacy (problema)

- `[FYL Banner Debug] loadAndShowCustomBanner inicio`
- `GET .../custom_product_banners` + 406 / "Sin config habilitada"
- **Causa:** flag OFF o solo banner curado en DB sin banner legacy enabled

---

## Verificación automatizada

```bash
node scripts/smoke-curated-banner-legacy-guard.mjs   # separación física HTML/JS
node scripts/smoke-curated-banner-home.mjs           # API staging anon
```

Evidencia: `scripts/outputs/phase3-curated-banner-home-evidence.json`

---

## Historial de fixes (2026-05-17 → 2026-05-18)

| Tema | Fix |
|------|-----|
| Legacy + curated a la vez | Guards → **loader condicional** (sin stubs) |
| 406 config curated | `.single()` → `.limit(1).maybeSingle()` |
| 406 config legacy (0 filas) | `.maybeSingle()` + excluir `__curated__` |
| Banner no visible | Flag + defer inline + `tag_filter` admin |
| Logs legacy con flag ON | No cargar `custom-banner.js` |

---

## Pendiente / rollout

- [ ] Prod: apply migraciones 220–222 + flag rollout acordado
- [ ] Opcional: flag ON por defecto en staging vía config
- [ ] Eliminar código legacy cuando curated sea 100% prod
