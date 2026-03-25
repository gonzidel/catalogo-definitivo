# Diagnóstico exacto: espacio blanco dentro del footer CTA

## 1) Estructura DOM real del footer

```html
<div id="product-modal-footer" class="product-modal-footer">
  <div class="product-modal-cta" data-precio-unidad="...">
    <div class="product-modal-cta-summary">
      <div class="product-modal-cta-pairs">Seleccioná talles para agregar</div>
      <div class="product-modal-cta-total">$0</div>
    </div>
    <button class="product-modal-cta-btn reserve-btn pdp-add-btn is-empty" 
            data-articulo="..." data-color="...">Agregar al borrador</button>
  </div>
</div>
```

**No hay** `.product-modal-cta-inner` ni wrapper adicional. El botón es hijo directo de `.product-modal-cta`.

---

## 2) CSS efectivo (styles.css)

### #product-modal-footer / .product-modal-footer
```css
#product-modal-footer.product-modal-footer {
  flex-shrink: 0;
  position: sticky;
  bottom: 0;
  background: #fff;
  border-top: 1px solid rgba(0,0,0,.08);
  box-shadow: 0 -6px 16px rgba(0,0,0,.06);
  padding: 10px 16px;
  padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));  /* ← SAFE AREA */
  z-index: 10;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
```

### .product-modal-cta
```css
.product-modal-cta {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
```

### .product-modal-cta-summary
```css
.product-modal-cta-summary {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
```

### .product-modal-cta-btn (y .pdp-add-btn)
```css
.product-modal-footer .pdp-add-btn,
.product-modal-cta .pdp-add-btn {
  width: 100%;
  min-height: 44px;
  padding: 14px 20px;
  border-radius: 14px;
  margin-bottom: 12px;  /* ← CULPABLE Nº1 */
  border: none;
  font-weight: 600;
  ...
}

.product-modal-cta-btn {
  padding: 12px 24px;
  ...
  margin-bottom: 0;  /* ← Sobrescrito por .pdp-add-btn que tiene mb:12px */
}
```

---

## 3) Código para mediciones en consola

```javascript
const footer = document.querySelector('#product-modal-footer');
const cta = document.querySelector('#product-modal-footer .product-modal-cta');
const btn = document.querySelector('#product-modal-footer .product-modal-cta-btn');
console.log({
  footerRect: footer?.getBoundingClientRect(),
  ctaRect: cta?.getBoundingClientRect(),
  btnRect: btn?.getBoundingClientRect(),
  footerPaddingTop: getComputedStyle(footer).paddingTop,
  footerPaddingBottom: getComputedStyle(footer).paddingBottom,
  ctaPaddingTop: getComputedStyle(cta).paddingTop,
  ctaPaddingBottom: getComputedStyle(cta).paddingBottom,
  btnHeight: getComputedStyle(btn).height,
  btnPaddingTop: getComputedStyle(btn).paddingTop,
  btnPaddingBottom: getComputedStyle(btn).paddingBottom,
  btnMarginBottom: getComputedStyle(btn).marginBottom  // ← 12px
});
```

---

## 4) Confirmación de safe area

**Sí**, el footer usa `env(safe-area-inset-bottom)`:

```css
padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
```

En desktop = 10px. En iPhone X+ ≈ 10 + 34 = **44px**.

---

## 5) Hipótesis final

El espacio blanco proviene de:

1. **margin-bottom: 12px** del botón (`.product-modal-footer .pdp-add-btn` / `.product-modal-cta .pdp-add-btn`) — añade 12px fijos debajo del botón.
2. **padding-bottom del footer** con safe-area: 10px + env(...) — en iPhone suma ~44px adicionales.

Total aproximado: **22px** en desktop, **~56px** en iPhone (12 + 10 + 34).

---

## Explicación en 2 líneas

El espacio blanco se debe a **margin-bottom: 12px** del botón y al **padding-bottom** del footer (10px + safe-area). El `margin-bottom` es redundante porque el footer ya define su propio padding inferior; el botón es el último hijo y no requiere margen extra.

---

## Diff mínimo en styles.css (APLICADO)

```diff
- margin-bottom: 12px;
+ margin-bottom: 0;
```

En dos sitios:
- `.product-modal-footer .pdp-add-btn` / `.product-modal-cta .pdp-add-btn` (línea ~2965)
- `.product-modal-cta .pdp-add-btn` dentro del media query (línea ~3197)
