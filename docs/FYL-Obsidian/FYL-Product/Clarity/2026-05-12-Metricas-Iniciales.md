# CLAR-2026-05-12-Metricas-Iniciales — Lectura base Web Vitals

- **Fecha lectura:** 2026-05-12
- **Ventana de datos:** por confirmar (sugerido: últimos 7 días)
- **Sample size:** por confirmar
- **Filtro aplicado:** todos los dispositivos / sin filtrar país
- **Tipo:** sesión completa + métricas Web Vitals

## Qué vimos

Microsoft Clarity reporta sobre el catálogo público:

| Métrica | Valor | Target Google | Estado |
|---|---|---|---|
| LCP | ~10s | < 2.5s | crítico |
| INP | ~1300ms | < 200ms | crítico |
| CLS | ~0.61 | < 0.1 | crítico |
| Dead clicks | alto (sin cifra exacta) | bajo | crítico |
| Rage clicks | alto (sin cifra exacta) | bajo | crítico |

Las tres Core Web Vitals están en **rojo simultáneamente**, lo que sugiere causa de boot, no de pantalla específica.

## Evidencia

- Reporte resumen Clarity (pendiente snapshot o link permanente).
- Patrón observado: pico de dead/rage en los primeros segundos de sesión.

## Hipótesis de causa

Ver auditoría completa [[../Performance/2026-05-12-Auditoria-Inicial]]. Resumen del mapeo:

- LCP → [[../Performance/PERF-001-LCP-Round-Trips-Supabase]] + [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]] + [[../Performance/PERF-007-Render-Card-A-Card]]
- INP → [[../Performance/PERF-002-MutationObserver-Filtros]] + [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]] + [[../Performance/PERF-004-SetInterval-Imagenes-Lazy]] + [[../Performance/PERF-005-Apply-Size-Filter-N-Queries]]
- CLS → [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]] + banners/slots sin reserva (medio)
- Dead clicks → [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] + [[../UX/UX-002-Handlers-Diferidos-Header-FAB]]
- Rage clicks → [[../UX/UX-003-Onboarding-Roba-Tap]] + [[../UX/UX-004-Color-Swatches-Touch-Target]] + handlers que tardan

## Confirmación técnica

- Confirmado en código fuente (ver auditoría).
- Falta confirmar en sesiones reales:
  - [ ] Heatmap de dead clicks → ¿se concentra en header? ¿en cards?
  - [ ] Heatmap de rage → ¿en swatches? ¿en filtro de talles? ¿en onboarding?
  - [ ] Browser breakdown → ¿Safari iOS empeora INP?
  - [ ] Sesiones con LCP > 15s → ¿qué red? ¿qué país?
  - [ ] LCP element identification → ¿la primera imagen del producto o el banner?

## Impacto estimado

- Probablemente afecta a **toda sesión mobile** en zonas de red lenta (mayoría del target B2B mayorista).
- Conversión: imposible cuantificar sin AB test, pero los benchmarks de e-commerce mobile estiman -10% por cada segundo extra de LCP sobre target.

## Acción

- [x] Documentar hallazgos técnicos: [[../Performance/2026-05-12-Auditoria-Inicial]]
- [x] Crear notas por causa raíz (PERF-001..007, UX-001..004)
- [ ] Confirmar heatmaps Clarity con datos reales (necesita acceso a panel)
- [ ] Priorizar fixes en [[../Roadmap/00-Roadmap-Performance-Q2-2026]]
- [ ] Re-medir Web Vitals 7 días post primeros fixes

## Próximas lecturas Clarity programadas

- Una semana después de cada deploy de performance (`DEP-...`).
- Comparar tendencia, no valor puntual.

## Cruces

- [[../Performance/2026-05-12-Auditoria-Inicial]]
- [[../Metricas/00-KPIs-Catalogo]]
- [[../Roadmap/00-Roadmap-Performance-Q2-2026]]
