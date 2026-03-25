# Pack compacto 430px — Verificación y correcciones

## A) ¿Existe #catalogo.compact?

**Sí existe**, pero **no se aplica en mobile**.

- **Dónde:** `scripts/main-supabase.js` línea 4611
- **Control:** botón `#view-toggle` (dentro de `#filter-container`)
- **Condición:** `catEl.classList.toggle("compact")` al hacer clic
- **Mobile:** `#filter-container` está oculto en `@media (max-width: 480px)` → el usuario no puede activar compact en móvil
- **Conclusión:** En ≤430px, `#catalogo` **nunca** tiene la clase `.compact`

## B) Cambios aplicados (ya sin depender de .compact)

| Elemento | Antes | Ahora |
|----------|-------|-------|
| `.main-image` | aspect-ratio 6/6.5; sin object-fit explícito | aspect-ratio 4/4.7, object-fit: cover, object-position: center |
| `#catalogo.compact .main-image` | aspect-ratio 1/1 | **Eliminado** (no aplicaba en mobile) |
| `#catalogo.compact .gallery img` | 44×44px | **Eliminado**; ahora `.gallery img` 44×44px directo |
| `.card-footer .colors-row` | - | overflow: visible |
| `.card-footer .colors` | - | overflow: visible |
| `.card-footer .colors .color-btn` | 16×16px | 15×15px |
| `.card-footer .colors .color-more-chip` | 20×18px, font 9px | 19×19px, font 10.5px, min-width 19px |

## C) 5 checks visuales (360, 390, 418, 430px)

1. **Imagen sin recorte raro** — Fotos 4:5 se ven centradas; no hay cabezas cortadas (object-position: center).
2. **Swatches completos** — Círculos y +N no se recortan ni se cortan.
3. **+N en una sola línea** — El chip "+N" queda en la misma fila que los colores.
4. **Proporción imagen correcta** — La imagen mantiene proporción cercana a 4:5.
5. **Tap targets útiles** — Carrito y swatches siguen siendo fáciles de tocar.

## D) Diff final — bloque @media (max-width: 430px)

Ver `styles.css` líneas 5912–6025. Resumen de reglas relevantes:

- Cards: padding, footer gap/margin
- colors-row y colors: overflow: visible
- color-btn: 15×15px
- color-more-chip: 19×19px, font 10.5px
- main-image: aspect-ratio 4/4.7, object-fit: cover, object-position: center
- gallery img: 44×44px (directo, sin .compact)
- Banners y secciones compactos
