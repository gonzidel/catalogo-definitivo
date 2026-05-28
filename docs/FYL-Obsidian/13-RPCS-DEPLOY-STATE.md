# 13 - RPCs Deploy State

Registro de estado/versionado de RPCs y triggers críticos.

Nota de contexto: FASE 4 completada el 2026-05-04. Todos los triggers y RPCs críticas verificados directamente contra Supabase producción via `information_schema.triggers` y `pg_proc`. Ver resultados completos en [[24-AUDITORIA-STOCK-2026-05-04]] y [[25-AUDITORIA-CATALOGO-2026-05-04]].

Estados usados:

- CONFIRMADO: verificado directamente en Supabase (pg_proc / pg_trigger / información_schema).
- ACTIVO SEGUN ACLARACION: cargado/activo según confirmación del usuario, sin verificación técnica directa.
- VERIFICACION TECNICA PENDIENTE: falta registrar salida real de `pg_proc`, `pg_get_functiondef`, grants o policies.
- LEGACY / HISTORICO: existe en repo pero no gobierna el flujo principal detectado.

---

## Triggers críticos de sincronización

| Trigger | Tabla | Eventos | Estado | Confirmado |
|---------|-------|---------|--------|-----------|
| `trigger_sync_variant_sizes_on_warehouse_stock` | `variant_size_warehouse_stock` | INSERT / UPDATE / DELETE (AFTER) | CONFIRMADO ACTIVO | 2026-05-04 FASE 4 |
| `trigger_sync_variant_warehouse_stock` | `variant_size_warehouse_stock` | INSERT / UPDATE / DELETE (AFTER) | CONFIRMADO ACTIVO | 2026-05-04 FASE 4 |
| `trg_guard_variant_sizes_stock_qty_writes` | `variant_sizes` | INSERT / UPDATE / DELETE (BEFORE) | CONFIRMADO ACTIVO | 2026-05-04 FASE 4 |
| `trg_guard_variant_warehouse_stock_qty_writes` | `variant_warehouse_stock` | INSERT / UPDATE / DELETE (BEFORE) | CONFIRMADO ACTIVO | 2026-05-04 FASE 4 |
| `trg_orders_release_reserved_qty_on_final_status` | `orders` | UPDATE OF `status` (AFTER) | ACTIVO SEGUN ACLARACION | Post-deploy 188 producción; verificar con `188_POST_DEPLOY_VERIFICATION.sql` |
| `trg_products_protect_sensitive_fields` | `products` | — | **NO ENCONTRADO en producción** | 2026-05-04 FASE 4 |
| `trg_product_variants_protect_sensitive_fields` | `product_variants` | — | **NO ENCONTRADO en producción** | 2026-05-04 FASE 4 |

**Migración 188 (reserved al estado final):** funciones internas `release_reserved_qty_for_order(uuid, text, text)` y `trgfn_orders_release_reserved_qty_on_final_status()`; tabla ledger `order_reserved_qty_released`. No son RPC expuestas al cliente. Detalle operativo en [[06-RESERVED-QTY-Y-RECONCILE]].

**Nota sobre triggers 182:** Los triggers de protección de costos (`enforce_sensitive_product_fields`) no aparecen en `information_schema.triggers`. La migración `182_protect_sensitive_product_fields.sql` existe en el repo pero no está desplegada en producción. La protección de `cost`, `price_percentage` y `logistic_amount` depende únicamente del frontend por ahora.

---

## Estado por RPC crítica

Verificadas el 2026-05-04 contra `pg_proc` en producción. Todas con `security_definer = true`.

