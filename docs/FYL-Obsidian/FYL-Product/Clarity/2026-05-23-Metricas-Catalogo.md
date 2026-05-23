# Clarity — métricas catálogo (2026-05-23)

- **Fuente:** Microsoft Clarity, Core Web Vitals
- **URL:** `fylmoda.com.ar/catalogo`
- **Auditoría técnica:** [[../Performance/2026-05-23-Auditoria-LCP-Catalogo-Clarity]]

## Snapshot

| Métrica | Valor | Target | vs 2026-05-12 baseline |
|---|---|---|---|
| LCP | **7.9 s** | < 2.5 s | ~10 s → mejora parcial |
| INP | **500 ms** | < 200 ms | ~1300 ms → mejora parcial |
| CLS | **1.2** | < 0.1 | ~0.61 → **empeoró** (revisar banners/slots) |
| Performance score | **33/100** | — | — |

## Contexto de tráfico

- ~**61%** sesiones: WebView Instagram / Facebook mobile.
- Implicación: parse JS y red en IAB penalizan más que Safari/Chrome standalone.

## Hipótesis LCP element (pendiente confirmar en Clarity)

1. Durante boot: dots del `#catalog-boot-overlay` (overlay `z-index: 10040`).
2. Tras boot: primera `.main-image` Cloudinary (`f_auto`, `w_480`).

Confirmar en Clarity → **LCP element** breakdown por sesión.

## Mapa a notas PERF

| Métrica | Notas |
|---|---|
| LCP | [[../Performance/PERF-010-CSR-JS-Critical-Path-Catalogo]], [[../Performance/PERF-008-DetallesSimilitud-Bridge-Boot]], [[../Performance/PERF-009-Offers-RPC-Before-First-Paint]], [[../Performance/PERF-001-LCP-Round-Trips-Supabase]], [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] |
| INP | [[../Performance/PERF-002-MutationObserver-Filtros]], [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]] |
| CLS | [[../Performance/PERF-003-Scroll-JS-Layout-Thrashing]], slots `home-top-dynamic-slot` (ver auditoría 2026-05-23) |

## Acciones de medición

- [ ] Exportar LCP por browser family (IG IAB vs resto)
- [ ] Correlacionar con `markBootStage` si se habilita tag en Clarity
- [ ] Re-medir 7 días post primer batch de fixes (PERF-008, 009, 012)

## Cruces

- Baseline: [[2026-05-12-Metricas-Iniciales]]
- `doc/catalogo/auditoria-lcp-2026-05-23.md`
- [[../Roadmap/00-Roadmap-Performance-Q2-2026]]
