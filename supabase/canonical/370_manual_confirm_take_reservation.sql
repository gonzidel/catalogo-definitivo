-- 370_manual_confirm_take_reservation.sql
--
-- NEGOCIO CONFIRMADO (2026-10-07): si al confirmar manualmente un producto (el
-- sistema dice 0 pero el par está en la estantería) ese talle está reservado
-- para otro pedido abierto, el admin ve el aviso y puede tomar ese par: el otro
-- pedido queda "sin stock" en ese producto y NO se suma stock fantasma.
--
-- Caso: 1632 Negro T37. A57180 (Yamila Aguirre) reservó el último T37 el 24/9;
-- el 25/9 se confirmó a mano para A57453 (Luna Natalia) el par de la
-- estantería (+1/-1 con fuente propia). Al vencer A57180 el 26/9 su fuente
-- reingresó +1: unidad fantasma. En los 30 días previos, 30 de 590
-- confirmaciones manuales coincidieron con otro pedido del mismo talle que
-- después quedó sin stock.
--
-- Cambios:
--   1) rpc_admin_manual_confirm_candidates(p_items, p_exclude_order_id):
--      lista, por variante+talle, los ítems de pedidos abiertos (active /
--      closing_soon) en picked/reserved con fuente en el depósito general.
--      "picked" no garantiza que el par esté en la bolsa (checked_at casi
--      nunca se completa), por eso decide el admin.
--   2) rpc_admin_manual_inject_and_deduct: cada ítem acepta
--      take_from_order_item_id. Si viene: valida el ítem origen, lo pasa a
--      'missing' con rpc_admin_mark_item_missing (baja la fuente y
--      reserved_qty sin reingresar), crea la fuente del ítem destino,
--      reserved_qty +qty (neto 0) y registra 'reserva_tomada' (stock sin
--      cambio). Sin el campo: comportamiento previo (+qty/-qty).
--      Devuelve taken_from para que la UI avise a la clienta afectada.
--   3) rpc_admin_add_order_items_atomic: propaga take_from_order_item_id y
--      devuelve stock.reservations_taken.
--   4) vw_stock_audit_manual_confirm_reserved: reporte de confirmaciones
--      manuales sobre talles reservados por otro pedido + reservas tomadas.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.rpc_admin_manual_inject_and_deduct(jsonb, uuid)'::regprocedure))
     <> '7533e954f01802a7962f09256ff3c008' THEN
    RAISE EXCEPTION '370: rpc_admin_manual_inject_and_deduct cambió desde la auditoría';
  END IF;
  IF md5(pg_get_functiondef('public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid)'::regprocedure))
     <> 'cbee2e3c015cb63984e4547544a6babc' THEN
    RAISE EXCEPTION '370: rpc_admin_add_order_items_atomic cambió desde la auditoría';
  END IF;
  IF md5(pg_get_functiondef('public.rpc_admin_mark_item_missing(uuid)'::regprocedure))
     <> 'd77ded2e9baccb1b01de86eb92a75a32' THEN
    RAISE EXCEPTION '370: rpc_admin_mark_item_missing cambió desde la auditoría';
  END IF;
  IF to_regprocedure('public.rpc_admin_manual_confirm_candidates(jsonb, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '370: rpc_admin_manual_confirm_candidates ya existe';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1) Candidatos: pedidos abiertos con el mismo talle reservado
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.rpc_admin_manual_confirm_candidates(
  p_items jsonb,
  p_exclude_order_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_general uuid;
  v_out jsonb := '[]'::jsonb;
  v_rec record;
  v_candidates jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Solo administradores';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN v_out;
  END IF;

  SELECT id INTO v_general FROM public.warehouses WHERE code = 'general' LIMIT 1;

  FOR v_rec IN
    SELECT DISTINCT
      (elem->>'variant_id')::uuid AS variant_id,
      fyl_private.normalize_size_admin_order(elem->>'size') AS size_norm
    FROM jsonb_array_elements(p_items) AS elem
    WHERE nullif(elem->>'variant_id', '') IS NOT NULL
      AND fyl_private.normalize_size_admin_order(elem->>'size') <> ''
  LOOP
    SELECT coalesce(jsonb_agg(c ORDER BY c->>'item_created_at' DESC), '[]'::jsonb)
      INTO v_candidates
      FROM (
        SELECT jsonb_build_object(
                 'order_item_id', oi.id,
                 'order_id', o.id,
                 'order_number', o.order_number,
                 'customer_id', o.customer_id,
                 'customer_name', coalesce(c.full_name, 'Cliente'),
                 'quantity', oi.quantity,
                 'item_status', oi.status,
                 'item_created_at', oi.created_at,
                 'checked_at', oi.checked_at,
                 'local_deferred_pickup', coalesce(o.local_deferred_pickup, false),
                 'source_qty', src.qty
               ) AS c
          FROM public.order_items oi
          JOIN public.orders o ON o.id = oi.order_id
          LEFT JOIN public.customers c ON c.id = o.customer_id
          JOIN LATERAL (
            SELECT sum(greatest(coalesce(s.qty, 0), 0))::int AS qty
              FROM public.order_item_stock_sources s
             WHERE s.order_item_id = oi.id
               AND s.warehouse_id = v_general
          ) src ON coalesce(src.qty, 0) > 0
         WHERE oi.variant_id = v_rec.variant_id
           AND fyl_private.normalize_size_admin_order(oi.size) = v_rec.size_norm
           AND o.id IS DISTINCT FROM p_exclude_order_id
           AND o.status IN ('active', 'closing_soon')
           AND lower(trim(coalesce(oi.status, ''))) IN ('picked', 'reserved')
         ORDER BY oi.created_at DESC
         LIMIT 10
      ) x;

    IF jsonb_array_length(v_candidates) > 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'variant_id', v_rec.variant_id,
        'size', v_rec.size_norm,
        'candidates', v_candidates
      ));
    END IF;
  END LOOP;

  RETURN v_out;
