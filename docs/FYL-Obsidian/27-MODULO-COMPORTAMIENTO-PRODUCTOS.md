# 27 — Módulo: Comportamiento de productos (inteligencia operativa)

> Fecha: 2026-05-04  
> Parte de: `admin/stock-audit.html` + `admin/stock-audit.js`  
> Bloque UI: `block-behavior` — "◈ Comportamiento de productos"

---

## Objetivo

Agregar a "Salud de stock" una capa de **análisis operativo** que detecta comportamiento de productos usando datos reales de ventas, publicaciones y stock. No son errores técnicos — son señales de oportunidad comercial.

---

## Señales implementadas (4 cards)

### B1 — Alta demanda

Productos activos que vendieron ≥ 3 unidades en los últimos 90 días (B2B + venta al público combinados).

Muestra por fila:
- Unidades vendidas (90d)
- Velocidad (u/día)
- Días de stock restante al ritmo actual
- Badge "Nuevo ✓" si fue dado de alta hace < 120 días

**Acción sugerida:** asegurar stock antes de publicar nuevamente.

---

### B2 — Nuevos con buena rotación

Subconjunto de B1 donde `es_nuevo = true` (alta en los últimos 120 días).

Muestra por fila:
- Fecha de alta
- Unidades vendidas
- Stock actual

**Acción sugerida:** evaluar reponer si días de stock < 30.

---

### B3 — Stock acumulado

Productos de B1 donde `dias_stock_restante > 180`. Tienen ventas activas pero el stock a esa velocidad tardaría más de 6 meses en agotarse.

Muestra por fila:
- Meses estimados de stock (`~N meses`)
- Unidades totales
- Velocidad actual

**Acción sugerida:** promo, reubicación o reducir compras futuras.

**Color:** violeta (oportunidad), no rojo.

---

### B4 — Publicados sin ventas

Productos que tienen `product_variants.last_published_at` seteado (publicados en redes en los últimos 180 días), tienen stock disponible, y registran **cero ventas** desde esa fecha de publicación.

Muestra por fila:
- Días desde la publicación
- Fecha de publicación
- Stock disponible
- Link "Re-publicar →" a `publications.html`

**Acción sugerida:** revisar precio, imagen o canal.

---

## Arquitectura técnica

### Fuentes de datos

| Señal | Tabla(s) |
|---|---|
| Ventas B2B | `order_items` + `orders` |
| Ventas al público | `public_sale_items` |
| Publicaciones | `product_variants.last_published_at` (migración 143) |
| Stock actual | `variant_warehouse_stock` |

**No existe tabla `publications`** — el módulo `admin/publications.js` escribe directamente en `product_variants.last_published_at`.

### Vistas SQL

| Vista | Migración | Descripción |
|---|---|---|
| `vw_stock_fast_sellers` | `185_vw_stock_fast_sellers.sql` | Productos con ventas en 90d; incluye velocidad y días de stock |
| `vw_stock_publication_inefficiency` | `186_vw_stock_publication_inefficiency.sql` | Publicados recientemente sin conversión a ventas |
| `vw_stock_dead_products` | `184_vw_stock_dead_products.sql` | Sin movimiento ≥ 90d (bloque separado: `block-opportunity`) |

### Carga en JS

Las vistas se cargan en `Promise.allSettled` junto con el resto de la auditoría. Si fallan, `state.fastSellers = []` y `state.pubInefficiency = []` → el bloque `block-behavior` queda oculto sin afectar los demás bloques.

```js
// En state:
fastSellers: [],      // B1/B2/B3
pubInefficiency: [],  // B4

// En loadAll():
loadFastSellers(),        // vw_stock_fast_sellers
loadPubInefficiency(),    // vw_stock_publication_inefficiency
```

### Derivación de señales en JS

Las 4 cards provienen de solo 2 queries:

- `card-fast-sellers` → `state.fastSellers` (todos)
- `card-new-rotation` → `state.fastSellers.filter(p => p.es_nuevo)`
- `card-stock-acum` → `state.fastSellers.filter(p => p.dias_stock_restante > 180)`
- `card-pub-inefficiency` → `state.pubInefficiency` (directo)

---

## Paleta de colores

| Tipo CSS | Color | Uso |
|---|---|---|
| `analisis` | Azul `#0369a1` | Cards B1, B2, B4 (señales de gestión) |
| `oportunidad` | Violeta `#7c3aed` | Card B3 (stock acumulado); ya existía |
| `positive` | Verde `#166534` | Badges de buenas noticias (ventas altas, nuevo ✓) |
| `neutral` | Azul claro | Info sin urgencia |
| `warning` | Naranja | Días de stock bajo / días sin conversión altos |

**Nunca rojo** — ninguna de estas señales es un error técnico.

---

## Umbral mínimo `vw_stock_fast_sellers`

`units_sold_90d >= 3` para reducir ruido estadístico. Si el catálogo tiene poco volumen de ventas, se puede ajustar a `>= 1` editando la vista en Supabase.

---

## Verificación rápida en SQL Editor

