# Hardening Supabase FYL — Registro Técnico 2026-05-13

Este documento registra las vulnerabilidades y riesgos detectados en la auditoría viva de Supabase/PostgreSQL, cómo fueron corregidos, qué evidencia se usó y qué queda como riesgo residual para futuras consultas.

Proyecto auditado: FYL, catálogo mayorista B2B mobile-first.

Backend: Supabase/PostgreSQL, Auth, Edge Functions, Storage.

Frontend: HTML/CSS/JavaScript vanilla.

Proyecto Supabase aplicado: `dtfznewwvsadkorxwzft`.

## Resumen Ejecutivo

La base no tenía tablas `public` sin RLS, pero sí una superficie pública demasiado amplia por combinación de:

- Grants excesivos a `anon` y `PUBLIC`.
- RPCs `SECURITY DEFINER` ejecutables por `anon`.
- Views públicas sobre tablas operativas.
- Edge Function `qz-sign` desplegada con secreto compartido histórico.
- Catálogo público calculado en vivo sobre tablas internas de stock, carritos y pedidos.
- Índices faltantes para consultas críticas de dashboard, carrito, pedidos y stock.

El hardening aplicado redujo superficie pública, reforzó autenticación de impresión, creó un snapshot público de catálogo, separó índices concurrentes de migraciones transaccionales y dejó herramientas de auditoría read-only.

## Evidencia Base

Archivos de evidencia generados durante la auditoría:

- `audit-output/live-audit-summary.md`
- `audit-output/live-db-sql-audit.json`
- `audit-output/live-explain-analyze.json`
- `audit-output/live-anon-sensitive-rest.json`
- `audit-output/live-anon-rpc-audit.json`
- `audit-output/live-edge-storage-audit.json`

Documentos relacionados:

- `docs/FYL-Obsidian/28-AUDITORIA-SUPABASE-POSTGRES-2026-05-13.md`
- `docs/FYL-Obsidian/29-ALLOWLIST-ANON-PUBLIC-SURFACE.md`
- `docs/FYL-Obsidian/30-SECURITY-DEFINER-INVENTORY.md`
- `docs/FYL-Obsidian/31-CHECKOUT-CONCURRENCY-RUNBOOK.md`
- `docs/FYL-Obsidian/32-TECH-DEBT-RPC-SOFT-DELETE-SCHEMAS.md`

SQL/scripts creados o ajustados:

- `supabase/canonical/209_security_hardening_followups.sql`
- `supabase/canonical/210_security_hardening_indexes_concurrent.sql`
- `supabase/canonical/211_anon_attack_surface_hardening.sql`
- `supabase/canonical/212_security_definer_grants_batch1.sql`
- `supabase/canonical/213_catalog_public_snapshot.sql`
- `scripts/supabase-readonly-audit.sql`
- `scripts/audit-edge-public-surface.mjs`
- `scripts/checkout-concurrency-smoke.mjs`

## Estado Final Verificado

Verificación final ejecutada contra la base viva:

- Tablas `public` sin RLS: `0`.
- Grants `anon` sobre superficie cerrada (`vw_stock_*`, `public_sales`, `public_sale_items`): `0`.
- Índices de hardening presentes: `11`.
- Paridad catálogo view vs snapshot: `1381 / 1381`.
- `SECURITY DEFINER` ejecutables por `anon`: bajaron de `140` a `61`.
- `SECURITY DEFINER` sin `search_path` seguro detectable: bajaron de `49` a `20`.
- `qz-sign` sin JWT responde `401` por auth/JWT, no por `x-qz-secret`.
- `catalog_public_snapshot` es legible por `anon`.
- `vw_stock_audit_snapshot` quedó cerrado a `anon`.

## Vulnerabilidades Y Correcciones

### 1. QZ Sign Con Secreto Compartido Expuesto

Severidad: crítica.

Estado previo:

