# 01 - Arquitectura general

## Vision

- Frontend catalogo cliente: JavaScript vanilla con ES modules. Entrada principal: `index.html`.
- Cliente logueado: `client/dashboard.html` + `client/dashboard-instant.js`.
- Carrito vivo: `scripts/cart-persistent.js` + dashboard cliente. Ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].
- Panel admin: carpeta `admin/`, con HTML/JS por area.
- Backend: Supabase (PostgreSQL, Auth, RLS, RPCs `rpc_*`).
- Hosting: Firebase Hosting.
- Imagenes: Cloudinary.
- Impresion/etiquetas: QZ Tray.

## Carpetas

| Ruta | Rol |
|---|---|
| `index.html` | Entrada principal del catalogo |
| `scripts/` | Logica compartida: Supabase, catalogo, carrito, filtros, busqueda |
| `client/` | Dashboard cliente, carrito separado, perfil, completar perfil |
| `admin/` | Backoffice: products, stock, orders, public sales, customers, permisos |
| `supabase/canonical/` | SQL canonico, migraciones, RPCs, triggers |
| `docs/FYL-Obsidian/` | Documentacion viva |

## Modulos auditados

| Modulo | Entrada principal | Nota |
|---|---|---|
| Products | `admin/products.js`, `admin/fyl-products.js` | [[14-AUDITORIA-MODULO-PRODUCTS]] |
| Stock | `admin/stock.js`, `admin/move-stock.js`, SQL stock | [[16-AUDITORIA-MODULO-STOCK]] |
| Orders | `admin/orders.js`, `admin/order-creator.js`, `client/dashboard-instant.js` | [[17-AUDITORIA-MODULO-ORDERS]] |
| Public Sales | `admin/public-sales.js`, `admin/local-order-edit.js` | [[18-AUDITORIA-MODULO-PUBLIC-SALES]] |
| Cliente/Carrito | `scripts/cart-persistent.js`, `client/dashboard-instant.js`, `client/cart.js` | [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]] |

## Nota de consistencia

Si esta nota o un mapa general contradice una auditoria modular, usar la auditoria modular y actualizar el mapa.

## Enlaces

- [[02-MAPA-DE-TABLAS]]
- [[03-MAPA-DE-RPCS]]
- [[12-CHECKLIST-CAMBIOS-FUTUROS]]
- [[99-AUDITORIA-DOCUMENTACION]]
