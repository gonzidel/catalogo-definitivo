# FASE 1B — Render & feedback de cambio de categoría

- **Fecha apertura:** 2026-05-12 (placeholder · sin implementación todavía)
- **Owner:** dev
- **Estado:** abierto · pendiente de definición de alcance
- **Origen:** smoke test de [[FASE-1A-Estabilizacion-UX-2026-05-12]] + auditoría madre [[../Performance/2026-05-12-Auditoria-Inicial]]

> Fase posterior a 1A. **No se implementa hasta cerrar 1A en producción y medir.** Existe sólo para evitar perder contexto del hallazgo.

---

## Problema central

Cambio de categoría en mobile percibido como "no respondió" → doble tap → render duplicado → más fricción.

Detalle completo y causa raíz en [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]].

## Ámbito propuesto


| Tarea posible                                                             | Cubre                                                                       | Doc origen                                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Pressed/selected state inmediato en categoría (opción A de UX-005)        | feedback inmediato del botón                                                | [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]]                                                  |
| Unificar `showCatalogBootOverlay` dentro de `cambiarCategoria` (opción B) | feedback consistente en todos los flujos (quick-action, banner, mobile-nav) | [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]]                                                  |
| Lock de re-entrada en `cambiarCategoria` (opción D)                       | doble tap deja de duplicar trabajo                                          | [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]]                                                  |
| Skeleton transitorio en `#catalogo` (opción C)                            | pinta algo antes del long task                                              | [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] + [[../Performance/PERF-007-Render-Card-A-Card]] |
| Optimistic URL/state (opción E)                                           | sensación de "ya cambié" antes de renderizar                                | [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]]                                                  |
| Render por lotes con `requestAnimationFrame` / `requestIdleCallback`      | long task se rompe en frames                                                | [[../Performance/PERF-007-Render-Card-A-Card]]                                                  |
| Reemplazar `MutationObserver` de filtros por llamada explícita            | mata el O(N²) durante el render                                             | [[../Performance/PERF-002-MutationObserver-Filtros]]                                            |


> Tareas marcadas son **candidatas**. El alcance real de FASE 1B se decide tras medir el efecto de FASE 1A.

## No-objetivos de esta fase

- No reestructurar `cambiarCategoria`.
- No tocar Supabase / RPCs.
- No optimizar imágenes / Cloudinary.
- No tocar PDP ni carrito.

## Pre-requisitos

- FASE 1A deployada en producción.
- Métricas Clarity de 7 días post-1A registradas en [[../Metricas/00-KPIs-Catalogo]].
- Confirmación de que UX-005 sigue activo tras 1A (T2 podría haberlo aliviado parcialmente al permitir ver el overlay-skeleton más temprano, pero no resuelve el long task del render).

## Plan de medición específico para 1B

Comparar antes / después:

- INP en interacción "tap categoría" (Lighthouse + Clarity).
- Dead clicks en `.quick-action`, `.bottom-nav button`.
- Rage clicks en mismas zonas.
- Tasa de "doble tap" (medible con un contador propio en `cambiarCategoria` — opcional instrumentar).
- Long task más largo del thread durante el cambio.

## Cruces

- [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] — hallazgo origen
- [[../Performance/PERF-002-MutationObserver-Filtros]]
- [[../Performance/PERF-007-Render-Card-A-Card]]
- [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]]
- [[FASE-1A-Estabilizacion-UX-2026-05-12]] — fase anterior
- [[00-Roadmap-Performance-Q2-2026]] — roadmap general