| RPC | Firmas en producción | Estado | Nota |
|-----|---------------------|--------|------|
| `rpc_checkout_cart()` | 1 firma (sin args) | CONFIRMADO ACTIVO | Firma interna legacy; delegada por wrapper 174. |
| `rpc_checkout_cart(uuid, jsonb)` | 1 firma con `p_operation_id, p_request` | CONFIRMADO ACTIVO | Wrapper idempotente usado por `client/dashboard-instant.js`. |
| `rpc_apply_order_stock_deduction` | 1 firma con `p_items, p_order_id, p_source` | CONFIRMADO ACTIVO | Crítica para orders/admin. |
| `rpc_admin_manual_inject_and_deduct` | 1 firma con `p_items, p_order_id` | CONFIRMADO ACTIVO | Crítica para faltantes/manual. |
| `rpc_set_variant_size_stock_batch` | 1 firma con `p_items, p_source` | CONFIRMADO ACTIVO | Stock por talle. |
| `rpc_set_variant_warehouse_stock_batch` | 1 firma con `p_items, p_source` | CONFIRMADO ACTIVO | Stock sin talle. |
| `rpc_move_size_stock` | 2 firmas (legacy + idempotente con `operation_id`) | CONFIRMADO ACTIVO | Ambas coexisten; JS usa la idempotente. |
| `rpc_reconcile_stock(boolean)` | 1 firma con `p_fix_reserved_qty default false` | CONFIRMADO ACTIVO | Reconciliación derivadas + optional reserved_qty. |
| `rpc_create_public_sale` | 3 firmas históricas (v1, v2, v3 con `operation_id`) | CONFIRMADO ACTIVO | 3 versiones coexisten; flujo vivo usa la última. |
| `rpc_void_public_sale` | 2 firmas (legacy + idempotente) | CONFIRMADO ACTIVO | Anulación/reversión. |
| `rpc_mark_order_as_devolucion` | 2 firmas (legacy + idempotente) | CONFIRMADO ACTIVO | Devolución. |
| `rpc_mark_order_items_picked` | 1 firma con `p_order_item_ids, p_operation_id` | CONFIRMADO ACTIVO | Picking idempotente. |
| `rpc_mark_order_as_sent` | 1 firma `uuid` | **ACTUALIZADO 2026-05-26** | Migración `227`: escribe `sent_at = now()` al finalizar. Ver [[39-LISTA-ENVIOS-SENT-AT-2026-05-26]]. |
| `rpc_get_shipping_orders` | `(date, uuid)` | **ACTUALIZADO 2026-05-26** | Lista envíos: solo `sent_at` (BA), sin fallback `closed_at`. |
| `rpc_get_shipping_orders_range` | `(date, date, uuid)` | **ACTUALIZADO 2026-05-26** | Excel extracción: mismo criterio que lista. |
| `register_envio_to_daily_sales` | trigger fn | CONFIRMADO ACTIVO | `COALESCE(sent_at, updated_at)` al pasar a `sent`. |
| `guard_variant_sizes_stock_qty_writes` | 1 firma sin args (trigger function) | CONFIRMADO ACTIVO | Guard 148 sobre variant_sizes. |
| `guard_variant_warehouse_stock_qty_writes` | 1 firma sin args (trigger function) | CONFIRMADO ACTIVO | Guard 148 sobre variant_warehouse_stock. |
| `sync_variant_sizes_stock_from_warehouse` | 1 firma sin args (trigger function) | CONFIRMADO ACTIVO | Función del trigger 84. |
| `sync_variant_warehouse_stock_from_sizes` | 1 firma sin args (trigger function) | CONFIRMADO ACTIVO | Función del trigger 145. |
| `enforce_sensitive_product_fields` | — | **NO ENCONTRADO en producción** | Migración 182 no desplegada. Costos solo protegidos en frontend. |
| `rpc_remove_order_item_restore_stock` | — | ACTIVO SEGUN ACLARACION (no verificado en F4) | Restauración stock. |
| `rpc_save_product_variant_initial_stock` | — | ACTIVO SEGUN ACLARACION (no verificado en F4) | Products/stock inicial. |
| `rpc_update_cart_item_quantity` | — | DUDOSA EN FLUJO JS | Existe en SQL; no llamada en flujo vivo auditado. |
| `get_user_cart`, `get_cart_items_simple`, `clear_cart_items`, `add_cart_item` | Todas con EXECUTE a PUBLIC, anon, authenticated | **CRÍTICO — grants amplios confirmados** | Ver sección Hallazgo F4-3. |
| `rpc_get_or_create_cart`, `rpc_reserve_item`, `rpc_submit_cart`, `rpc_update_cart_item_quantity` | Todas con EXECUTE a PUBLIC, anon, authenticated | **CRÍTICO — grants amplios confirmados** | Ver sección Hallazgo F4-3. |

