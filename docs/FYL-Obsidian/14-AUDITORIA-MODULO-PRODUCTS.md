# 14 - Auditoria modulo Products

Estado: auditoria de codigo, solo lectura.
Fecha: 2026-04-24.
Alcance: modulo administrativo de productos, stock inicial, tags, imagenes, variantes y costos.

> Nota importante: esta auditoria confirma lo que existe en el repo. No confirma que todas las migraciones esten efectivamente aplicadas en Supabase produccion. Donde dependa del estado real de DB, marcar como DUDOSO.

## 1. Archivos principales

| Archivo | Rol actual | Evidencia |
|---|---|---|
| `admin/products.js` | Alta/edicion completa de producto, variantes, imagenes, tags, proveedor, costos y stock inicial por talle. | Imports de auth/permisos en `admin/products.js:2-4`; guardado principal en `saveProduct()` desde `admin/products.js:5617`; carga por ID desde `admin/products.js:5244`. |
| `admin/products.html` | Pantalla principal de alta/edicion. | Carga `products.js` desde la pantalla. |
| `admin/fyl-products.js` | Edicion operativa/listado FYL: precios, activo/inactivo y stock batch. | RPCs de stock en `admin/fyl-products.js:849`, `864`, `929`, `950`; updates directos de precio/activo en `810`, `834`, `979`. |
| `admin/fyl-products.html` | Pantalla de administracion/listado FYL. | Carga `fyl-products.js`. |
| `admin/incomplete-products.js` | Completar productos con `pending_stock`: stock inicial y activacion. | Busca `products.status = pending_stock` en `admin/incomplete-products.js:84-96`; usa RPCs stock en `577` y `615`; activa producto en `648-649`. |
| `admin/incomplete-products.html` | Pantalla para productos sin stock. | Texto de uso en `admin/incomplete-products.html:462`; carga script en `489`. |
| `admin/complete-tags.js` | Completar productos con `missing_tags`: tags, detalles y highlights. | Busca `missing_tags` en `admin/complete-tags.js:49-55`; guarda `product_tags`/`product_tag_details` en `496-551`. |
| `admin/complete-incomplete-tags.js` | Flujo auxiliar para completar tags en productos incompletos. | Usa `products`, `product_tags`, `product_variants`, `variant_images`, `tags`. |

## 2. Tablas usadas actualmente

| Tabla | Uso en products | Tipo de acceso observado | Archivos |
|---|---|---|---|
| `products` | Cabecera del producto: categoria, handle, nombre, descripcion, status, proveedor, costos/margenes. | SELECT, INSERT, UPDATE, DELETE/archivar. | `products.js`, `incomplete-products.js`, `complete-tags.js`, `complete-incomplete-tags.js`, `fyl-products.js`. |
| `product_variants` | Variantes por color/SKU/precio/activo. Ya no guarda talle como fuente principal. | SELECT, INSERT, UPDATE, soft delete/inactivar. | `products.js`, `fyl-products.js`, `incomplete-products.js`, `complete-tags.js`. |
| `variant_sizes` | Metadata de talles por variante: size, sku, qr, stock derivado. | SELECT; escritura via RPC/triggers, no como canal principal de stock. | `products.js`, `fyl-products.js`, `incomplete-products.js`. |
| `variant_size_warehouse_stock` | Fuente canonica de stock por talle y deposito. | SELECT directo; escritura via RPCs. | `products.js`, `fyl-products.js`, `incomplete-products.js`. |
| `variant_warehouse_stock` | Fuente canonica para variantes sin talles. Tambien stock derivado/total segun modelo. | SELECT directo; escritura via RPCs para sin talle. | `products.js`, `fyl-products.js`, `incomplete-products.js`. |
| `warehouses` | Resolucion de deposito `general` y otros depositos. | SELECT. | `products.js`, `fyl-products.js`, `incomplete-products.js`. |
| `variant_images` | Imagenes por variante: orden, main, URLs/Cloudinary. | SELECT, INSERT, UPDATE, DELETE. | `products.js`, `complete-tags.js`, `complete-incomplete-tags.js`. |
| `product_tags` | Tags jerarquicos y highlights asociados al producto. | SELECT, INSERT, UPDATE, DELETE. | `products.js`, `complete-tags.js`, `complete-incomplete-tags.js`. |
| `product_tag_details` | Detalles por tag3/producto. | SELECT, INSERT, DELETE. | `products.js`, `complete-tags.js`. |
| `tags` | Catalogo jerarquico de tags. | SELECT, INSERT, UPDATE, DELETE. | `products.js`, `complete-tags.js`, `complete-incomplete-tags.js`, `incomplete-products.js`. |
| `colors` | Catalogo auxiliar de colores. | SELECT, INSERT, UPDATE. | `products.js`. |
| `suppliers` | Proveedor del producto y codigo. | SELECT, INSERT, UPDATE. | `products.js`, `fyl-products.js`, `incomplete-products.js`. |

