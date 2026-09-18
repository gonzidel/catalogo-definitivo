-- 349_ROLLBACK_admin_expiry_kanban.sql
-- Revierte cambios de list/clear; deja reopen/mark-sent como estaban en prod
-- (no las dropea: ya existían antes de 349).

CREATE OR REPLACE FUNCTION public.rpc_list_admin_expiry_warn_sent()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_ids json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT coalesce(json_agg(order_id), '[]'::json)
    INTO v_ids
    FROM public.admin_order_expiry_warn_sent;

  RETURN json_build_object('ok', true, 'order_ids', v_ids);
END;
$function$;

DROP FUNCTION IF EXISTS public.rpc_clear_admin_expiry_warn_sent(uuid);
