# Auditoría LCP — catálogo público (2026-05-23)

**URL:** `fylmoda.com.ar/catalogo`  
**Fuente canónica (Obsidian):** `docs/FYL-Obsidian/FYL-Product/Performance/2026-05-23-Auditoria-LCP-Catalogo-Clarity.md`

## Métricas Clarity (Core Web Vitals)

| Métrica | Valor | Target |
|---|---|---|
| LCP | 7.9 s | < 2.5 s |
| INP | 500 ms | < 200 ms |
| CLS | 1.2 | < 0.1 |
| Performance score | 33/100 | — |

~61% del tráfico: WebView Instagram/Facebook en mobile.

## Conclusión en una línea

El usuario ve spinner/blanco porque el sitio es **CSR puro**: ~600 KB de JS deben ejecutarse antes del fetch a Supabase; un **overlay** tapa el viewport hasta ese render; la **imagen LCP** llega después desde Cloudinary, sin preload en `<head>`.

## Top 5 acciones (orden LCP)

1. **SSG o HTML estático** de la primera card + `link rel=preload` de su imagen.
2. **Quitar overlay en cold load** (skeleton visible) — ver UX-001 en Obsidian.
3. **`DetallesSimilitud` en `CATALOG_PUBLIC_SELECT`** — evita bridge `commercial-tags` en boot (`main-supabase.js` L117–118).
4. **RPC `get_active_offers_with_images` después del primer paint** (`main-supabase.js` L1488–1490).
5. **`preconnect` a Supabase** + `defer` en `/config.prod.js` (`catalogo.html` L1100).

## Archivos de código más relevantes

| Archivo | Rol |
|---|---|
| `catalogo.html` | Entry, overlay, scripts boot |
| `scripts/main-supabase.js` | Fetch, render, overlay timing |
| `scripts/commercial-tags.js` | Bridge si falta columna en SELECT |
| `styles.css` | Overlay, aspect-ratio cards |

## Notas PERF derivadas (Obsidian)

- PERF-008 — Bridge DetallesSimilitud
- PERF-009 — RPC ofertas antes de paint
- PERF-010 — CSR + JS critical path
- PERF-011 — Preload / preconnect LCP
- PERF-012 — config.prod bloqueante

## Evidencia / verificación

Tras fixes: Clarity 7 días, Lighthouse mobile en `catalogo.html`, stages `markBootStage` en `boot-telemetry.js`.