## 3. RPCs usadas por el modulo

| RPC | Donde se llama | Que hace segun repo | Seguridad detectada | Riesgo |
|---|---|---|---|---|
| `rpc_save_product_variant_initial_stock` | `admin/products.js:1708` | Guarda stock inicial por talle en deposito `general`; reemplazo completo para la variante. | `SECURITY DEFINER`; valida `auth.uid()` y presencia en `admins` en `139_rpc_save_product_variant_initial_stock.sql:34-40`. | Alto: cualquier admin puede modificar stock inicial si puede invocarla. |
| `assign_qr_code_to_variant_size` | `admin/products.js:1742` | Asigna QR a filas de `variant_sizes` devueltas por la RPC de stock inicial. | Definicion SQL no auditada en detalle en esta pasada. | Normal/DUDOSO. |
| `rpc_set_variant_size_stock_batch` | `admin/fyl-products.js:849`, `929`; `admin/incomplete-products.js:577` | Ajusta stock absoluto por talle/deposito, registra `stock_history`. | `SECURITY DEFINER`; valida solo que el usuario exista en `admins`, no permiso granular, en `164_rpc_set_variant_size_stock_batch.sql:100-112`. | Alto. |
| `rpc_set_variant_warehouse_stock_batch` | `admin/fyl-products.js:864`, `950`; `admin/incomplete-products.js:615` | Ajusta stock absoluto para variantes sin talle. | `SECURITY DEFINER`; valida solo que el usuario exista en `admins`, no permiso granular, en `165_rpc_set_variant_warehouse_stock_batch.sql:91-103`. | Alto. |

## 4. Flujo actual de alta/edicion

1. Permisos frontend:
   - `canEditProducts()` requiere usuario admin y `products:edit` o `products:delete` (`admin/products.js:40-42`).
   - `ensureProductsEditPermission()` bloquea acciones de edicion si no hay permiso (`admin/products.js:56-66`).

2. Campos sensibles:
   - `canViewCostSensitiveProductFields()` exige `isSuperAdmin()` (`admin/products.js:45-52`).
   - Los campos de costo, porcentaje y logistico se ocultan/deshabilitan en UI cuando no es super admin (`admin/products.js:97-138`).
   - Al crear producto solo agrega `price_percentage` y `logistic_amount` si `allowSensitive` es true (`admin/products.js:1103-1128`).
   - Al guardar producto existente usa `allowSensitiveProductPricing` para incluir o no `cost`, `price_percentage`, `logistic_amount` (`admin/products.js:5643-5717`).

3. Precio recomendado:
   - Se calcula en frontend con formula `costo + costo * porcentaje / 100 + monto_logistico`, redondeado a 100 (`admin/products.js:965-976`).
   - Por lo tanto `recommended_price` depende funcionalmente de costo/margen/logistico.

4. Stock inicial por talle:
   - `saveVariantSizes()` toma talles desde `.sizes-list`, arma `p_items` y llama `rpc_save_product_variant_initial_stock` (`admin/products.js:1557-1710`).
   - Esta RPC trabaja contra deposito `general` y actualiza tablas de stock por talle (`139_rpc_save_product_variant_initial_stock.sql:1-8`, `49-58`).
   - Luego intenta asignar QR a cada `variant_size` sin `qr_code` (`admin/products.js:1735-1755`).

5. Carga de producto existente:
   - Lee `products` completo (`admin/products.js:5247-5251`).
   - Lee `product_variants` (`admin/products.js:5257-5261`).
   - Lee `variant_sizes` como metadata de talle/SKU (`admin/products.js:5269-5289`).
   - Lee stock editable desde `variant_size_warehouse_stock` y/o `variant_warehouse_stock` (`admin/products.js:5333`, `5375`).

