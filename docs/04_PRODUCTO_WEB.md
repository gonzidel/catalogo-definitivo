# Producto web

Última revisión: 2026-09-23

## VERIFICADO EN CÓDIGO

### Aplicaciones y rutas

Estado: Vigente / transición  
Fuente: Código y configuración  
Última revisión: 2026-09-23

#### `nj/` - Next.js 15, React 19

Rutas públicas:

- `/`: catálogo principal.
- `/[categoria]`: categoría.
- `/tags/[...slugs]`: navegación por tags.
- `/coleccion/[slug]` y `/banner/[slug]`: colecciones/banners.
- `/producto/[sku]` y compatibilidad `/produto/[sku]`: PDP.
- `/como-comprar`, `/quienes-somos`.
- `/login`, `/auth/callback`.

Rutas autenticadas:

- `/dashboard`: perfil, carrito/pedido y notificaciones del cliente.
- `/admin/orders`: Kanban de envíos.
- `/admin/retiro`: Kanban de retiro local.
- `/admin/products`: productos Next.js.
- `/admin/search`: diccionario y analítica de búsqueda.
- `/admin/conciliacion-reembolso`: conciliación COD.

API interna:

- `/api/catalog`
- `/api/catalog/has-ofertas`

#### `catalogo1/` - catálogo Next.js separado

- Usa `basePath: /catalogo`.
- No contiene dashboard, carrito ni panel de pedidos.
- Comparte Supabase, catálogo, banners y PDP con una superficie pública orientada a consulta.

#### Raíz/legacy

- HTML/JS vanilla bajo raíz, `client/` y `admin/`.
- Firebase redirige `/`, `/catalogo*` y dashboard cliente heredado hacia el catálogo Next.js.
- Rutas legales/SEO y el panel `admin/` permanecen servidos por Firebase.

### Catálogo

- Fuente de lectura principal en Next.js: `catalog_public_snapshot` (`CATALOG_SOURCE`).
- Vista viva/fallback: `catalog_public_available_view`.
- El snapshot se revalida con `rpc_catalog_public_version`; no hay polling continuo.
- Productos se agrupan por artículo y color; PDP enriquece variantes, talles, imágenes y stock vendible.
- La publicación exige producto activo, variante activa, talles vendibles e imagen en la vista canónica.

### Búsqueda

- Buscador público con normalización, ranking, aliases y diccionario.
- Tablas: `search_keywords`, `search_aliases`, `search_ignored_terms`, `search_events`.
- Vista pública: `search_dictionary_public`.
- El panel admin agrega analítica y mantenimiento; tags de catálogo y vocabulario de búsqueda son dominios separados.

### Autenticación y autorización

- Login cliente mediante Google OAuth y PKCE/cookies de `@supabase/ssr`.
- Middleware protege `/dashboard` y `/admin` por existencia de usuario.
- El layout admin exige además una fila en `admins`.
- Permisos de colaboradores se cargan desde `admin_permissions`; `super_admin` omite la matriz granular.
- RLS y chequeos internos en RPC siguen siendo necesarios; ocultar una ruta no autoriza datos.

### Carrito y sincronización

- Estado de UI: Zustand persistido como `fyl-nj-cart` en localStorage.
- Persistencia servidor: `carts` y `cart_items`.
- `useCartSync` hidrata y combina carrito local/servidor, y sincroniza todas las líneas antes de checkout.
- El checkout utiliza lock del navegador o lease en localStorage/BroadcastChannel, más `operation_id` persistida.

### Analytics

- GA4 se carga en catálogo/cliente y evita admin.
- **TÉCNICA VERIFICADA en trabajo local (2026-09-29), Microsoft Clarity en NJ:** `ClarityLoader` está montado en `nj/app/layout.tsx` y carga el proyecto de test `yekz20nia8` solo si `window.location.hostname` figura en `NJ_TEST_CLARITY_HOSTS` (`nj/lib/analytics/clarity.ts`, hoy únicamente `nj-fyl-testing.vercel.app`). Cualquier host `fylmoda.com.ar` queda excluido aunque se agregue a la lista. No depende de `VERCEL_ENV` ni de variables de entorno. La decisión es del lado del cliente, después de la hidratación, así que el HTML del servidor es igual en todos los hosts.
  - Historia: se agregó en `8f201c3` (07/09) con la condición `VERCEL_ENV === "preview"`. El commit `8c6e0b1` (18/09) quitó el montaje del layout sin mencionarlo en su mensaje, y desde el deploy de ese código el sitio de pruebas dejó de grabar.
  - Producción (`www.fylmoda.com.ar/catalogo`, app `catalogo1`) mide con otro proyecto de Clarity, `w7h6cytm9j`. No se deben mezclar.
  - Para grabar en otro host de pruebas, agregarlo a `NJ_TEST_CLARITY_HOSTS`. Test: `nj/lib/analytics/clarity.test.ts`.
- Búsqueda registra eventos propios en `search_events`.

### PWA y offline

- La aplicación legacy conserva `manifest.json` y prompt de instalación.
- `sw.js` no ofrece catálogo offline: borra caches y solo fuerza network-only para archivos críticos.
- El layout Next.js desregistra service workers legacy para evitar que intercepten NJ.
- No se verificó una estrategia offline funcional para Next.js; sí hay persistencia local del carrito y revalidación al reconectar.

## CONTEXTO CONFIRMADO POR EL NEGOCIO

Estado: Histórico reciente / topología actual pendiente de confirmar  
Fuente: Contexto confirmado por responsable del negocio  
Última revisión: 2026-09-23

- `www.fylmoda.com.ar/catalogo` fue el catálogo público Next.js sin login ni carrito, denominado internamente `catalogo1`.
- `www.fylmoda.com.ar/nj` fue el sistema Next.js completo con Google Login, carrito, pedidos, dashboard y administración.
- NJ comenzó como experiencia para testers y existió la intención de convertirlo en el sistema principal y moverlo a raíz.
- Este contexto no confirma que el cambio de raíz se haya completado. La configuración local muestra redirects hacia `/catalogo`, pero no demuestra por sí sola toda la topología productiva actual.
- La implementación Vanilla/legacy conserva valor de compatibilidad hasta verificar rutas y redirects desplegados.

## INFERIDO

- `nj/` es la aplicación funcional más completa y `catalogo1/` el catálogo público recortado, pero la topología final de producción debe confirmarse.
- El catálogo snapshot busca rendimiento/estabilidad y la vista viva cubre contenido recientemente cambiado.

## DESCONOCIDO

- Hostnames exactos de producción/test para `nj` y `catalogo1` hoy.
- Si NJ continúa limitado a testers o ya es la experiencia general.
- Qué porcentaje de clientes usa dashboard web frente a pedidos administrados por WhatsApp.
- Política vigente de caché/revalidación operativa y SLA de actualización del catálogo.

## Archivos clave

- `nj/app/`
- `nj/middleware.ts`
- `nj/lib/utils/catalog.ts`
- `nj/lib/supabase/queries.ts`
- `nj/hooks/useCatalog.ts`
- `nj/hooks/useCart.ts`
- `nj/lib/cart/checkout-flow.ts`
- `catalogo1/next.config.ts`
- `firebase.json`
- `sw.js`
