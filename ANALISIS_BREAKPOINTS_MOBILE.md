# Análisis breakpoints mobile (360–430px)

## A) Breakpoints activos en styles.css

### Media queries que afectan mobile (orden de aparición):

| Línea | Media query | Elementos afectados |
|-------|-------------|-------------------|
| 82 | max-width: 480px | .menu-desktop |
| 97 | max-width: 480px | #filter-container |
| 186 | max-width: 480px | #catalogo grid 2 cols |
| **280** | **min-width: 415px** | **Bordes cards (#catalogo .card)** |
| 294 | max-width: 480px | #catalogo .card.producto bordes |
| 306 | max-width: 480px | .card.producto padding |
| 388 | max-width: 480px | .main-image, .product-name-badge |
| 926 | max-width: 480px | .load-more-wrap, .btn-ver-mas-modelos |
| 1007 | max-width: 480px | .infinite-scroll-loader |
| 1047 | max-width: 480px | (otras reglas) |
| 1171 | max-width: 480px | .card-footer .card-price .price → 20px |
| **1180** | **min-width: 415px** | **.card-footer .card-price .price → 1.75rem (~28px)** ← CULPABLE |
| 1277 | max-width: 768px | #wa-popup, #wa-menu bottom/z-index |
| 1385 | min-width: 769px | .sticky-cart display:none |
| 1493 | max-width: 480px | (varios) |
| 2432 | max-width: 479px | (específico) |
| 3500 | max-width: 480px | Estilos mobile compacto (body, colors, cards, price 18.975px) |
| 3578 | max-width: 480px | Header mobile, catalogo |
| 4478 | max-width: 480px | .bottom-nav, html, body |
| 4565 | max-width: 480px | (otros) |
| 5565 | max-width: 480px | .btn-ver-mas-modelos |
| 5755 | max-width: 480px | .custom-banner-*, .bottom-nav |
| 5783 | max-width: 768px | .bottom-nav height 62px, padding |

### ¿Qué cambia al pasar de 414px a 415/418px?

- A 414px: aplica `max-width: 480px` → precio cards = 20px.
- A 415px+: aplica `min-width: 415px` → precio cards = **1.75rem (~28px)**.
- La regla de `min-width: 415px` está **después** en el cascade, por eso gana y genera el salto.

---

## B) Diferencias computed 390 vs 418 (resumen)

| Elemento | 390px | 418px | Causa |
|----------|-------|-------|-------|
| .card-footer .price | font-size: 20px | font-size: 28px (1.75rem) | min-width: 415px (L1180) |
| .card .color-btn | 20×20px | 20×20px | Igual (solo max-width: 480px) |
| .color-more-chip | 24×22px | 24×22px | Igual |
| .sticky-cart | bottom: calc(56px+10px+0) | Igual | No cambia por breakpoint 415 |
| #btn-ver-mas-modelos | position: static | Igual | Inline |
| #wa-popup | bottom: calc(...) | Igual | max-width: 768px |
| .bottom-nav | height: 62px | Igual | max-width: 768px |

El salto principal es el precio: 20px → 28px.

---

## C) Regla que provoca el salto

**Selector:** `.card-footer .card-price .price`  
**Línea:** 1180–1185  
**Media query:** `@media (min-width: 415px)`

```css
@media (min-width: 415px) {
  .card-footer .card-price .price {
    font-size: 1.75rem;  /* ~28px – infla el precio en 415px+ */
  }
}
```

---

## D) Snippet para loguear computed styles (pegar en consola)

```javascript
(function(){
  const sel = (s) => document.querySelector(s);
  const cs = (el, props) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return props.reduce((o, p) => ({...o, [p]: c.getPropertyValue(p) || c[p]}), {});
  };
  const props = (name, el, list) => { const r = cs(el, list); if(r) console.log(name, r); };
  props('.sticky-cart', sel('.sticky-cart'), ['height', 'bottom', 'z-index', 'display']);
  props('.bottom-nav', sel('#bottom-nav') || sel('.bottom-nav'), ['height', 'bottom', 'z-index', 'padding-bottom']);
  props('#wa-popup', sel('#wa-popup'), ['bottom', 'z-index', 'right']);
  props('.load-more-wrap', sel('.load-more-wrap'), ['margin-bottom', 'padding', 'display']);
  props('#btn-ver-mas-modelos', sel('#btn-ver-mas-modelos'), ['font-size', 'position', 'bottom', 'z-index']);
  props('.card-footer .price', sel('.card-footer .card-price .price') || sel('.card .price'), ['font-size', 'font-weight', 'line-height']);
  props('.card .color-btn', sel('.card-footer .colors .color-btn'), ['width', 'height']);
  props('.color-more-chip', sel('.card-footer .colors .color-more-chip'), ['width', 'height', 'font-size']);
  console.log('innerWidth:', window.innerWidth);
})();
```

Ejecutar con viewport a 390px y a 418px para comparar.

---

## Resumen de cambios aplicados

### Causa del salto
El `@media (min-width: 415px)` en la línea 1180 hacía que `.card-footer .card-price .price` pasara de 20px a 1.75rem (~28px) en anchos ≥415px. A 418px se percibía un salto de escala.

### Cambios realizados

1. **Eliminación del inflador de precio**  
   - Eliminado el bloque `@media (min-width: 415px)` que subía el tamaño del precio de las cards.

2. **Ajuste del breakpoint de bordes**  
   - `@media (min-width: 415px)` de bordes de cards cambiado a `min-width: 431px` para que 360–430 usen solo reglas compactas.

3. **Nuevo bloque `@media (max-width: 430px)`**  
   - Precio: 18px, peso 800  
   - Swatches: 16×16px, chip +N 20×18px  
   - Cards: padding 0.4rem, gaps reducidos  
   - Banners: padding y tamaños más compactos  
   - Botón “Ver más”: padding y font más pequeños  

4. **Orden de overlays (z-index)**  
   - bottom-nav: 10000  
   - sticky-cart: 10001  
   - wa-popup: 10003  
   - Ver más: inline, sin `z-index` fijo  

5. **Offsets**  
   - `--floating-gap`: 10 → 8px  
   - sticky-cart: `bottom = bottom-nav + 8px`  
   - WhatsApp: `bottom = bottom-nav + sticky-cart + 10px` (sin solapar sticky-cart)
