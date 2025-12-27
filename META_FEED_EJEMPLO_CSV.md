# Ejemplo de CSV - Meta Catalog Feed

## Headers del Feed

```
id,item_group_id,title,description,price,availability,condition,brand,link,image_link,color,size
```

## Ejemplo de 3 filas

```csv
id,item_group_id,title,description,price,availability,condition,brand,link,image_link,color,size
1530-1-SUELA-37,1530-1,1530-1 - SUELA - Talle 37,Zapatilla deportiva con suela antideslizante,45000.00 ARS,in stock,new,FYL,https://tudominio.com/index.html?sku=1530-1-SUELA-37,https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1234567890/products/1530-1-suela-37.jpg,SUELA,37
1530-1-SUELA-38,1530-1,1530-1 - SUELA - Talle 38,Zapatilla deportiva con suela antideslizante,45000.00 ARS,in stock,new,FYL,https://tudominio.com/index.html?sku=1530-1-SUELA-38,https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1234567890/products/1530-1-suela-38.jpg,SUELA,38
1530-1-NEGRO-40,1530-1,1530-1 - NEGRO - Talle 40,Zapatilla deportiva con suela antideslizante,45000.00 ARS,out of stock,new,FYL,https://tudominio.com/index.html?sku=1530-1-NEGRO-40,https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1/meta-placeholder.jpg,NEGRO,40
```

## Características del Feed

### 1. Normalización automática de URLs Cloudinary

Todas las URLs de Cloudinary se normalizan automáticamente en el Edge Function para incluir transformaciones optimizadas:
- `f_auto`: Formato automático (WebP si es compatible, PNG/JPG si no)
- `q_auto`: Calidad automática optimizada
- `w_1200`: Ancho máximo de 1200px (requerido por Meta Catalog)

**Regla de normalización**: Solo se normaliza si la URL contiene `/image/upload/v` (versión sin transformaciones). Si ya tiene transformaciones (f_auto, w_, q_, c_, etc.), no se modifica.

**Ejemplo de normalización:**

URL original:
```
https://res.cloudinary.com/dnuedzuzm/image/upload/v1234567890/products/1530-1-suela-37.jpg
```

URL normalizada:
```
https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1234567890/products/1530-1-suela-37.jpg
```

### 2. Fallback chain para image_link

El sistema garantiza que `image_link` **nunca esté vacío** usando este orden de prioridad:

1. **variant_images(position=1)**: Imagen principal de la variante
2. **Placeholder Cloudinary fijo**: `https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto,w_1200/v1/meta-placeholder.jpg`

### 3. Columna brand

Todas las filas incluyen `brand='FYL'` como marca del catálogo.

### 4. Escaping CSV (RFC 4180)

El feed utiliza escaping correcto según RFC 4180:
- Valores con comas, comillas o saltos de línea se envuelven en comillas dobles
- Comillas internas se duplican (`"` → `""`)
