# 73 — Security Advisor Supabase: vistas definer y tablas sin RLS — 2026-10-08

> **Estado:** 5 de 6 alertas cerradas en producción (`fyl-core`, `dtfznewwvsadkorxwzft`) el 2026-10-08 con aprobación explícita del usuario. Registro versionado: `supabase/canonical/370_advisors_stock_audit_views_invoker_cod_tables.sql` (+ `370_ROLLBACK_…`).
> **Excepción aceptada:** `catalog_public_available_view` sigue como security definer (decisión del usuario 2026-10-09: documentar, no aplicar). Ver § Excepción.

## Alertas recibidas

| Lint | Objeto | Resultado |
|---|---|---|
| 0010 `security_definer_view` | `vw_stock_audit_untracked_sales` | Cerrada (370) |
| 0010 `security_definer_view` | `vw_stock_audit_untracked_sales_watchlist` | Cerrada (370) |
| 0013 `rls_disabled_in_public` | `_cod_fase5_test_log` | Cerrada (370) |
| 0013 `rls_disabled_in_public` | `_cod_286_sql_chunks` | Cerrada (370) |
| 0013 `rls_disabled_in_public` | `_cod_286_b64_parts` | Cerrada (370) |
| 0010 `security_definer_view` | `catalog_public_available_view` | **Excepción documentada** |

## Vistas de auditoría de stock (341/343) — fuga real

**TÉCNICA VERIFICADA (2026-10-08, producción):**

- 341 y 343 solo hacen `GRANT SELECT … TO authenticated`, pero los default privileges del schema `public` le dieron también `ALL` a `anon`. Regresión respecto de `211_anon_attack_surface_hardening.sql`, que había cerrado `vw_stock_*` para `anon` antes de que existieran estas vistas.
- Al correr como owner (`postgres`) se salteaban RLS. Simulado con `SET LOCAL ROLE anon`: **8.538 filas** de eventos y **565 filas de watchlist con 170 emails de admins** (la watchlist hace join a `public.admins`). Un cliente logueado no admin veía lo mismo.
- Único consumidor en código: `admin/stock-audit.js` (`loadUntrackedSalesWatchlist`).

**Fix (370):** `REVOKE ALL … FROM anon`, `authenticated` reducido a `SELECT`, `security_invoker = true` en ambas vistas.

**Verificación post-cambio:**

- `anon` → `permission denied for view vw_stock_audit_untracked_sales_watchlist`.
- Admin (JWT simulado de un `admins.user_id`): 8.538 / 565 filas, 170 emails, **mismo md5** que antes del cambio. Funciona por las policies `public_sale_items_admin_all`, `public_sales_admin_all`, `orders_admin_manage`, `order_items_admin_manage` y `authenticated_select_admins`.
- Cliente logueado no admin: 0 filas.

**Riesgo de regresión:** si una migración futura recrea estas vistas (`CREATE OR REPLACE VIEW` / `DROP` + `CREATE`), tiene que incluir `WITH (security_invoker = true)` y no otorgar nada a `anon`. Revisar también los default privileges: toda vista nueva en `public` nace con `ALL` para `anon`.

## Tablas `_cod_*` — restos de pruebas

- `_cod_fase5_test_log` (32 filas, log de pruebas COD fase 5/280 del 2026-08-21), `_cod_286_sql_chunks` (vacía), `_cod_286_b64_parts` (1 fila: script de prueba en base64 con el uuid de un admin).
- Sin RLS y con `ALL` (incluido `TRUNCATE`) para `anon` y `authenticated`.
- Sin referencias en el repo, en vistas ni en funciones.

**Fix (370):** RLS activado + `REVOKE ALL FROM anon, authenticated`. No se borraron. Pendiente opcional: exportar y `DROP TABLE`.

## Excepción: `catalog_public_available_view`

**Decisión (usuario, 2026-10-09):** queda como security definer. La alerta del advisor se acepta y no se aplica `security_invoker`.

**Por qué no es una fuga (TÉCNICA VERIFICADA):**

