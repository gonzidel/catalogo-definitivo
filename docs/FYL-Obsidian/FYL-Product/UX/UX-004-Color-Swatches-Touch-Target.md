# UX-004 — Color swatches con touch target de 20×20px

- **Estado:** abierto
- **Severidad:** alto
- **Detectado:** 2026-05-12 — [[../Performance/2026-05-12-Auditoria-Inicial]]
- **Pantalla:** card de producto (listado catálogo)
- **Métrica afectada:** dead clicks, rage clicks, conversión

## Síntoma

En la card, los puntitos de color son visibles pero **muy pequeños**. La usuaria intenta tappear un color (cambiar variante o entrar al PDP de ese color) y el tap cae fuera. Reintento → rage click.

## Causa raíz (confirmada por código)

`styles.css`:

```css
.card-footer .colors .color-btn {
  width: 20px;
  height: 20px;
  /* ... */
}
```

20×20px. WCAG 2.5.5 (AA) recomienda **44×44 CSS px** mínimo. iOS HIG recomienda 44×44. Android Material recomienda 48×48dp. **El swatch está menos de la mitad del estándar.**

Además están en el footer de la card, zona de "tappers gordos" (pulgar).

## Impacto

- Dead clicks concentrados en la zona de swatches.
- Tap accidental en card vecina por sliding del dedo.
- Pérdida directa de conversión: si la usuaria quería ver ese color y termina en otro producto, abandona.

## Opciones consideradas

| Opción | Pro | Contra |
|---|---|---|
| A — Subir tamaño visual del swatch a ≥28px y `padding` que extienda el hit area a 44×44 | Cumple WCAG sin cambiar visual mucho | Toca grilla de card |
| B — Mantener visual 20px pero extender hit area con `::before` invisible que cubra 44×44 | Cero cambio visual | Hit areas pueden solaparse entre swatches contiguos |
| C — Mostrar menos swatches (3 + "+N") y abrir un picker más grande al tap | Resuelve hit + acomoda muchos colores | Cambio mayor de UX |

## Decisión sugerida

**A** como default, evaluando spacing entre swatches para que no choquen los hit areas. Si los productos suelen tener >5 colores, considerar **C** en segunda iteración.

## Detalle UX (a definir)

- Tamaño visual: 28–32px.
- Hit area: `padding` o `::before` extendiendo a 44×44 CSS px.
- Spacing horizontal entre swatches: ≥8px.
- Estado `:active` táctil (escala + outline).
- Estado seleccionado claramente diferenciado.

## Riesgos

- Cambio de altura del footer de card → puede impactar density del listado. Ajustar grilla.
- Mobile UX Guardian (regla del proyecto) recuerda priorizar thumb-friendly — alineado.

## Verificación

- Clarity heatmap: dispersión de taps en zona swatches ya no cae fuera.
- Lighthouse / accesibilidad: deja de marcar "tap targets too small".
- Repro manual mobile real: tap en swatch del medio del card no abre PDP de otro color.

## Cruces

- Reglas FYL: Mobile-UX, mobile-first
- [[UX-002-Handlers-Diferidos-Header-FAB]] (mismo problema-familia: zonas táctiles ineficientes)