6. Estado del producto:
   - Alta inicial crea `status = pending_stock` (`admin/products.js:1111-1120`).
   - `incomplete-products.js` busca `pending_stock`, completa stock y activa (`admin/incomplete-products.js:84-96`, `648-649`).
   - `complete-tags.js` busca `missing_tags`, completa tags/detalles y espera actualizacion de estado (`admin/complete-tags.js:49-55`, `558`).

## 5. Modelo de stock usado por Products

| Caso | Tabla canonica | Como se escribe | Como se lee |
|---|---|---|---|
| Variante con talles | `variant_size_warehouse_stock` | `rpc_save_product_variant_initial_stock` en alta/edicion principal; `rpc_set_variant_size_stock_batch` en bulk/completar. | `variant_sizes` para metadata + `variant_size_warehouse_stock` para stock por deposito. |
| Variante sin talles | `variant_warehouse_stock` | `rpc_set_variant_warehouse_stock_batch`. | `variant_warehouse_stock`. |
| Stock agregado/derivado por talle | `variant_sizes.stock_qty` | No deberia escribirse directo desde cliente; derivado por triggers. | Se lee como metadata/estado, no como canal principal de escritura. |

Guardas SQL relevantes:

- `148_guard_derived_stock_writes.sql` bloquea escritura directa de `variant_sizes.stock_qty` y protege `variant_warehouse_stock` cuando la variante tiene modelo por talle (`148_guard_derived_stock_writes.sql:1-53`, `55-90`).
- `164_rpc_set_variant_size_stock_batch.sql` declara la RPC atomica de stock por talle, con `SECURITY DEFINER` y validacion de admin (`164...:54-61`, `100-112`).
- `165_rpc_set_variant_warehouse_stock_batch.sql` declara la RPC atomica de stock sin talle, con `SECURITY DEFINER` y validacion de admin (`165...:49-56`, `91-103`).

## 6. Costos y campos sensibles

Campos sensibles detectados:

- `products.cost`
- `products.price_percentage`
- `products.logistic_amount`
- `products.recommended_price`, si existe o si depende de costo
- La migracion `182` tambien instala trigger en `product_variants`, por lo que protege esos nombres si existen alli.

Proteccion frontend:

- Confirmada en `admin/products.js`.
- No se vuelcan costos al DOM para colaboradores al cargar producto (`admin/products.js:5471-5504`, segun auditoria previa).
- Los payloads de create/update excluyen campos sensibles si no es super admin.

Proteccion DB en repo:

- `supabase/canonical/182_protect_sensitive_product_fields.sql` crea `enforce_sensitive_product_fields()`.
- Bloquea cambios a `cost`, `price_percentage`, `logistic_amount`, `recommended_price` para usuarios no super_admin (`182...:33-54`).
- Instala triggers en `products` y `product_variants` (`182...:61-69`).

Estado real:

- DUDOSO hasta verificar en Supabase que la migracion `182` este aplicada y que los triggers existan.

## 7. Seguridad observada

| Capa | Estado |
|---|---|
| UI products | Usa permisos frontend: `products:edit/delete` para editar, `isSuperAdmin()` para costos. |
| RLS products/product_variants | Existen RLS y policies en migraciones, pero hay historico de politicas permisivas/dev y fixes. Requiere confirmar estado desplegado. |
| Triggers de costos | Existen en repo (`182`), pero requieren confirmacion en DB real. |
| RPCs stock | Son `SECURITY DEFINER` y validan que el usuario este en `admins`; no se vio validacion granular `admin_permissions` en las RPCs revisadas. |
| DevTools/API | Si un colaborador es `admin`, podria intentar invocar RPCs de stock o updates directos. DB debe ser la barrera final. |

## 8. Conclusiones

- El modulo `products` esta razonablemente estructurado para el modelo actual: producto -> variantes por color -> talles en `variant_sizes` -> stock canonico por deposito.
- La escritura de stock se movio mayormente a RPCs atomicas y no a updates directos sobre tablas derivadas.
- La proteccion de costos ya no parece solo frontend en el repo, porque existe `182_protect_sensitive_product_fields.sql`.
- El punto mas delicado no es el funcionamiento actual, sino la falta de evidencia escrita del estado real desplegado en Supabase.
- Para cerrar la auditoria de seguridad de Products hay que confirmar `pg_trigger`, `pg_proc`, `pg_policies` y grants reales en produccion.