END
$function$;

COMMENT ON FUNCTION public.rpc_admin_manual_confirm_candidates(jsonb, uuid) IS
  'canonical:370 — pedidos abiertos con el mismo talle reservado (fuente en general) antes de una confirmación manual.';

REVOKE EXECUTE ON FUNCTION public.rpc_admin_manual_confirm_candidates(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_admin_manual_confirm_candidates(jsonb, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Confirmación manual con opción de tomar una reserva
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_admin_manual_inject_and_deduct(p_items jsonb, p_order_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_uid           uuid;
  v_general_id    uuid;
  v_rec           record;
  v_variant_id    uuid;
  v_size_norm     text;
  v_warehouse_id  uuid;
  v_qty           int;
  v_order_item_id uuid;
  v_product_id    uuid;
  v_stock_before  int;
  v_after_inject  int;
  v_after_deduct  int;
  v_processed     int := 0;
  v_details       jsonb := '[]'::jsonb;
  v_take_from     uuid;
  v_from          record;
  v_from_src_qty  int;
  v_from_src_other int;
  v_taken         jsonb := '[]'::jsonb;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'rpc_admin_manual_inject_and_deduct: no autenticado';
  end if;
  if not exists (select 1 from public.admins where user_id = v_uid) then
    raise exception 'rpc_admin_manual_inject_and_deduct: solo administradores';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', true, 'processed', 0);
  end if;

  select id into v_general_id from public.warehouses where code = 'general' limit 1;

  if v_general_id is null then
    raise exception 'rpc_admin_manual_inject_and_deduct: no se encontró el warehouse "general"';
  end if;

  for v_rec in
    select
      (elem->>'variant_id')::uuid                                  as variant_id,
      elem->>'size'                                                as size_raw,
      nullif(elem->>'warehouse_id', '')::uuid                      as warehouse_id,
      (elem->>'qty')::int                                          as qty,
      nullif(elem->>'order_item_id', '')::uuid                     as order_item_id,
      nullif(elem->>'take_from_order_item_id', '')::uuid           as take_from_order_item_id
    from jsonb_array_elements(p_items) as elem
    order by
      (elem->>'variant_id')::uuid,
      elem->>'size'
  loop
    v_variant_id    := v_rec.variant_id;
    v_qty           := v_rec.qty;
    v_order_item_id := v_rec.order_item_id;
    v_warehouse_id  := coalesce(v_rec.warehouse_id, v_general_id);
    v_take_from     := v_rec.take_from_order_item_id;

    if v_variant_id is null then
      raise exception 'rpc_admin_manual_inject_and_deduct: variant_id null en un ítem';
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'rpc_admin_manual_inject_and_deduct: qty debe ser > 0 (variant=%)', v_variant_id;
    end if;

    v_size_norm := trim(coalesce(v_rec.size_raw, ''));
    if v_size_norm = '' then
      raise exception 'rpc_admin_manual_inject_and_deduct: size vacío (variant=%)', v_variant_id;
    end if;
    if v_size_norm ~ '^\d+(\.\d+)?$' then
      v_size_norm := split_part(v_size_norm, '.', 1);
    end if;

    select product_id into v_product_id
    from public.product_variants
    where id = v_variant_id;

    if not found then
      raise exception 'rpc_admin_manual_inject_and_deduct: variant % no encontrada', v_variant_id;
    end if;

    insert into public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
    values (v_variant_id, v_size_norm, v_warehouse_id, 0)
    on conflict (variant_id, size, warehouse_id) do nothing;

    select stock_qty
    into   v_stock_before
    from   public.variant_size_warehouse_stock
    where  variant_id   = v_variant_id
      and  size         = v_size_norm
      and  warehouse_id = v_warehouse_id
    for update;

    if v_take_from is not null then
      -- Tomar la reserva de otro pedido: el par físico es el mismo, no se suma stock.
      if v_order_item_id is null then
        raise exception 'Para tomar una reserva hace falta el producto destino';
      end if;

      select oi.id, oi.order_id, oi.variant_id, oi.size, oi.quantity, oi.status,
             o.status as order_status, o.order_number, o.customer_id
        into v_from
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
       where oi.id = v_take_from
       for update of oi;

      if v_from.id is null then
        raise exception 'La reserva elegida ya no existe. Volvé a guardar para ver la situación actual.';
      end if;
      if v_from.order_id is not distinct from p_order_id then
        raise exception 'No se puede tomar una reserva del mismo pedido';
      end if;
      if v_from.variant_id is distinct from v_variant_id
         or fyl_private.normalize_size_admin_order(v_from.size) <> v_size_norm then
        raise exception 'La reserva elegida es de otro producto o talle';
      end if;
      if lower(trim(coalesce(v_from.status, ''))) not in ('picked', 'reserved') then
        raise exception 'La reserva de % ya cambió (estado %). Volvé a guardar.', v_from.order_number, v_from.status;
      end if;
      if v_from.order_status not in ('active', 'closing_soon') then
        raise exception 'El pedido % ya no está abierto (estado %)', v_from.order_number, v_from.order_status;
      end if;
      if coalesce(v_from.quantity, 0) <> v_qty then
        raise exception 'La reserva de % tiene % unidades y se pidieron %', v_from.order_number, v_from.quantity, v_qty;
      end if;

      select coalesce(sum(greatest(coalesce(s.qty, 0), 0)), 0)::int,
             count(*) filter (where s.warehouse_id <> v_warehouse_id)::int
        into v_from_src_qty, v_from_src_other
        from public.order_item_stock_sources s
       where s.order_item_id = v_take_from;

      if v_from_src_qty <> v_qty or v_from_src_other > 0 then
        raise exception 'La reserva de % no está completa en este depósito', v_from.order_number;
      end if;

      perform public.rpc_admin_mark_item_missing(v_take_from);

      insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      values (v_order_item_id, v_warehouse_id, v_qty);

      update public.product_variants
      set    reserved_qty = greatest(coalesce(reserved_qty, 0) + v_qty, 0)
      where  id = v_variant_id;

      perform public.log_stock_change(
        v_product_id,
        v_variant_id,
        v_size_norm,
        v_warehouse_id,
        'reserva_tomada',
        v_stock_before,
        v_stock_before,
        null, null,
        concat_ws(' | ',
          format('Reserva tomada de %s (order_item:%s)', v_from.order_number, v_take_from),
          case when p_order_id      is not null then 'order_id:'      || p_order_id::text      end,
          case when v_order_item_id is not null then 'order_item_id:' || v_order_item_id::text end
        )
      );

      v_taken := v_taken || jsonb_build_object(
        'order_item_id', v_take_from,
        'order_id', v_from.order_id,
        'order_number', v_from.order_number,
        'customer_id', v_from.customer_id,
        'to_order_item_id', v_order_item_id
      );

      v_processed := v_processed + 1;
      v_details   := v_details || jsonb_build_object(
        'variant_id',      v_variant_id,
        'size',            v_size_norm,
        'warehouse_id',    v_warehouse_id,
        'qty',             v_qty,
        'order_item_id',   v_order_item_id,
        'stock_before',    v_stock_before,
        'stock_after_net', v_stock_before,
        'taken_from',      v_take_from
      );
      continue;
    end if;

    v_after_inject := v_stock_before + v_qty;
    v_after_deduct := v_stock_before;

    update public.variant_size_warehouse_stock
    set    stock_qty  = v_after_inject,
           updated_at = now()
    where  variant_id   = v_variant_id
      and  size         = v_size_norm
      and  warehouse_id = v_warehouse_id;

    perform public.log_stock_change(
      v_product_id,
      v_variant_id,
      v_size_norm,
      v_warehouse_id,
      'admin_manual_confirmation',
      v_stock_before,
      v_after_inject,
      null, null,
      concat_ws(' | ',
        'Confirmación manual admin',
        case when p_order_id      is not null then 'order_id:'      || p_order_id::text      end,
        case when v_order_item_id is not null then 'order_item_id:' || v_order_item_id::text end
      )
    );

    update public.variant_size_warehouse_stock
    set    stock_qty  = v_after_deduct,
           updated_at = now()
    where  variant_id   = v_variant_id
      and  size         = v_size_norm
      and  warehouse_id = v_warehouse_id;

    perform public.log_stock_change(
      v_product_id,
      v_variant_id,
      v_size_norm,
      v_warehouse_id,
      'order_deduction',
      v_after_inject,
      v_after_deduct,
      null, null,
      concat_ws(' | ',
        'Descuento por confirmación manual admin',
        case when p_order_id      is not null then 'order_id:'      || p_order_id::text      end,
        case when v_order_item_id is not null then 'order_item_id:' || v_order_item_id::text end
      )
    );

    -- rpc_remove_order_item_restore_stock usa las fuentes para saber a qué depósito devolver.
    if v_order_item_id is not null then
      insert into public.order_item_stock_sources (order_item_id, warehouse_id, qty)
      values (v_order_item_id, v_warehouse_id, v_qty);
    end if;

    update public.product_variants
    set    reserved_qty = greatest(coalesce(reserved_qty, 0) + v_qty, 0)
    where  id = v_variant_id;

    v_processed := v_processed + 1;
    v_details   := v_details || jsonb_build_object(
      'variant_id',      v_variant_id,
      'size',            v_size_norm,
      'warehouse_id',    v_warehouse_id,
      'qty',             v_qty,
      'order_item_id',   v_order_item_id,
      'stock_before',    v_stock_before,
      'stock_after_net', v_after_deduct
    );
  end loop;

  return jsonb_build_object(
    'ok',         true,
    'processed',  v_processed,
    'order_id',   p_order_id,
    'details',    v_details,
    'taken_from', v_taken
  );
end;
$function$;

COMMENT ON FUNCTION public.rpc_admin_manual_inject_and_deduct(jsonb, uuid) IS
  'canonical:370 — confirmación manual (+qty/-qty) o, con take_from_order_item_id, toma la reserva de otro pedido sin stock fantasma.';

-- ---------------------------------------------------------------------------
-- 3) Edición atómica: propaga take_from_order_item_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_admin_add_order_items_atomic(p_order_id uuid, p_payload jsonb, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
DECLARE
  v_uid uuid;
  v_hash text;
  v_inserted_key uuid;
  v_dedupe public.admin_order_edit_idempotency%rowtype;
  v_order record;
  v_expected_status text;
  v_status text;
  v_items jsonb;
  v_items_eff jsonb := '[]'::jsonb;
  v_item jsonb;
  v_norm_item jsonb;
  v_index int;
  v_qty int;
  v_qty_general int;
  v_qty_venta int;
  v_price numeric;
  v_size text;
  v_variant_id uuid;
  v_is_special boolean;
  v_is_return boolean;
  v_admin_missing boolean;
  v_item_id uuid;
  v_item_ids uuid[] := array[]::uuid[];
  v_manual jsonb := '[]'::jsonb;
  v_manual_result jsonb;
  v_deductions jsonb := '[]'::jsonb;
  v_general uuid;
  v_venta uuid;
  v_deduct_result jsonb;
  v_notes jsonb;
  v_notes_patch jsonb;
  v_subtotal numeric := 0;
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_extras_amount numeric := 0;
  v_extras_percentage numeric := 0;
  v_total numeric := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: p_idempotency_key es obligatorio'
      USING ERRCODE = '22023';
  END IF;

  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'rpc_admin_add_order_items_atomic: order_id inválido'
      USING ERRCODE = '22023';
  END IF;

  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'rpc_admin_add_order_items_atomic: usuario no autenticado';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.admins a
    WHERE a.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'rpc_admin_add_order_items_atomic: forbidden (solo admins)';
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: p_payload debe ser objeto jsonb'
      USING ERRCODE = '22023';
  END IF;

  v_hash := fyl_private.admin_order_payload_sha256(
    jsonb_build_object('order_id', p_order_id, 'payload', p_payload)
  );

  INSERT INTO public.admin_order_edit_idempotency (
    idempotency_key,
    admin_user_id,
    order_id,
    payload_hash,
    status
  )
  VALUES (
    p_idempotency_key,
    v_uid,
    p_order_id,
    v_hash,
    'pending'
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING idempotency_key INTO v_inserted_key;

  IF v_inserted_key IS NULL THEN
    SELECT *
    INTO v_dedupe
    FROM public.admin_order_edit_idempotency d
    WHERE d.idempotency_key = p_idempotency_key;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: idempotencia inconsistente';
    END IF;

    IF v_dedupe.admin_user_id IS DISTINCT FROM v_uid
       OR v_dedupe.order_id IS DISTINCT FROM p_order_id
    THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: idempotency key pertenece a otra operación';
    END IF;

    IF v_dedupe.payload_hash IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: IDEMPOTENCY_CONFLICT — misma clave con payload distinto'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_dedupe.status = 'success' THEN
      RETURN coalesce(v_dedupe.response_jsonb, '{}'::jsonb)
        || jsonb_build_object(
             'idempotency',
             jsonb_build_object('replay', true)
           );
    END IF;

    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: operación en curso; reintentá';
  END IF;

  SELECT
    o.id,
    o.status,
    o.customer_id,
    o.order_number,
    o.total_amount,
    o.notes
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: ORDER_NOT_FOUND — pedido inexistente'
      USING ERRCODE = 'P0001';
  END IF;

  v_status := lower(trim(coalesce(v_order.status, '')));
  v_expected_status := lower(
    trim(coalesce(p_payload->>'expected_status', ''))
  );

  IF v_expected_status <> '' AND v_expected_status IS DISTINCT FROM v_status THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: ORDER_STATE_CHANGED — esperado %, actual %',
      v_expected_status,
      v_status
      USING ERRCODE = 'P0001';
  END IF;

  -- Allowlist operativa: Activos / closing_soon / Cerrados / Enviados.
  -- cancelled/expired/stock_pending/devolución se rechazan.
  -- `sent` permitido para editar desde admin/sent-orders (350) sin reabrir.
  IF v_status NOT IN (
    'active',
    'closing_soon',
    'closed',
    'sent'
  ) THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: ORDER_STATE_BLOCKED — no se puede editar estado %',
      v_status
      USING ERRCODE = 'P0001';
  END IF;

  v_items := p_payload->'items';
  IF v_items IS NULL
     OR jsonb_typeof(v_items) <> 'array'
     OR jsonb_array_length(v_items) = 0
  THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: items debe ser un array no vacío'
      USING ERRCODE = '22023';
  END IF;

  SELECT w.id INTO v_general
  FROM public.warehouses w
  WHERE w.code = 'general'
  LIMIT 1;

  SELECT w.id INTO v_venta
  FROM public.warehouses w
  WHERE w.code = 'venta-publico'
  LIMIT 1;

  IF v_general IS NULL OR v_venta IS NULL THEN
    RAISE EXCEPTION
      'rpc_admin_add_order_items_atomic: warehouses general o venta-publico no encontrados';
  END IF;

  FOR v_index IN 0..jsonb_array_length(v_items) - 1 LOOP
    v_item := v_items->v_index;

    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: ítem % inválido',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    v_qty := coalesce((v_item->>'quantity')::int, 0);
    IF v_qty <= 0 THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: quantity debe ser > 0 (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    IF nullif(trim(coalesce(v_item->>'product_name', '')), '') IS NULL THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: product_name requerido (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_price := coalesce((v_item->>'price_snapshot')::numeric, 0);
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION
          'rpc_admin_add_order_items_atomic: price_snapshot inválido (ítem %)',
          v_index + 1
          USING ERRCODE = '22023';
    END;

    v_is_special := coalesce(
      (v_item->>'is_special_extra')::boolean,
      false
    );
    v_is_return := v_price < 0;
    v_size := fyl_private.normalize_size_admin_order(v_item->>'size');
    v_qty_general := coalesce((v_item->>'qty_from_general')::int, 0);
    v_qty_venta := coalesce((v_item->>'qty_from_venta')::int, 0);

    IF v_qty_general < 0 OR v_qty_venta < 0 THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: split negativo (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    IF nullif(trim(coalesce(v_item->>'variant_id', '')), '') IS NULL THEN
      IF NOT v_is_special THEN
        RAISE EXCEPTION
          'rpc_admin_add_order_items_atomic: variant_id requerido salvo extra especial (ítem %)',
          v_index + 1
          USING ERRCODE = '22023';
      END IF;
      v_variant_id := NULL;
      v_qty_general := 0;
      v_qty_venta := 0;
      v_admin_missing := false;
      v_size := '';
    ELSE
      BEGIN
        v_variant_id := (trim(v_item->>'variant_id'))::uuid;
      EXCEPTION
        WHEN invalid_text_representation THEN
          RAISE EXCEPTION
            'rpc_admin_add_order_items_atomic: variant_id UUID inválido (ítem %)',
            v_index + 1
            USING ERRCODE = '22023';
      END;

      IF v_is_return THEN
        v_qty_general := 0;
        v_qty_venta := 0;
        v_admin_missing := false;
      ELSE
        v_admin_missing := coalesce(
          (v_item->>'admin_confirmed_missing')::boolean,
          false
        );

        IF v_size <> ''
           AND v_qty_general + v_qty_venta <> v_qty
        THEN
          v_admin_missing := true;
        END IF;
      END IF;
    END IF;

    IF lower(trim(coalesce(v_item->>'status', 'picked'))) NOT IN (
      'picked',
      'reserved',
      'waiting',
      'missing'
    ) THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: status de ítem inválido (ítem %)',
        v_index + 1
        USING ERRCODE = '22023';
    END IF;

    v_norm_item := v_item || jsonb_build_object(
      'variant_id', v_variant_id,
      'size', nullif(v_size, ''),
      'quantity', v_qty,
      'price_snapshot', v_price,
      'qty_from_general', v_qty_general,
      'qty_from_venta', v_qty_venta,
      'status', lower(trim(coalesce(v_item->>'status', 'picked'))),
      'admin_confirmed_missing', v_admin_missing,
      'is_special_extra', v_is_special
    );

    v_items_eff := v_items_eff || jsonb_build_array(v_norm_item);
  END LOOP;

  FOR v_index IN 0..jsonb_array_length(v_items_eff) - 1 LOOP
    v_item := v_items_eff->v_index;

    INSERT INTO public.order_items (
      order_id,
      variant_id,
      product_name,
      color,
      size,
      quantity,
      price_snapshot,
      imagen,
      status,
      admin_confirmed_missing
    )
    VALUES (
      p_order_id,
      nullif(v_item->>'variant_id', '')::uuid,
      trim(v_item->>'product_name'),
      nullif(v_item->>'color', ''),
      nullif(v_item->>'size', ''),
      (v_item->>'quantity')::int,
      (v_item->>'price_snapshot')::numeric,
      nullif(v_item->>'imagen', ''),
      v_item->>'status',
      coalesce((v_item->>'admin_confirmed_missing')::boolean, false)
    )
    RETURNING id INTO v_item_id;

    v_item_ids := array_append(v_item_ids, v_item_id);
  END LOOP;

  FOR v_index IN 0..jsonb_array_length(v_items_eff) - 1 LOOP
    v_item := v_items_eff->v_index;

    IF coalesce((v_item->>'admin_confirmed_missing')::boolean, false)
       AND coalesce((v_item->>'price_snapshot')::numeric, 0) >= 0
       AND nullif(v_item->>'variant_id', '') IS NOT NULL
       AND fyl_private.normalize_size_admin_order(v_item->>'size') <> ''
    THEN
      v_manual := v_manual || jsonb_build_array(
        jsonb_build_object(
          'variant_id', (v_item->>'variant_id')::uuid,
          'size', fyl_private.normalize_size_admin_order(v_item->>'size'),
          'warehouse_id', v_general,
          'qty', (v_item->>'quantity')::int,
          'order_item_id', v_item_ids[v_index + 1],
          'take_from_order_item_id', nullif(v_item->>'take_from_order_item_id', '')
        )
      );
    ELSIF coalesce((v_item->>'price_snapshot')::numeric, 0) >= 0
       AND fyl_private.admin_order_item_qualifies_deduction(v_item)
    THEN
      v_qty_general := coalesce((v_item->>'qty_from_general')::int, 0);
      v_qty_venta := coalesce((v_item->>'qty_from_venta')::int, 0);

      IF v_qty_general > 0 THEN
        v_deductions := v_deductions || jsonb_build_array(
          jsonb_build_object(
            'variant_id', (v_item->>'variant_id')::uuid,
            'size', fyl_private.normalize_size_admin_order(v_item->>'size'),
            'warehouse_id', v_general,
            'qty_to_deduct', v_qty_general,
            'order_item_id', v_item_ids[v_index + 1]
          )
        );
      END IF;

      IF v_qty_venta > 0 THEN
        v_deductions := v_deductions || jsonb_build_array(
          jsonb_build_object(
            'variant_id', (v_item->>'variant_id')::uuid,
            'size', fyl_private.normalize_size_admin_order(v_item->>'size'),
            'warehouse_id', v_venta,
            'qty_to_deduct', v_qty_venta,
            'order_item_id', v_item_ids[v_index + 1]
          )
        );
      END IF;
    END IF;
  END LOOP;

  IF jsonb_array_length(v_manual) > 0 THEN
    SELECT public.rpc_admin_manual_inject_and_deduct(
      v_manual,
      p_order_id
    )
    INTO v_manual_result;
  END IF;

  IF jsonb_array_length(v_deductions) > 0 THEN
    SELECT public.rpc_apply_order_stock_deduction(
      v_deductions,
      p_order_id,
      'order_edit'
    )
    INTO v_deduct_result;

    IF NOT coalesce((v_deduct_result->>'ok')::boolean, false) THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: descuento de stock sin confirmación';
    END IF;

    -- 166 descuenta stock y reserved_qty, pero no escribe OISS. Sin estas
    -- fuentes, cancelación/devolución posteriores no restauran el depósito
    -- correcto. Se insertan en la misma transacción, una por línea+depósito.
    FOR v_index IN 0..jsonb_array_length(v_deductions) - 1 LOOP
      INSERT INTO public.order_item_stock_sources (
        order_item_id,
        warehouse_id,
        qty
      )
      VALUES (
        (v_deductions->v_index->>'order_item_id')::uuid,
        (v_deductions->v_index->>'warehouse_id')::uuid,
        (v_deductions->v_index->>'qty_to_deduct')::int
      );
    END LOOP;
  END IF;

  BEGIN
    v_notes := coalesce(nullif(v_order.notes, '')::jsonb, '{}'::jsonb);
    IF jsonb_typeof(v_notes) <> 'object' THEN
      v_notes := '{}'::jsonb;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      v_notes := '{}'::jsonb;
  END;

  v_notes_patch := p_payload->'notes_extras';
  IF v_notes_patch IS NOT NULL
     AND jsonb_typeof(v_notes_patch) = 'object'
  THEN
    v_notes := v_notes || v_notes_patch;
  END IF;

  IF nullif(trim(coalesce(v_notes->>'extras_label', '')), '') IS NULL THEN
    v_notes := v_notes - 'extras_label' - 'extras_name';
  END IF;

  SELECT coalesce(
    sum(oi.price_snapshot * oi.quantity),
    0
  )
  INTO v_subtotal
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
    AND lower(trim(coalesce(oi.status, ''))) NOT IN ('cancelled', 'expired');

  BEGIN
    v_shipping := coalesce(nullif(v_notes->>'shipping', '')::numeric, 0);
    v_discount := coalesce(nullif(v_notes->>'discount', '')::numeric, 0);
    v_extras_amount := coalesce(
      nullif(v_notes->>'extras_amount', '')::numeric,
      0
    );
    v_extras_percentage := coalesce(
      nullif(v_notes->>'extras_percentage', '')::numeric,
      0
    );
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION
        'rpc_admin_add_order_items_atomic: valores extra inválidos'
        USING ERRCODE = '22023';
  END;

  v_total :=
    v_subtotal
    + v_shipping
    - v_discount
    + v_extras_amount
    + CASE
        WHEN v_extras_percentage > 0
          THEN v_subtotal * v_extras_percentage / 100
        ELSE 0
      END;

  UPDATE public.orders o
  SET
    -- Preservar closed/sent; solo normalizar active/closing_soon a active.
    status = CASE
      WHEN v_status IN ('active', 'closing_soon') THEN 'active'
      ELSE o.status
    END,
    total_amount = v_total,
    notes = v_notes::text,
    updated_at = now()
  WHERE o.id = p_order_id;

  v_result := jsonb_build_object(
    'ok', true,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'order_status', CASE
      WHEN v_status IN ('active', 'closing_soon') THEN 'active'
      ELSE v_order.status
    END,
    'total_amount', v_total,
    'inserted_items', (
      SELECT coalesce(
        jsonb_agg(
          jsonb_build_object(
            'id', oi.id,
            'variant_id', oi.variant_id,
            'size', oi.size,
            'quantity', oi.quantity,
            'admin_confirmed_missing', oi.admin_confirmed_missing
          )
          ORDER BY oi.created_at, oi.id
        ),
        '[]'::jsonb
      )
      FROM public.order_items oi
      WHERE oi.id = ANY(v_item_ids)
    ),
    'stock', jsonb_build_object(
      'manual_processed', jsonb_array_length(v_manual),
      'deduction_applied_items',
        CASE
          WHEN jsonb_array_length(v_deductions) > 0
            THEN coalesce((v_deduct_result->>'applied_items')::int, 0)
          ELSE 0
        END,
      'reservations_taken', coalesce(v_manual_result->'taken_from', '[]'::jsonb),
      'source', 'order_edit'
    ),
    'idempotency', jsonb_build_object('replay', false)
  );

  UPDATE public.admin_order_edit_idempotency d
  SET
    status = 'success',
    response_jsonb = v_result,
    completed_at = now()
  WHERE d.idempotency_key = p_idempotency_key;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.rpc_admin_add_order_items_atomic(uuid, jsonb, uuid) IS
  'canonical:370 — alta atómica de ítems; propaga take_from_order_item_id a la confirmación manual.';

-- ---------------------------------------------------------------------------
-- 4) Reporte
-- ---------------------------------------------------------------------------
CREATE VIEW public.vw_stock_audit_manual_confirm_reserved
WITH (security_invoker = true) AS
WITH mc AS (
  SELECT h.id AS history_id,
         h.created_at AS confirmed_at,
         h.user_id,
         h.variant_id,
         h.size,
         nullif(substring(h.notes from 'order_id:([0-9a-f-]{36})'), '')::uuid AS order_id,
         nullif(substring(h.notes from 'order_item_id:([0-9a-f-]{36})'), '')::uuid AS order_item_id
    FROM public.stock_history h
   WHERE h.change_type = 'admin_manual_confirmation'
     AND h.created_at > now() - interval '90 days'
),
manual_rows AS (
  SELECT 'confirmacion_manual'::text AS kind,
         mc.confirmed_at,
         mc.user_id,
         mc.variant_id,
         mc.size,
         mc.order_id,
         mc.order_item_id,
         oi2.id AS other_order_item_id,
         oi2.order_id AS other_order_id
    FROM mc
    JOIN public.order_items oi2
      ON oi2.variant_id = mc.variant_id
     AND (CASE WHEN trim(coalesce(oi2.size, '')) ~ '^\d+(\.\d+)?$'
               THEN split_part(trim(oi2.size), '.', 1)
               ELSE trim(coalesce(oi2.size, '')) END) = mc.size
     AND oi2.order_id IS DISTINCT FROM mc.order_id
     AND oi2.created_at < mc.confirmed_at
    JOIN public.orders o2 ON o2.id = oi2.order_id
   WHERE (o2.sent_at IS NULL OR o2.sent_at > mc.confirmed_at)
     AND (
       lower(trim(coalesce(oi2.status, ''))) IN ('picked', 'reserved')
       OR (lower(trim(coalesce(oi2.status, ''))) = 'missing'
           AND (oi2.checked_at IS NULL OR oi2.checked_at > mc.confirmed_at))
       OR (lower(trim(coalesce(oi2.status, ''))) = 'cancelled'
           AND oi2.cancelled_from_status = 'missing'
           AND oi2.updated_at > mc.confirmed_at)
     )
),
taken_rows AS (
  SELECT 'reserva_tomada'::text AS kind,
         h.created_at AS confirmed_at,
         h.user_id,
         h.variant_id,
         h.size,
         nullif(substring(h.notes from 'order_id:([0-9a-f-]{36})'), '')::uuid AS order_id,
         nullif(substring(h.notes from 'order_item_id:([0-9a-f-]{36})'), '')::uuid AS order_item_id,
         nullif(substring(h.notes from 'order_item:([0-9a-f-]{36})'), '')::uuid AS other_order_item_id,
         NULL::uuid AS other_order_id
    FROM public.stock_history h
   WHERE h.change_type = 'reserva_tomada'
     AND h.created_at > now() - interval '90 days'
),
all_rows AS (
  SELECT * FROM manual_rows
  UNION ALL
  SELECT * FROM taken_rows
)
SELECT r.kind,
       r.confirmed_at,
       a.email AS confirmed_by,
       pv.sku,
       r.size,
       o.order_number AS order_number,
       oth_o.order_number AS other_order_number,
       oth_c.full_name AS other_customer,
       oth.created_at AS other_item_created_at,
       oth.status AS other_item_status,
       oth.cancelled_from_status AS other_cancelled_from,
       oth_o.status AS other_order_status,
       CASE
         WHEN r.kind = 'reserva_tomada' THEN 'reserva tomada con aviso'
         WHEN lower(trim(coalesce(oth.status, ''))) = 'missing'
              OR oth.cancelled_from_status = 'missing' THEN 'el otro pedido quedó sin stock'
         WHEN oth_o.status = 'sent' THEN 'el otro pedido se envió (había otro par)'
         WHEN oth_o.status IN ('active', 'closing_soon', 'closed') THEN 'el otro pedido sigue con el producto'
         ELSE coalesce(oth_o.status, 'otro pedido borrado')
       END AS outcome,
       r.variant_id,
       r.order_id,
       r.order_item_id,
       r.other_order_item_id,
       coalesce(r.other_order_id, oth.order_id) AS other_order_id
  FROM all_rows r
  LEFT JOIN public.admins a ON a.user_id = r.user_id
  LEFT JOIN public.product_variants pv ON pv.id = r.variant_id
  LEFT JOIN public.orders o ON o.id = r.order_id
  LEFT JOIN public.order_items oth ON oth.id = r.other_order_item_id
  LEFT JOIN public.orders oth_o ON oth_o.id = coalesce(r.other_order_id, oth.order_id)
  LEFT JOIN public.customers oth_c ON oth_c.id = oth_o.customer_id;

COMMENT ON VIEW public.vw_stock_audit_manual_confirm_reserved IS
  'canonical:370 — confirmaciones manuales sobre talles reservados por otro pedido (90 días) y reservas tomadas con aviso.';

REVOKE ALL ON public.vw_stock_audit_manual_confirm_reserved FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vw_stock_audit_manual_confirm_reserved TO authenticated, service_role;

COMMIT;
