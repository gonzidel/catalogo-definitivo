# BUG-001 — `fylAnalytics.init` rechaza `app_area: "public_catalog"` con error

- **Estado:** abierto
- **Severidad:** bajo
- **Detectado:** 2026-05-12 (durante smoke FASE 1A post-build)
- **Reportado por:** dev
- **Área:** catálogo (analytics)
- **Reproducible:** sí (consistente, cada page load de `catalogo.html`)

## Síntoma

Al cargar `catalogo.html`, la consola emite:

```
[fylAnalytics] init omitido app_area invalido public_catalog
analytics.js?v=m260514:19
```

Severity `error` en Chromium. La página funciona normal, pero `fylAnalytics` queda sin inicializar para el área pública.

## Reproducción

1. Abrir `http://127.0.0.1:5000/catalogo` (o `https://fyl.com.ar/`).
2. Abrir DevTools → Console.
3. Filtrar por "fylAnalytics".

**Dispositivo / entorno:** cualquier, dev y prod. Detectado vía Firebase emulator local + `cursor-ide-browser`.

## Causa raíz (hipótesis)

`catalogo.html` línea 1104-1106 llama:

```js
import { fylAnalytics } from "./scripts/analytics.js?v=m260514";
fylAnalytics.init({ app_area: "public_catalog", page_type: "home", user_role: "guest" });
```

`scripts/analytics.js:19` tiene un guard que valida `app_area` contra un whitelist y rechaza `"public_catalog"`. El valor pasado no está en la lista permitida (probablemente espera `"catalog"`, `"public"` o similar — sin verificar todavía).

Hipótesis: el whitelist de `analytics.js` no se actualizó cuando se introdujo el flag `__FYL_PUBLIC_CATALOG__` y la variante "public_catalog".

## Impacto

- **UX:** ninguno directo.
- **Performance:** ninguno.
- **Conversión / pedidos:** **medible/silencioso**: si `fylAnalytics` no inicializa, GA4/Meta pueden estar perdiendo eventos del catálogo público (consultas WhatsApp, vistas de producto, etc.). Verificar en GA4 Realtime si está reportando eventos del público.
- **Frecuencia estimada:** 100 % de los page loads de `catalogo.html` (versión de producción).

## Archivos afectados

- `scripts/analytics.js:19` (whitelist de `app_area` que rechaza `"public_catalog"`)
- `catalogo.html:1103-1106` (init call que pasa el valor rechazado)

## Workaround

Ninguno aplicado. Los events de GA4 vía gtag siguen disparándose por el `<script>` directo de Google Analytics que se carga en el `<head>`, así que el funnel básico no se rompe.

## Plan de fix

A confirmar — opciones:

1. **Agregar `"public_catalog"` al whitelist en `analytics.js:19`** (cambio mínimo, 1 línea, riesgo bajo).
2. **Cambiar `catalogo.html:1105` a un valor ya aceptado** (ej: `"catalog"` o `"public"`) si hay una convención previa.
3. **Revisar la convención** y unificar `app_area` entre `index.html`, `catalogo.html` y `client/dashboard.html`.

Opción 1 es la más segura mientras no se conozca la convención completa. Confirmar revisando todos los call-sites de `fylAnalytics.init`.

## Riesgos del fix

- Bajo. Cambiar la whitelist solo habilita un valor más; no afecta los demás call-sites.
- Si `public_catalog` se usa para segmentar dashboards/reportes en analytics, hay que asegurarse de que el backend de `fylAnalytics.send()` también lo reconozca.

## Verificación post-fix

- Recargar `catalogo.html`. Console sin error `[fylAnalytics] init omitido`.
- DevTools → Network: si fylAnalytics manda eventos, verificar la request del `page_view`.
- GA4 Realtime / Clarity: confirmar que sigue llegando tráfico desde el flag `public_catalog`.

## Cruces

- [[../Decisiones/DEC-001-Paridad-Catalogo-Index]] — si el fix afecta el call-site, replicar entre entrypoints.
- [[../Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12]] — detectado durante el smoke post-build de esta fase, no se ataca en FASE 1A (es preexistente, severidad bajo).
