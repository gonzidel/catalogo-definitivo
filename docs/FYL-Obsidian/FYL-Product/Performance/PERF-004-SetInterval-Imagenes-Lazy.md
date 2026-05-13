# PERF-004 — `setInterval(200ms)` global recorre imágenes lazy

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** INP, consumo de batería, idle time
- **Área:** carga de imágenes del catálogo

## Síntoma

Main thread con trabajo constante incluso cuando la usuaria no interactúa. Profile DevTools muestra "anonymous task" cada 200ms recorriendo el DOM. Interacciones llegan con latencia constante incluso en cards ya pintadas.

## Causa raíz (confirmada por código)

`scripts/main-supabase.js`:

```js
setInterval(detectarImagenesCargando, 200);
```

`detectarImagenesCargando` hace:

- `document.querySelectorAll('img[loading="lazy"]')` o equivalente,
- itera todas las imágenes,
- por cada una llama `getBoundingClientRect()` para detectar visibilidad y forzar carga si entró al viewport.

Esto es un **polifill manual de IntersectionObserver / lazy loading nativo**, ejecutándose cada 200ms para siempre. En un catálogo con 200–500 imágenes, cada tick es:

- N `getBoundingClientRect` → fuerza layout
- N lecturas de `complete` / `naturalWidth`
- posibles writes a `src` / `data-src`

## Impacto

- INP: cada interacción cae potencialmente en un tick → +30–100ms extra.
- Batería mobile: trabajo constante incluso con la app en background tab.
- Scroll jank acumulativo (sobre [[PERF-003-Scroll-JS-Layout-Thrashing]]).

## Archivos afectados

- `scripts/main-supabase.js` — `setInterval(...)` y `detectarImagenesCargando`

## Workaround

Ninguno.

## Plan de fix (propuesto, no implementado)

1. **Eliminar el intervalo.** El navegador ya hace lazy loading nativo (`loading="lazy"`).
2. Si hace falta lógica custom (decode prioritario, fetchpriority, blur-up), usar **`IntersectionObserver`** una sola vez al montar la card. Es la API correcta y delega el cálculo al motor.
3. Si la causa real era manejar fallbacks (imagen rota → placeholder), atarlo al evento `error` de cada `<img>` en lugar de un poll global.

## Riesgos del fix

- Verificar que ningún flow dependa del intervalo (ej. detección de imágenes que cambian dinámicamente). Buscar referencias a `detectarImagenesCargando` antes de eliminar.

## Verificación post-fix

- DevTools Performance idle: 0 tasks recurrentes.
- INP estable independientemente del tiempo en la página.
- Sin regresión en placeholders / fallback de imagen rota.

## Cruces

- [[PERF-003-Scroll-JS-Layout-Thrashing]] (suman trabajo en main thread)
- [[PERF-007-Render-Card-A-Card]] (origen del N grande de imágenes)
