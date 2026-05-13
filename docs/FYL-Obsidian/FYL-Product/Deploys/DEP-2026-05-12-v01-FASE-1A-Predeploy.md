# DEP-2026-05-12-v01 — FASE 1A predeploy UX/performance

- **Fecha:** 2026-05-12 23:20 (UTC-3)
- **Versión / cache-bust:** `m260514`
- **Autor:** dev
- **Tipo:** performance / UX / predeploy
- **Áreas tocadas:** catálogo público, entrypoints HTML, boot overlay, handlers críticos, onboarding, documentación
- **Estado:** validado localmente · pendiente push/deploy

## Resumen ejecutivo

FASE 1A quedó validada antes de push/deploy. El objetivo era bajar dead clicks, rage clicks y mejorar percepción de carga mobile-first sin tocar render pesado, Supabase, RPCs ni arquitectura.

Se confirmó una regla nueva del proyecto: `catalogo.html` e `index.html` son dos modos del mismo catálogo. Toda mejora core de UX/performance/render/mobile debe quedar equivalente en ambos entrypoints. Esta regla quedó documentada en [[../Decisiones/DEC-001-Paridad-Catalogo-Index]].

## Cambios incluidos

| Tipo | Resumen | Archivos | Doc |
|---|---|---|---|
| perf | `styles-desktop.css` deja de bloquear render mobile usando `media="(min-width: 1024px)"` | `index.html`, `catalogo.html` | [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]] |
| ux | Overlay de boot mantiene feedback visual pero ya no atrapa taps ni bloquea scroll | `styles.css` | [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]] |
| ux | Handlers visibles críticos se atan antes en `index.html`; `catalogo.html` ya cumplía con `whatsapp.js` como `defer` clásico | `index.html`, `catalogo.html` por construcción | [[../UX/UX-002-Handlers-Diferidos-Header-FAB]] |
| ux | Onboarding de `index.html` pasa de 3s a 6s y aborta si la usuaria interactúa; `catalogo.html` no carga onboarding | `scripts/catalog-onboarding.js` | [[../UX/UX-003-Onboarding-Roba-Tap]] |
| docs | Regla arquitectónica de paridad entre entrypoints | `docs/FYL-Obsidian/FYL-Product/Decisiones/DEC-001-Paridad-Catalogo-Index.md` | [[../Decisiones/DEC-001-Paridad-Catalogo-Index]] |
| bug-doc | Error preexistente de analytics registrado, sin fix en esta fase | `docs/FYL-Obsidian/FYL-Product/Bugs/BUG-001-Analytics-Init-App-Area-Invalido.md` | [[../Bugs/BUG-001-Analytics-Init-App-Area-Invalido]] |

## Qué se reparó

- **Dead clicks por overlay:** el overlay de boot ya no captura la interacción. La usuaria puede tocar header/FAB/categorías aunque todavía vea feedback de carga.
- **Carga desktop en mobile:** `styles-desktop.css` queda condicionado a desktop. En mobile ya no entra como hoja render-blocking.
- **Handlers visibles tarde:** en `index.html`, WhatsApp y notifications salen del bloque +1300ms. En `catalogo.html`, WhatsApp ya cargaba temprano como script `defer`, por eso no se duplicó lógica.
- **Onboarding invasivo:** en `index.html`, el modal ya no aparece a los 3s si la usuaria empezó a tocar, scrollear o navegar. En `catalogo.html`, no existe onboarding, por lo que no puede robar taps.
- **Drift entre entrypoints:** se detectó y documentó que `catalogo.html` es producción actual e `index.html` es evolución futura. La regla de paridad evita que futuras mejoras queden solo en uno.

## Qué NO se tocó

- Render pesado card-a-card.
- Scroll optimizations.
- MutationObserver / filtros.
- Supabase, RPCs, SQL o RLS.
- Lógica de negocio.
- Carrito, pedidos o dashboard.
- Refactor de arquitectura o fusión de HTMLs.

