# DEC-001 — Paridad UX/performance entre `catalogo.html` e `index.html`

- **Estado:** aceptada
- **Fecha:** 2026-05-12
- **Área:** frontend / infra
- **Severidad:** alta (afecta a TODO cambio core de catálogo a futuro)

## Contexto

El proyecto tiene **dos HTML entrypoints del catálogo** que coexisten por razones históricas:

| Archivo | Rol | Ruta de servido | Carga |
|---|---|---|---|
| `catalogo.html` | Versión pública actual en producción | `https://fyl.com.ar/` y todas las rutas, vía rewrite Firebase `**` → `/catalogo.html` (ver `firebase.json` lines 87–97) | Header simplificado, sin login, sin notifications, sin onboarding |
| `index.html` | Evolución futura completa (catálogo + login + carrito + dashboard) | No se sirve en producción (redirect 301 `/index.html` → `/catalogo`) | Header completo con `header-notifications`, `cliente-link`, `pwa-install`, `catalog-onboarding`, etc. |

Histórico git (verificado al 2026-05-12):

- `catalogo.html` nació en commit `077d0ea` (Actualizar flujo de stock/admin) y desde entonces solo dos commits lo tocan (`dd4d3e0`, `255e434`).
- `index.html` se modifica en **cada** commit posterior. Es el archivo de trabajo activo, pero **no es lo que sirve producción**.

**Consecuencia natural si no hay regla:** drift silencioso entre los dos. Mejoras UX/perf llegan a `index.html` y nunca a `catalogo.html`, mientras producción sigue mostrando lo viejo.

Caso concreto que disparó esta decisión: FASE 1A se implementó sobre `index.html` (commits `ea494c9`, `d2c6ab5`, `3cb7f70`). Solo T2 (overlay) llegó a producción porque modifica `styles.css` compartido. T1, T3, T4 quedaron sin efecto en `catalogo.html`. Ver `Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12.md`.

## Opciones

| Opción | Pro | Contra | Esfuerzo |
|---|---|---|---|
| A — Mantener dos archivos con paridad obligatoria por convención (regla escrita) | Cambios mínimos, no toca arquitectura, no rompe nada | Disciplina manual, riesgo de drift si no se aplica | Bajo |
| B — Fusionar en un solo entrypoint con flags `__CATALOG_ONLY__` ya existente | Elimina drift por construcción | Refactor grande, riesgo alto en producción, viola "FYL-Architecture: no refactor sin pedido" | Alto |
| C — Generar `catalogo.html` desde `index.html` con un step de build | Auto-sincroniza | Build más complejo, herramienta nueva, viola "FYL-Architecture: no frameworks/abstracciones nuevas" | Medio |

## Decisión

**Opción A: paridad obligatoria por convención.**

Respeta los principios FYL (`FYL-Architecture`):

- No refactoriza la arquitectura sin pedido explícito.
- No introduce frameworks ni build steps nuevos.
- Cambios mínimos, dirigidos.

## Regla arquitectónica (aplicar SIEMPRE)

Toda modificación de **`index.html`** que afecte cualquiera de estos ejes:

- UX
- Performance
- Render
- Mobile / responsive
- Loading / boot
- Interacciones / event handlers
- Feedback visual
- Comportamiento general del catálogo

…**debe** replicarse en **`catalogo.html`** con cambio mínimo equivalente en el mismo PR / commit / WIP.

Y vice versa: si se descubre algo solo en `catalogo.html`, replicar en `index.html`.

### Diferencias **permitidas** (lo que SÍ puede divergir)

`catalogo.html` (público) puede omitir:

- Login / autenticación (`auth-status.js`, login flow).
- Carrito persistente sincronizado con Supabase (cart-persistent vs visitor cart).
- Dashboard del cliente (`/client/*`).
- Notifications/bell (`notifications.js`, `#header-notifications`).
- Onboarding modal (`catalog-onboarding.js`, `#catalog-onboarding`).
- PWA install prompt (`pwa-install.js`).
- Cualquier flujo privado o de back-office.

