# Auditoría Supabase/PostgreSQL FYL — 2026-05-13

## Alcance y límites

Auditoría estática de producción basada en el schema SQL versionado, Edge Functions y código JS del workspace. No se pudo obtener salida útil del CLI/MCP de Supabase en esta sesión, por lo que los hallazgos no dependen de supuestos de la base viva. Las secciones de `EXPLAIN ANALYZE`, advisors y grants efectivos deben ejecutarse en Supabase SQL Editor antes del deploy final.

Archivos principales revisados:

- `supabase/canonical/*`
- `supabase/config.toml`
- `supabase/functions/*`
- `scripts/supabase-client.js`
- `scripts/config.js`
- `scripts/cart-persistent.js`
- `scripts/main-supabase.js`
- `client/dashboard-instant.js`
- `admin/*.js`

## Resumen ejecutivo

El proyecto ya contiene hardening importante: RLS en tablas core, `SET search_path` en muchas funciones críticas, wrappers idempotentes para checkout/stock, revocación de funciones legacy de carrito, auditorías pre/post deploy y fixes recientes para tablas operativas (`151`, `153`, `183`, `208`).

Persistían riesgos reales:

- Crítico: `QZ_SIGN_SECRET` estaba expuesto en archivos del navegador y la Edge Function `qz-sign` aceptaba un secreto compartido con `verify_jwt=false`.
- Alto: varias vistas/RPCs públicas entregan datos agregados operativos con `SECURITY DEFINER` o grants a `anon`. Algunas son intencionales por catálogo/Meta, pero deben monitorearse como superficie pública.
- Alto: el checkout legacy `rpc_checkout_cart()` sigue siendo el cuerpo canónico delegado por el wrapper idempotente; tiene locks relevantes, pero la firma vieja no exige `operation_id` y debe quedar en transición controlada.
- Medio: faltaban índices compuestos explícitos para queries críticas de checkout, carrito, stock reservado y dashboards admin.
- Medio: varios `select("*")` en JS/admin elevan payload, latencia móvil y riesgo de exponer columnas nuevas si una policy/grant se relaja.

## Hallazgos críticos

### CRIT-1 — Secreto QZ expuesto en frontend + Edge Function sin JWT

Evidencia:

- `config.prod.js` exponía `window.QZ_SIGN_SECRET`.
- `config.local.js` contenía otro secreto QZ.
- `scripts/config.js` leía `QZ_SIGN_SECRET` desde `window`/local config.
- `admin/qz-printing.js` enviaba `x-qz-secret`.
- `supabase/config.toml` y `supabase/functions/qz-sign/config.toml` tenían `verify_jwt = false`.
- `supabase/functions/qz-sign/index.ts` autorizaba solo por secreto compartido.

Impacto real:

Un usuario con acceso al bundle publicado podía extraer el secreto y llamar la función de firmado QZ desde un origin permitido. La función firma payloads arbitrarios con la clave privada QZ, lo que rompe el modelo de confianza de impresión interna.

Cómo reproducir:

1. Abrir producción.
2. Leer `window.QZ_SIGN_SECRET` o descargar `config.prod.js`.
3. Enviar `POST /functions/v1/qz-sign` con header `x-qz-secret`.
4. Recibir firma válida sin sesión Supabase.

Fix aplicado:

- `QZ_SIGN_SECRET` ya no se expone en `config.prod.js`, `config.local.js` ni `scripts/config.js`.
- `admin/qz-printing.js` ahora usa `Authorization: Bearer <access_token>`.
- `qz-sign` ahora exige JWT y valida que el usuario tenga fila en `public.admins`.
- `verify_jwt` quedó en `true` para `qz-sign`.

Acción manual obligatoria:

- Rotar `QZ_SIGN_SECRET` aunque ya no se use.
- Rotar `QZ_PRIVATE_KEY_B64`/certificado QZ si el secreto expuesto pudo usarse en producción.
- Redeploy de Edge Function `qz-sign`.

### CRIT-2 — Funciones legacy de carrito podían ser críticas si el fix 183 no está aplicado en producción

Evidencia:

