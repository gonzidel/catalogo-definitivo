# FYL /nj — Filtros y Categorías

> Última actualización: 2026-06-08

## Categorías disponibles

| Slug | Label | Emoji |
|------|-------|-------|
| `calzado` | Calzado | 👟 |
| `ropa` | Ropa | 👕 |
| `otros` | Otros | 📦 |

> La opción "Todo" fue eliminada. El catálogo arranca sin filtro de categoría.

## Chips de categoría (`CategoryTabs`)

- **Activo**: fondo naranja (#CD844D), texto blanco, borde bold, sombra
- **Inactivo**: opacidad 0.72, fondo gris claro
- Comparación case-insensitive: `activeCategoria.toLowerCase() === slug`

## Heading de categoría activa (CatalogShell)

Cuando hay una categoría seleccionada, se muestra debajo de los chips:
```
👟 CALZADO    ← emoji + nombre en mayúsculas
Zapatillas, botas y más    ← descripción
38 productos    ← count filtrado
```

## Filtro de talles — flujo de 2 pasos

### Caso 1: Categoría ya seleccionada
→ Abre `SizeFilterSheet` directamente con los talles de esa categoría.

### Caso 2: Sin categoría seleccionada
→ `onNeedCategory` hace blinquear los chips de categoría (CSS keyframe `fyl-blink`)
→ Aparece tooltip fixed bajo el header: "Primero elegí una categoría"
→ El botón "Talles" pulsa (CSS keyframe `fyl-talles-pulse`)

### Dentro del modal — flujo de 2 pasos si categoría es "all"
1. Pantalla: seleccionar tipo (Calzado / Ropa / Otros)
2. Pantalla: talles de esa categoría

## Talles por categoría

### Calzado
- Infantil: 18 → 33
- Adulto: 34 → 42
- Especiales: 42½, 43, 43½, 44, 44½, 45

### Ropa
- Bebé/Niño: 1, 2, 3, 4, 6, 8, 10, 12, 14
- Letras: XS, S, M, L, XL, XXL, XXXL, 4XL
- Pantalón: 40, 42, 44, 46, 48, 50
- Único: U

### Otros
- S, M, L, XL, U, 1, 2, 3

## Portal para modales

`SizeFilterSheet` usa `createPortal(modal, document.body)` para evitar clipping por `position: sticky` del header. El tooltip de "Primero elegí una categoría" también usa portal con `position: fixed` y `top` calculado.

## Implementación en URL

Los filtros se manejan por URL params (no hash):
- `?categoria=calzado`
- `?talle=38`
- `?q=zapatilla`

Esto permite compartir links filtrados y es compatible con el botón "atrás" del navegador.
