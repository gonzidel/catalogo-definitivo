# PERF-012 — `/config.prod.js` sin `defer` bloquea el parser

- **Estado:** implementado (2026-05-23) — `catalogo.html` + `index.html`
- **Severidad:** medio
- **Detectado:** 2026-05-23 — [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- **Métrica afectada:** LCP (secundario)
- **Área:** `catalogo.html` L1100

## Síntoma

Retraso en el inicio del download/parse de scripts defer y modules que vienen después en el body.

## Causa raíz

```html
<script src="/config.prod.js"></script>
```

Sin `defer` ni `async`. El navegador debe ejecutar el script antes de continuar parseando el resto del body.

## Impacto LCP

**Secundario** (~200–500 ms en mobile). No explica solo los 7.9 s, pero suma en la cadena.

## Plan de fix

```html
<script defer src="/config.prod.js"></script>
```

Asegurar que `window.SUPABASE_URL` / `__FYL_CONFIG_PROD_LOADED__` existan antes de que corran los modules: los `type="module"` ya son defer y corren en orden documento tras HTML parseado; validar en Safari iOS WebView.

Alternativa: inline mínimo de credenciales en HTML generado en build (menos round-trip).

## Verificación

HTML parse hasta primer module empieza antes en Performance panel.

## Cruces

- [[PERF-010-CSR-JS-Critical-Path-Catalogo]]
- `scripts/config.js` — lectura de `window` post config.prod
