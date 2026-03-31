# PRD — Sistema Catálogo FYL

**Product Requirements Document**  
Versión: 1.2  
Fecha: Marzo 2026

---

## 1. Resumen ejecutivo

**Catálogo FYL** es una PWA (Progressive Web App) de catálogo y ventas para un negocio de indumentaria/retail. Permite a **clientes** ver productos, armar pedidos y completar checkout; a **administradores** gestionar productos, stock, pedidos, ventas diarias y venta al público (múltiples cajas); y soporta **impresión de etiquetas/tickets** vía QZ Tray con firma digital. El backend es Supabase (PostgreSQL + Auth + Edge Functions); el hosting es Firebase.

---

## 2. Objetivos del producto

- Ofrecer un **catálogo digital** usable en móvil y desktop (PWA, offline básico).
- Permitir a clientes **registrados** ver precios, agregar al carrito y **confirmar pedidos** (checkout con reserva de stock).
- Dar al equipo interno un **panel administrativo** para productos, stock, pedidos, ventas y reportes.
- Soportar **venta al público** en punto de venta (múltiples cajas) con clientes y créditos.
- Integrar **impresión** (etiquetas, tickets) mediante QZ Tray con certificado/firma segura.
- Mantener **una sola fuente de verdad** para catálogo y stock (Supabase).

---

## 3. Usuarios y roles

| Rol | Descripción | Acceso principal |
|-----|-------------|-------------------|
| **Visitante** | No autenticado | Catálogo público (productos visibles, sin precios o con precios según configuración). |
| **Cliente** | Usuario registrado (Supabase Auth) | Catálogo con precios, carrito persistente, checkout, historial de pedidos, perfil. |
| **Admin / Colaborador** | Usuario en tabla `admins` con permisos | Panel admin: productos, stock, pedidos, ventas, etc. Acceso según `admin_permissions`. |
| **Super Admin** | `admins.role = 'super_admin'` | Todo lo anterior + gestión de colaboradores (permisos). |

**Autenticación**

- Clientes: Supabase Auth con varias opciones — **email/contraseña**, **magic link** (OTP por email, desde modal en catálogo vía `auth-status.js`), **Google OAuth** y **Passkeys** (WebAuthn, Edge Function `passkeys` + `passkeys.js`). El modal de login en la página principal permite elegir email o Google; si no hay modal se redirige a `client/login.html`.
- Admins: mismo Auth; pertenencia y rol en `public.admins`; permisos granulares en `admin_permissions`.

---

## 4. Módulos y funcionalidades

### 4.1 Catálogo público (frontend cliente)

