# UX-002 — Handlers de header, FAB y notificaciones se atan tarde

- **Estado:** abierto
- **Severidad:** crítico
- **Detectado:** 2026-05-12 — [[../Performance/2026-05-12-Auditoria-Inicial]]
- **Pantalla:** header global + FAB WhatsApp
- **Métrica afectada:** dead clicks, rage clicks

## Síntoma

Elementos **visibles desde el primer paint** (`.cliente-link` del avatar, `#wa-toggle` FAB de WhatsApp, `#header-notifications` campana) no responden al tap durante varios segundos. La usuaria tappea repetido → rage click registrado en Clarity.

## Causa raíz (confirmada por código)

Los markup están en `index.html` y se ven al instante, pero los listeners reales están en scripts **diferidos**:

- `scripts/whatsapp.js` → ata el click en `#wa-toggle` solo cuando carga (defer / on first interaction).
- Dropdown del avatar (`.cliente-link`) tiene `onclick="return false;"` inline + listener real diferido.
- Notificaciones (`#header-notifications`) depende de un script de cliente cargado tarde.

Además `.cliente-link` tiene `href="#" onclick="return false;"` ⇒ comportamiento visualmente "interactivo" pero sin acción real hasta que el listener correcto entre.

## Impacto

- Dead clicks concentrados en el header, exactamente donde el ojo cae primero en mobile.
- Rage clicks porque la usuaria reintenta.
- La sensación general es de "la app no responde", aunque el catálogo ya esté pintado.

## Archivos afectados

- `index.html` — markup del header, FAB, notificaciones
- `scripts/whatsapp.js` — handler `#wa-toggle`
- `scripts/auth-status.js` / dropdown del avatar — handler `.cliente-link`
- script de notificaciones — handler `#header-notifications`

## Opciones consideradas

| Opción | Pro | Contra |
|---|---|---|
| A — Atar handlers críticos en un único script no-diferido y mínimo (event delegation desde `<body>`) | Cero dead clicks por listener faltante | Hay que reescribir la atadura |
| B — Disabled visual de los elementos hasta que su script cargue | Honesto con el estado | Visualmente peor |
| C — Cargar los scripts más temprano (sin diferir tanto) | Cambio mínimo | Pesa el LCP |

## Decisión sugerida

**A** + delegation: un mini-loader inline en `index.html` que delega clicks de `#wa-toggle`, `.cliente-link`, `#header-notifications` a un router que:

- Si el script real está cargado → ejecuta normal.
- Si no → encola el evento, fuerza la carga, y lo replay cuando el handler esté listo.

Esto da feedback inmediato (highlight, ripple) y la acción se ejecuta apenas el script termina.

## Detalle UX (a definir)

- Feedback táctil siempre presente: `:active` state en CSS, mínimo `transform: scale(0.97)` o color.
- Si la acción no puede ejecutarse en <100ms, mostrar spinner local.
- Eliminar `href="#" onclick="return false;"` — usar `<button>` o `role="button"` real.

## Riesgos

- Replay de evento puede disparar dos veces si el script atado no es idempotente. Marcar evento como "ya despachado".

## Verificación

- Clarity 7 días: caída de dead clicks específicamente en selectores `.cliente-link`, `#wa-toggle`, `#header-notifications`.
- Repro manual: tap en estos 3 botones a los 500ms post-LCP debe ejecutar la acción.

## Cruces

- [[UX-001-Overlay-Boot-Bloquea-Interaccion]]
- [[../Arquitectura/01-Boot-Sequence-Catalogo]]
