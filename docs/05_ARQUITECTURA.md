# Arquitectura

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Stack

| Capa | Tecnología |
|---|---|
| Frontend público/cliente nuevo | Next.js 15 App Router, React 19, TypeScript |
| Estado cliente | Zustand, SWR, localStorage |
| Frontend heredado/admin | HTML, CSS y JavaScript vanilla/ES modules |
| Backend principal | Supabase PostgreSQL, Auth, PostgREST, RLS, RPC, Realtime, Edge Functions, pg_cron/pg_net en migraciones recientes |
| Backend facturación | Node.js, Express, TypeScript, ARCA SDK, Puppeteer/PDF, Google APIs |
| Hosting legacy | Firebase Hosting |
| Imágenes | Cloudinary |
| Impresión | GZ Agent local (Node/.NET nativo) |
| Tests | Scripts Node, selftests TypeScript, SQL de verificación/runtime y smoke scripts |

### Límites de aplicaciones

- Raíz: sitio legacy, panel admin y configuración Firebase.
- `nj/`: aplicación Next.js completa con cliente y módulos admin nuevos.
- `catalogo1/`: fork de catálogo público bajo `/catalogo`.
- `backend/`: servicio de facturación ARCA separado; no puede ejecutarse en Firebase Hosting.
- `supabase/functions/`: funciones Deno para imágenes, feed, passkeys, facturación Facturante, n8n y WhatsApp.
- `gz-agent/`: servicio local de impresión para PCs operativas.

### Contexto empresarial sobre la transición

Estado: Histórico reciente; estado productivo actual pendiente  
Fuente: Contexto confirmado por responsable del negocio y configuración local  
Última revisión: 2026-09-23

- `catalogo1` fue concebido como catálogo público Next.js bajo `/catalogo`, sin login ni carrito.
- `nj` fue concebido como sistema completo bajo `/nj`, inicialmente para testers.
- Existió la intención de convertir NJ en sistema principal y moverlo a raíz.
- Ni el contexto empresarial ni el repositorio local demuestran por sí solos que el cutover completo haya terminado. Firebase conserva legacy/admin y redirects hacia `/catalogo`.

### Supabase

Estado: Vigente con historial extenso  
Fuente: Código y migraciones  
Última revisión: 2026-09-23

Dominios principales:

| Dominio | Objetos centrales |
|---|---|
| Identidad | `auth.users`, `customers`, `admins`, `admin_permissions` |
| Catálogo | `products`, `product_variants`, `variant_sizes`, `variant_images`, `tags`, `product_tags`, `product_tag_details`, `colors`, `suppliers` |
| Publicación | `catalog_public_available_view`, `catalog_public_snapshot`, `catalog_public_snapshot_meta`, banners y ofertas |
| Carrito/pedidos | `carts`, `cart_items`, `orders`, `order_items`, `customer_notifications` |
| Stock | `warehouses`, `variant_size_warehouse_stock`, `variant_warehouse_stock`, `stock_history`, `stock_movements`, `order_item_stock_sources` |
| Ventas locales | `public_sales`, `public_sale_items`, `local_orders`, `local_order_items`, créditos |
| Envíos/cobro | `transports`, `shipping_lists`, tablas COD y remesas |
| Compras | `purchase_*`, `supplier_*` |
| Facturación | `invoices`, `invoice_items` |
| Observabilidad | vistas `vw_stock_audit_*`, `rpc_operations`, eventos de búsqueda/publicación |

### Fuentes de verdad

- Stock físico por talle/depósito: `variant_size_warehouse_stock`.
- Disponibilidad web: `fn_sellable_qty` / `fn_sellable_stock_batch` sobre depósitos `general` + `venta-publico`.
- Catálogo público: snapshot derivado de la vista de disponibilidad.
- Precio en checkout: `get_effective_price` en DB.
- Distribución del stock descontado: `order_item_stock_sources`.
- Idempotencia de operaciones críticas: `rpc_operations` y tablas específicas de idempotencia admin.

### Realtime y concurrencia

- Kanban escucha cambios de `orders`, `order_items`, `customers` y mensajes admin mediante Supabase Realtime.
- Checkout serializa por cliente en frontend y vuelve a serializar el carrito en SQL.
- RPCs críticas usan locks de filas/advisory y `operation_id` para replay.
- El backend ARCA usa mutex en memoria; no es seguro para escalado horizontal sin lock compartido.

### Seguridad

- Navegador usa anon key; secretos/service role viven en backend/Edge Functions.
- Autorización se apoya en RLS, filas `admins`, permisos y validaciones dentro de RPC/Edge Functions.
- Varias funciones son `SECURITY DEFINER`; sus grants y chequeos internos forman parte del perímetro.
- No asumir que `REVOKE FROM PUBLIC` revoca grants directos a `anon`/`authenticated`.

## INFERIDO

- `supabase/canonical/` es un historial incremental, no una migración reproducible limpia desde cero: hay redefiniciones y parches dinámicos basados en estado previo.
- La arquitectura actual acepta convivencia temporal de legacy y Next.js para reducir riesgo operativo.

## DESCONOCIDO

- Esquema productivo exacto y lista de migraciones efectivamente aplicadas.
- Políticas RLS efectivas de todas las tablas en producción.
- Pipeline CI/CD y gates obligatorios reales.
- Observabilidad, backups y recuperación ante incidentes de cada servicio.

## Verificación antes de cambios de DB

1. Identificar la última definición efectiva de cada función, no confiar solo en el número/nombre histórico.
2. Comparar repositorio con `pg_get_functiondef`, catálogo y grants del entorno objetivo.
3. Revisar RLS, `SECURITY DEFINER`, `search_path` y grants explícitos.
4. Ejecutar tests SQL/smoke asociados y verificar efectos.
5. Actualizar esta documentación y `docs/FYL-Obsidian/`.
