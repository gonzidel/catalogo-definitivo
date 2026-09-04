-- 324_rpc_customer_request_close.sql
--
-- Bug (A56434, 2026-09-03): al tocar "Cerrar pedido" con ítems todavía
-- `reserved`/`waiting`, ActiveOrderTab hacía:
--   supabase.from("orders").update({ notes: { customer_requested_close: true } })
-- Los customers SOLO tienen políticas SELECT sobre `orders` (no UPDATE).
-- El update fallaba por RLS; el modal de confirmación no avanzaba a
-- "En preparación". Cuando el admin confirma/aparta, `refreshAndMaybeAutoClose`
-- tampoco veía el flag.
--
-- Esta RPC (SECURITY DEFINER) ya estaba aplicada en fyl-core; este archivo
-- la deja versionada en el repo. El frontend NJ debe llamarla vía
-- `rpcCustomerRequestClose` — nunca un .update() directo a orders.notes.

CREATE OR REPLACE FUNCTION public.rpc_customer_request_close(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order record;
  v_notes jsonb;
BEGIN
  SELECT id, customer_id, status, notes
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

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'El pedido no está en un estado que permita solicitar cierre';
  END IF;

  v_notes := coalesce(v_order.notes::jsonb, '{}'::jsonb);
  v_notes := jsonb_set(v_notes, '{customer_requested_close}', 'true'::jsonb);

  UPDATE public.orders
  SET notes = v_notes::text,
      updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object('ok', true, 'order_id', p_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_customer_request_close(uuid) IS
  'Cliente: marca notes.customer_requested_close sin cerrar el pedido. Para ítems aún reserved/waiting; admin aparta y auto-cierra.';

GRANT EXECUTE ON FUNCTION public.rpc_customer_request_close(uuid) TO authenticated;
