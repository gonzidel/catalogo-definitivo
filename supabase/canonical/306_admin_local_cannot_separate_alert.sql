-- 306_admin_local_cannot_separate_alert.sql
-- Aviso cross-device: depósito (venta al público) no puede separar → Kanban admin orders.

ALTER TABLE public.admin_order_message_notifications
  ALTER COLUMN order_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.rpc_create_admin_local_cannot_separate_alert(
  p_pending_count integer DEFAULT 0
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_notif_id uuid;
  v_msg text;
  v_count int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  v_count := greatest(0, coalesce(p_pending_count, 0));
  v_msg := CASE
    WHEN v_count <= 0 THEN 'El local no puede separar productos pendientes en venta al público.'
    WHEN v_count = 1 THEN 'El local no puede separar 1 producto pendiente en venta al público.'
    ELSE 'El local no puede separar ' || v_count::text || ' productos pendientes en venta al público.'
  END;

  UPDATE public.admin_order_message_notifications
     SET dismissed_at = now()
   WHERE kind = 'local_cannot_separate'
     AND dismissed_at IS NULL;

  INSERT INTO public.admin_order_message_notifications (
    order_id, customer_name, customer_phone, message, kind
  )
  VALUES (
    NULL,
    'Depósito — Venta al público',
    NULL,
    v_msg,
    'local_cannot_separate'
  )
  RETURNING id INTO v_notif_id;

  RETURN json_build_object('ok', true, 'notification_id', v_notif_id, 'message', v_msg);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_admin_local_cannot_separate_alert(integer) TO authenticated;
