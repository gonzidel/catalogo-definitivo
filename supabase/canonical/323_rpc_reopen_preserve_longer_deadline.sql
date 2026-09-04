-- 323_rpc_reopen_preserve_longer_deadline.sql
--
-- Bug (A56427, 2026-09-02): al reabrir un pedido en preparación,
-- rpc_customer_reopen_order_for_editing (270) siempre pisaba dismantle_at
-- con fn_compute_order_deadline(now(), 1) (próximo día hábil). El admin
-- mostraba "Mañana" mientras Mi pedido ignoraba plazos cortos no-deferred
-- (getCustomerFacingDismantleAt) y seguía mostrando ~7 días desde created_at.
--
-- Regla: al reabrir, el plazo corto es un piso — si el dismantle_at actual
-- todavía es posterior, se conserva. Solo se acorta cuando el pedido ya
-- estaba vencido / sin plazo / con menos margen que 1 día hábil.

CREATE OR REPLACE FUNCTION public.rpc_customer_reopen_order_for_editing(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_order record;
  v_notes_obj jsonb;
  v_was_requested_close boolean;
  v_short_dismantle timestamptz;
  v_new_dismantle timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, notes, dismantle_at
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        v_notes_obj := '{}'::jsonb;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_notes_obj := '{}'::jsonb;
    END;
  END IF;

  v_was_requested_close := coalesce((v_notes_obj->>'customer_requested_close')::boolean, false);

  IF v_order.status <> 'closed' AND NOT v_was_requested_close THEN
    RAISE EXCEPTION 'Este pedido no está en preparación, no corresponde reabrirlo para editar';
  END IF;

  v_short_dismantle := public.fn_compute_order_deadline(now(), 1);
  -- Conservar plazo más largo si todavía queda margen real.
  IF v_order.dismantle_at IS NOT NULL AND v_order.dismantle_at > v_short_dismantle THEN
    v_new_dismantle := v_order.dismantle_at;
  ELSE
    v_new_dismantle := v_short_dismantle;
  END IF;

  v_notes_obj := v_notes_obj - 'customer_requested_close';

  UPDATE public.orders
  SET
    status = 'active',
    dismantle_at = v_new_dismantle,
    notes = v_notes_obj::text,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rpc_customer_reopen_order_for_editing(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