## Build real

Comando ejecutado:

```shell
npm run build
```

Resultado:

```text
✅ OK: config.prod.js generado
✅ OK: config.local.js generado
✅ cache-bust (prod) -> v=m260514 | HTML: 57/69 | sw.js: sí | pwa-install.js: no | JS extra: 5
```

Validaciones:

- `app-version.json` mantiene `"prod": "m260514"`.
- `<meta name="app-version" content="m260514">` queda actualizado en `index.html` y `catalogo.html`.
- `?v=` único restante en `index.html` y `catalogo.html`: `m260514`.
- `SW_BUILD_TAG = "m260514"` en `sw.js`.
- Los cambios FASE 1A permanecen intactos tras el build.

## Smoke local post-build

Entorno:

- Firebase Hosting emulator en `http://127.0.0.1:5000`.
- Ruta validada: `/catalogo` (entrypoint real de producción).
- Viewport mobile: 390x844.

Resultado:

- ✅ `catalogo.html` renderiza completo.
- ✅ T1: body servido contiene `styles-desktop.css?v=m260514` con `media="(min-width: 1024px)"`.
- ✅ T2: overlay desaparece tras boot y no deja la UI congelada.
- ✅ T3: tap en "Calzado" responde, cambia estado activo, renderiza productos y actualiza URL a `?tab=calzado`.
- ✅ T3: FAB WhatsApp visible/clickeable.
- ✅ T4: tras 7s de espera, no aparece onboarding; el texto "Bienvenida" no existe en el DOM de `catalogo.html`.
- ✅ No hubo errores de imports rotos por cache-bust.

## Incidentes detectados

- [[../UX/UX-005-Cambio-Categoria-Sin-Feedback]] — hallazgo UX detectado durante smoke inicial: el cambio de categoría puede sentirse como doble tap por falta de feedback inmediato. No es bug de navegación roto. Queda para [[../Roadmap/FASE-1B-Render-Feedback]].
- [[../Bugs/BUG-001-Analytics-Init-App-Area-Invalido]] — error preexistente: `fylAnalytics.init` rechaza `app_area: "public_catalog"` en `catalogo.html`. No fue introducido por FASE 1A.

## Limitaciones del smoke

- Firebase emulator local no aplicó los redirects 301 (`/` → `/catalogo`, `/index.html` → `/catalogo`) ni algunos headers de `firebase.json`. Para la validación se usó directamente `/catalogo`, que sí sirve `catalogo.html`.
- Falta smoke en producción real después del deploy.
- Falta monitoreo Clarity 7 días para confirmar caída de dead clicks/rage clicks.

## Post-deploy pendiente

- [ ] Push de commits locales.
- [ ] Deploy hosting.
- [ ] Smoke producción mobile real.
- [ ] Confirmar `/catalogo` y `/index.html` redirigen/reescriben como esperado en producción.
- [ ] Confirmar `m260514` servido en HTML/SW.
- [ ] Revisar Clarity 30 minutos post-deploy.
- [ ] Revisar Clarity 7 días: dead clicks primeros 10s, rage clicks, INP, CLS.

## Rollback plan

- T2 CSS overlay: revertir commit `d2c6ab5`.
- T3 handlers críticos: revertir commit `3cb7f70`.
- T4 onboarding: revertir commit `ea494c9`.
- T1 `media=`: quitar `media="(min-width: 1024px)"` de `index.html` y `catalogo.html` si apareciera una regresión desktop/mobile inesperada.

## Cruces

- [[../Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12]]
- [[../Decisiones/DEC-001-Paridad-Catalogo-Index]]
- [[../UX/UX-001-Overlay-Boot-Bloquea-Interaccion]]
- [[../UX/UX-002-Handlers-Diferidos-Header-FAB]]
- [[../UX/UX-003-Onboarding-Roba-Tap]]
- [[../Performance/PERF-006-Styles-Desktop-Render-Blocking]]
