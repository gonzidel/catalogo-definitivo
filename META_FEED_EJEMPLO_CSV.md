# Ejemplo de CSV - Meta Catalog Feed

> **Spec enriquecimiento (2026-05-23):** `doc/meta-feed/2026-05-23-meta-feed-enriquecimiento-spec.md` · Obsidian: `docs/FYL-Obsidian/38-META-FEED-ENRICHMENT-2026-05-23.md`  
> **Fase 1 implementada en repo:** headers 14 columnas (ver abajo). Fases 2–3 pendientes.

## Headers del Feed (Fase 1 — vigente en código)

```
id,item_group_id,title,description,availability,condition,price,link,image_link,brand,color,size,gender,product_type
```

Ejemplo completo: `doc/meta-feed/ejemplo-csv-fase1.csv`

## Ejemplo de filas (Fase 1)

```csv
id,item_group_id,title,description,availability,condition,price,link,image_link,brand,color,size,gender,product_type
1530-1-SUELA-37,<uuid-producto>,Botas ... Suela Talle 37,...,in stock,new,45000 ARS,https://fylmoda.com.ar/catalogo?sku=1530-1-SUELA-37,<cloudinary>,FYL,Suela,37,female,Calzado > Botas
1530-1-NEGRO-38,<uuid-producto>,Botas ... Negro Talle 38,...,in stock,new,45000 ARS,https://fylmoda.com.ar/catalogo?sku=1530-1-NEGRO-38,<cloudinary>,FYL,Negro,38,female,Calzado > Botas
```

`item_group_id` = `products.id` (UUID). Variantes del mismo modelo comparten UUID.

## Reglas vigentes (Fase 1)

- Una fila por `variant_sizes.sku` con stock disponible real (depósitos `general` + `venta-publico`, reservas por talle).
- Solo variantes presentes en `catalog_public_available_view`.
- Sin filas `out of stock` en el CSV exportado.
- `link`: `https://fylmoda.com.ar/catalogo?sku=<SKU_REAL>`.

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
