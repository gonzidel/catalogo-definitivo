# 00 — FYL Product (UX · Performance · Continuidad)

Hub de documentación **de producto** para el catálogo FYL. Complementa el vault técnico operativo ([[../00-INDICE]]). Foco: continuidad, decisiones, performance real medida, debugging UX.

**No es académico. No es genérico.** Cada nota debe responder: qué pasa, por qué, cuánto duele, qué archivos toca, qué decidimos.

---

## Convenciones

- Prefijos de ID estables por categoría:
  - `PERF-NNN` — hallazgos de performance
  - `UX-NNN` — fricción / decisiones UX
  - `BUG-NNN` — bugs detectados
  - `DEC-NNN` — decisiones técnicas
  - `UXD-NNN` — decisiones UX
  - `ROAD-NNN` — features en roadmap
  - `CLAR-YYYY-MM-DD-...` — hallazgos puntuales de Clarity
  - `DEP-YYYY-MM-DD-vXX` — deploys
- Estado: `abierto | en-análisis | en-progreso | resuelto | descartado`
- Severidad: `crítico | alto | medio | bajo`
- Fechas siempre `YYYY-MM-DD`.
- Wikilinks `[[ID-...]]` para cruzar notas.

---

## Estructura

```
FYL-Product/
├── 00-INDICE.md              ← este archivo
├── _Templates/                ← plantillas reutilizables
├── UX/                        ← decisiones UX, fricción, copys
├── Performance/               ← LCP, INP, CLS, long tasks, queries lentas
├── Clarity/                   ← lecturas y sesiones reales
├── Bugs/                      ← bugs vivos + postmortems
├── Arquitectura/              ← boot, render, scripts, dependencias reales
├── Decisiones/                ← DEC (técnicas) y UXD (UX)
├── Deploys/                   ← bitácora con cache-bust y deltas
├── Roadmap/                   ← prioridades, fases, hipótesis
└── Metricas/                  ← KPIs, target, tendencia
```

---

## Templates (`_Templates/`)

| Template | Cuándo usarlo |
|---|---|
| [[Template-Bug]] | Problema detectado (no resuelto) |
| [[Template-Postmortem]] | Bug ya resuelto, registrar causa raíz |
| [[Template-Decision-UX]] | Cambio o estándar UX |
| [[Template-Decision-Tecnica]] | Trade-off técnico que merece registrarse |
| [[Template-Auditoria-Performance]] | Sesión de medición de LCP/INP/CLS/long tasks |
| [[Template-Hallazgo-Clarity]] | Patrón en Clarity (dead clicks, rage, scroll, error) |
| [[Template-Deploy]] | Cada deploy a producción |
| [[Template-Roadmap-Feature]] | Feature propuesto |

---

## Notas vivas (estado actual del producto)

### Performance — auditoría 2026-05-12

- [[2026-05-12-Auditoria-Inicial]] — auditoría completa (LCP 10s · INP 1300ms · CLS 0.61)
- Críticos abiertos:
  - [[PERF-001-LCP-Round-Trips-Supabase]]
  - [[PERF-002-MutationObserver-Filtros]]
  - [[PERF-003-Scroll-JS-Layout-Thrashing]]
  - [[PERF-004-SetInterval-Imagenes-Lazy]]
  - [[PERF-005-Apply-Size-Filter-N-Queries]]
  - [[PERF-006-Styles-Desktop-Render-Blocking]]
  - [[PERF-007-Render-Card-A-Card]]

### UX — fricción detectada

- [[UX-001-Overlay-Boot-Bloquea-Interaccion]]
- [[UX-002-Handlers-Diferidos-Header-FAB]]
- [[UX-003-Onboarding-Roba-Tap]]
- [[UX-004-Color-Swatches-Touch-Target]]
- [[UX-005-Cambio-Categoria-Sin-Feedback]] — detectado en smoke 2026-05-12, asociado a [[FASE-1B-Render-Feedback]]

### Clarity — base

- [[2026-05-12-Metricas-Iniciales]] — lectura base de Web Vitals

### Arquitectura

- [[01-Boot-Sequence-Catalogo]] — secuencia real de boot tal como está hoy

### Decisiones

- [[Decisiones/DEC-001-Paridad-Catalogo-Index]] — **regla maestra**: toda mejora UX/perf/render/mobile debe aplicarse a `index.html` Y `catalogo.html`. Solo login/carrito/dashboard/notifications/onboarding pueden diferir.

### Bugs abiertos

- [[Bugs/BUG-001-Analytics-Init-App-Area-Invalido]] — severidad bajo · `fylAnalytics.init` rechaza `app_area: "public_catalog"` en `catalogo.html`, detectado durante smoke FASE 1A (preexistente).

### Roadmap

- [[00-Roadmap-Performance-Q2-2026]] — orden propuesto de fixes derivados de la auditoría
- [[FASE-1A-Estabilizacion-UX-2026-05-12]] — **fase en curso** · estabilización UX · T1+T2+T3+T4 aplicados en ambos entrypoints · build/smoke post-build validados · pendiente push/deploy + medición
- [[FASE-1B-Render-Feedback]] — placeholder · feedback de cambio de categoría (gatillado por hallazgo UX-005 en smoke 1A)

### Deploys / predeploy

- [[Deploys/DEP-2026-05-12-v01-FASE-1A-Predeploy]] — bitácora de lo hecho, reparado y validado antes de push/deploy (`m260514`).

### Métricas

- [[00-KPIs-Catalogo]] — qué medimos, objetivos, fuente

---

## Cruces con el vault técnico

- Backend/operativa: [[../00-INDICE]], [[../01-ARQUITECTURA-GENERAL]], [[../06-FLUJO-CATALOGO]]
- Bugs resueltos legacy: [[../10-BUGS-RESUELTOS]]
- Decisiones técnicas previas: [[../11-DECISIONES-TECNICAS]]

Estas notas (FYL-Product) son **producto**. Las del vault raíz son **backend/operativa**. Hay link cuando se solapa, no se duplica contenido.

---

*Creado: 2026-05-12 — basado en auditoría técnica completa de frontend mobile-first.*
