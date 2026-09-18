-- 349_admin_expiry_kanban.sql
--
-- Columna Kanban "Vencido" (Pedidos + Retiro):
-- 1) Versiona en canonical las RPC ya desplegadas en fyl-core (2026-09-15):
--    rpc_admin_reopen_expired_order / rpc_admin_mark_expired_order_sent
--    (comportamiento: sin tocar stock; pensado para carga QR — ver nota 65).
-- 2) Extiende rpc_list_admin_expiry_warn_sent para devolver sent_at (cooldown azul 24h).
-- 3) Agrega rpc_clear_admin_expiry_warn_sent para reiniciar el aviso tras +24hs.
--
-- Tabla admin_order_expiry_warn_sent ya existe (305) con sent_at.
-- Rollback: 349_ROLLBACK_admin_expiry_kanban.sql
--
-- Antes de aplicar en producción: presentar SQL, riesgo, rollback y verificación
-- (regla FYL Supabase Production Safety).

-- =============================================================================
-- 1) Reopen expired (dump prod — sin tocar stock)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_admin_reopen_expired_order(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_order record;
  v_notes_obj jsonb;
  v_admin_uses int;
  v_new_dismantle timestamptz;
  v_items_restored int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores pueden reabrir pedidos vencidos';
  END IF;

  SELECT id, status, notes
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) <> 'expired' THEN
    RAISE EXCEPTION 'Solo se puede reabrir un pedido en estado "expired"';
  END IF;

  -- Restaura a 'picked' SIN tocar stock (carga masiva QR / productos ya apartados
  -- físicamente). Ver docs/FYL-Obsidian/60 y 65.
  UPDATE public.order_items
  SET status = 'picked', updated_at = now()
  WHERE order_id = p_order_id
    AND status = 'expired';

  GET DIAGNOSTICS v_items_restored = ROW_COUNT;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        v_notes_obj := '{}'::jsonb;
      END IF;
    EXCEPTION WHEN others THEN
      v_notes_obj := '{}'::jsonb;
    END;
  END IF;
  v_admin_uses := COALESCE((v_notes_obj->>'admin_enable_24h_uses')::int, 0);
  v_new_dismantle := public.fn_compute_order_deadline(now(), 1);

  UPDATE public.orders
  SET status = 'active',
      expired_at = NULL,
      dismantle_at = v_new_dismantle,
      notes = (v_notes_obj || jsonb_build_object(
        'admin_enable_24h_uses', v_admin_uses + 1,
        'admin_reopened_from_expired_at', now()
      ))::text,
      updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'items_restored_to_picked', v_items_restored,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

COMMENT ON FUNCTION public.rpc_admin_reopen_expired_order(uuid) IS
  '349: reabre pedido expired a active/picked sin tocar stock; nuevo dismantle_at día hábil.';

REVOKE ALL ON FUNCTION public.rpc_admin_reopen_expired_order(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_reopen_expired_order(uuid) TO authenticated;

-- =============================================================================
-- 2) Mark expired as sent (dump prod — solo status)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_admin_mark_expired_order_sent(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid;
  v_order record;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar un pedido vencido como enviado';
  END IF;

  SELECT id, status, closed_at INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) <> 'expired' THEN
    RAISE EXCEPTION 'Solo se puede aplicar a un pedido en estado "expired"';
  END IF;

  UPDATE public.orders
  SET status = 'sent',
      closed_at = COALESCE(closed_at, now()),
      updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object('ok', true, 'order_id', p_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_admin_mark_expired_order_sent(uuid) IS
  '349: corrige expired→sent sin tocar stock ni ítems (entrega fuera del sistema).';

REVOKE ALL ON FUNCTION public.rpc_admin_mark_expired_order_sent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_admin_mark_expired_order_sent(uuid) TO authenticated;

-- =============================================================================
-- 3) List expiry warn with sent_at (cooldown 24h en FE)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_list_admin_expiry_warn_sent()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_entries json;
  v_ids json;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  SELECT coalesce(json_agg(json_build_object(
           'order_id', order_id,
           'sent_at', sent_at
         ) ORDER BY sent_at DESC), '[]'::json)
    INTO v_entries
    FROM public.admin_order_expiry_warn_sent;

  SELECT coalesce(json_agg(order_id), '[]'::json)
    INTO v_ids
    FROM public.admin_order_expiry_warn_sent;

  -- entries = contrato nuevo; order_ids = compat clientes viejos
  RETURN json_build_object('ok', true, 'entries', v_entries, 'order_ids', v_ids);
END;
$function$;

COMMENT ON FUNCTION public.rpc_list_admin_expiry_warn_sent() IS
  '349: lista avisos de vencimiento con sent_at para cooldown azul 24h.';

REVOKE ALL ON FUNCTION public.rpc_list_admin_expiry_warn_sent() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_list_admin_expiry_warn_sent() TO authenticated;

-- =============================================================================
-- 4) Clear expiry warn (tras +24hs / reopen)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.rpc_clear_admin_expiry_warn_sent(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  DELETE FROM public.admin_order_expiry_warn_sent
  WHERE order_id = p_order_id;

  RETURN json_build_object('ok', true, 'order_id', p_order_id);
END;
$function$;

COMMENT ON FUNCTION public.rpc_clear_admin_expiry_warn_sent(uuid) IS
  '349: borra el aviso de vencimiento para reiniciar semáforo (tras +24hs).';

REVOKE ALL ON FUNCTION public.rpc_clear_admin_expiry_warn_sent(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_clear_admin_expiry_warn_sent(uuid) TO authenticated;