- La definición viva ya **no lee pedidos, carritos ni OISS** (comentario de la vista: "Numeracion = talles con fn_sellable_qty > 0 … No resta OISS/carts/reserved_qty"). Lee solo `products`, `product_variants`, `suppliers`, `product_tags`, `colors`, `variant_images`, `color_price_offers`, `promotion_items`, `promotions`, `tags`, `product_tag_details`, `variant_size_warehouse_stock` y `warehouses`.
- `anon` ya tiene `SELECT` + policy de lectura en todas esas tablas.
- Simulación del cuerpo de la vista con permisos de `anon` y de `authenticated`: mismas filas y **mismo md5** que la vista actual (1.027 filas el 2026-10-08, 1.022 el 2026-10-09).

**Por qué no se aplica `security_invoker` (medido en producción, usuario logueado):**

| Consulta | Definer (hoy) | Invoker simulado |
|---|---|---|
| 20 `variant_id` puntuales (carrito, recomendados, fallback de banners) | 14 ms | ~1.150 ms |
| Nuevos ingresos: `order by FechaPublicacion limit 800` | ~590 ms | ~1.180 ms |
| Vista completa `count(*)` | ~560 ms | ~1.150 ms |

Causa: con invoker, las policies RLS de `authenticated` (por ejemplo `auth_select_variants` con `EXISTS products` y las `*_admin_manage` con `EXISTS admins`) actúan como barrera de seguridad, y el planner deja de bajar el filtro `variant_id` antes de calcular toda la vista. Forzar `NOT MATERIALIZED` en las CTE no cambia nada (probado). Para `anon` el costo de la vista completa no cambia (~555 ms).

**Consumidores en vivo** (motivo por el que la latencia importa): `nj/lib/banners/nuevos-ingresos.ts`, `nj/lib/banners/curated-banner-fetch.ts`, `nj/components/cart/CartRecommendedCarousel.tsx`, `nj/components/cart/ActiveOrderTab.tsx`, `scripts/main-supabase.js` y `scripts/curated-banner.js` (fallback), `admin/curated-banner-admin.js`. Funciones: `fn_catalog_snapshot_rebuild`, `fyl_rebuild_catalog_public_snapshot_parity`, `rpc_catalog_snapshot_observability`, `fyl_catalog_snapshot_has_view_parity`, `fyl_catalog_snapshot_insert_select_star_ok`, `get_meta_feed`.

**Camino para cerrarla en el futuro (EN EVALUACIÓN, no aprobado):**

1. Migrar los consumidores cliente a `catalog_public_snapshot`. Es una decisión de negocio: el carrito usa la vista en vivo por frescura de stock y el snapshot puede ir atrasado.
2. Mover la vista a un schema no expuesto por PostgREST, usada solo por las funciones de rebuild/paridad y por `get_meta_feed`.
3. Recién ahí, si se quiere, pasarla a invoker.

**Condición para reabrir:** si la vista llega a incluir una tabla o columna que `anon` no puede leer directamente, deja de ser una excepción segura y hay que aplicar invoker o mover la vista.

## Otro hallazgo pendiente (fuera del advisor)

`public.admins` tiene la policy `authenticated_select_admins` (`USING true`): cualquier cliente logueado lee las 10 filas (`email`, `role`, …). Antes de restringirla hay que verificar que el admin y NJ no dependan de listar la tabla como `authenticated` no admin.

## Método

Todo con SQL de solo lectura en producción: `pg_class.reloptions`, `has_table_privilege`, `pg_policies`, `pg_get_viewdef`; simulación con `SET LOCAL ROLE` + `request.jwt.claims` y `query_to_xml` dentro de transacciones revertidas; tiempos con `clock_timestamp()` (3 corridas). El único cambio aplicado fue 370, con aprobación previa.

## Relacionado

- [[28-AUDITORIA-SUPABASE-POSTGRES-2026-05-13]] (HIGH-3, ahora con drift corregido)
- [[64-AUDITORIA-STOCK-FANTASMA-CHECKOUT-2026-09-14]] (origen de 341/343)
- [[36-CATALOGO-SNAPSHOT-REFRESH-2026-05-15]]
- `doc/hardening-supabase-2026-05-13.md` § Seguimiento 2026-10-08
