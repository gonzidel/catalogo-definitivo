# PERF-010 — CSR puro + ~600 KB JS en ruta crítica de `/catalogo`

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-23 — [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- **Métrica afectada:** LCP, INP
- **Área:** arquitectura boot `catalogo.html`

## Síntoma

Pantalla en blanco / spinner varios segundos; primer producto solo tras ejecutar `main-supabase.js` y dependencias.

## Causa raíz

1. **Sin SSR/SSG:** `#catalogo` vacío en HTML servido (`catalogo.html` L806–809). Hosting estático Firebase.
2. **Waterfall de scripts** al final del body: `config.prod.js` → bundle Supabase 164 KB → 15+ modules incl. banners (`catalogo.html` L1100–1145).
3. **`main-supabase.js` 302 KB** importa red, analytics, commercial-tags, error-state, etc. (L4–35).
4. Fetch Supabase solo tras `DOMContentLoaded` + `inicializarCatalogo` (L6911, L7219).

En WebView Instagram/Facebook el parse/compile domina.

## Impacto LCP

**Directo** — suele ser el mayor tramo del 7.9 s medido.

## Plan de fix (por fases)

### Fase A — sin cambiar arquitectura

- Diferir modules no críticos hasta `fyl-catalog-boot-done`: `curated-banner`, `fyl-originals-banner`, `como-comprar`, `banner.js`.
- `modulepreload` de `supabase-client.js` + chunk mínimo de boot.
- Early fetch inline (ver [[PERF-011-LCP-Preload-Preconnect-Gaps]]).

### Fase B — máximo impacto

- **SSG:** primera card en HTML + hidratación JS.
- **Code-split:** `catalog-boot.js` (<40 KB) vs `catalog-pdp.js` vs admin.

## Verificación

- Lighthouse: reducir “JavaScript execution time” y “Main thread work” pre-LCP.
- Clarity: LCP en sesiones `instagram_iab` / `facebook_iab`.

## Cruces

- [[PERF-001-LCP-Round-Trips-Supabase]]
- [[../Decisiones/DEC-001-Paridad-Catalogo-Index]]
- [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