---

## Checks para FASE 4 (verificación técnica pendiente)

Ejecutar en SQL Editor de Supabase. Los resultados deben registrarse en este archivo actualizando el estado de cada fila.

### Triggers

```sql
-- Confirmar todos los triggers críticos
SELECT
  event_object_table AS tabla,
  trigger_name,
  action_timing,
  event_manipulation,
  'ACTIVO' AS estado
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND trigger_name IN (
    'trigger_sync_variant_sizes_on_warehouse_stock',
    'trigger_sync_variant_warehouse_stock',
    'trg_guard_variant_sizes_stock_qty_writes',
    'trg_guard_variant_warehouse_stock_qty_writes',
    'trg_products_protect_sensitive_fields',
    'trg_product_variants_protect_sensitive_fields'
  )
ORDER BY event_object_table, trigger_name;
```

### RPCs críticas: firma, SECURITY DEFINER y existencia

```sql
SELECT
  p.proname            AS function_name,
  pg_get_function_arguments(p.oid) AS args,
  pg_get_function_result(p.oid)    AS returns,
  p.prosecdef          AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'rpc_checkout_cart',
    'rpc_apply_order_stock_deduction',
    'rpc_admin_manual_inject_and_deduct',
    'rpc_set_variant_size_stock_batch',
    'rpc_set_variant_warehouse_stock_batch',
    'rpc_move_size_stock',
    'rpc_reconcile_stock',
    'rpc_create_public_sale',
    'rpc_void_public_sale',
    'rpc_mark_order_as_devolucion',
    'rpc_mark_order_items_picked',
    'sync_variant_sizes_stock_from_warehouse',
    'sync_variant_warehouse_stock_from_sizes',
    'guard_variant_sizes_stock_qty_writes',
    'guard_variant_warehouse_stock_qty_writes',
    'enforce_sensitive_product_fields'
  )
ORDER BY p.proname, args;
```

### Grants de funciones legacy de carrito

```sql
SELECT
  routine_name,
  grantee,
  privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_user_cart',
    'get_cart_items_simple',
    'clear_cart_items',
    'add_cart_item',
    'rpc_get_or_create_cart',
    'rpc_reserve_item',
    'rpc_submit_cart',
    'rpc_update_cart_item_quantity'
  )
ORDER BY routine_name, grantee;
```

### Policies activas de tablas críticas

```sql
SELECT
  tablename,
  policyname,
  cmd,
  roles,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'variant_sizes',
    'variant_size_warehouse_stock',
    'variant_warehouse_stock',
    'products',
    'product_variants',
    'orders',
    'order_items',
    'order_item_stock_sources',
    'carts',
    'cart_items'
  )
ORDER BY tablename, policyname;
```

---

## Policies de tablas críticas (F4-4)

Verificadas el 2026-05-04. Resumen de hallazgos:

| Tabla | Observación | Riesgo |
|-------|------------|--------|
| `variant_size_warehouse_stock` | Legible por `anon` sin autenticación (`qual: true`). Intencional para catálogo público. | Bajo — expone inventario sin auth. |
| `variant_sizes` | Igual a la anterior. | Bajo |
| `variant_warehouse_stock` | Tiene 2 policies de admin redundantes (`admin_manage_variant_warehouse_stock` + `warehouse_stock_admin_manage`). | Muy bajo — redundancia sin impacto. |
| `carts` | `customer_insert_own_carts` tiene `qual: null` — no valida ownership en INSERT. | Bajo — barrera real está en `carts_self_access`. |
| `cart_items` | `customer_insert_own_cart_items` tiene `qual: null` — no valida ownership en INSERT. Igual que carts. | Bajo — barrera real está en `cart_items_self_access`. |
| `order_item_stock_sources` | Solo admins pueden acceder (ALL). Sin lectura pública. | OK |
| `orders` | Self-select para auth y anon; admin y service_role manejan todo. | OK |
| `order_items` | Igual patrón que orders. | OK |

