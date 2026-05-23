# Catalogo publico: visibilidad por stock real

**Performance / LCP:** ver `doc/catalogo/auditoria-lcp-2026-05-23.md` y Obsidian `docs/FYL-Obsidian/FYL-Product/Performance/2026-05-23-Auditoria-LCP-Catalogo-Clarity.md`.

## Problema detectado

El index publico consumia `catalog_public_view`, cuya publicacion se apoyaba en `variant_sizes.stock_qty > 0`.

Eso genero desalineacion:

- visibilidad SQL: basada en tabla derivada
- stock real de negocio: basado en `variant_size_warehouse_stock` + reservas

Resultado: productos sin stock real seguian apareciendo en el index.

## Criterio correcto de visibilidad

Una fila (producto + color) es visible en el index solo si:

- `products.status = 'active'`
- `product_variants.active = true`
- existe al menos un talle con `disponible > 0` en depositos validos
- existe al menos una imagen de variante con URL no vacia (misma idea que el catalogo previo, pero sin exigir `position = 1`)

Donde:

- `disponible = stock_fisico_por_talle_en_depositos_validos - reservas_activas_por_talle`

## Separacion conceptual

- estado editorial (`status`) != disponibilidad (`stock`)

No se cambia automaticamente el estado editorial por falta de stock.

## Artefactos en el repo


| Artefacto                      | Ruta                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| Definicion SQL de la vista     | `supabase/canonical/193_catalog_public_available_view.sql`                 |
| Loader del index / PDP publico | `scripts/main-supabase.js`                                                 |
| Vista anterior (sin tocar)     | `supabase/canonical/04_catalog_public_view.sql` y sucesivos fixes de vista |


## Cambio implementado

Se creo una nueva vista:

- `public.catalog_public_available_view`

Misma forma de columnas que espera el frontend (Filtro1/2/3, ofertas, promos, etc.), alineada al patron de `catalog_public_view` pero con filtro de disponibilidad real.

No se modifico `catalog_public_view` para no romper otros consumidores existentes.

### Detalles tecnicos resueltos en 193

1. **PostgreSQL y `max(uuid)`**: en el CTE `wh` no se puede usar `max(case ... then id end)` sobre UUID. En el archivo canonico se usa `(max(id::text) filter (where code = '...'))::uuid` sobre `warehouses`.
2. **Imagen principal vs cualquier imagen**: una primera version de la vista exigia `img."Imagen Principal" is not null` (solo `position = 1`). Eso ocultaba variantes con stock y con imagenes en otras posiciones (casos reales: 108 Negro, 730 Negro, R2133 Gris). La version actual usa `image_count > 0` y `coalesce("Imagen Principal", first_image)` para la columna principal.

### Llamadas migradas en index

En `scripts/main-supabase.js` hay **8** llamadas activas a `catalog_public_available_view` para el flujo principal del catalogo publico:

- `cargarDesdeSupabase()` — consulta base de categorias y filtros
- `abrirPdpPorSkuIfPossible()` — resolucion PDP desde index
- `existeNovedades()`
- `existeOfertas()`
- `inicializarCatalogo()` — banner / tag / similares inicial

Lineas actuales (buscar `from("catalog_public_available_view")`): **515, 583, 3004, 3011, 5579, 5607, 5756, 5780**.

### Excepcion residual en el mismo archivo (vigilar)

- `getRecoCandidates()` (~3818): si no hay `__allProductsCache` ni `productosPendientes`, el fallback a Supabase sigue usando `.from('catalog_public_view')`. Es un camino poco frecuente pero puede recomendar articulos que la nueva regla de index excluiria. Convivencia documentada hasta alinearlo si se desea coherencia total.
- Quedan **strings/comentarios** de debug o mensajes que mencionan `catalog_public_view` (no afectan la query principal).

### Alcance del cambio