- `QZ_SIGN_SECRET` estaba disponible para el navegador.
- `admin/qz-printing.js` firmaba llamando a `qz-sign` con header `x-qz-secret`.
- La Edge Function `qz-sign` respondía en producción con `Unauthorized: Missing or invalid x-qz-secret`, evidencia de que el deployment vivo todavía usaba el secreto compartido.
- `verify_jwt` no estaba activo en el deployment previo.

Impacto:

Un atacante con acceso al bundle o a `window.QZ_SIGN_SECRET` podía llamar la función de firmado y obtener firmas QZ sin sesión Supabase ni permisos admin. Eso comprometía la confianza del sistema de impresión interna.

Corrección aplicada:

- `supabase/functions/qz-sign/index.ts` ahora exige `Authorization: Bearer <access_token>`.
- La función valida el JWT con Supabase Auth.
- Luego verifica que el usuario tenga fila en `public.admins`.
- `supabase/config.toml` y `supabase/functions/qz-sign/config.toml` quedaron con `verify_jwt = true`.
- `admin/qz-printing.js` dejó de usar `x-qz-secret` y ahora envía el access token de la sesión Supabase.
- `scripts/config.js`, `config.prod.js`, `scripts/config.local.js` y `scripts/config.local.example.js` dejaron de exponer secretos de firma.
- Se redeployó `qz-sign`.
- Se rotó `QZ_SIGN_SECRET` histórico en Supabase Secrets.

Verificación:

- `POST /functions/v1/qz-sign` sin JWT devolvió `401` con `UNAUTHORIZED_NO_AUTH_HEADER`.
- Ya no aparece el mensaje de `x-qz-secret`.

Riesgo residual:

- Si se sospecha que el secreto expuesto fue usado, evaluar rotar también `QZ_PRIVATE_KEY_B64` y certificado QZ.
- Mantener `scripts/audit-edge-public-surface.mjs` como check post-deploy.

### 2. RPCs De Vinculación Ejecutables Por `anon`

Severidad: alta.

Estado previo:

La auditoría viva mostró que `anon` podía ejecutar:

- `get_customer_id_for_user(uuid)`
- `rpc_link_or_create_customer(uuid,text,text,text,text)`

Ambas eran funciones sensibles porque operan cerca de `customers`, Auth links, pedidos o carrito.

Impacto:

Un caller anónimo podía invocar lógica privilegiada `SECURITY DEFINER` con parámetros controlados. Aunque algunas validaciones internas podían frenar casos, la exposición no era necesaria para el flujo real autenticado.

Corrección aplicada:

- Se revocó `EXECUTE` de `anon` y `PUBLIC`.
- Se reotorgó explícitamente a `authenticated` y `service_role`.
- El primer intento revocaba solo `anon`, pero la verificación mostró que el permiso seguía heredado por `PUBLIC`. Se corrigió revocando también `PUBLIC`.

Verificación:

- `anon_can_execute = false`.
- `authenticated = true`.
- `service_role = true`.

Lección:

En PostgreSQL/Supabase no alcanza con revocar `anon` si `PUBLIC` conserva `EXECUTE`. Para RPCs sensibles hay que revisar `has_function_privilege('anon', oid, 'EXECUTE')`, no solo grants nominales.

### 3. Views De Auditoría Stock Públicas

Severidad: alta.

Estado previo:

Las views `vw_stock_*` eran accesibles por `anon`, incluyendo:

- `vw_stock_audit_snapshot`
- `vw_stock_audit_reserved_qty_diff`
- `vw_stock_dead_products`
- `vw_stock_fast_sellers`
- `vw_stock_publication_inefficiency`
- `vw_stock_publication_last_pub_performance`
- `vw_stock_tag_summary`
- otras views `vw_stock_audit_*`

Impacto:

