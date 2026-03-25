# Investigación: Imagen principal no aparece en PDP (modal de producto)

## Síntomas

- **Miniaturas**: Se muestran correctamente (5 thumbnails con el producto)
- **Imagen principal**: Área vacía/gris donde debería verse la foto grande
- **Productos afectados**: J35 Beige, SPIDER Rosa V, y aparentemente todos

## Hallazgos de la investigación

### 1. Misma fuente de datos

La imagen principal y las miniaturas usan **la misma fuente**:

- `obtenerGaleriaYImagenPrincipal()` recorre `producto.DetalleColor.flatMap(v => v.images)`
- Las miniaturas usan `getImgUrl(img, 200)` → `src` y `data-full`
- La imagen principal usa `mainImgUrl` = `getImgUrl(img, 1200)` del mismo loop

Si las miniaturas cargan, esa URL debería ser válida.

### 2. Posibles causas identificadas

| # | Hipótesis | Verificación |
|---|-----------|--------------|
| 1 | **mainImgUrl vacío** | Si `getImgUrl` devuelve `""`, el `img` tendría `src=""` y no mostraría nada. Las miniaturas usan la misma `getImgUrl` con el mismo `img`, así que es raro que falle solo para la principal. |
| 2 | **URL con caracteres especiales** | Si la URL tiene `"` o `&` sin escapar en `src="${mainImgUrl}"`, el atributo HTML podría romperse. Las Cloudinary suelen ser seguras. |
| 3 | **Orden de keys en el catálogo** | El agregado usa `Object.keys(i).filter(k => k.startsWith("imagen"))` – el orden puede variar y alterar qué imagen se usa como “principal”. |
| 4 | **Comparación `img === preferida`** | Si `preferida` es un objeto y `img` es string (o al revés), `isActive` podría ser siempre false y cambiar cuál URL se asigna a `mainImgUrl`. |
| 5 | **CSS ocultando la imagen** | `.product-modal-main-image` tiene `width: 100%; height: 100%; object-fit: contain`. Con `overflow: hidden` en el wrap, una imagen con dimensiones raras podría quedar recortada o no verse. |
| 6 | **Elemento separado vs. mismo elemento** | La principal es un `img` distinto al de las miniaturas. Cualquier fallo de carga solo afectaría a ese elemento. |

### 3. Estructura del DOM

```
#product-modal-body
  └── .product-modal-main-content
        └── .product-modal-gallery-wrap
              └── .product-modal-images
                    ├── .product-modal-main-image-wrap (overflow: hidden, 140px altura)
                    │     └── img.product-modal-main-image  ← NO SE VE
                    └── .product-modal-gallery
                          └── img.miniatura (x5)  ← SÍ SE VEN
```

### 4. Flujo de datos

```
catalog_public_view (Supabase)
  → vi.url como "Imagen Principal", "Imagen 1", etc.
  → reduce() agrupa por artículo
  → DetalleColor[].images = [url1, url2, url3].filter(Boolean)

obtenerGaleriaYImagenPrincipal():
  → images = flatMap de DetalleColor.images
  → para cada img: thumb=getImgUrl(img,200), full=getImgUrl(img,1200)
  → mainImgUrl = full de la primera imagen con isActive o primera con full
```

## Solución recomendada: usar la miniatura como imagen principal

En vez de un `img` principal separado que depende de `mainImgUrl`, **usar la primera miniatura como imagen principal**:

1. Mostrar la primera miniatura más grande (o duplicar su `src` en un contenedor principal).
2. Al hacer clic en otra miniatura, actualizar esa imagen “principal” con el `data-full` de la miniatura clickeada.

Así se reutiliza la misma lógica y los mismos elementos que ya funcionan para las miniaturas.

### Alternativa: diagnóstico en consola

Para confirmar la causa antes de cambiar la estructura, ejecutar en la consola (con el modal abierto):

```javascript
const main = document.querySelector('.product-modal-main-image');
const primera = document.querySelector('.product-modal-gallery .miniatura');
console.log('Main img src:', main?.src);
console.log('Main img complete:', main?.complete);
console.log('Primera miniatura data-full:', primera?.getAttribute('data-full'));
console.log('¿Son iguales?', main?.src === primera?.getAttribute('data-full'));
```

- Si `main?.src` está vacío o es `"undefined"`, el problema está en `mainImgUrl`.
- Si `main?.src` y `data-full` son iguales, el problema podría ser de carga (red/CORS) o de CSS.
- Si son distintas, hay un fallo en la lógica que asigna `mainImgUrl`.
