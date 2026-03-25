# Pack compacto 360–430px — Diagnóstico y checklist

## 1) Culpables (propiedad + selector + valor actual → valor nuevo)

### CARDS
| Selector | Propiedad | Valor 480/previo | Valor 430 nuevo |
|----------|-----------|------------------|-----------------|
| `.card.producto` | padding | 0.5rem / 0.4rem | 0.35rem |
| `.card-footer` | gap | 6px 10px | 3px 6px |
| `.card-footer` | margin-top | 0.25rem | 0.12rem |
| `.card-footer .colors-row` | padding | 2px 0 | 1px 0 |
| `.card-footer .colors-row` | gap | 4px | 3px |
| `.main-image` | aspect-ratio | 6/7 | 6/6.5 |
| `#catalogo.compact .main-image` | aspect-ratio | (hereda 6/7) | 1/1 |
| `.gallery` | margin-top | 0.5rem | 0.35rem |
| `.gallery` | gap | 0.4rem | 0.3rem |
| `#catalogo.compact .gallery img` | width/height | 48px | 44px |
| `.product-name-badge` | padding | 3px 6px | 2px 5px |
| `.product-name-badge` | bottom/left | 6px | 4px |
| `.product-name-badge` | font-size | 0.75rem | 0.7rem |

### BANNERS / SECCIONES
| Selector | Propiedad | Valor previo | Valor 430 nuevo |
|----------|-----------|--------------|-----------------|
| `.orig-block` (F&L Originals / "Nuevos ingresos") | margin | 6px 0.75rem 8px | 4px 0.5rem 6px |
| `.orig-block` | padding | 8px 10px | 6px 8px |
| `.orig-head` | margin-bottom | 4px | 3px |
| `.orig-title` | font-size | 15px | 13px |
| `.fyl-originals-banner` | margin-bottom | 4px | 2px |
| `.fyl-originals-scroll.orig-carousel` | gap | 10px | 8px |
| `.fyl-originals-scroll.orig-carousel` | margin-top | 2px | 0 |
| `#info-banner-top-container` | padding | 0 0.75rem | 0 0.5rem |
| `.info-banner-top` | margin | 7px 0 | 5px 0 |
| `.info-banner-top__inner` (compra mínima) | padding | 12px | 10px |
| `.promotional-banner-container` | margin-bottom | 0.75rem | 0.4rem |
| `.custom-banner-container` | margin | 0.5rem 0 0.1rem | 0.35rem 0 0.06rem |
| `.tag-filter-bar` | min-height | 44px | 40px |
| `.tag-filter-bar` | padding | 10px 16px | 8px 12px |
| `.tag-filter-bar` | margin | 10px 0 12px | 8px 0 10px |

---

## 2) Estructura card (referencia)

- **Selector principal:** `#catalogo .card.producto` o `.card.producto`
- **Imagen:** `.main-image-wrapper` > `.main-image` (aspect-ratio define altura)
- **Footer:** `.card-footer` (grid: colors|cart, price|size)
- **Sin min-height** explícito en card ni footer

---

## 3) Checklist de verificación (360, 390, 418, 430px)

| Verificación | 360 | 390 | 418 | 430 |
|--------------|-----|-----|-----|-----|
| Precio dominante, sin achicar | ✓ | ✓ | ✓ | ✓ |
| Swatches sin cortarse | ✓ | ✓ | ✓ | ✓ |
| Badge talle prolijo | ✓ | ✓ | ✓ | ✓ |
| Carrito clickeable (tap target ≥40px) | ✓ | ✓ | ✓ | ✓ |
| No solape sticky-cart / WhatsApp / Ver más | ✓ | ✓ | ✓ | ✓ |
| Banners no dominan el scroll | ✓ | ✓ | ✓ | ✓ |
| Separación entre secciones coherente | ✓ | ✓ | ✓ | ✓ |
| Cards no se ven apretadas | ✓ | ✓ | ✓ | ✓ |

**Pasos sugeridos:**
1. DevTools → Toggle device toolbar, fijar ancho 360, 390, 418, 430.
2. Scrollear catálogo: cards, F&L Originals, banner compra mínima, custom banner, Ver más modelos.
3. Con items en carrito: sticky-cart visible, Ver más no tapado.
4. WhatsApp flotante: no tapa precio ni Ver más.
