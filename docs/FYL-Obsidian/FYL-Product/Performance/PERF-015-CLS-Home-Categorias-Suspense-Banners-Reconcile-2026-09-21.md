# PERF-015 — CLS home/categorías: Suspense estable, banners, reconcile — 2026-09-21

## Objetivo

- Home CLS ≤ 0,05
- Categorías CLS ≤ 0,10
- Sin mover cards del primer fold tras el primer paint
- Sin tocar CartFloatingBar / onboarding / reglas comerciales de stock-precio-carrito

## Causas corregidas

1. **Suspense incompleto**: el fallback solo reservaba el grid; el contenido final agregaba tabs, zona de categoría, talles y banners → salto estructural.
2. **Banners home (SWR)**: skeleton → colapso a altura 0 → banner (Curated / Originals / Nuevos / Special).
3. **Enrichment del catálogo**: `initialProducts` se reemplazaba al completar `useEnrichedCatalog`, reordenando/eliminando cards del fold (especialmente ofertas/calzado).

## Cambios

| Área | Archivos |
|------|----------|
| Fallback estructural | `CatalogShellSkeleton.tsx`, `app/page.tsx`, `app/[categoria]/page.tsx`, `app/tags/[...slugs]/page.tsx` |
| Presence SSR banners | `lib/banners/home-banner-presence.ts` + `expectedVisible` en banners |
| Slots CSS | `styles/globals.css` (`.home-banner-slot--*`) |
| Reconcile estable | `lib/catalog/reconcile-display-products.ts` (+ tests), uso en `CatalogShell.tsx` |

### Estrategia de reconciliación

Mientras `isEnriching`: conserva slots ya pintados y **neutraliza** `hasStock`/`hasAnyStock` (undefined → no CTA comprable, no stock positivo).

Cuando el pool enriquecido está listo:

- Si el artículo del slot sigue comprable → actualiza in-place (misma posición).
- Si debe salir (OOS / sin imágenes) → **reemplazo in-place** con el siguiente del pool que **no** esté reservado por otro slot previo.
- Si no hay reemplazo → deja el slot marcado OOS (overlay) para no colapsar la fila.
- Artículos nuevos del pool solo llenan **slots libres al final**.

No se usan keys por índice.

## CLS lab (390×844, Samsung UA, PerformanceObserver sin `hadRecentInput`)

Baseline (pre-fix, `cls-results-valid.json`):

| Ruta | Mediana |
|------|---------|
| `/` | 0,075 |
| `/calzado` | 0,183 |
| `/ropa` | 0,255 |
| `/ofertas` | 0,322 |
| `/tags/Zapatilla` | 0,002 |

Post-fix (`cls-results-post.json`, 5 runs, mediana):

| Ruta | Mediana | Δ |
|------|---------|---|
| `/` | **0,0035** | −0,0715 |
| `/calzado` | **0,0002** | −0,183 |
| `/ropa` | **0,0007** | −0,254 |
| `/ofertas` | **0,0005** | −0,321 |
| `/tags/Zapatilla` | **0,0005** | −0,0015 |

Spot home/calzado: carrito persistido y visita recurrente ≈ mismas medianas. `navPos=fixed`, CSS `/_next/static/css/*` → 200, sin errores de hidratación en harness.

Capturas: `nj/.cls-audit/post/*-early.jpg` / `*-late.jpg`.

## CSS 4xx / `.bottom-nav` static — investigación

**Evidencia del falso positivo de auditoría (~CLS 0,49):** HTML servido contra build viejo → CSS hasheado 404 → sin reglas de `styles.css` (`.bottom-nav { position: fixed }` en raíz `styles.css`) → nav en `static` y reflow masivo.

**Hallazgos:**

- NJ **no** registra service worker propio; `layout.tsx` **desregistra** SWs (vanilla/Firebase scope `/`).
- Vanilla sí tiene `/sw.js` (firebase.json) — riesgo residual si el usuario visita el catálogo legacy en el mismo origen antes de NJ.
- `next.config.ts` no customise Cache-Control; en deploy tipico Vercel: HTML fresco + `/_next/static/*` immutable.
- Lab actual: CSS live 200; hash inexistente → **404**.
- **Riesgo post-deploy:** HTML cacheado (CDN/proxy/SW) apuntando a chunks CSS eliminados tras un nuevo build → misma falla de `bottom-nav` static. Mitigación: no cachear HTML agresivamente; mantener unregister SW; purgar CDN al deploy.

No se aplicó workaround visual (p.ej. inline `position:fixed`) — la causa es asset 404, no CSS incompleto en el bundle válido.

## Risk-fix 2026-09-21 (sync reset + tri-state + cache)

### Reset síncrono
`PaintedGridState { filterKey, products }` + `resolvePreviousForFilter` en render.
Clave distinta → previous `[]` (sin carrera useEffect / falso OOS).

### Presencia tri-state
`present | absent | unknown`. Error SSR → `unknown` (SWR sigue; no oculta banner).
Skeleton SSR solo reserva si `present`.

### Señales públicas cacheadas
`hasActiveOfertas` + `getHomeBannerPresence`: anon sin cookies, `unstable_cache` revalidate 300, tag `catalog-products`, `limit(1)` sin `count: exact`.

### Vitals lab (mediana, 5 runs, 390×844, Samsung UA)

| Ruta | TTFB ms before→after | FCP | LCP | CLS before→after |
|------|----------------------|-----|-----|------------------|
| home | 313→19 | 756→508 | 1032→868 | 0,0035→0,0035 |
| calzado | 280→14 | 816→536 | 1056→744 | 0,0002→0,0002 |
| ropa | 315→14 | 856→512 | 1080→720 | 0,0010→0,0010 |
| ofertas | 292→15 | 768→496 | 1096→780 | 0,0006→0,0006 |

CLS conservado vs objetivo ≈ 0,0035 / 0,0002 / 0,0007 / 0,0005.
TTFB after refleja Data Cache caliente (`unstable_cache` + HTML revalidate) tras el baseline.

Smoke: calzado→ropa residual arts=0, talle=39 falseOos=0, banners home presentes, nav fixed.

## Deuda residual

- Badge conteo categoría (ancho).
- `unknown` + banner real: posible micro-CLS al montar post-SWR (sin reserva permanente).
- `tsc` aún falla en `board-scope.test.ts` (deuda previa, fuera de este cambio).

## Verificación

```bash
cd nj
npx tsx --test lib/catalog/reconcile-display-products.test.ts
npm run build && npx next start -H 127.0.0.1 -p 3018
node .cls-audit/run-cls-post.mjs
```

Sin commit en esta entrega.