`index.html` puede tener:

- Componentes adicionales del header (campana, avatar, perfil).
- Scripts adicionales que dependen de sesión.

### Diferencias **no permitidas** (lo que debe estar igual)

Todo lo demás:

- Hash router del catálogo (`#/pdp/X`).
- Filtros, búsqueda, categorías.
- PDP fullscreen, sticky cart, scroll, banners.
- Boot overlay y secuencia de arranque.
- `styles.css`, `styles-desktop.css` (compartidos por archivo).
- Timing de scripts compartidos (`whatsapp.js`, etc.).
- `main-supabase.js`, `catalogo-publico.js`, `quick-actions.js`, `mobile-nav.js`.
- Performance, INP, CLS, dead clicks.

## Procedimiento operativo

Antes de cerrar **cualquier** cambio que toque `index.html` (o `catalogo.html`):

1. ¿Toca alguno de los ejes listados arriba? Si sí, pasa al paso 2.
2. ¿El cambio aplica también al otro entrypoint? Decisión binaria:
   - **Sí, aplica** → replicar el cambio mínimo equivalente. Si requiere agregar/quitar DOM, ver si choca con "diferencias permitidas".
   - **No aplica** (porque el componente no existe en el otro) → documentar **explícitamente** en el commit message y/o en `FASE-NN.md` por qué no aplica y bajo qué construcción queda "cumplido".
3. Mencionar la paridad en el commit message:
   - `[FASE 1A][T1] styles-desktop media-query (index.html + catalogo.html)`
   - O: `[FASE 1A][T4] onboarding less invasive (index.html; no aplica a catalogo.html: no carga catalog-onboarding.js)`.

## Consecuencias

- **Inmediatas:**
  - FASE 1A debe cerrar con T1 portado a `catalogo.html` (T2/T3/T4 ya cumplidos por construcción, ver doc FASE 1A).
  - Cada PR futuro tiene que pasar por checklist mental: "¿toqué el otro entrypoint?".
- **A 3 meses:**
  - Drift mínimo si la regla se respeta.
  - Decisión re-evaluable si el proyecto pivotea a un solo entrypoint (cuando `index.html` reemplace 100% a `catalogo.html`).
- **A 1 año:**
  - Si `index.html` (con login/dashboard/carrito) llega a producción y reemplaza a `catalogo.html`, esta decisión se vuelve obsoleta y se cierra. Hasta entonces, regla vigente.

## Trade-offs aceptados

- **Disciplina manual** en lugar de automación. Asumido porque introducir build steps o templating viola la arquitectura vanilla del proyecto.
- **Duplicación de markup** entre ambos archivos. Asumido como costo del modelo "dos modos del mismo catálogo".

## Trade-offs no aceptables (límites)

Re-evaluar esta decisión si:

- Una mejora UX importante se omite repetidamente en `catalogo.html` y el drift se vuelve sistemático (>3 incidentes).
- `catalogo.html` queda más de 3 versiones atrás de `index.html` en cualquier eje core.
- Se introduce un tercer entrypoint (rompería el modelo binario).

## Métricas / signals para revisar

- Auditorías periódicas: comparar Web Vitals de `catalogo.html` (producción real) vs `index.html` (entorno dev) → no deben divergir más de un 10 % en LCP/INP/CLS si la regla se respeta.
- Cada FASE-NN debe declarar explícitamente "aplicado en: X.html | Y.html" en su checklist.

## Cruces

- `Roadmap/FASE-1A-Estabilizacion-UX-2026-05-12.md` (caso que disparó esta decisión)
- `Arquitectura/01-Boot-Sequence-Catalogo.md` (descripción del boot que ambos entrypoints comparten)
- `firebase.json` lines 42–97 (redirects y rewrites que dirigen tráfico a `catalogo.html`)
- `FYL-Architecture` (rule) — esta DEC respeta el principio "no refactor sin pedido".