- **Ubicación**: `index.html` (entrada principal); `scripts/` (main, catalog, filtros, search-manager, como-comprar, etc.). La sección “Cómo comprar” y colecciones (ej. FYL Originals) se manejan por hash (`#/como-comprar`, `#/coleccion/...`) con `como-comprar.js`.
- **Fuente de datos**: Vista `catalog_public_view` (productos activos, variantes con stock > 0 e imágenes, precios, ofertas, tags). Fallback opcional a vista/tabla `catalog_items` si la principal no devuelve datos.
- **Funcionalidades**:
  - Listado de productos con filtros (categoría, color, talle, tags, búsqueda). Filtro de talles con normalización (`size-filter.js`, `utils/size-normalizer.js`) y modal bottom sheet por categoría.
  - Detalle de producto (variantes, talles, imágenes, precio/oferta). **Productos similares / alternativos** vía `product-alternatives.js` y RPCs `find_similar_products`, `get_product_highlights`; navegación por tags con `get_types_by_category`, `get_attributes_by_type`, `get_product_details` (`tag-service.js`).
  - **Banners promocionales**: tablas `promotional_banners` y `custom_product_banners`; páginas/vistas `banner.html` (productos del banner), `custom-banner.js`, `fyl-originals-banner.js` para banners por colección o campaña.
  - Agregar al carrito (requiere sesión cliente).
  - Acciones rápidas (quick actions) para categorías/tags/ofertas/proveedores; datos en tabla `quick_actions`.
  - Contacto: menú/flotante WhatsApp (`whatsapp.js`) para consultas.
  - PWA: `manifest.json` (nombre "Catálogo FYL", theme_color #CD844D, shortcuts, iconos 192/512); service worker (`sw.js`), caché y uso offline básico.
  - Tema/identidad: color principal #CD844D, tipografía Poppins.

### 4.2 Área cliente (dashboard y carrito)

- **Entradas**: `client/login.html`, `client/dashboard.html`, `client/cart.html`, `client/profile.html`, `client/complete-profile.html`.
- **Carrito**:
  - Carrito persistente en Supabase (`carts`, `cart_items`) asociado al `customer_id`; cambio de cantidades con `rpc_update_cart_item_quantity`.
  - Sincronización al iniciar sesión; persistencia entre sesiones.
- **Checkout**:
  - Flujo vía RPC `rpc_checkout_cart()`: reserva de stock por talle/almacén, creación de `orders` y `order_items`, `order_item_stock_sources`, generación de `order_number`, limpieza del carrito.
  - Vencimiento de pedidos y notificaciones (`order_notifications`, `expires_at`, `dismantle_at`).
- **Dashboard**: resumen de carrito, pedidos recientes, acceso a perfil y completar datos.
- **Vinculación con venta al público**: En perfil y “completar perfil” el cliente puede vincular su cuenta con un cliente de venta al público (por número o QR), vía RPCs `rpc_link_public_sales_customer` y `rpc_upsert_customer`, para unificar historial.
- **Historial de compras (venta al público)**: Página `customer.html` (“Mi Historial de Compras”) permite al cliente consultar ventas asociadas por código QR o número de venta (`rpc_get_public_sale_details`, `rpc_get_customer_public_data`).
- **Datos de perfil y dirección**: Soporte para provincia y localidad (Argentina); datos de ciudades en `admin/argentina-cities-data.js` (generado por script `scripts/fetch-cities.js`), usados en perfil y completar perfil.

### 4.3 Panel administrativo

- **Entrada**: `admin/index.html` (login con Google o email/contraseña). Tras login, dashboard con tarjetas a cada módulo. Módulos visibles según permisos (`permissions-helper.js`, `admin_permissions`).
- **Módulos principales**:

| Módulo | Ruta | Descripción |
|--------|------|-------------|
| Productos | `products.html` | CRUD productos y variantes (nombre, categoría, color, precios, tags, estado). |
| Productos FYL | `fyl-products.html` | Gestión de productos propios (stock y visibilidad). |
| Stock | `stock.html` | Control de inventario y precios por variante/talle/almacén. |
| Pedidos | `orders.html` | Pedidos pendientes (creados por clientes vía checkout). |
| Pedidos enviados | `sent-orders.html` | Pedidos marcados como enviados (impacto en daily_sales). |
| Pedidos cerrados | `closed-orders.html` | Cierre de pedidos, transporte, rótulos. |
| Ventas diarias | `daily-sales.html` | Registro y consulta de ventas diarias (y envíos). |
| Estadísticas | `statistics.html` | KPIs, gráficos, rankings. |
| Venta al público | `public-sales.html`, `public-sales-caja2.html`, `public-sales-caja3.html` | Ventas en caja (clientes de venta al público, créditos, ítems). |
| Clientes | `customers.html` | Gestión de clientes (datos, número de cliente). |
| Importar/Exportar | `import-export.html` | Importación/exportación CSV. |
| Publicaciones | `publications.html` | Productos para publicar en redes. |
| Mover stock | `move-stock.html` | Movimientos entre almacenes. |
| OFERTA | `offers.html` | Ofertas por color y promociones (2x1, 2xMonto). |
| Búsqueda | `search.html` | Búsqueda avanzada de productos y stock. |
| ETIQUETAS | `labels.html` | Impresión de etiquetas (QZ Tray). |
| Colaboradores | `collaborators.html` | Solo super_admin: gestión de admins y permisos. |
| Imágenes faltantes | `missing-images.html` | Detección y carga de imágenes para variantes. |
| Completar tags | `complete-tags.html` | Tags jerárquicos y detalles de productos. |
| Productos incompletos | `incomplete-products.html` | Completar stock y tags pendientes. |
| Estado de productos | `product-status.html` | Visibilidad en catálogo. |
| Meta (Catálogo) | `meta-feed.html` | Feed CSV para Facebook/Instagram Catalog. |
| Acciones rápidas | `quick-actions.html` | Gestionar acciones rápidas del catálogo móvil. |
| Diagnóstico productos | `diagnose-products.html` | Diagnóstico de productos y datos asociados. |
| Importar clientes | `import-customers.html` | Importación masiva de clientes (CSV/planilla). |
| Restablecer contraseña | `reset-password.html` | Flujo de recuperación de contraseña para usuarios. |
| Completar tags (incompletos) | `complete-incomplete-tags.html` | Completar tags desde el flujo de productos incompletos (acceso desde incomplete-products). |

- **Creación de pedidos por admin**: `order-creator.html` para generar pedidos desde el panel (acceso desde pedidos u otras entradas; no está en el grid del dashboard).
- **Edición de pedidos locales**: `local-order-edit.html` para pedidos de venta local (acceso desde venta al público u otros flujos).

### 4.4 Pedidos y flujo de stock

- **Órdenes**: `orders` (order_number, customer_id, estado, fechas), `order_items` (variant, size, quantity, precio, status).
- **Reserva**: En checkout se descuenta/reserva stock por talle en `variant_sizes` / `variant_size_warehouse_stock`; se registra en `order_item_stock_sources`.
- **Estados**: Pendiente → Enviado (`sent_at`) → Cerrado (`closed_at`). Al marcar enviado se alimenta `daily_sales` (triggers). Soporte para **devoluciones** (`rpc_mark_order_as_devolucion` en pedidos enviados).
- **Pedidos locales**: `local_orders`, `local_order_items` para ventas no asociadas al flujo cliente web.
- **Pedidos cerrados y rótulos**: Listas de envío (`rpc_save_shipping_list`, `rpc_get_shipping_lists`), conteo e impresión de rótulos (`rpc_update_order_labels_count`, `rpc_mark_labels_printed`), revertir pedido a estado “armado” (`rpc_revert_order_to_picked`). Los talles pueden tener **código QR** único (`variant_sizes.qr_code`) generado con `assign_qr_code_to_variant_size` (etiquetas en admin).

### 4.5 Venta al público (cajas)

- **Tablas**: `public_sales_customers`, `public_sales_customer_credits`, `public_sales`, `public_sale_items`, `pending_sales` (cajas 2 y 3).
- **Conceptos**: Clientes de venta al público (customer_number), créditos, ventas con sale_number, ítems por venta. Múltiples “cajas” (p. ej. caja 2, caja 3) con vistas dedicadas.
- **Funcionalidades**: Alta/consulta de ventas, aplicación de créditos, anulación (`rpc_void_public_sale`), permitir agregar sin stock según política (`public_sale_allow_add_without_stock`).

### 4.6 Impresión (QZ Tray)

- **Objetivo**: Imprimir etiquetas y tickets sin popups de seguridad repetidos.
- **Implementación**: Certificado propio; firma del mensaje en backend (Edge Function `qz-sign`) con llave privada en Supabase Secrets; cliente QZ en el navegador usa certificado público (`qz-site.crt`). “Remember this decision” habilitado.
- **Uso**: Desde admin (p. ej. etiquetas en `labels.html`, tickets en flujos de venta).

### 4.7 Otros flujos

- **Daily sales**: Registro manual o automático vía triggers al enviar pedidos; tablas `daily_sales` y relaciones.
- **Ofertas y promociones**: `color_price_offers`, `promotions`, `promotion_items`; expuesto en `catalog_public_view` (PrecioOferta, etc.).
- **Almacenes y stock**: `warehouses`, `variant_warehouse_stock` / `variant_size_warehouse_stock`, `stock_movements`, `stock_history`.
- **Proveedores**: `suppliers` vinculados a productos.
- **Transportes y envíos**: `transports`, `shipping_lists` para pedidos cerrados.
- **Notificaciones**: `order_notifications`, `admin_notifications`.
- **Meta / redes**: Edge Function `meta-feed` para generar feed CSV para catálogo en Meta.
- **Subida de imágenes**: Edge Function `upload-image` (ej. Cloudinary); variantes con `variant_images` (posición, url).
- **Autenticación avanzada**: Edge Function `passkeys` para soporte WebAuthn/Passkeys; tablas `passkeys`, `webauthn_challenges`.
- **Tags automáticos**: Edge Function `auto_tags` para asignación o sugerencia de tags (si está en uso).

### 4.8 RPCs y APIs principales (resumen)

- **Checkout y carrito**: `rpc_checkout_cart`, `rpc_link_or_create_customer`, `rpc_update_cart_item_quantity`; carrito persistente con `carts`/`cart_items`.
- **Clientes**: `rpc_upsert_customer`, `rpc_link_public_sales_customer`, `rpc_create_admin_customer`, `rpc_update_admin_customer`, `rpc_bulk_create_customers`.
- **Pedidos**: `rpc_close_order`, `rpc_mark_order_as_sent`, `rpc_cancel_order_item`, `rpc_update_order_item_status`, `rpc_reschedule_sent_order`, `rpc_mark_order_as_devolucion`, `rpc_update_customer_transport`, `rpc_send_order_to_local`; **pedidos cerrados y envíos**: `rpc_save_shipping_list`, `rpc_get_shipping_lists`, `rpc_update_order_labels_count`, `rpc_mark_labels_printed`, `rpc_revert_order_to_picked`.
- **Venta al público**: `rpc_create_public_sale`, `rpc_void_public_sale` (anulación), `rpc_get_public_sale_details`, `rpc_create_pending_sale`, `rpc_complete_pending_sale`, `rpc_search_public_customer`, `rpc_get_customer_credits` / `rpc_add_customer_credit` / `rpc_add_return_credit`, `rpc_create_public_customer`, `rpc_update_local_order`, `rpc_load_local_order_to_sale`, `rpc_create_local_order`, `rpc_get_local_order_items`.
- **Stock y precios**: `rpc_move_size_stock`, `get_variant_stock_by_warehouse`, `get_effective_price`, `get_active_promotions_for_variants`, `log_stock_change`; **QR en talles**: `assign_qr_code_to_variant_size`.
- **Catálogo y tags**: `get_types_by_category`, `get_attributes_by_type`, `get_product_details`, `get_product_highlights`, `find_similar_products`.
- **Estadísticas y reportes**: `get_dashboard_kpis`, `get_daily_sales_summary`, `get_sales_timeseries`, `get_top_skus`, `get_top_products`, `get_meta_feed`.
- **Permisos y admin**: `has_permission`, `is_super_admin`, `create_collaborator_with_account`, `add_collaborator_to_admins`, `confirm_user_email`.

### 4.9 Otras páginas y recursos

- **Catálogo**: `banner.html` — vista de “Productos del banner” (productos destacados en banners).
- **Errores**: `404.html` — página de error 404 (Firebase rewrites pueden enviar rutas desconocidas a `index.html`; si existe 404 se usa como fallback).
- **Diagnóstico**: `admin/debug-auth.html` y otras páginas `debug-*.html` en la raíz para desarrollo y diagnóstico (no forman parte del flujo estándar del producto).

---

## 5. Modelo de datos (resumen)

- **Auth**: `auth.users` (Supabase).
- **Clientes**: `customers` (id = auth.users.id, customer_number, datos de perfil); `customer_auth_links`; `pending_customers`.
- **Catálogo**: `products`, `product_variants`, `variant_sizes` (incl. `qr_code` opcional por talle), `variant_images`, `product_tags`, `product_tag_details`, `tags`, `colors`, `suppliers`.
- **Stock**: `warehouses`, `variant_warehouse_stock`, `variant_size_warehouse_stock`, `variant_sizes.stock_qty`, `stock_movements`, `stock_history`.
- **Carrito**: `carts`, `cart_items`.
- **Pedidos**: `orders`, `order_items`, `order_item_stock_sources`, `order_notifications`.
- **Admin**: `admins`, `admin_permissions`.
- **Venta al público**: `public_sales_customers`, `public_sales_customer_credits`, `public_sales`, `public_sale_items`, `pending_sales`.
- **Ventas diarias**: `daily_sales`.
- **Ofertas**: `color_price_offers`, `promotions`, `promotion_items`.
- **Otros**: `payment_methods`, `transports`, `shipping_lists`, `local_orders`, `local_order_items`, `quick_actions`, `promotional_banners`, `custom_product_banners`, `passkeys`, `webauthn_challenges`.

La vista pública del catálogo es `catalog_public_view` (productos activos, variantes con stock e imágenes, precios y ofertas).

---

## 6. Stack técnico

| Capa | Tecnología |
|------|------------|
| Frontend | HTML, CSS, JS (ES modules), sin framework; PWA (manifest + Service Worker). |
| Estilos | `styles.css`, estilos por página; tema #CD844D, Poppins. |
| Backend / DB | Supabase: PostgreSQL, Auth, RLS, Edge Functions (qz-sign, upload-image, meta-feed, passkeys, auto_tags). |
| Hosting | Firebase Hosting (raíz = carpeta del proyecto; rewrites a index.html para SPA). |
| Impresión | QZ Tray, Edge Function `qz-sign`, certificado y llave privada (PKCS#8 DER, base64 en secrets). |
| Imágenes | Cloudinary (upload/optimización vía Edge Function `upload-image`); URLs en `variant_images`. |
| Config | `scripts/config.js` (Supabase URL/anon key); opcional `config.local.js` (gitignored). |
| Build / Deploy | `node scripts/generate-config.mjs`; `deploy.js` / `deploy.ps1`; Firebase CLI. |

---

## 7. Seguridad y políticas

- **RLS**: Políticas en tablas para que clientes solo accedan a sus datos (carrito, pedidos, perfil) y admins según permisos.
- **Auth**: Rutas admin protegidas por sesión y pertenencia a `admins`; módulos filtrados por `admin_permissions`.
- **Secrets**: Claves sensibles en Supabase Secrets (p. ej. `QZ_PRIVATE_KEY_B64`); no en frontend. Husky + escaneo de secretos en pre-commit.
- **Certificado QZ**: CN acorde al dominio en producción; uso interno con certificado autofirmado aceptable.

---

## 8. Criterios de éxito (resumidos)

- Clientes pueden ver catálogo, agregar al carrito y completar checkout con reserva de stock correcta.
- Admins pueden gestionar productos, stock, pedidos, ventas diarias y venta al público sin bloqueos.
- Impresión con QZ Tray funciona con “Remember this decision” y sin exponer la llave privada.
- PWA instalable y uso offline básico; rendimiento aceptable en móvil.
- Una sola fuente de verdad (Supabase) para catálogo, stock y pedidos.

---

## 9. Documentos de referencia

- `README.md`: puesta en marcha local, QZ Tray, configuración Supabase/Firebase.
- Migraciones en `supabase/canonical/`: esquema completo y evolución (checkout, RLS, daily_sales, public_sales, quick_actions, meta_feed, etc.).
- Archivos de troubleshooting y configuración en la raíz (QZ, upload, deploy, etc.) para detalles de operación.
- Páginas de diagnóstico (`admin/debug-auth.html`, `debug-*.html`) y tests (`test-*.html`) para desarrollo; no son parte del flujo de usuario final.

---

## 10. Glosario breve

| Término | Significado |
|--------|-------------|
| **Variante** | Producto en un color concreto; tiene talles (`variant_sizes`) e imágenes (`variant_images`). |
| **Talle** | Talla en `variant_sizes` (stock por talle); puede tener QR. |
| **Order number** | Identificador único de pedido (ej. A00001) generado en checkout. |
| **Customer number** | Número de cliente (ej. 0001) en `customers` o en venta al público. |
| **Venta al público** | Flujo de caja (public_sales) con clientes propios y créditos; independiente del carrito web. |
| **Daily sales** | Registro de ventas/envios por día; alimentado por triggers al marcar pedidos como enviados. |
| **Magic link** | Inicio de sesión sin contraseña: se envía un enlace por email (OTP) al usuario. |
| **Passkey** | Credencial WebAuthn (clave de acceso sin contraseña, biométrico o dispositivo). |
| **Banner promocional** | Mensaje/banner configurable en catálogo (`promotional_banners`); puede enlazar categoría, tag o URL. |
| **Lista de envío** | Conjunto de pedidos agrupados para un transporte/fecha (`shipping_lists`); se gestiona desde pedidos cerrados. |

---

*Este PRD describe el sistema Catálogo FYL tal como está implementado y sirve como referencia para desarrollo, onboarding y alineación de producto.*