Estas views no exponen necesariamente PII, pero sí inteligencia comercial: productos muertos, fast sellers, drift de reservas, stock operativo, performance de publicaciones y señales de auditoría. En un negocio B2B mayorista esto puede revelar rotación, demanda y debilidades operativas.

Corrección aplicada:

- `supabase/canonical/211_anon_attack_surface_hardening.sql` revoca `ALL` de `anon` y `PUBLIC` sobre `vw_stock_*`.
- Mantiene `SELECT` para `authenticated`, porque `admin/stock-audit.js` usa estas views.
- Se redujeron grants de `authenticated` a solo `SELECT` en esas views.

Verificación:

- Grants `anon` sobre `vw_stock_*`: `0`.
- `scripts/audit-edge-public-surface.mjs` confirmó que `vw_stock_audit_snapshot` responde cerrado a `anon`.

Riesgo residual:

- `authenticated` sigue pudiendo leer estas views; RLS/policies de admin deben sostener la separación operativa si en el futuro hay usuarios autenticados no admin con acceso directo al cliente Supabase.

### 4. `public_sales` Y `public_sale_items` Accesibles Por `anon`

Severidad: alta.

Estado previo:

La auditoría REST `anon` devolvía filas reales de:

- `public_sales`
- `public_sale_items`

Además existían policies `public_sales_public_access` y `public_sale_items_public_access` con `SELECT true` para `anon, authenticated`.

Impacto:

Exposición de ventas públicas, importes, fechas, items, variantes y actividad comercial interna. Aunque algunas filas no tengan `customer_id`, la información es sensible para el negocio.

Corrección aplicada:

- Se revocó `ALL` de `anon` y `PUBLIC`.
- Se eliminaron policies públicas de SELECT.
- Se conservaron permisos `SELECT, INSERT, UPDATE, DELETE` para `authenticated`, compatibles con caja/admin.
- Se removieron privilegios innecesarios como `TRIGGER`, `TRUNCATE` y `REFERENCES` para `authenticated`.

Verificación:

- Grants `anon` sobre `public_sales` y `public_sale_items`: `0`.

Riesgo residual:

- Revisar si todo usuario autenticado puede llegar a caja/admin. Si aparecen clientes autenticados con acceso al cliente Supabase, conviene mover estos grants a RPCs admin-only o policies estrictas por `public.is_admin()`.

### 5. Exceso De `SECURITY DEFINER` Ejecutable Por `anon`

Severidad: alta.

Estado previo:

Baseline vivo:

- `161` funciones `SECURITY DEFINER` en schema `public`.
- `140` ejecutables por `anon`.
- `49` sin `search_path` seguro detectable.

Impacto:

Una función `SECURITY DEFINER` ejecuta con privilegios del owner. Si está expuesta a `anon`, cualquier bug de validación interna se vuelve una escalada de permisos. La cantidad elevada también dificulta auditoría, rollback y razonamiento de seguridad.

Corrección aplicada:

- Se creó `supabase/canonical/212_security_definer_grants_batch1.sql`.
- Batch 1 revocó `EXECUTE` de `anon` y `PUBLIC` en RPCs de:
  - administración,
  - métricas,
  - ventas públicas internas,
  - pedidos,
  - stock,
  - compras/proveedores,
  - colaboradores,
  - perfil autenticado.
- Se conservó `EXECUTE` para `authenticated` y `service_role`.
- Se aplicó `ALTER FUNCTION ... SET search_path = public, pg_catalog`.
- No se reescribieron cuerpos ni firmas para minimizar riesgo.

Verificación:

- `SECURITY DEFINER` ejecutables por `anon`: `140 -> 61`.
- Sin `search_path` seguro detectable: `49 -> 20`.

Allowlist temporal no tocada:

- `rpc_get_variant_size_reserved(uuid[])`
- `get_meta_feed()`
- Helpers públicos de catálogo/tags/ofertas/imágenes

Riesgo residual:

