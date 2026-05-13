# 00 — KPIs del catálogo FYL

Métricas que medimos, dónde se ven, qué consideramos verde/rojo, y tendencia.

> Si una métrica no tiene fuente clara y owner, no es KPI. Es opinión.

---

## Web Vitals (mobile, valor de campo)

Fuente: **Microsoft Clarity** + Lighthouse spot-checks mensuales.

| Métrica | Verde | Amarillo | Rojo | Valor actual (2026-05-12) |
|---|---|---|---|---|
| LCP | < 2.5s | 2.5–4s | > 4s | ~10s 🔴 |
| INP | < 200ms | 200–500ms | > 500ms | ~1300ms 🔴 |
| CLS | < 0.1 | 0.1–0.25 | > 0.25 | ~0.61 🔴 |
| Dead clicks / 1k sesiones | sin baseline | — | "muchos" | 🔴 |
| Rage clicks / 1k sesiones | sin baseline | — | "muchos" | 🔴 |

Objetivo Q2 2026: las tres Web Vitals en **verde sostenido por 14 días** en mobile.

---

## Negocio (acopla a producto, no es propietario aún)

Sin fuente automatizada hoy. Acción: definir owner.

| Métrica | Fuente | Owner | Estado |
|---|---|---|---|
| Conversión sesión → pedido | GA4 + Supabase | por definir | sin track formal |
| Bounce rate primera sesión | GA4 | por definir | sin baseline |
| Tasa de abandono PDP → carrito | GA4 + heatmap | por definir | sin baseline |
| Tasa de abandono carrito → checkout | Supabase `carts` vs `orders` | por definir | medible vía SQL |
| Tiempo a primer pedido | Supabase | por definir | medible vía SQL |

---

## Performance técnica

| Métrica | Fuente | Verde | Notas |
|---|---|---|---|
| Errores JS / 1k sesiones | Clarity | < 5 | sin baseline registrado |
| Boot time hasta `fyl-catalog-boot-done` | telemetry inline (`scripts/boot-telemetry.js`) | < 3s p75 | sin alerta automática |
| Tiempo de query crítica `catalog_public_available_view` | Supabase | < 300ms p95 | sin alerta |
| Tiempo de `rpc_checkout_cart` | Supabase | < 800ms p95 | sin alerta |

---

## Calidad operativa

| Métrica | Fuente | Verde |
|---|---|---|
| `vw_stock_audit_*` diffs | SQL (ver [[../../07-RELEASE-GATE-Y-AUDITORIA]]) | 0 |
| `reserved_qty` drift | SQL ([[../../06-RESERVED-QTY-Y-RECONCILE]]) | 0 |
| Variantes visibles sin stock real | SQL | 0 |

---

## Cadencia

- **Diaria informal**: revisar Clarity 1 minuto.
- **Semanal**: lectura Clarity + comparar tendencia vs semana anterior. Si hay anomalía → crear nota [[_Templates/Template-Hallazgo-Clarity]].
- **Post-deploy**: cargar métricas en la nota de deploy ([[_Templates/Template-Deploy]]).
- **Mensual**: snapshot de Web Vitals + KPIs en este documento.

## Histórico (snapshots)

| Fecha | LCP | INP | CLS | Notas |
|---|---|---|---|---|
| 2026-05-12 | ~10s | ~1300ms | ~0.61 | baseline, ver [[../Clarity/2026-05-12-Metricas-Iniciales]] |

## Cruces

- [[../Clarity/2026-05-12-Metricas-Iniciales]]
- [[../Performance/2026-05-12-Auditoria-Inicial]]
- [[../Roadmap/00-Roadmap-Performance-Q2-2026]]
