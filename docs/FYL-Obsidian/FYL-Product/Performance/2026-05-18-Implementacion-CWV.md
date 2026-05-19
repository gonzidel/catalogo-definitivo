# Implementación CWV — 2026-05-18

## Baseline Clarity (pre-fix)

| Métrica | Valor | Target |
|---------|-------|--------|
| LCP | 7.9s | < 2.5s |
| INP | 700ms | < 200ms |
| CLS | 1.1 | < 0.1 |
| Performance score | ~31 | 65+ |

## Verificación local

1. Abrir `catalogo.html?debug_boot=1` — revisar `window.__FYL_BOOT__.stages` hasta `catalog.first_paint`.
2. Lighthouse mobile (Moto G4, 4G throttled) en `catalogo.html`.
3. DevTools Performance: no debe existir tarea periódica cada 200ms (`detectarImagenesCargando`).
4. Clarity 7 días post-deploy vs baseline.

## Cambios implementados (este deploy)

- PERF-004: eliminado poll 200ms; IntersectionObserver + eventos load/error.
- PERF-007: render por lote (un append por chunk).
- PERF-002: filtros sin MutationObserver; `window.construirMenuFiltros()` explícito.
- CLS: banner destacado en `#home-custom-banner-slot` (no mid-grid).
- CLS: `home-top-dynamic-slot--home` altura reservada en Inicio.
- CSS: `aspect-ratio` 4/5 unificado; sin `will-change` global en `.main-image`.
- PERF-003: `scroll.js` con `--fyl-header-h` y un listener scroll coalescido.
- PERF-001: primer chunk sin `await enrich`; enrich en idle + refresh badges.
- LCP: `<link rel="preload">` para primera imagen above-the-fold.
- Quick actions: ofertas vía `get_active_offers_with_images` (sin `.limit(4000)`).
- PERF-005: filtro de talles usa `productosActualesMap` antes de queries.
- `content-visibility: auto` en cards (Fase 5 ligera).
- `scripts/fyl-scheduler.js` para tareas idle.
- HI-2: boot Home con `fetchCatalogPublicRowsBoot` (120 filas) + full catalog en idle.
- HTML: `#home-custom-banner-slot`, `preconnect` Cloudinary, Poppins `display=optional`.
- PDP hero: `getPdpHeroWidth()` (800 móvil / 1200 desktop).
- UX-002: `scripts/fyl-header-early.js` en `index.html` (FAB WhatsApp al primer paint).
- Sticky cart: `--sticky-cart-h` reservado (48px) al crear el botón.
- SQL documental: `supabase/canonical/224_OPTIONAL_catalog_home_first_screen.sql`.

## Gates por fase

| Fase | Gate |
|------|------|
| 1 | INP p75 < 450ms; CLS p75 < 0.5 |
| 2 | INP p75 < 300ms |
| 3 | LCP p75 < 3.5s |
| 4 | LCP < 2.5s stretch; filtro talles < 200ms |
