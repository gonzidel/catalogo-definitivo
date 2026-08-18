-- 258_extension_24h_business_day.sql
--
-- Las dos prorrogas de "24 horas" (cliente y admin) hacian `now() + interval
-- '24 hours'` literal, sin respetar la regla nueva de 257 (17:00 hora
-- Argentina + proximo dia habil). El usuario pidio explicitamente adaptarlas
-- tambien: ahora ambas usan fn_compute_order_deadline(now(), 1), que da el
-- proximo dia habil (desde hoy) a las 17:00 Argentina.
--
-- A) rpc_customer_request_order_extension_24h: mismo comportamiento y checks
-- (uso unico, solo si ya vencio, solo el dueño del pedido), solo cambia el
-- calculo de v_new_dismantle.
--
-- B) rpc_admin_extend_order_24h (NUEVA): equivalente admin de la anterior,
-- sin limite de usos (autoridad de admin), reemplaza el update directo que
-- hacia nj/hooks/useOrders.ts calculando la fecha en el cliente.

CREATE OR REPLACE FUNCTION public.rpc_customer_request_order_extension_24h(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_uid uuid;
  v_order record;
  v_notes_obj jsonb;
  v_customer_uses int;
  v_new_dismantle timestamptz;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, customer_id, status, dismantle_at, notes
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
  END IF;

  IF v_order.customer_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'No tenés permiso para modificar este pedido';
  END IF;

  IF lower(trim(coalesce(v_order.status, ''))) NOT IN ('active', 'closing_soon') THEN
    RAISE EXCEPTION 'Este pedido no admite prórroga';
  END IF;

  IF v_order.dismantle_at IS NULL OR now() < v_order.dismantle_at THEN
    RAISE EXCEPTION 'El pedido aún no venció';
  END IF;

  v_notes_obj := '{}'::jsonb;
  IF v_order.notes IS NOT NULL AND trim(v_order.notes) <> '' THEN
    BEGIN
      v_notes_obj := v_order.notes::jsonb;
      IF jsonb_typeof(v_notes_obj) <> 'object' THEN
        RAISE EXCEPTION 'Estado del pedido inválido (notes)';
      END IF;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'Estado del pedido inválido (notes)';
    END;
  END IF;

  v_customer_uses := COALESCE((v_notes_obj->>'customer_enable_24h_uses')::int, 0);
  IF v_customer_uses >= 1 THEN
    RAISE EXCEPTION 'Ya usaste la prórroga de 24 horas para este pedido';
  END IF;

  -- Antes: now() + interval '24 hours' (podia vencer de nuevo un fin de
  -- semana/feriado, a cualquier hora). Ahora: proximo dia habil a las 17:00 Arg.
  v_new_dismantle := public.fn_compute_order_deadline(now(), 1);

  UPDATE public.orders
  SET
    dismantle_at = v_new_dismantle,
    notes = (v_notes_obj || jsonb_build_object('customer_enable_24h_uses', 1))::text,
    status = CASE
      WHEN lower(trim(coalesce(status, ''))) = 'closing_soon' THEN 'active'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.rpc_admin_extend_order_24h(p_order_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $function$
DECLARE
  v_order record;
  v_notes_obj jsonb;
  v_admin_uses int;
  v_new_dismantle timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores pueden otorgar prórrogas';
  END IF;

  SELECT id, status, notes
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'Pedido no encontrado';
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

  v_admin_uses := COALESCE((v_notes_obj->>'admin_enable_24h_uses')::int, 0);

  -- Sin tope de usos: a diferencia de la prorroga del cliente, esta es una
  -- accion manual de admin (autoridad total), el contador es solo para
  -- auditoria/UI (ver getEnable24hUsesFromOrder en nj/lib/orders/domain.ts).
  v_new_dismantle := public.fn_compute_order_deadline(now(), 1);

  UPDATE public.orders
  SET
    dismantle_at = v_new_dismantle,
    notes = (v_notes_obj || jsonb_build_object('admin_enable_24h_uses', v_admin_uses + 1))::text,
    status = CASE
      WHEN lower(trim(coalesce(status, ''))) = 'closing_soon' THEN 'active'
      ELSE status
    END,
    updated_at = now()
  WHERE id = p_order_id;

  RETURN json_build_object(
    'ok', true,
    'order_id', p_order_id,
    'dismantle_at', v_new_dismantle
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.rpc_admin_extend_order_24h(uuid) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