- Catalogo/index publico: `scripts/main-supabase.js` (vista nueva).
- No se cambiaron fuentes de `admin/`*.
- No se cambiaron fuentes de `client/dashboard*`.

## Depositos considerados

Para visibilidad publica se suman filas de `variant_size_warehouse_stock` donde `warehouse_id` es:

- `general`
- `venta-publico`

(IDs resueltos desde `public.warehouses` en la vista.)

## Reservas consideradas (por talle)

Implementacion en `193_catalog_public_available_view.sql`:

- **Pedidos**: `order_item_stock_sources` unido a `order_items` y `orders`, con `orders.status not in ('sent', 'expired', 'devolución')`.
- **Carrito**: `cart_items` con `ci.status = 'reserved'` en `carts` con `c.status = 'open'`.

Talle normalizado con `trim` / `nullif` para cruzar reserva con `variant_size_warehouse_stock.size`.

## Errores previos detectados

- Uso de tabla derivada (`variant_sizes`) como criterio de publicacion.
- Enriquecimiento de stock real en frontend correcto, pero aplicado despues de publicar cards.
- Filtro de imagen demasiado estricto (`position = 1` obligatorio) en un borrador de la vista nueva.

## Productos usados como control (historial de auditoria)

- **Correctamente ocultos por disponible 0**: ejemplo DD Negro (segun diagnostico previo).
- **Ocultos por bug de imagen (corregido)**: 108 Negro, 730 Negro, R2133 Gris.
- **Posible ocultamiento por reservas infladas / drift** (requiere revision de datos, no de la vista): R2130 Negro, MEDTL Multicolor, R2132 Azul — ver `public.vw_stock_audit_reserved_qty_diff` y trazas de `order_item_stock_sources` / carritos.

## Validacion SQL en el editor de Supabase

- Cada bloque de validacion debe ser **una sola sentencia** con sus propios CTEs. En PostgreSQL un `WITH` solo aplica a la query inmediata siguiente; no reutilizar CTEs entre consultas pegadas por separado.
- Evitar `max(uuid)` sin cast intermedio a `text` (o usar subqueries `(select id from warehouses where code = 'general' limit 1)`).

## Validacion funcional esperada

- `active` + al menos un talle con disponible real > 0 + imagen: aparece
- `active` + disponible 0 en todos los talles: no aparece
- `draft`, `completar stock`, `completar tags`, `archivado`: no aparecen
- Admin no se afecta (flujo separado)

## Queries utiles

### Listado rapido desde la vista

```sql
select "Articulo", "Color", "Numeracion"
from public.catalog_public_available_view
order by "Articulo", "Color";
```

### Confirmar presencia de filas concretas (ajustar literales)

```sql
select *
from public.catalog_public_available_view
where "Articulo" = '108' and "Color" = 'Negro'
   or "Articulo" = '730' and "Color" = 'Negro'
   or "Articulo" = 'R2133' and "Color" = 'Gris';
```

### Diagnostico de “deberia estar pero no esta”

1. Confirmar `products.status` y `product_variants.active`.
2. Confirmar filas en `variant_size_warehouse_stock` para `general` / `venta-publico` y `available_qty` mental (fisico - reservas).
3. Confirmar al menos una URL en `variant_images` para la variante.
4. Si fisico - reserva parece > 0 pero sigue fuera, revisar **normalizacion de talle** (espacios, texto vs numerico) y **reservas** en pedidos/carrito abiertos.

## Checklist de prueba manual (index publico)

1. Abrir el index en movil (360–430px): lista carga sin errores en consola de red.
2. Buscar un articulo que antes aparecia sin stock: no debe listarse si disponible real es 0.
3. Abrir PDP de un articulo con stock en un solo talle: numeracion coherente con disponibilidad.
4. Filtros (tags/categorias): mismos campos Filtro1/2/3 que antes.
5. Novedades / ofertas / banners: siguen respondiendo si la vista devuelve filas.
6. Admin: pantallas de producto/stock sin cambios de fuente.