## Estado de verificación

| Área | Estado | Fecha |
|------|--------|-------|
| Triggers 84 y 145 (sync) | CONFIRMADO ACTIVO | 2026-05-04 FASE 4 |
| Guards derivadas (148) | CONFIRMADO ACTIVO | 2026-05-04 FASE 4 |
| Triggers protección costos (182) | **NO ENCONTRADOS EN PRODUCCIÓN** | 2026-05-04 FASE 4 |
| RPCs críticas de stock | CONFIRMADO ACTIVO (todas) | 2026-05-04 FASE 4 |
| RPCs críticas de pedidos | CONFIRMADO ACTIVO (todas) | 2026-05-04 FASE 4 |
| Grants funciones legacy carrito | **CRÍTICO — EXECUTE a `anon` y `PUBLIC` confirmado** | 2026-05-04 FASE 4 |
| Policies de tablas críticas | REVISADO — 3 observaciones menores | 2026-05-04 FASE 4 |

---

## Hallazgo F4-3 — Grants de funciones legacy de carrito (CRÍTICO)

Confirmado el 2026-05-04. Las 8 funciones legacy de carrito tienen `EXECUTE` otorgado a `PUBLIC`, `anon`, `authenticated`, `postgres` y `service_role`.

| Función | Riesgo | Descripción |
|---------|--------|-------------|
| `clear_cart_items` | **CRÍTICO** | Puede vaciar carritos; callable por `anon` sin autenticación |
| `rpc_submit_cart` | **ALTO** | Checkout alternativo legacy sin pasar por `rpc_checkout_cart`; no descuenta stock ni crea `order_items` correctamente |
| `rpc_reserve_item` | **ALTO** | Puede reservar stock fuera del flujo canónico |
| `add_cart_item` | ALTO | Puede agregar ítems a carritos |
| `rpc_get_or_create_cart` | MEDIO | Puede crear carritos para cualquier usuario |
| `get_user_cart` | MEDIO | Expone datos de carritos |
| `get_cart_items_simple` | MEDIO | Expone contenido de carritos |
| `rpc_update_cart_item_quantity` | MEDIO | Puede modificar cantidades en carritos |

**Función `clear_cart_items` — CUERPO VERIFICADO (2026-05-04):**

```sql
CREATE OR REPLACE FUNCTION public.clear_cart_items(cart_uuid uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    DELETE FROM public.cart_items WHERE cart_id = cart_uuid;
END;
$$
```

**No hay validación de ownership.** La función recibe un UUID y borra sin verificar `auth.uid()` ni que el carrito pertenezca al usuario que llama. Con `EXECUTE TO anon` activo, cualquier persona sin cuenta puede vaciar el carrito de cualquier cliente B2B conociendo el `cart_id`. Los UUIDs son difíciles de adivinar pero si alguno quedó expuesto en logs o respuestas de API, la brecha es explotable directamente.

**Acción requerida — migración `183_revoke_legacy_cart_function_grants.sql` creada.**
Ejecutar en Supabase SQL Editor antes de continuar con FASE 5. SQL:

```sql
-- Revocar grants de funciones legacy de carrito
REVOKE EXECUTE ON FUNCTION public.clear_cart_items() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.add_cart_item(uuid, text, integer, numeric) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_cart(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_cart_items_simple(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_get_or_create_cart() FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_reserve_item(uuid, text, integer) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_submit_cart(uuid) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rpc_update_cart_item_quantity(uuid, integer) FROM anon, authenticated, PUBLIC;
```

**Nota:** Las firmas exactas de los argumentos deben verificarse antes de ejecutar el REVOKE. Si las firmas no coinciden, el REVOKE no produce error pero tampoco revoca nada.

---

## Enlaces

- [[03-MAPA-DE-RPCS]]
- [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]]
- [[24-AUDITORIA-STOCK-2026-05-04]]
- [[99-AUDITORIA-DOCUMENTACION]]
