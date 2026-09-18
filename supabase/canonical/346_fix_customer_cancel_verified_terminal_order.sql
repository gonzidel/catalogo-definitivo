-- 346_fix_customer_cancel_verified_terminal_order.sql
--
-- BUG (2026-09-16, Romina Ferster / A56917):
-- el dashboard consideraba exitosa rpc_customer_cancel_order con solo
-- `error = null`, sin validar el JSON. Además, 319 podía borrar el pedido
-- durante la última transición de item a cancelled, antes de que la RPC
-- actualizara orders.status. El resultado podía describir un estado distinto
-- del realmente persistido y el pedido desaparecía del seguimiento admin.
--
-- Contrato nuevo:
--   1) una cancelación cliente exitosa deja el pedido terminal
--      status='cancelled' y visible en Cancelados;
--   2) checkout no reutiliza status='cancelled' (ya es el comportamiento
--      vigente: solo reutiliza active/closing_soon), por lo que el próximo
--      checkout obtiene otro order_number;
--   3) la RPC solo retorna ok=true después de verificar sus postcondiciones;
--   4) reintentar es idempotente, incluso si un pedido viejo ya fue borrado
--      y existe su recibo en order_empty_deletion_audit;
--   5) el borrado/archivo queda como acción posterior del admin ("Desarmar").
--
-- Riesgo: MEDIO. Cambia el ciclo de vida de cancelación completa: el pedido
-- ya no se autoelimina al cancelar la última línea. No altera la lógica de
-- devolución de stock de rpc_cancel_order_item.

-- ---------------------------------------------------------------------------
-- 1) Recibo durable de cancelación, independiente de la vida de orders.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_order_cancellation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE,
  order_number text,
  customer_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  items_cancelled int NOT NULL DEFAULT 0,
  had_picked boolean NOT NULL DEFAULT false,
  final_status text NOT NULL,
  order_deleted boolean NOT NULL DEFAULT false,
  result_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customer_order_cancellation_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customer_order_cancellation_audit_admin_read
  ON public.customer_order_cancellation_audit;
CREATE POLICY customer_order_cancellation_audit_admin_read
  ON public.customer_order_cancellation_audit
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.admins a
      WHERE a.user_id = auth.uid()
    )
  );

REVOKE ALL ON TABLE public.customer_order_cancellation_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.customer_order_cancellation_audit FROM anon;
GRANT SELECT ON TABLE public.customer_order_cancellation_audit TO authenticated;

COMMENT ON TABLE public.customer_order_cancellation_audit IS
  '346: recibo durable e idempotente de cancelación completa cliente; sin FK a orders para sobrevivir al archivado.';

-- ---------------------------------------------------------------------------
-- 2) No autoeliminar mientras el pedido padre ya sea terminal cancelled.
--    El trigger AFTER DELETE de 119 permanece intacto, por lo que el admin
--    puede desarmar/archivar luego mediante el flujo canónico.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_order_items_cancelled_try_empty_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF lower(trim(coalesce(NEW.status, ''))) = 'cancelled'
     AND NOT EXISTS (
       SELECT 1
       FROM public.orders o
       WHERE o.id = NEW.order_id
         AND lower(trim(coalesce(o.status, ''))) = 'cancelled'
     )
  THEN
    PERFORM public.maint_try_delete_order_if_eligible(
      NEW.order_id,
      'trigger_order_items_cancelled'
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trg_order_items_cancelled_try_empty_order() IS
  '346: tras cancelar un item solo autoelimina pedidos cuyo padre todavía no está cancelled; la cancelación completa cliente conserva el pedido para auditoría/admin.';

REVOKE ALL ON FUNCTION public.trg_order_items_cancelled_try_empty_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_order_items_cancelled_try_empty_order() FROM anon;

-- ---------------------------------------------------------------------------
-- 3) Cerrar la carrera checkout vs. cancelación.
--
-- El checkout pudo haber seleccionado el pedido cuando aún estaba active y
-- quedar en vuelo mientras la cancelación lo pasa a cancelled. La guarda es
-- diferida para comprobar el estado final al COMMIT sin invertir el orden de
-- locks stock->order del checkout.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_order_items_reject_cancelled_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.id = NEW.order_id
      AND lower(trim(coalesce(o.status, ''))) = 'cancelled'
  ) THEN
    RAISE EXCEPTION
      'No se pueden agregar productos a un pedido cancelado (order_id=%)',
      NEW.order_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_order_items_reject_cancelled_parent() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_order_items_reject_cancelled_parent() FROM anon;

DROP TRIGGER IF EXISTS order_items_reject_cancelled_parent ON public.order_items;
CREATE CONSTRAINT TRIGGER order_items_reject_cancelled_parent
  AFTER INSERT OR UPDATE OF order_id ON public.order_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_order_items_reject_cancelled_parent();

COMMENT ON FUNCTION public.trg_order_items_reject_cancelled_parent() IS
  '346: al commit rechaza INSERT/movimiento de order_items hacia un pedido cuyo estado final sea cancelled; cierra carrera checkout-cancelación.';