- `183_revoke_legacy_cart_function_grants.sql` documenta que `clear_cart_items(cart_uuid)` podía borrar items de cualquier carrito y que varias funciones legacy tenían `EXECUTE` a `PUBLIC`, `anon` o `authenticated`.

Impacto real:

Si producción no tiene `183`, un atacante anónimo o autenticado podría borrar, leer o mutar carritos por UUID o ejecutar flujos de reserva/submit alternativos.

Cómo reproducir:

```sql
SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE')
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('clear_cart_items','add_cart_item','get_user_cart','rpc_submit_cart');
```

Solución:

Aplicar/verificar `183_revoke_legacy_cart_function_grants.sql` y el follow-up `209_security_hardening_followups.sql`.

## Hallazgos altos

### HIGH-1 — RPCs de vinculación de customer históricamente expuestas a anon

Evidencia:

- `26_sistema_vinculacion_completo.sql` otorgaba `EXECUTE` a `anon` para `get_customer_id_for_user(uuid)` y `rpc_link_or_create_customer(...)`.
- `153_fix_anon_grants.sql` revoca esos permisos.

Impacto:

Sin `153`, un cliente anónimo podía invocar funciones `SECURITY DEFINER` que leen/modifican `customers`, `orders`, `carts` y `customer_auth_links` con parámetros controlados por el caller.

Solución:

Confirmar en producción que `anon_can_execute = false` para esas funciones. El archivo `209_security_hardening_followups.sql` reafirma la revocación.

### HIGH-2 — `rpc_link_public_sales_customer(...)` sigue callable por anon

Evidencia:

- `30_link_public_sales_customer.sql` concede `EXECUTE` a `authenticated, anon`.
- La función busca por DNI/teléfono/nombre y devuelve campos de cliente público o admin-created.

Impacto:

Puede permitir enumeración parcial de clientes por DNI/teléfono si no hay rate limit y si el flujo público no exige un token de invitación/QR fuerte.

Riesgo de tocar ahora:

Puede romper onboarding/vinculación desde QR si ese flujo depende de acceso anónimo.

Recomendación:

No revocar en caliente sin revisar UX. Reemplazar por RPC con token de invitación de un solo uso, expiración, límite de intentos y respuesta constante (`found` sin datos sensibles hasta autenticación).

### HIGH-3 — `catalog_public_available_view` es una vista pública compleja sobre tablas operativas

Evidencia:

- `193_catalog_public_available_view.sql` crea una view pública con grants a `anon` y `authenticated`.
- La view calcula disponibilidad leyendo `order_item_stock_sources`, `order_items`, `orders`, `cart_items`, `carts`, stock, promociones e imágenes.

Impacto:

Como vista normal de Postgres, puede comportarse como security definer si no se declara `security_invoker=true`. Cambiarla directamente a invoker probablemente rompa el catálogo porque `anon` no debe tener SELECT directo sobre tablas operativas de carritos/pedidos.

Solución recomendada:

No hacer `ALTER VIEW ... security_invoker=true` sin reemplazo. Crear una tabla/proyección pública de catálogo (`catalog_public_snapshot`) mantenida por job/RPC admin que contenga solo campos publicables y stock disponible ya agregado. Dar `anon SELECT` solo a esa proyección.

### HIGH-4 — `rpc_get_variant_size_reserved(uuid[])` expone reservas agregadas a anon

Evidencia:

- `183_rpc_get_variant_size_reserved.sql` concede execute a `anon`.
- La función agrega reservas desde pedidos activos y carritos abiertos.

Impacto:

No filtra PII, pero expone señal operacional: demanda/reservas por variante y talle. En B2B mayorista esto puede revelar velocidad de venta o presión de stock a competidores.

Riesgo de tocar ahora:

El catálogo, PDP, carrito y dashboard lo usan para disponibilidad visual.

Solución futura:

Fusionar ese cálculo en la proyección pública de catálogo y retirar el RPC de `anon`. Mantenerlo para `authenticated`/admin si hace falta diagnóstico.

## Hallazgos medios

### MED-1 — Índices compuestos faltantes o no explícitos en queries críticas

Evidencia:

- Checkout busca `carts` por `(customer_id, status, created_at desc)`.
- Checkout busca `orders` por `(customer_id, status, created_at desc)`.
- Disponibilidad pública agrega `cart_items`, `order_items`, `order_item_stock_sources`, `variant_size_warehouse_stock`.

