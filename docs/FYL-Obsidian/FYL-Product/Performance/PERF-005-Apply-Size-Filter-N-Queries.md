# PERF-005 — `applySizeFilter` dispara N queries Supabase secuenciales

- **Estado:** abierto
- **Severidad:** crítico (cuando la usuaria abre el filtro de talles)
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** INP en apertura/aplicación del filtro de talles
- **Área:** filtro de talles

## Síntoma

Al aplicar un filtro de talle, la UI se congela varios segundos. En mobile + 4G real puede llegar a 8–15s. Algunas tap secundarios durante el congelado se pierden ⇒ rage click.

## Causa raíz (confirmada por código)

`scripts/size-filter.js` → `applySizeFilter`:

- `document.querySelectorAll('.card.producto')` — itera todas las cards visibles.
- Por cada card llama `await checkProductHasSizes(...)`, que internamente hace **hasta 3 queries Supabase secuenciales** (variantes, talles disponibles, stock por warehouse).

Con 200 cards visibles → potencialmente 600 round-trips Supabase **en serie**, todos en una sola interacción. El `await` dentro del loop fuerza que no se paralelicen.

## Impacto

- INP medido durante la interacción explota (>1000ms es lo medible, pero el congelado real es de segundos).
- Rage click sobre el botón "aplicar" porque parece no responder.
- Pico de carga en Supabase desproporcionado para la acción.

## Archivos afectados

- `scripts/size-filter.js` — `applySizeFilter`, `checkProductHasSizes`

## Workaround

Limitar manualmente el catálogo a menos productos antes de filtrar (no es una opción real para usuaria).

## Plan de fix (propuesto, no implementado)

1. **Pre-cargar el mapa `producto → talles disponibles`** en el mismo paso de `enrichProductsWithStock` (ya consulta `variant_sizes`). El filtro filtra in-memory sin queries.
2. Si no se puede pre-cargar, **hacer una sola query batch**: `select … where product_id in (…)` con todos los IDs visibles, una vuelta a la base.
3. Si lo anterior es muy invasivo, al menos `Promise.all` para paralelizar (manteniendo el N pero acortando el tiempo total a `max` en vez de `sum`).
4. **Loading state visible**: mientras filtra, deshabilitar el botón y mostrar spinner. Mitiga rage click incluso sin tocar el tiempo.

## Riesgos del fix

- (1) y (2) requieren que el mapa de talles disponibles esté actualizado cuando hay cambios de stock en sesión. Hoy el filtro consulta on-demand y es siempre fresco; el cache puede mostrar talles "fantasma".
- Revisar políticas RLS en `variant_sizes` para query batch.

## Verificación post-fix

- INP en interacción "abrir filtro talles + aplicar" ≤ 200ms.
- Network panel: 0 o 1 request al aplicar.
- Clarity: caída de rage clicks en zona del filtro de talles.

## Cruces

- [[PERF-001-LCP-Round-Trips-Supabase]] (mismo enrich ya consulta `variant_sizes`, se puede aprovechar)
- [[../UX/UX-003-Onboarding-Roba-Tap]] (otra fuente de rage clicks tempranos)
