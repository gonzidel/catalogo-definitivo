# 00 — Roadmap performance Q2 2026

Orden propuesto para atacar la auditoría [[../Performance/2026-05-12-Auditoria-Inicial]] y re-auditoría LCP [[../Performance/2026-05-23-Auditoria-LCP-Catalogo-Clarity]] (Clarity 7.9s). **Optimizado por ratio impacto/esfuerzo y bajo riesgo.**

> Regla: no reestructurar arquitectura. Fixes mínimos, reversibles, medibles.

---

## Fase 1 — Quick wins (semana 1)

Cambios chicos, alto impacto, riesgo bajo. Idealmente uno por deploy.


| ID   | Doc                                                                                                     | Estimado   | Impacto principal         |
| ---- | ------------------------------------------------------------------------------------------------------- | ---------- | ------------------------- |
| QW-1 | [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]]                                              | XS (15min) | LCP −300/−600ms en mobile |
| QW-2 | [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]] (eliminar el `setInterval`)                       | S (1–2h)   | INP estable, batería      |
| QW-3 | [[../UX/UX-004-Color-Swatches-Touch-Target]] (CSS only)                                                 | S          | Dead/rage clicks en cards |
| QW-4 | [[../UX/UX-003-Onboarding-Roba-Tap]] (quitar auto-open, mover al header)                                | S          | Rage clicks primer tap    |
| QW-5 | scroll listener → `{ passive: true }` (parte de [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]]) | XS         | Scroll jank inmediato     |


Resultado esperado: LCP −1s, INP −300/−500ms, dead clicks visiblemente menos en Clarity.

## Fase 2 — Boot path (semana 2)


| ID   | Doc                                                                                         | Estimado | Impacto                       |
| ---- | ------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| F2-1 | [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] (overlay no-bloqueante)                   | M        | Mata dead clicks de boot      |
| F2-2 | [[../UX/UX-002-Handlers-Diferidos-Header-FAB]] (delegation + replay)                        | M        | Mata dead clicks en header    |
| F2-3 | [[../Performance/PERF-002-MutationObserver-Filtros]] (eliminar observer, llamada explícita) | M        | INP del primer tap en filtros |
| F2-4 | [[../Performance/PERF-007-Render-Card-A-Card]] (un solo append)                             | S        | LCP + INP durante render      |


Resultado esperado: dead/rage clicks por la mitad o menos.

## Fase 3 — Datos del primer paint (semana 3–4)


| ID   | Doc                                                                                                                | Estimado | Impacto                    |
| ---- | ------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------- |
| F3-1 | [[../Performance/PERF-001-LCP-Round-Trips-Supabase]] (primer batch sin enrich, paralelizar, paginar inicial chica) | L        | LCP −2/−4s                 |
| F3-1b | [[../Performance/PERF-008-DetallesSimilitud-Bridge-Boot]] + [[../Performance/PERF-009-Offers-RPC-Before-First-Paint]] | S     | LCP −0.5/−2s (quick)       |
| F3-1c | [[../Performance/PERF-011-LCP-Preload-Preconnect-Gaps]] + [[../Performance/PERF-012-Config-Prod-Render-Blocking]] | S–M      | LCP −0.3/−1s               |
| F3-1d | [[../Performance/PERF-010-CSR-JS-Critical-Path-Catalogo]] (SSG 1ª card / code-split)                             | L        | LCP −2/−4s                 |
| F3-2 | [[../Performance/PERF-005-Apply-Size-Filter-N-Queries]] (precargar mapa de talles)                                 | M        | INP filtro de talles 5–10× |


Resultado esperado: LCP cerca de target Google, INP de filtros bajo 200ms.

## Fase 4 — Scroll y CLS finos (semana 4+)


| ID   | Doc                                                                                                                   | Estimado | Impacto                        |
| ---- | --------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| F4-1 | [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]] completo (rAF coalesce, histeresis, `will-change` condicional) | M        | CLS, INP durante scroll        |
| F4-2 | Reservar espacios para banners y slots dinámicos                                                                      | S        | CLS                            |
| F4-3 | Unificar `aspect-ratio` de imágenes (revisar 6/7 vs 4/5 vs 1/1)                                                       | M        | CLS en navegación entre vistas |


---

## Métricas de salida por fase

Cada fase debe terminar con:

- Lectura Clarity 7 días post-deploy.
- Lighthouse mobile en `catalogo.html` y `client/dashboard.html`.
- Comparativa LCP / INP / CLS / dead-rage vs baseline ([[../Clarity/2026-05-12-Metricas-Iniciales]]).
- Nota de deploy con métricas: ver [[../Deploys]] y [[_Templates/Template-Deploy]].

## Reglas para el roadmap

- Un fix = un deploy (preferentemente). Permite atribuir métricas.
- Si un fix tarda más de su estimación × 1.5 → parar, repensar, no extender silenciosamente.
- Si un fix no mueve la métrica esperada en 7 días → escalar a [[_Templates/Template-Postmortem]].
- Si un fix rompe algo, **rollback inmediato**, sin discusión. Después se reabre.

## Cruces

- [[../Performance/2026-05-12-Auditoria-Inicial]]
- [[../Performance/2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- [[../Clarity/2026-05-12-Metricas-Iniciales]]
- `doc/catalogo/auditoria-lcp-2026-05-23.md`
- [[../Metricas/00-KPIs-Catalogo]]