-- 355_ROLLBACK_stock_history_readable_labels.sql
-- Revierte labels de 355. NO restaura notes/change_type del backfill histórico
-- (quedaría inconsistente); solo restaura la RPC a textos pre-355 (342).

-- Nota: para volver change_types del backfill:
--   cancelacion_confirmada_reingreso → adjustment (solo si notes tienen el patrón viejo)
--   quitado_sin_reingreso → no_restore_no_sources_review
--   sin_stock_baja → writeoff_missing

UPDATE public.stock_history
SET change_type = 'adjustment'
WHERE change_type = 'cancelacion_confirmada_reingreso'
  AND notes ILIKE '%rpc_remove_order_item_restore_stock%devoluci%por fuentes%';

UPDATE public.stock_history
SET change_type = 'no_restore_no_sources_review'
WHERE change_type = 'quitado_sin_reingreso';

UPDATE public.stock_history
SET change_type = 'writeoff_missing'
WHERE change_type = 'sin_stock_baja';

-- Reaplicar 342 (mismo cuerpo; labels viejos). Preferir re-ejecutar
-- supabase/canonical/342_fix_remove_order_item_no_blind_restore.sql completo.
-- Aquí solo documentamos el rollback de change_types.

SELECT pg_notify('pgrst', 'reload schema');