Impacto:

A 10x tráfico, los scans/joins en carrito y stock reservado se vuelven caros y elevan latencia mobile.

Fix:

`209_security_hardening_followups.sql` agrega índices concurrentes idempotentes.

### MED-2 — `select("*")` frecuente en frontend/admin

Evidencia:

Hay múltiples `select("*")` en `scripts/main-supabase.js`, `scripts/cart-persistent.js`, `admin/products.js`, `admin/public-sales.js`, `admin/offers.js`, `admin/stock-audit.js`, etc.

Impacto:

Payload excesivo en mobile, riesgo de exponer columnas futuras y peor cacheabilidad. Es especialmente sensible en vistas públicas de catálogo.

Solución:

Reducir primero en catálogo público y carrito: seleccionar columnas estrictas, usar `range`, y evitar traer imágenes/metadata que no renderizan en viewport inicial.

### MED-3 — Edge Functions con CORS amplio o token opcional

Evidencia:

- `upload-image` usa `Access-Control-Allow-Origin: *`, pero valida JWT y permiso `products/edit`.
- `meta-feed` usa service role y token opcional: si `META_FEED_TOKEN` está vacío, el feed queda público.
- `passkeys` usa service role y CORS `*` en respuestas de error/preflight, aunque valida origin en handlers.

Impacto:

No todos son vulnerabilidades explotables por sí mismas, pero agrandan superficie y dificultan auditoría.

Solución:

Hacer tokens obligatorios donde haya service role y datos comerciales, devolver CORS solo a origins permitidos, y normalizar `SUPABASE_SERVICE_ROLE_KEY` vs `SERVICE_ROLE_KEY`.

## Hallazgos bajos

### LOW-1 — `search_path = public` sin `pg_catalog` en funciones antiguas

Evidencia:

Hay funciones antiguas con `set search_path = public` o `public, auth`. Existen scripts `110` y `152` para corregir alertas, pero conviene verificar la base real.

Impacto:

Riesgo bajo/medio de resolución inesperada de objetos si existen objetos maliciosos o duplicados en schemas del path.

Solución:

Ejecutar advisor de funciones y asegurar `public, pg_catalog` salvo funciones que requieran `auth`.

### LOW-2 — `ON DELETE CASCADE` amplio en entidades operativas

Evidencia:

Pedidos, order items, ledgers, notificaciones y algunas tablas de compra usan cascadas.

Impacto:

Útil para limpieza, pero peligroso ante borrados admin/productos. Puede borrar trazabilidad si no se audita antes.

Solución:

No tocar ahora. Para producción madura, preferir soft delete en entidades de negocio (`orders`, `products`, `customers`) y cascada solo en tablas estrictamente derivadas.

## Stock, concurrencia y overselling

Estado actual:

- `rpc_checkout_cart(uuid,jsonb)` agrega idempotencia por `operation_id`, fingerprint y lock pesimista sobre el carrito.
- La firma nueva delega en `rpc_checkout_cart()` legacy.
- El cuerpo legacy bloquea `product_variants` con `FOR UPDATE` y filas de `variant_size_warehouse_stock` con `FOR UPDATE`.
- Existen funciones fuertes para void/devolución/move/reconcile y ledger de liberación idempotente.

Riesgo residual:

- La firma legacy sin `operation_id` sigue existiendo por compatibilidad. Si algún cliente viejo la llama directamente, no hay replay-safe end-to-end.
- La disponibilidad del catálogo se calcula por view/RPC pública y puede quedarse cara con tráfico alto.
- La consistencia entre `product_variants.reserved_qty`, `variant_size_warehouse_stock`, `order_item_stock_sources` y `cart_items.status='reserved'` requiere smoke tests en producción.

Pruebas obligatorias:

```sql
-- Pedidos finales recientes sin ledger de liberacion
SELECT o.id, o.status, o.updated_at
FROM public.orders o
LEFT JOIN public.order_reserved_qty_released r ON r.order_id = o.id
WHERE o.status IN ('sent', 'expired', 'devolución')
  AND o.updated_at > now() - interval '7 days'
  AND r.order_id IS NULL
ORDER BY o.updated_at DESC;

-- Doble reserva por fuente
SELECT order_item_id, warehouse_id, count(*), sum(qty)
FROM public.order_item_stock_sources
GROUP BY order_item_id, warehouse_id
HAVING count(*) > 1;

-- Stock negativo por talle/warehouse
SELECT *
FROM public.variant_size_warehouse_stock
WHERE stock_qty < 0;
```

## EXPLAIN ANALYZE recomendado

Ejecutar en staging o producción con cuidado:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM public.carts
WHERE customer_id = '<CUSTOMER_UUID>'::uuid
  AND status = 'open'
ORDER BY created_at DESC
LIMIT 1;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, expires_at, dismantle_at
FROM public.orders
WHERE customer_id = '<CUSTOMER_UUID>'::uuid
  AND status IN ('active', 'closing_soon')
ORDER BY
  CASE WHEN status = 'active' THEN 0 WHEN status = 'closing_soon' THEN 1 ELSE 2 END,
  created_at DESC
LIMIT 1;

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM public.catalog_public_available_view
LIMIT 50;
```

## SQL listo para ejecutar

1. `supabase/canonical/209_security_hardening_followups.sql`
2. `supabase/canonical/208b_audit_public_rls_exposure.sql`
3. `supabase/canonical/208_PRE_DEPLOY_SMOKE_TEST.sql`
4. `supabase/canonical/208_POST_DEPLOY_SMOKE_TEST.sql`

## Checklist de hardening

- Rotar secretos QZ y redeploy de `qz-sign`.
- Confirmar `verify_jwt=true` en Supabase para `qz-sign`.
- Ejecutar advisors de Supabase Security y Performance.
- Ejecutar `208b_audit_public_rls_exposure.sql`.
- Confirmar 0 tablas sensibles con `RLS OFF + grants anon/authenticated`.
- Confirmar 0 funciones `SECURITY DEFINER` con execute a `anon` salvo lista pública aprobada.
- Confirmar `catalog_public_available_view` no expone PII y medir plan.
- Ejecutar `209_security_hardening_followups.sql`.
- Ejecutar smoke tests pre/post deploy.
- Revisar logs Edge Function por 401/403 esperados tras hardening QZ.

## Quick wins

- Reducir `select("*")` del catálogo público.
- Cachear catálogo público en proyección/snapshot.
- Paginación real en admin lists.
- Rate limit en RPCs públicas de vinculación/consulta.
- Unificar variables de Edge Functions: `SUPABASE_SERVICE_ROLE_KEY` o `SERVICE_ROLE_KEY`, no ambas.

## Riesgos a 10x tráfico

- View pública de catálogo con joins y agregaciones sobre tablas operativas.
- RPC de reservas por talle callable desde UI con arrays grandes.
- Admin dashboards con `.limit(1000)` y `select("*")`.
- Edge `meta-feed` sin cache efectivo (`no-store`) para consumidores externos.
- Índices parciales faltantes en estados activos/finales si crecen `orders` y `order_items`.

## Riesgos mobile-first

- Payload grande de catálogo por `select("*")` y múltiples imágenes por producto.
- Round trips adicionales para reservas por talle.
- Timeouts largos de Supabase (`55s`) ocultan degradaciones en 4G.
- Falta de proyección liviana para listados iniciales.

## Riesgos B2B mayorista

- Exposición agregada de reservas/stock puede revelar demanda por talle.
- Vinculación por DNI/teléfono debe tener rate limit y respuestas constantes.
- Pedidos sin pago dependen de reservas correctas y liberación idempotente.
- Operaciones admin de stock necesitan ledger/auditoría inmutable antes de permitir borrados masivos.

## No tocar todavía

- No revocar `anon` de `rpc_get_variant_size_reserved` sin reemplazo de catálogo.
- No cambiar `catalog_public_available_view` a `security_invoker` sin snapshot público.
- No eliminar firma legacy `rpc_checkout_cart()` hasta migrar todos los clientes a `rpc_checkout_cart(uuid,jsonb)`.
- No cambiar cascadas de pedidos/productos sin plan de soft delete y auditoría.
