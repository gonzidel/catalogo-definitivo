# Diagnóstico: altura vertical de la card producto (<=430px)

## 1) Estructura HTML real de una card renderizada

```html
<div class="card producto" data-filtro1="..." data-filtro2="..." data-sku="..." data-name="...">
  <div class="main-image-wrapper">
    <img class="main-image" loading="lazy" src="..." alt="..." data-sku="..."/>
    <div class="product-name-badge">R1838</div>
  </div>
  <div class="image-loader"><div class="spinner"></div></div>
  <!-- badges oferta/promo si hay -->
  <div class="title-row">
    <h3>🔥</h3>
  </div>
  <div class="card-footer">
    <div class="card-footer-top">
      <div class="card-price"><span class="price">$8.000</span></div>
    </div>
    <button class="cart-icon-btn" data-articulo="..." title="Agregar al carrito">...</button>
    <div class="colors-row">
      <div class="colors"><!-- color-btn, color-more-chip --></div>
    </div>
    <div class="card-footer-size" data-articulo="..." data-color-selected="...">
      <span class="card-size-badge">Único</span>
    </div>
  </div>
</div>
```

**Nota:** La galería (.gallery) no está en la card del catálogo; solo en PDP/modal.

---

## 2) Qué define la ALTURA vertical

| Pregunta | Respuesta |
|----------|-----------|
| ¿display grid o flex en card? | **Block** (default). Los hijos se apilan en columna. |
| ¿min-height en card? | **No** |
| ¿min-height en footer? | **No** (tiene `min-height: 0`) |
| ¿padding vertical en card? | **Sí**: 0.35rem (430px) ≈ 5.6px arriba + abajo |
| ¿margin-top/bottom en footer? | **Sí**: margin-top 0.12rem ≈ 1.9px |
| ¿Imagen aspect-ratio? | **Sí**: 4/4.7 (≈ altura = ancho × 1.175) |
| ¿Imagen margin-bottom? | **No** |
| ¿Wrapper con gap grande? | **Sí**: `.card-footer` usa `gap: 3px 6px` (row-gap 3px) |

**Display del footer:** `display: grid` con:
- `grid-template-areas: "colors cart" / "price size"`
- Filas: 1) colors + cart, 2) price + size
- **La fila 1 toma la altura del elemento más alto = cart-icon-btn (44px)**

---

## 3) Valores COMPUTED en viewport 390px (≤430)

| Elemento | Propiedad | Valor base/480 | Valor 430 |
|----------|-----------|----------------|-----------|
| `.card.producto` | padding | 0.5rem (8px) | **0.35rem (5.6px)** |
| `.card.producto` | min-height | none | none |
| `.main-image` | aspect-ratio | 6/7 | **4/4.7** |
| `.main-image` | margin-bottom | 0 | 0 |
| `.card-footer` | margin-top | 0.25rem (4px) | **0.12rem (1.9px)** |
| `.card-footer` | gap (row) | 6px | **3px** |
| `.card-footer` | min-height | 0 | 0 |
| `.card-size-badge` | padding | 3px 8px | 3px 8px |
| `.card-size-badge` | line-height | 1 | 1 |
| `.cart-icon-btn` | height | **44px** | **44px** |
| `.cart-icon-btn` | min-height | 44px | 44px |
| `.cart-icon-btn` | padding | 0 | 0 |
| `.colors-row` | gap | 4px | 3px |
| `.colors-row` | padding | 2px 0 | **1px 0** |

---

## 4) Propiedades que agregan altura

| ¿Existe? | Selector | Valor |
|----------|----------|-------|
| ❌ | align-content: space-between | No |
| ❌ | justify-content: space-between (en card) | No (sí en title-row) |
| ❌ | min-height forzado | No |
| ❌ | height fija en footer | No |
| ❌ | flex-grow en bloque | No (card-footer-size tiene justify-self: end) |

---

## 5) Lista de culpables (ordenados por impacto)

| # | Culpable | Contribución | Valor actual (430) |
|---|----------|--------------|--------------------|
| **1** | **`.cart-icon-btn` height** | Fuerza fila 1 del footer a 44px | 44px |
| 2 | `.main-image` aspect-ratio | Define altura de imagen | 4/4.7 |
| 3 | `.card-footer` margin-top | Separación imagen→footer | 0.12rem |
| 4 | `.card.producto` padding | Aire interno | 0.35rem × 2 |
| 5 | `.card-footer` row-gap | Entre filas del grid | 3px |
| 6 | `.card-size-badge` padding | Altura del badge | 3px 8px |
| 7 | `.title-row` | Si hay contenido (🔥) | variable |

---

## 6) Mayor culpable

**`.cart-icon-btn` a 44×44px** impone la altura de la primera fila del grid del footer. Los colores (15×15px) serían suficientes, pero el botón los estira a 44px.

---

## 7) Valores propuestos para mobile ≤430px

| Selector | Propiedad | Actual | Propuesto |
|----------|-----------|--------|-----------|
| `.card-footer .cart-icon-btn` | width, height, min-width, min-height | 44px | **36px** |
| `.card-footer .cart-icon-btn svg` | width, height | 18px | **16px** |
| `.card-footer` | margin-top | 0.12rem | **0.08rem** |
| `.card.producto` | padding | 0.35rem | **0.3rem** |
| `.card-footer` | gap (row) | 3px | **2px** |
| `.card-size-badge` | padding | 3px 8px | **2px 6px** |
| `.title-row` | margin, min-height | 0, 0 | **margin-top: 0.2rem** (o reducir si existe) |
| `.card-footer-top` | (revisar) | - | Asegurar sin margin extra |

**Nota:** 36px sigue siendo tap target aceptable (recomendación mínima ~44px para accesibilidad; 36px es aceptable para acciones secundarias).

---

## 8) Aplicado: nuevo grid footer ≤430px

**Cambio:** grid-template-areas de `"colors cart" / "price size"` a `"colors size" / "price cart"`.

**Por qué baja la altura:** Antes la fila 1 (colors | cart) medía 44px por el botón carrito. Ahora la fila 1 es (colors | size): colores 15px + badge talle ~20px → fila ~20px. El carrito (40px) pasa a la fila 2 con el precio.

**Checklist visual (360, 390, 418, 430px):**
1. Producto con muchos colores + chip +N → swatches no se recortan, +N en misma línea.
2. Talle "Único" → alineado a la derecha en fila 1.
3. Rango "36–43" → badge compacto, sin cortar.