- Quedan `61` funciones ejecutables por `anon`. No todas son vulnerabilidades, pero deben tener justificación pública explícita.
- Próximos batches: triggers internos, helpers legacy y funciones públicas reales con contrato mínimo.

### 6. Catálogo Público Calculado Sobre Tablas Operativas

Severidad: alta.

Estado previo:

`catalog_public_available_view` era pública y calculaba disponibilidad leyendo tablas operativas como stock, carritos, pedidos y reservas. Esto era funcional, pero mezclaba API pública con datos internos y hacía difícil revocar `anon` de tablas operativas.

Impacto:

- Superficie pública difícil de razonar.
- Riesgo de fuga si la view incorpora columnas internas.
- Performance variable por joins/agregaciones en vivo.
- Dependencia de grants directos a objetos operativos.

Corrección aplicada:

- Se creó `public.catalog_public_snapshot` con la forma compatible de `catalog_public_available_view`.
- Se creó `public.catalog_public_snapshot_meta`.
- Se creó `rpc_refresh_catalog_public_snapshot()`, admin-only.
- Se cargó el snapshot inicial.
- `anon` puede hacer `SELECT` sobre `catalog_public_snapshot`.
- `anon` no puede refrescar el snapshot.
- `scripts/main-supabase.js` ahora usa snapshot por defecto con fallback configurable a la view anterior:
  - default: `catalog_public_snapshot`
  - override: `localStorage.FYL_USE_CATALOG_SNAPSHOT = "0"` o `window.FYL_USE_CATALOG_SNAPSHOT = false`
- Se redujo el `select("*")` principal del catálogo a una lista explícita de columnas publicables.

Verificación:

- `catalog_public_available_view`: `1381` filas.
- `catalog_public_snapshot`: `1381` filas.
- `anon_can_select_snapshot = true`.
- `anon_can_refresh = false`.

Riesgo residual:

- Todavía no se revocó `anon` de `products`, `product_variants`, `variant_warehouse_stock` ni `variant_size_warehouse_stock`, porque puede haber dependencias directas del frontend/PDP/carrito.
- Siguiente paso seguro: medir paridad y uso real del snapshot, luego retirar dependencias directas por etapas.

### 7. Índices Faltantes En Pedidos, Carritos, Stock Y Dashboard

Severidad: media/alta.

Estado previo:

La auditoría viva detectó:

- `orders` con aproximadamente `47M` sequential scans acumulados.
- `order_item_stock_sources` con scans masivos.
- `dashboard_orders_recent` hacía seq scan + sort.
- Faltaban índices compuestos explícitos para lookup de carrito, pedidos, items y stock por talle/warehouse.

Impacto:

Riesgo de degradación con 10x tráfico, especialmente en mobile y admin. El costo de dashboard/admin puede competir con checkout si crece el volumen.

Corrección aplicada:

Se separó `supabase/canonical/210_security_hardening_indexes_concurrent.sql` porque `CREATE INDEX CONCURRENTLY` no puede ejecutarse dentro de transacción.

Índices aplicados:

- `idx_carts_customer_status_created_at`
- `idx_cart_items_cart_id`
- `idx_cart_items_variant_size_status`
- `idx_orders_customer_status_created_at`
- `idx_orders_status_updated_at`
- `idx_orders_created_at_desc`
- `idx_order_items_order_id`
- `idx_order_items_variant_size`
- `idx_order_item_stock_sources_order_item_id`
- `idx_order_item_stock_sources_warehouse_id`
- `idx_variant_size_wh_stock_variant_size_wh`

Se ejecutó `ANALYZE` en tablas afectadas.

Verificación:

- Índices presentes: `11`.
- `dashboard_orders_recent` pasó de seq scan + sort a `Index Scan` sobre `idx_orders_created_at_desc`.
- Tiempo medido aproximado:
  - antes: `~1.54 ms`
  - después: `~0.11 ms`

Riesgo residual:

- `pg_stat_user_indexes` necesita ventana de uso real para confirmar beneficio sostenido.
- Los índices concurrentes consumen IO/CPU al crearse; ya fueron ejecutados, pero deben mantenerse separados de migraciones transaccionales.

### 8. Observabilidad Insuficiente Para Drift Y Regresiones

Severidad: media.

Estado previo:

La auditoría viva detectó drift entre repo y producción, especialmente en `qz-sign`. Sin checks repetibles, una regresión de deploy podía volver a exponer secretos o grants.

Corrección aplicada:

Se crearon checks read-only:

- `scripts/supabase-readonly-audit.sql`
- `scripts/audit-edge-public-surface.mjs`

El SQL verifica:

- tablas `public` sin RLS,
- superficie `anon` fuera de allowlist,
- RPCs `SECURITY DEFINER` ejecutables por `anon`,
- funciones sin `search_path` seguro,
- top sequential scans,
- índices de hardening,
- invariantes de stock,
- paridad snapshot vs view.

El script Edge/REST verifica:

- `qz-sign` exige JWT y no acepta `x-qz-secret`,
- `catalog_public_snapshot` es legible por `anon`,
- `vw_stock_audit_snapshot` está cerrado a `anon`.

Verificación:

El script Edge/REST devolvió:

- `OK qz-sign requires JWT: HTTP 401`
- `OK catalog snapshot anon readable: HTTP 200`
- `OK stock audit snapshot anon closed: HTTP 401`

Nota de entorno:

En Windows/Node local apareció un problema de certificado intermedio. Se agregó `FYL_AUDIT_INSECURE_TLS=1` solo para auditoría local cuando el entorno tenga ese problema. No usar ese flag en producción ni en automatizaciones sensibles.

### 9. Riesgo De Overselling Y Concurrencia De Checkout

Severidad: crítica para negocio, no modificada en producción.

Estado previo:

El checkout usa RPCs críticas, stock reservado y lógica de idempotencia. La auditoría no ejecutó doble checkout concurrente contra datos reales para evitar contaminar stock.

Impacto:

Si dos checkouts simultáneos descuentan el mismo stock sin locks/idempotencia correcta, puede haber overselling, pedidos inconsistentes o reservas infladas/desinfladas.

Corrección aplicada:

No se modificó la lógica de stock/checkout en producción.

Se creó:

- `scripts/checkout-concurrency-smoke.mjs`
- `docs/FYL-Obsidian/31-CHECKOUT-CONCURRENCY-RUNBOOK.md`

El harness cubre:

- mismo `operation_id` repetido,
- dos `operation_id` distintos sobre el mismo carrito.

Tiene guardrails:

- exige staging o fixtures aislados,
- se niega a correr contra producción salvo `FYL_CONCURRENCY_ALLOW_PROD_FIXTURES=1`,
- requiere token/cart de prueba.

Verificación:

Ejecutado sin variables, falló de forma segura:

- `Faltan variables: SUPABASE_URL, FYL_TEST_ACCESS_TOKEN, FYL_TEST_CART_ID`

Riesgo residual:

- Falta correr pruebas reales en staging o fixtures aislados.
- No tocar lógica de descuento/reserva hasta completar esos escenarios.

### 10. `select("*")` En Catálogo Y Riesgo Mobile

Severidad: media.

Estado previo:

El catálogo usaba `select("*")` contra views públicas. Esto aumenta payload, latencia mobile y riesgo de exposición accidental si la view suma columnas nuevas.

Corrección aplicada:

En `scripts/main-supabase.js` se agregó `CATALOG_PUBLIC_SELECT` con columnas explícitas publicables:

- categoría,
- artículo,
- descripción,
- color,
- numeración,
- precio,
- imágenes,
- filtros,
- datos de oferta/promo,
- color display,
- supplier code.

El catálogo principal usa esa lista explícita contra `catalog_public_snapshot`.

