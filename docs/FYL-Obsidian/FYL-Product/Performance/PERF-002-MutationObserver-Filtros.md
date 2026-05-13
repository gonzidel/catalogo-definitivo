# PERF-002 — MutationObserver de filtros reconstruye menú en cada inserción

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** LCP, INP, long tasks durante render
- **Área:** filtros catálogo

## Síntoma

Long tasks largas durante el render inicial del listado. Filtros aparecen, desaparecen y vuelven a aparecer ("parpadeo"). Tap en filtros antes de que termine de cargar = dead click.

## Causa raíz (confirmada por código)

`scripts/filtros.js` arranca con:

```js
new MutationObserver(...).observe(document.querySelector('#catalogo'), {
  childList: true,
  subtree: true,
});
```

Cada vez que se inserta una card (lo que ocurre **una vez por producto**, ver [[PERF-007-Render-Card-A-Card]]) llama a `construirMenuFiltros`, que:

- hace `document.querySelectorAll('.producto')` sobre **todo el catálogo ya renderizado**,
- recorre las cards y arma el set de categorías/colores/tags,
- desmonta y vuelve a montar el menú de filtros entero,
- vuelve a atar listeners (no hay event delegation).

Con N productos ⇒ O(N²) trabajo. El script además se carga **sincrónico** en `index.html`, por lo que bloquea parsing del HTML.

## Impacto

- LCP: el thread está ocupado reconstruyendo filtros en lugar de pintar.
- INP: tap en filtro durante el render no tiene listener atado todavía o el listener viejo ya fue removido.
- CLS: el menú de filtros cambia de altura múltiples veces.

## Archivos afectados

- `scripts/filtros.js` — MutationObserver + `construirMenuFiltros`
- `index.html` — incluye `filtros.js` sin `defer`/`async`

## Workaround

Ninguno desde producto.

## Plan de fix (propuesto, no implementado)

1. **Llamar `construirMenuFiltros` una vez**, cuando termina el render del primer batch (evento `fyl-catalog-boot-done` o callback explícito post-render). No con MutationObserver.
2. Si el listado debe re-filtrar al cambiar de categoría, hacerlo por **API explícita** desde `main-supabase.js` (`filtros.refresh()`), no por observar el DOM.
3. **Event delegation** del menú de filtros sobre un contenedor estable, evitando re-atar handlers en cada reconstrucción.
4. Cargar `filtros.js` con `defer` o moverlo a final del body.

## Riesgos del fix

- Si algún otro flujo depende del observer (búsqueda dinámica, "ofertas"), validar que la llamada explícita cubre todos los casos.
- Cambio en el orden de listeners puede afectar el click inicial en filtros si no se ata antes de mostrar el menú.

## Verificación post-fix

- DevTools Performance: una sola llamada a `construirMenuFiltros` en cold load.
- INP en interacción "tappear filtro al primer paint" ≤ 200ms.
- Sin parpadeo visual del menú.

## Cruces

- [[PERF-007-Render-Card-A-Card]] (causa que dispara el observer)
- [[../UX/UX-002-Handlers-Diferidos-Header-FAB]] (patrón similar de listener atado tarde)
