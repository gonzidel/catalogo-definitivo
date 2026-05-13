# PERF-006 — `styles-desktop.css` render-blocking en mobile

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[2026-05-12-Auditoria-Inicial]]
- **Métrica afectada:** LCP, FCP
- **Área:** `index.html` head

## Síntoma

CSS pesado descargado y parseado en mobile, aunque sus reglas estén dentro de `@media (min-width: 1024px)` que jamás aplica en ese dispositivo.

## Causa raíz (confirmada por código)

`index.html` incluye:

```html
<link rel="stylesheet" href="styles.css?v=m260512">
<link rel="stylesheet" href="styles-desktop.css?v=m260512">
```

Sin atributo `media`, el navegador trata `styles-desktop.css` como render-blocking — descarga y parsea antes del primer paint. Dentro del CSS las reglas se aplican solo con `min-width: 1024px`, pero el coste de descarga/parseo ocurre igual.

## Impacto

- LCP: kilobytes extra de descarga + parseo CSS en el camino crítico.
- TTFB → FCP: tiempo de bloqueo mientras se baja un CSS irrelevante.
- En 3G real puede sumar varios cientos de ms.

## Archivos afectados

- `index.html:14-15`
- `styles-desktop.css` — todo el archivo aplica bajo `min-width: 1024px`

## Workaround

Ninguno.

## Plan de fix (propuesto, no implementado)

1. **Agregar `media` al link:**

   ```html
   <link rel="stylesheet" href="styles-desktop.css?v=m260512" media="(min-width: 1024px)">
   ```

   El navegador descarga el archivo con **prioridad baja y no bloquea el render** en viewports menores.

2. Verificar que ninguna regla de `styles-desktop.css` aplica a < 1024px (grep por reglas sueltas fuera de `@media`).

3. Considerar dividir `styles-desktop.css` en módulos si crece (lazy más fino).

## Riesgos del fix

- Bajos. Si una regla está fuera del `@media`, va a dejar de aplicar en mobile. Validar con grep antes de deploy.

## Verificación post-fix

- Network panel mobile: `styles-desktop.css` aparece con prioridad "Lowest" y no bloquea.
- Lighthouse mobile: "Eliminate render-blocking resources" deja de listarlo.
- Visual idéntico en mobile y desktop tras el cambio.

## Cruces

- [[PERF-001-LCP-Round-Trips-Supabase]] (otro contribuidor a LCP)
- [[../Arquitectura/01-Boot-Sequence-Catalogo]]