-- ---------------------------------------------------------------------------
-- 4) Cancelación completa verificada e idempotente.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_customer_cancel_order(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_order record;
  v_item_id uuid;
  v_item_status text;
  v_rpc_result json;
  v_cancelled int := 0;
  v_had_picked boolean := false;
  v_remaining int := 0;
  v_order_number text;
  v_result jsonb;
BEGIN
  v_uid := auth.uid();

  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'Pedido inválido';
  END IF;

  SELECT a.result_json
  INTO v_result
  FROM public.customer_order_cancellation_audit a
  WHERE a.order_id = p_order_id
    AND a.customer_id = v_uid
  LIMIT 1;

  IF FOUND THEN
    RETURN (
      v_result || jsonb_build_object('idempotent_replay', true)
    )::json;
  END IF;

  SELECT o.id, o.customer_id, o.status, o.order_number
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  -- Reintento después de que una versión anterior o el admin ya archivó el
  -- pedido. El audit funciona como recibo durable ligado al mismo cliente.
  IF v_order.id IS NULL THEN
    SELECT a.order_number
    INTO v_order_number
    FROM public.order_empty_deletion_audit a
    WHERE a.order_id = p_order_id
      AND a.customer_id = v_uid
    ORDER BY a.deleted_at DESC, a.id DESC
    LIMIT 1;

    IF FOUND THEN
      v_result := jsonb_build_object(
        'ok', true,
        'verified', true,
        'idempotent_replay', true,
        'order_id', p_order_id,
        'order_number', v_order_number,
        'items_cancelled', 0,
        'had_picked', false,
        'order_status', 'deleted',
        'order_deleted', true
      );

      INSERT INTO public.customer_order_cancellation_audit (
        order_id,
        order_number,
        customer_id,
        actor_user_id,
        items_cancelled,
        had_picked,
        final_status,
        order_deleted,
        result_json
      )
      VALUES (
        p_order_id,
        v_order_number,
        v_uid,
        v_uid,
        0,
        false,
        'deleted',
        true,
        v_result
      )
      ON CONFLICT (order_id) DO NOTHING;

      RETURN v_result::json;
    END IF;

    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para cancelar este pedido';
  END IF;

  v_order_number := v_order.order_number;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN (
    'active',
    'closing_soon',
    'cancelled'
  ) THEN
    RAISE EXCEPTION 'No se puede cancelar un pedido en este estado';
  END IF;

  -- Marcar primero el padre evita que el trigger 319 borre la orden al
  -- cancelar la última línea. Todo ocurre en una sola transacción.
  UPDATE public.orders
  SET status = 'cancelled',
      updated_at = now()
  WHERE id = p_order_id;

  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
  FOR UPDATE;

  FOR v_item_id, v_item_status IN
    SELECT oi.id, lower(trim(coalesce(oi.status, '')))
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled'
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_cancel_order_item(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT coalesce((v_rpc_result->>'applied')::boolean, false)
    THEN
      RAISE EXCEPTION
        'No se pudo cancelar el producto del pedido (item=%)',
        v_item_id;
    END IF;

    IF coalesce((v_rpc_result->>'was_picked')::boolean, false)
       OR v_item_status = 'picked'
    THEN
      v_had_picked := true;
    END IF;

    v_cancelled := v_cancelled + 1;
  END LOOP;

  SELECT count(*)::int
  INTO v_remaining
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND lower(trim(coalesce(oi.status, ''))) <> 'cancelled';

  IF NOT EXISTS (
    SELECT 1
    FROM public.orders o
    WHERE o.id = p_order_id
      AND o.customer_id = v_uid
      AND lower(trim(coalesce(o.status, ''))) = 'cancelled'
  )
  OR coalesce(v_remaining, 0) <> 0
  THEN
    RAISE EXCEPTION
      'La cancelación no alcanzó su estado terminal (items_pendientes=%)',
      coalesce(v_remaining, 0);
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'verified', true,
    'idempotent_replay',
      lower(trim(coalesce(v_order.status, ''))) = 'cancelled'
      AND v_cancelled = 0,
    'order_id', p_order_id,
    'order_number', v_order_number,
    'items_cancelled', v_cancelled,
    'had_picked', v_had_picked,
    'order_status', 'cancelled',
    'order_deleted', false
  );

  INSERT INTO public.customer_order_cancellation_audit (
    order_id,
    order_number,
    customer_id,
    actor_user_id,
    items_cancelled,
    had_picked,
    final_status,
    order_deleted,
    result_json
  )
  VALUES (
    p_order_id,
    v_order_number,
    v_uid,
    v_uid,
    v_cancelled,
    v_had_picked,
    'cancelled',
    false,
    v_result
  )
  ON CONFLICT (order_id) DO NOTHING;

  RETURN v_result::json;
END;
$$;

COMMENT ON FUNCTION public.rpc_customer_cancel_order(uuid) IS
  '346: cancelación cliente terminal, verificada e idempotente. Conserva orders.status=cancelled para seguimiento admin; el próximo checkout crea otro número.';

REVOKE ALL ON FUNCTION public.rpc_customer_cancel_order(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_customer_cancel_order(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.rpc_customer_cancel_order(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