Verificación:

- `rg` ya no encontró `select("*")` ni `select('*')` en `scripts/main-supabase.js`.
- `node --check scripts/main-supabase.js` pasó.

Riesgo residual:

- Quedan otros `select("*")` en admin y otros módulos. Deben reducirse gradualmente según criticidad y payload.

## Allowlist Pública Actual

Permitidos temporalmente para `anon`:

- `catalog_public_snapshot`: fuente pública preferida.
- `catalog_public_view`: compatibilidad temporal.
- `catalog_public_available_view`: compatibilidad temporal.
- `get_meta_feed()`: Meta Commerce, mientras no haya endpoint firmado/cacheado.
- `rpc_get_variant_size_reserved(uuid[])`: dependencia temporal de catálogo/PDP.
- `products`, `product_variants`, `variant_warehouse_stock`, `variant_size_warehouse_stock`: dependencia temporal hasta completar migración a snapshot.

Denylist cerrada:

- `vw_stock_*`
- `public_sales`
- `public_sale_items`
- `get_customer_id_for_user(uuid)` para `anon`
- `rpc_link_or_create_customer(uuid,text,text,text,text)` para `anon`

## Qué No Se Tocó A Propósito

- No se cambió la lógica central de `rpc_checkout_cart()`.
- No se eliminó la firma legacy de checkout.
- No se revocó `anon` de tablas operativas todavía usadas por catálogo/PDP.
- No se cambió `catalog_public_available_view` a `security_invoker`.
- No se modificaron cascades ni se implementó soft delete en caliente.
- No se cerró `meta-feed` porque puede depender de Meta Commerce.
- No se ejecutaron pruebas destructivas de overselling en producción real.

## Comandos Y Checks Recomendados A Futuro

Auditoría SQL read-only:

```sql
-- Ejecutar contenido de:
-- scripts/supabase-readonly-audit.sql
```

Auditoría Edge/REST:

```bash
SUPABASE_ANON_KEY="<anon-key>" node scripts/audit-edge-public-surface.mjs
```

Solo si el entorno local Windows/Node falla por certificado:

```bash
FYL_AUDIT_INSECURE_TLS=1 SUPABASE_ANON_KEY="<anon-key>" node scripts/audit-edge-public-surface.mjs
```

Refresh manual del snapshot, como admin:

```sql
select public.rpc_refresh_catalog_public_snapshot();
```

Verificar paridad:

```sql
select
  (select count(*) from public.catalog_public_available_view) as view_rows,
  (select count(*) from public.catalog_public_snapshot) as snapshot_rows;
```

Verificar grants críticos:

```sql
select
  p.oid::regprocedure as function_signature,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'get_customer_id_for_user',
    'rpc_link_or_create_customer',
    'rpc_refresh_catalog_public_snapshot'
  )
order by 1;
```

## Próximas Decisiones Técnicas

1. Completar pruebas de concurrencia en staging.
2. Migrar todo catálogo/PDP a `catalog_public_snapshot`.
3. Retirar `anon` de `products`, `product_variants`, `variant_warehouse_stock` y `variant_size_warehouse_stock` cuando no haya consumidores directos.
4. Reemplazar `rpc_get_variant_size_reserved(uuid[])` público por disponibilidad precalculada en snapshot.
5. Revisar los `61` `SECURITY DEFINER` que siguen ejecutables por `anon`.
6. Reducir `select("*")` en admin de alto payload.
7. Diseñar soft delete antes de tocar cascades.
8. Separar schemas: `public` mínimo, `internal/private` para lógica operativa.

## Resultado Operativo

El hardening principal ya fue aplicado en la base viva. Este documento queda como registro para entender:

- qué estaba expuesto,
- por qué era riesgoso,
- qué SQL/código lo corrigió,
- cómo se verificó,
- qué no se tocó para no romper producción,
- y qué queda como deuda técnica controlada.
