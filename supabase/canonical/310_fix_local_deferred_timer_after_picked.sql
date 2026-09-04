-- 310_fix_local_deferred_timer_after_picked.sql
--
-- Bug 309: rpc_mark_order_items_picked llamaba fn_start_local_pickup_timer_if_needed
-- ANTES de pasar el ítem a 'picked', y esa función exige un ítem picked → el timer
-- nunca arrancaba (dismantle_at quedaba NULL).
-- Fix: commit stock → UPDATE picked → start timer.
-- Backfill: pedidos deferred con al menos un picked y sin dismantle_at.

CREATE OR REPLACE FUNCTION public.rpc_mark_order_items_picked(
  p_order_item_ids  uuid[],
  p_operation_id    uuid,
  p_request         jsonb default '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_operation_request jsonb;
  v_prev_result       jsonb;
  v_result            jsonb;

  v_existing_ids      uuid[];
  v_unknown_ids       uuid[];
  v_cancelled_ids     uuid[];
  v_updatable_ids     uuid[];
  v_updated_count     int;
  v_item_id           uuid;
  v_order_id          uuid;

  v_err_msg    text;
  v_err_state  text;
  v_err_detail text;
  v_err_hint   text;
BEGIN
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'rpc_mark_order_items_picked: p_operation_id es obligatorio'
      USING errcode = '22023';
  END IF;

  IF p_order_item_ids IS NULL OR array_length(p_order_item_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'rpc_mark_order_items_picked: p_order_item_ids no puede estar vacío'
      USING errcode = '22023';
  END IF;

  v_operation_request := coalesce(p_request, '{}'::jsonb)
    || jsonb_build_object(
         'item_ids', (
           SELECT jsonb_agg(x ORDER BY x)
           FROM unnest(p_order_item_ids) AS x
         )
       );

  v_prev_result := public.rpc_operations_begin(
    p_operation_id   => p_operation_id,
    p_operation_kind => 'mark_order_items_picked',
    p_request        => v_operation_request,
    p_target_type    => 'order_items',
    p_target_id      => null
  );

  IF v_prev_result IS NOT NULL THEN
    RETURN coalesce(v_prev_result, '{}'::jsonb)
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  BEGIN
    SELECT array_agg(id)
      INTO v_existing_ids
    FROM public.order_items
    WHERE id = ANY(p_order_item_ids);

    v_unknown_ids := ARRAY(
      SELECT unnest(p_order_item_ids)
      EXCEPT
      SELECT unnest(coalesce(v_existing_ids, '{}'))
    );

    IF array_length(v_unknown_ids, 1) > 0 THEN
      RAISE EXCEPTION
        'rpc_mark_order_items_picked: los siguientes order_item_ids no existen: %',
        v_unknown_ids
        USING errcode = '02000';
    END IF;

    SELECT array_agg(id)
      INTO v_cancelled_ids
    FROM public.order_items
    WHERE id = ANY(p_order_item_ids)
      AND status = 'cancelled';

    IF array_length(v_cancelled_ids, 1) > 0 THEN
      RAISE EXCEPTION
        'rpc_mark_order_items_picked: no se pueden marcar como picked items cancelados: %',
        v_cancelled_ids
        USING errcode = '23000';
    END IF;

    -- 1) Commit stock diferido (awaiting_apartado → sources)
    FOREACH v_item_id IN ARRAY p_order_item_ids LOOP
      PERFORM public.fn_commit_deferred_order_item_stock(v_item_id);
    END LOOP;

    -- 2) Pasar a picked
    SELECT array_agg(id)
      INTO v_updatable_ids
    FROM public.order_items
    WHERE id = ANY(p_order_item_ids)
      AND status NOT IN ('picked', 'cancelled');

    IF v_updatable_ids IS NOT NULL AND array_length(v_updatable_ids, 1) > 0 THEN
      UPDATE public.order_items
      SET
        status     = 'picked',
        updated_at = now()
      WHERE id = ANY(v_updatable_ids)
        AND status IN ('reserved', 'waiting', 'awaiting_apartado');

      GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    ELSE
      v_updated_count := 0;
    END IF;

    -- 3) Timer 36h al primer apartado (después de picked)
    FOREACH v_item_id IN ARRAY p_order_item_ids LOOP
      SELECT oi.order_id INTO v_order_id FROM public.order_items oi WHERE oi.id = v_item_id;
      IF v_order_id IS NOT NULL THEN
        PERFORM public.fn_start_local_pickup_timer_if_needed(v_order_id);
      END IF;
    END LOOP;

    v_result := jsonb_build_object(
      'ok',            true,
      'updated_count', v_updated_count,
      'skipped_count', array_length(p_order_item_ids, 1) - v_updated_count,
      'idempotent_replay', false
    );

    RETURN public.rpc_operations_complete(p_operation_id, v_result);

  EXCEPTION
    WHEN others THEN
      GET STACKED DIAGNOSTICS
        v_err_msg    = message_text,
        v_err_state  = returned_sqlstate,
        v_err_detail = pg_exception_detail,
        v_err_hint   = pg_exception_hint;

      BEGIN
        PERFORM public.rpc_operations_fail(
          p_operation_id,
          jsonb_build_object(
            'message',  v_err_msg,
            'sqlstate', v_err_state,
            'detail',   v_err_detail,
            'hint',     v_err_hint
          )
        );
      EXCEPTION
        WHEN others THEN NULL;
      END;

      RAISE;
  END;
END;
$$;

COMMENT ON FUNCTION public.rpc_mark_order_items_picked(uuid[], uuid, jsonb) IS
  '310: apartado con commit stock diferido; timer 36h arranca DESPUÉS del UPDATE a picked.';

-- Backfill pedidos deferred ya apartados sin timer
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT o.id
    FROM public.orders o
    JOIN public.order_items oi ON oi.order_id = o.id
    WHERE coalesce(o.local_deferred_pickup, false) = true
      AND o.dismantle_at IS NULL
      AND o.status IN ('active', 'closing_soon', 'closed')
      AND oi.status = 'picked'
  LOOP
    PERFORM public.fn_start_local_pickup_timer_if_needed(r.id);
  END LOOP;
END;
$$;

SELECT pg_notify('pgrst', 'reload schema');
