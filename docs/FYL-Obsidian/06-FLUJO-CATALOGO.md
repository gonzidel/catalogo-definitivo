# 06 - Flujo de catalogo cliente

Esta nota resume catalogo, PDP y carrito. Para el detalle real de carrito/checkout, ver [[19-AUDITORIA-MODULO-CLIENTE-CARRITO]].

**Hardening 2026-04 (overlay, primer paint, slot superior del home, red/abort, PDP):** ver [[21-CONTEXTO-AGENTE-HARDENING-2026-04]].

**Catálogo público (`catalogo.html`, `html.public-catalog`):** FAB WhatsApp `#wa-popup` / `#wa-toggle` — comportamiento y reparo 2026-05-07 en [[10-BUGS-RESUELTOS]] (FAB sin JS que bloquee el `<a>`, carga `defer` de `whatsapp.js`, CSS anti-solapamiento con scroll-top).

**Boot crítico Supabase 2026-05-08:** `<script defer src="scripts/vendor/supabase-js.bundle.min.js?v=...">` (IIFE same-origin) cargado **antes** de cualquier `<script type="module">`. `scripts/supabase-client.js` lee `window.fylSupabase.createClient` de forma síncrona — sin `import()` dinámico, sin CDN cross-origin. Servicio Worker en modo tombstone network-only para `/scripts/vendor/*` y `/config.prod.js`. Detalle y motivación en [[10-BUGS-RESUELTOS]] §2026-05-08 y [[11-DECISIONES-TECNICAS]] §B.13–16.

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

**NJ (Next.js):** el merge admin↔auth no corre en el carrito NJ. Se dispara al completar onboarding en `nj/components/profile/ProfileOnboardingModal.tsx` (`rpc_link_or_create_customer` → `rpc_link_public_sales_customer` → `rpc_upsert_customer`). Detalle: [[325-VINCULACION-ADMIN-NJ-ONBOARDING-2026-09-03]].

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