```sql
-- Fast sellers
SELECT nombre, category, units_sold_90d, dias_stock_restante, es_nuevo
FROM vw_stock_fast_sellers
LIMIT 10;

-- Publicados sin conversión
SELECT nombre, dias_desde_publicacion, ventas_tras_publicacion, stock_total
FROM vw_stock_publication_inefficiency
LIMIT 10;

-- Verificar que last_published_at existe y tiene datos
SELECT COUNT(*) FROM product_variants WHERE last_published_at IS NOT NULL;
```

---

## Relación con otros módulos

- **`admin/stock-audit.html`** — host del bloque
- **`admin/publications.js`** — escribe `last_published_at`; sus datos alimentan B4
- **`admin/orders.js`** — genera los `order_items` que alimentan B1/B2/B3
- **`admin/stock-audit.js` bloque `block-opportunity`** — "Stock sin movimiento" (vw_stock_dead_products, migración 184); bloque separado pero complementario

---

## Estado de verificación

- **2026-05-04 (confirmado por operador):** el módulo Salud de stock con inteligencia operativa, clasificación fabricación propia / carryover estacional heurístico, botón "Ver todos" en listas truncadas, cargo de flags por proveedor y payload con `is_own_manufacturing` / `is_seasonal` **funciona correctamente** en el entorno de uso.

Para el informe IA (`stock_report_ai`) siguen aplicando los prerrequisitos de despliegue: Edge Function desplegada, `OPENAI_API_KEY` en secrets, vistas 184–187 aplicadas en Supabase.

---

## Relación con el roadmap

Ver [[00-INDICE]] — FASE 9.

---

## Clasificación de productos: fabricación propia y estacionalidad

> Implementado: 2026-05-04 como parte de FASE 10

### Fabricación propia / Reposición interna

**Criterio usado:** `products.supplier_id → suppliers(code, name)`. Se consideran de fabricación propia si:

1. `supplier_id IS NULL` — sin proveedor externo asignado
2. `supplier.code` o `supplier.name` contiene alguno de: `FYL`, `F&L`, `F Y L`, `FABRICACION PROPIA`, `PROPIO`, `INTERNO`

**Implementación:** JS-side, post-carga (`loadProductSupplierFlags()`). Las vistas SQL no exponen `supplier_id` actualmente — se hace una query adicional con los `product_id` ya cargados en `state`.

**Impacto en UI:**
- Fast sellers: badge "Reposición interna" reemplaza el badge de "días de stock restante" → no genera alerta de quiebre
- Stock acumulado: badge "Reposición interna" reemplaza badge naranja → no se trata como urgente
- Dead stock: badge "Reposición interna" → señal contextual, no se sugiere discontinuar

**Impacto en payload de IA:** cada ítem de `fast_sellers` y `dead_stock` incluye `is_own_manufacturing: true|false|null`.

**Ajuste futuro:** si el slug real del proveedor FYL difiere de los patrones, editar `OWN_MANUFACTURING_PATTERNS` en `admin/stock-audit.js`.

---

### Estacionalidad (detección heurística)

**Estado:** detección heurística por nombre de producto. **No existe campo DB confiable.**

**Criterio actual:** el nombre del producto contiene alguna de estas palabras (insensible a mayúsculas): `ojota`, `sandalia`, `chancleta`, `hawaiana`, `pantufla`, `botin verano`, `calzado verano`.

**Limitaciones:**
- Solo funciona si el producto tiene estas palabras en el nombre
- No detecta estacionalidad por tag1 (requeriría enriquecer las vistas con tag1 por producto)
- No hay ventana temporal: una ojota parece "dead stock" en invierno aunque sea carryover comercialmente válido

**Impacto en UI:** dead stock — badge "Carryover estacional" si el nombre coincide. Solo informativo, no cambia acciones.

**Impacto en payload de IA:** `is_seasonal: true|false` en cada ítem de dead_stock y fast_sellers.

---

### GAP documentado: falta `lifecycle_status` en `products`

**Problema:** no existe ningún campo en la tabla `products` que permita distinguir:
- Producto de temporada (carryover aceptado)
- Producto discontinuado a propósito
- Producto de fabricación propia sin proveedor externo
- Producto de colección permanente

**Campo propuesto para implementación futura:**

```sql
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS lifecycle_status text
  CHECK (lifecycle_status IN ('standard', 'seasonal', 'own_manufacturing', 'discontinued', 'clearance'))
  DEFAULT 'standard';

COMMENT ON COLUMN public.products.lifecycle_status IS
  'Clasificación del ciclo de vida del producto para análisis operativo.
   standard: producto regular de catálogo.
   seasonal: carryover estacional, stock inmovilizado en temporada baja es normal.
   own_manufacturing: producción propia FYL, reposición interna, sin proveedor externo.
   discontinued: eliminado comercialmente, pendiente de liquidar.
   clearance: en liquidación activa.';
```

**Impacto si se implementa:** las vistas `vw_stock_dead_products`, `vw_stock_fast_sellers` y `vw_stock_publication_inefficiency` podrían incluirlo directamente, sin el workaround JS actual.

**Prioridad sugerida:** media. El workaround actual funciona para los casos más comunes.