# PERF-007 — Render card-a-card con `insertAdjacentHTML` en loop

- **Estado:** abierto
- **Severidad:** alto
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** LCP, INP, long tasks durante render
- **Área:** render del listado de productos

## Síntoma

Render del listado se siente "trabado": las cards aparecen una a una con micro-pausas. Durante el render, cualquier interacción (scroll, tap) llega con delay.

## Causa raíz (confirmada por código)

`scripts/main-supabase.js` → `renderizarProductosPagina`:

```js
productos.forEach(p => {
  container.insertAdjacentHTML('beforeend', productoHTML);
});
```

Cada `insertAdjacentHTML`:

- parsea HTML y crea nodos,
- **inserta en el DOM live** → dispara reflow,
- dispara el `MutationObserver` de [[PERF-002-MutationObserver-Filtros]] **una vez por card**,
- aumenta el N de [[PERF-004-SetInterval-Imagenes-Lazy]] mientras dura.

El coste real **no es sólo del insert**, sino del trabajo encadenado que cada insert provoca.

## Impacto

- LCP: el primer producto pintado es relativamente rápido, pero el "above the fold" completo tarda más por la cadena.
- INP durante render: cualquier tap mientras el listado se está poblando entra en una long task.
- Acopla a [[PERF-002]] y [[PERF-004]] — bajar el N de inserts mitiga los tres.

## Archivos afectados

- `scripts/main-supabase.js` — `renderizarProductosPagina`

## Workaround

Ninguno.

## Plan de fix (propuesto, no implementado)

1. **Construir el HTML en una sola string** y hacer un solo `insertAdjacentHTML` por lote.
2. O usar `DocumentFragment`:

   ```js
   const tpl = document.createElement('template');
   tpl.innerHTML = productos.map(toHTML).join('');
   container.appendChild(tpl.content);
   ```

   Un solo append → un solo reflow → una sola notificación al observer (que igual debería eliminarse en [[PERF-002]]).

3. Si se mantiene paginación, **renderizar lotes pequeños** (ej. 20 productos) entre `requestIdleCallback` o `rAF` para no monopolizar el thread.

## Riesgos del fix

- Validar que ningún listener depende de recibir un nodo por vez (no se detectó en el código).

## Verificación post-fix

- DevTools Performance: 1 long task por render de lote en vez de N.
- INP estable durante el render del listado.

## Cruces

- [[PERF-002-MutationObserver-Filtros]] (consumidor principal de los inserts)
- [[PERF-004-SetInterval-Imagenes-Lazy]] (consumidor secundario)
