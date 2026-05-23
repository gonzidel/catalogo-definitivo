# PERF-011 — Sin preload LCP ni preconnect Supabase

- **Estado:** parcial — preconnect Supabase en head (2026-05-23); preload imagen LCP pendiente
- **Severidad:** alto
- **Detectado:** 2026-05-23 — [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- **Métrica afectada:** LCP
- **Área:** `<head>` de `catalogo.html`

## Síntoma

La primera imagen de producto empieza a descargarse solo después de render JS; no hay hint temprano al navegador.

## Causa raíz

- `catalogo.html` tiene `preconnect` a fonts y Cloudinary (L9–11) pero **no** a `https://dtfznewwvsadkorxwzft.supabase.co` (`scripts/config.js` L47).
- No hay `<link rel="preload" as="image">` ni `modulepreload` en head.
- `fylPreloadLcpImage` (`main-supabase.js` L1820–1832) corre en `fylAfterCatalogChunkRendered` — demasiado tarde para competir en LCP.

## Impacto LCP

**Directo** en la fase de descarga de imagen (+300–1000 ms en redes lentas).

## Plan de fix

### Preconnect (bajo riesgo)

```html
<link rel="preconnect" href="https://dtfznewwvsadkorxwzft.supabase.co" crossorigin>
<link rel="dns-prefetch" href="https://dtfznewwvsadkorxwzft.supabase.co">
```

### Preload imagen (requiere URL estable)

Con SSG o endpoint build-time:

```html
<link rel="preload" as="image"
      href="https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,c_scale,w_480/..."
      fetchpriority="high">
```

### Early fetch catálogo (opcional)

Script inline que lance `fetch` REST antes de modules; consumir en `main-supabase` si `window.__FYL_CATALOG_BOOT__` existe.

## Verificación

Waterfall: conexión Supabase y descarga imagen empiezan antes del fin de `main-supabase.js`.

## Cruces

- [[PERF-010-CSR-JS-Critical-Path-Catalogo]]
- [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
