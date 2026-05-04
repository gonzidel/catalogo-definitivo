-- 188_POST_DEPLOY_VERIFICATION.sql
--
-- Verificación post-deploy de migración 188 (producción o staging).
-- Por defecto: solo SELECT. La sección 5 incluye rpc_reconcile_stock(true)
-- comentada — descomentar y ejecutar UNA sola vez cuando corresponda, luego
-- repetir la sección 6.
--
-- No toca stock físico ni order_item_stock_sources.

-- =============================================================================
-- 1) Tabla order_reserved_qty_released existe
-- =============================================================================

SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name = 'order_reserved_qty_released';

-- =============================================================================
-- 2) Funciones (internas + trigger)
-- =============================================================================

SELECT p.proname,
       p.prosecdef AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'release_reserved_qty_for_order',
    'trgfn_orders_release_reserved_qty_on_final_status'
  )
ORDER BY p.proname;

-- =============================================================================
-- 3) Trigger en orders — activo (tgenabled = 'O')
-- =============================================================================

SELECT t.tgname,
       c.relname AS on_table,
       t.tgenabled,
       CASE t.tgenabled
         WHEN 'O' THEN 'enabled'
         WHEN 'D' THEN 'disabled'
         WHEN 'R' THEN 'replica'
         WHEN 'A' THEN 'always'
         ELSE t.tgenabled::text
       END AS enabled_label,
       pg_get_triggerdef(t.oid, true) AS trigger_def
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'orders'
  AND NOT t.tgisinternal
  AND t.tgname = 'trg_orders_release_reserved_qty_on_final_status';

-- Esperado: una fila, tgenabled = 'O'.

-- =============================================================================
-- 4) Comportamiento hacia adelante (manual; reemplazar UUID)
-- =============================================================================
--
-- a) Elegir pedido closed con oiss > 0 (o crear flujo de prueba en staging).
-- b) Anotar reserved_qty de las variantes del pedido ANTES.
-- c) SELECT public.rpc_mark_order_as_sent('<ORDER_UUID>'::uuid);
-- d) Verificar ledger:
--
--    SELECT * FROM public.order_reserved_qty_released
--    WHERE order_id = '<ORDER_UUID>'::uuid;
--
-- e) Comparar reserved_qty en product_variants (variantes del pedido).
-- f) Idempotencia: UPDATE orders SET status = 'sent', updated_at = now()
--    WHERE id = '<ORDER_UUID>'::uuid;  → reserved_qty no debe bajar de nuevo;
--    ledger sigue 1 fila.
--
-- g) sent → devolución: no debe insertarse segunda fila (misma PK order_id).

-- =============================================================================
-- 5) Reconciliación histórica reserved_qty (UNA vez; requiere permiso admin)
-- =============================================================================
--
-- Descomentar solo cuando el operador decida cerrar drift acumulado pre-188:
--
-- SELECT public.rpc_reconcile_stock(true);
--
-- Guardar el JSON de salida (reserved_qty.fixed, remaining_diffs, etc.).

-- =============================================================================
-- 6) KPI infladas post-reconcile (o post-deploy si aún no corriste 5)
-- =============================================================================

SELECT count(*)::int AS inflated_rows,
       coalesce(sum(delta), 0)::bigint AS total_delta
FROM public.vw_stock_audit_reserved_qty_diff
WHERE anomaly_type = 'reserved_qty_inflated';

-- =============================================================================
-- 7) Conteo filas ledger (crece con cada pedido que pasa a final la primera vez)
-- =============================================================================

SELECT count(*)::bigint AS ledger_rows,
       max(released_at) AS last_release_at
FROM public.order_reserved_qty_released;
