# UX-003 — Onboarding modal aparece 3s tras boot y roba el primer tap

- **Estado:** abierto
- **Severidad:** alto
- **Detectado:** 2026-05-12 — [[../Performance/2026-05-12-Auditoria-Inicial]]
- **Pantalla:** home (primera visita)
- **Métrica afectada:** dead clicks, rage clicks, conversión del primer tap

## Síntoma

La usuaria entra, espera el boot, ve el catálogo, va a tappear su primera card o filtro… y aparece **el modal de bienvenida** que captura el tap. La usuaria cierra molesta o tappea por error en el botón equivocado.

## Causa raíz (confirmada por código)

`scripts/catalog-onboarding.js`:

```js
const OPEN_DELAY_MS = 3000;
// ...
window.addEventListener('fyl-catalog-boot-done', () => {
  setTimeout(openOnboarding, OPEN_DELAY_MS);
});
```

El modal se abre **3 segundos después de que el boot terminó**, justo en la ventana donde la usuaria recién puede interactuar. Es la peor latencia posible para un modal interruptor.

## Impacto

- Primer tap robado → Clarity lo registra como dead click contra la card / filtro original y como tap "inesperado" contra el botón del modal.
- Bounce rate sospechoso en primera sesión.
- Visualmente: aparece "de la nada" sin que haya habido scroll o interacción.

## Opciones consideradas

| Opción | Pro | Contra |
|---|---|---|
| A — Mostrar el onboarding **antes** del catálogo (al boot, tipo splash con CTA "Empezar") | Cero robo de tap. La usuaria decide cuándo entrar | Suma fricción al LCP percibido |
| B — Mostrarlo solo en respuesta a una acción ("¿Cómo comprar?" en header) | Cero fricción, sigue siendo accesible | Más usuarias no lo verán |
| C — Mostrarlo en la primera vista del PDP, no en home | Está más conectado a la decisión real | Cambia el contexto |
| D — Quitarlo y reemplazar por tooltips contextuales | Más natural | Esfuerzo de diseño mayor |

## Decisión sugerida

**B** como mínimo viable: dejar de auto-abrirlo. El acceso al onboarding queda en un punto fijo del header / dropdown del avatar. Si se requiere conversión proactiva al onboarding, plantear **A** como segunda iteración con métrica clara.

## Detalle UX (a definir)

- Botón "Cómo comprar" persistente en el dropdown del avatar.
- Si se decide auto-abrir, usar `requestIdleCallback` + condición "no hubo interacción del usuario en los últimos 5s" para no robar el tap.

## Riesgos

- Si la conversión a primer pedido caía por desconocimiento del flujo y el onboarding lo cubría, su quita puede reducir conversión. Medir con ventana de 14 días post-fix.

## Verificación

- Clarity: caída de dead clicks en zona "centro de viewport" en los primeros 30s de sesión.
- Tasa de finalización de onboarding vs antes (si se preserva el acceso manual).
- Bounce rate primera sesión.

## Cruces

- [[UX-001-Overlay-Boot-Bloquea-Interaccion]]
- [[UX-002-Handlers-Diferidos-Header-FAB]]
- `scripts/catalog-onboarding.js`
