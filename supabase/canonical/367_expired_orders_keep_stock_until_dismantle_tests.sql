-- 367_expired_orders_keep_stock_until_dismantle_tests.sql
-- Solo lectura. Ejecutar después de aplicar 367.

DO $$
DECLARE
  v_def text;
  v_trg text;
BEGIN
  v_def := pg_get_functiondef('public.rpc_orders_daily_maintenance()'::regprocedure);

  IF v_def ILIKE '%DELETE FROM public.order_item_stock_sources%' THEN
    RAISE EXCEPTION '367 FAIL: el mantenimiento sigue borrando fuentes al vencer';
  END IF;
  IF v_def ILIKE '%variant_size_warehouse_stock%' OR v_def ILIKE '%variant_warehouse_stock%' THEN
    RAISE EXCEPTION '367 FAIL: el mantenimiento sigue tocando stock al vencer';
  END IF;
  IF v_def NOT LIKE '%interval ''24 hours''%' OR v_def NOT LIKE '%local_deferred_pickup%' THEN
    RAISE EXCEPTION '367 FAIL: se perdió la ventana de gracia 355';
  END IF;
  IF v_def NOT LIKE '%oi.status = ''awaiting_apartado''%' THEN
    RAISE EXCEPTION '367 FAIL: awaiting_apartado ya no pasa a expired';
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_trg
  FROM pg_trigger t
  WHERE t.tgname = 'trg_orders_release_reserved_qty_on_final_status'
    AND t.tgrelid = 'public.orders'::regclass;

  IF v_trg IS NULL THEN
    RAISE EXCEPTION '367 FAIL: falta el trigger de liberación de reserved_qty';
  END IF;
  IF v_trg ILIKE '%expired%' THEN
    RAISE EXCEPTION '367 FAIL: el trigger sigue liberando reserved_qty al vencer';
  END IF;
  IF pg_get_functiondef('public.trgfn_orders_release_reserved_qty_on_final_status()'::regprocedure) ILIKE '%expired%' THEN
    RAISE EXCEPTION '367 FAIL: la función del trigger sigue considerando expired';
  END IF;

  IF pg_get_viewdef('public.vw_stock_audit_reserved_qty_diff'::regclass) ILIKE '%expired%' THEN
    RAISE EXCEPTION '367 FAIL: la auditoría de reservas sigue excluyendo expired';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.vw_stock_audit_reserved_qty_diff'::regclass
      AND 'security_invoker=on' = ANY(reloptions)
  ) THEN
    RAISE EXCEPTION '367 FAIL: la vista perdió security_invoker';
  END IF;

  IF md5(pg_get_functiondef('public.fn_reserved_by_variant_size()'::regprocedure)) <> '350a87cc52154734b0bff34f49717236'
     OR md5(pg_get_functiondef('public.rpc_get_variant_size_reserved(uuid[])'::regprocedure)) <> '54d09be518c122aeae93a82a52ceec32'
     OR md5(pg_get_functiondef('public.get_meta_feed()'::regprocedure)) <> '1e9c9cf2a981c7d7f883a688e0f79f5b' THEN
    RAISE EXCEPTION '367 FAIL: alguna función de reservados no quedó en la versión 367';
  END IF;

  RAISE NOTICE '367 OK: estructura aplicada';
END $$;

-- Grants de la vista intactos (authenticated lee la auditoría desde el admin).
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'vw_stock_audit_reserved_qty_diff'
  AND grantee IN ('anon', 'authenticated')
ORDER BY 1, 2;

-- Verificación operativa (correr tras los próximos vencimientos):
-- pedidos vencidos con stock todavía reservado, esperando desarme.
SELECT o.order_number,
       o.expired_at AT TIME ZONE 'America/Argentina/Buenos_Aires' AS vencido_ar,
       count(DISTINCT oi.id) AS items_con_fuentes,
       sum(s.qty) AS unidades_reservadas
FROM public.orders o
JOIN public.order_items oi ON oi.order_id = o.id
JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id AND s.qty > 0
WHERE o.status = 'expired'
GROUP BY o.order_number, o.expired_at
ORDER BY o.expired_at DESC;

-- Esas reservas no deben aparecer como anomalía en la auditoría.
SELECT a.*
FROM public.vw_stock_audit_reserved_qty_diff a
WHERE a.variant_id IN (
  SELECT oi.variant_id
  FROM public.orders o
  JOIN public.order_items oi ON oi.order_id = o.id
  JOIN public.order_item_stock_sources s ON s.order_item_id = oi.id AND s.qty > 0
  WHERE o.status = 'expired'
);
