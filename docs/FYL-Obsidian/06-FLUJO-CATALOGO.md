# 06 - Flujo de catalogo cliente

Esta nota resume catalogo, PDP y carrito. Para el detalle real de carrito/checkout, ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

**Hardening 2026-04 (overlay, primer paint, slot superior del home, red/abort, PDP):** ver [[21-CONTEXTO-AGENTE-HARDENING-2026-04]].

## Carga de productos

- Entrada principal: `index.html`.
- Listado/PDP: `scripts/main-supabase.js`.
- Vista principal: `catalog_public_view`.
- Tablas leidas segun flujo: `products`, `product_variants`, `variant_sizes`, `variant_size_warehouse_stock`, `warehouses`, `variant_images`.

## Filtros y detalle

| Area | Archivos/RPCs |
|---|---|
| Filtros | `scripts/filtros.js`, `scripts/size-filter.js` |
| Busqueda | `scripts/search-manager.js` |
| Tags/atributos | `scripts/tag-service.js`, RPCs `get_types_by_category`, `get_attributes_by_type`, `get_product_details` |
| Alternativas/similares | `scripts/product-alternatives.js` |
| Ofertas | `get_active_offers_with_images`, `get_active_promotions_for_variants`, `get_effective_price` |

## Carrito real

Flujo vivo:

1. `index.html` carga `scripts/cart-persistent.js`.
2. `scripts/cart-persistent.js` expone `window.addToCart`.
3. Si no hay usuario, usa `localStorage` (`fyl_cart`).
4. Si hay usuario, vincula/crea cliente con `rpc_link_or_create_customer`, busca/crea `carts`, y escribe `cart_items`.
5. `client/dashboard.html` carga `scripts/cart-persistent.js` y `client/dashboard-instant.js`.
6. El checkout real ocurre en `client/dashboard-instant.js` con `rpc_checkout_cart(uuid,jsonb)`.

## Rutas alternativas/legacy

| Ruta | Estado |
|---|---|
| `client/cart.html` + `client/cart.js` | Ruta separada; no usa `rpc_checkout_cart`; marcada para revisar. |
| `client/cart-fixed.js` | Variante corregida pero no detectada como script cargado por `client/cart.html`. |
| `scripts/cart.js` | Contiene RPCs `rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart`; no es el flujo principal del catalogo. |

## Riesgos

- No asumir un solo flujo de carrito.
- No confiar en validaciones frontend para stock/precio.
- `price_snapshot` del carrito debe ser tratado como no confiable si el checkout no recalcula precio en DB.

## Enlaces

- [[21-CONTEXTO-AGENTE-HARDENING-2026-04]]
- [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]]
- [[03-MAPA-DE-RPCS]]
- [[04-FLUJO-STOCK]]
- [[05-FLUJO-PEDIDOS]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
