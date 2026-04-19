-- 163_stage1_stock_hardening.sql
-- Etapa 1 (cierre):
-- 1) Cancelación completa de pedido en una RPC transaccional, validando
--    explícitamente el JSON devuelto por las RPC canónicas por item y
--    delegando el borrado del pedido en el camino oficial de auditoría
--    (maint_try_delete_order_if_eligible), sin DELETE directo de orders.
-- 2) Hardening de void de venta pública con lock + idempotencia.
--
-- NOTA idempotencia (deuda explícita para Etapa 2):
--   rpc_cancel_order_full tiene hoy idempotencia DÉBIL:
--     - si la orden no existe, retorna idempotent_noop=true (reintento seguro
--       después de una cancelación exitosa).
--     - NO hay operation_id propio ni deduplicación fuerte por clave de
--       operación. Un reintento concurrente real sobre una orden todavía
--       existente se serializa vía FOR UPDATE, pero no devuelve un resultado
--       determinista de "ya se hizo esta operación exacta".
--   La idempotencia FUERTE (operation_id + tabla de operaciones) queda
--   pendiente para la etapa siguiente y NO se implementa aquí.
--
-- NOTA gobernanza void public sale (deuda explícita para Etapa 2):
--   rpc_void_public_sale quedó endurecida contra concurrencia (FOR UPDATE +
--   idempotent_noop por voided_at), pero el hardening de RLS/grants para
--   impedir caminos alternos de escritura directa sobre public_sales y
--   tablas de stock desde clientes admin NO forma parte de Etapa 1.
--   Se deja explícito como deuda para Etapa 2 (centralización de escrituras).

CREATE OR REPLACE FUNCTION public.rpc_cancel_order_full(
  p_order_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_uid uuid;
  v_order record;
  v_item_id uuid;
  v_rpc_result json;
  v_cancelled_items int := 0;
  v_removed_items int := 0;
  v_order_deleted boolean := false;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.admins a WHERE a.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden cancelar pedidos completos';
  END IF;

  SELECT
    o.id,
    o.order_number,
    o.status,
    o.customer_id
  INTO v_order
  FROM public.orders o
  WHERE o.id = p_order_id
  FOR UPDATE;

  -- Idempotencia débil: si la orden ya no existe, consideramos que
  -- la operación ya fue aplicada previamente y devolvemos noop.
  IF v_order.id IS NULL THEN
    RETURN json_build_object(
      'ok', true,
      'idempotent_noop', true,
      'reason', 'order_not_found',
      'order_id', p_order_id
    );
  END IF;

  IF v_order.status IN ('closed', 'sent') THEN
    RAISE EXCEPTION 'No se puede cancelar un pedido con estado %', v_order.status;
  END IF;

  -- Bloquear ítems actuales del pedido para evitar carrera con otras acciones.
  PERFORM 1
  FROM public.order_items oi
  WHERE oi.order_id = p_order_id
  FOR UPDATE;

  -- Pase 1: reserved / waiting / missing -> rpc_cancel_order_item.
  -- rpc_cancel_order_item marca el item como 'cancelled' (trazabilidad),
  -- devuelve stock cuando corresponde y NO borra el pedido. Validamos
  -- applied=true en el JSON devuelto; si no, rollback de TODA la cancelación.
  FOR v_item_id IN
    SELECT oi.id
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) IN ('reserved', 'waiting', 'missing')
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_cancel_order_item(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'applied')::boolean, false)
    THEN
      RAISE EXCEPTION
        'rpc_cancel_order_item no confirmó applied=true para item_id=% (resultado=%)',
        v_item_id, v_rpc_result;
    END IF;

    v_cancelled_items := v_cancelled_items + 1;
  END LOOP;

  -- Pase 2: picked -> rpc_remove_order_item_restore_stock.
  -- Esta RPC restaura stock, BORRA el order_item y, si el pedido queda sin
  -- ítems operacionales, delega el borrado en maint_try_delete_order_if_eligible
  -- (registra order_empty_deletion_audit). Validamos ok=true del JSON; si no,
  -- rollback de TODA la cancelación.
  FOR v_item_id IN
    SELECT oi.id
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND lower(trim(coalesce(oi.status, ''))) = 'picked'
    ORDER BY oi.created_at, oi.id
  LOOP
    v_rpc_result := public.rpc_remove_order_item_restore_stock(v_item_id);

    IF v_rpc_result IS NULL
       OR NOT COALESCE((v_rpc_result->>'ok')::boolean, false)
    THEN
      RAISE EXCEPTION
        'rpc_remove_order_item_restore_stock no confirmó ok=true para item_id=% (resultado=%)',
        v_item_id, v_rpc_result;
    END IF;

    v_removed_items := v_removed_items + 1;

    -- La RPC puede haber borrado el pedido ya (trigger 119).
    IF COALESCE((v_rpc_result->>'order_deleted')::boolean, false) THEN
      v_order_deleted := true;
      EXIT;
    END IF;
  END LOOP;

  -- Borrado del pedido por el camino oficial con auditoría.
  -- Si todos los ítems operativos pasaron a 'cancelled' o fueron eliminados,
  -- el pedido es elegible y maint_try_delete_order_if_eligible:
  --   - inserta una fila en public.order_empty_deletion_audit
  --   - DELETE FROM public.orders (que CASCADEA order_items y tablas derivadas)
  -- Los order_items en estado 'cancelled' se pierden por CASCADE: ese es el
  -- diseño actual del sistema (la auditoría se conserva en
  -- order_empty_deletion_audit + stock_history vía log_stock_change, no en
  -- order_items). No se introduce aquí un cambio de esa política.
  IF NOT v_order_deleted THEN
    v_order_deleted := COALESCE(
      public.maint_try_delete_order_if_eligible(p_order_id, 'rpc_cancel_order_full'),
      false
    );
  END IF;

  IF NOT v_order_deleted THEN
    -- Invariante esperada: tras procesar todos los ítems operacionales, el
    -- pedido debe quedar elegible para borrado. Si no, algún ítem quedó en
    -- estado operativo inesperado: abortar para forzar revisión manual.
    RAISE EXCEPTION
      'rpc_cancel_order_full: el pedido % no quedó elegible para borrado tras cancelar ítems operacionales',
      p_order_id;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'idempotent_noop', false,
    'order_id', p_order_id,
    'order_number', v_order.order_number,
    'items_cancelled_reserved_waiting_missing', v_cancelled_items,
    'items_removed_picked', v_removed_items,
    'order_deleted', v_order_deleted
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_cancel_order_full(uuid) IS
  'Cancela un pedido completo en una transacción: valida applied/ok de RPCs canónicas por item y delega el borrado auditado en maint_try_delete_order_if_eligible. Idempotencia DÉBIL (noop si la orden ya no existe); idempotencia fuerte con operation_id queda para Etapa 2.';

GRANT EXECUTE ON FUNCTION public.rpc_cancel_order_full(uuid) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.rpc_void_public_sale(p_sale_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_sale record;
  v_psi record;
  v_wh_vp uuid;
  v_wh_g uuid;
  v_pv_size text;
  v_norm text;
  v_has_size_model boolean;
BEGIN
  SELECT id INTO v_wh_vp FROM public.warehouses WHERE code = 'venta-publico' LIMIT 1;
  SELECT id INTO v_wh_g FROM public.warehouses WHERE code = 'general' LIMIT 1;

  IF v_wh_vp IS NULL THEN
    RAISE EXCEPTION 'Warehouse venta-publico no encontrado';
  END IF;
  IF v_wh_g IS NULL THEN
    RAISE EXCEPTION 'Warehouse general no encontrado';
  END IF;

  -- Lock fuerte para evitar doble restauración concurrente.
  SELECT id, sale_number, customer_id, credit_used, voided_at
  INTO v_sale
  FROM public.public_sales
  WHERE id = p_sale_id
  FOR UPDATE;

  IF v_sale.id IS NULL THEN
    RAISE EXCEPTION 'Venta no encontrada';
  END IF;

  -- Idempotencia: si ya está anulada, responder éxito sin tocar stock.
  IF v_sale.voided_at IS NOT NULL THEN
    RETURN json_build_object(
      'success', true,
      'sale_number', v_sale.sale_number,
      'idempotent_noop', true
    );
  END IF;

  FOR v_psi IN
    SELECT psi.*, pv.size AS pv_size
    FROM public.public_sale_items psi
    LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
    WHERE psi.sale_id = p_sale_id AND psi.variant_id IS NOT NULL
  LOOP
    IF (v_psi.qty_venta_publico IS NULL) <> (v_psi.qty_general IS NULL) THEN
      RAISE EXCEPTION 'public_sale_items id %: qty_venta_publico y qty_general deben ser ambas NULL o ambas NOT NULL',
        v_psi.id;
    END IF;

    IF v_psi.qty_venta_publico IS NULL AND v_psi.qty_general IS NULL THEN
      SELECT (
        EXISTS (
          SELECT 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_psi.variant_id
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.variant_sizes
          WHERE variant_id = v_psi.variant_id
            AND TRIM(COALESCE(size, '')) <> ''
          LIMIT 1
        )
      )
      INTO v_has_size_model;

      IF COALESCE(v_has_size_model, false) THEN
        RAISE EXCEPTION 'La variante % usa talles. No se puede anular línea legacy sin size.', v_psi.variant_id;
      END IF;

      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    v_norm := NULL;
    IF v_psi.sold_size_normalized IS NOT NULL AND TRIM(v_psi.sold_size_normalized::text) != '' THEN
      v_norm := TRIM(v_psi.sold_size_normalized::text);
      IF v_norm ~ '^\d+(\.\d+)?$' THEN
        v_norm := split_part(v_norm, '.', 1);
      END IF;
    END IF;
    IF v_norm IS NULL OR v_norm = '' THEN
      v_pv_size := v_psi.pv_size;
      IF v_pv_size IS NOT NULL AND TRIM(v_pv_size::text) != '' THEN
        v_norm := TRIM(v_pv_size::text);
        IF v_norm ~ '^\d+(\.\d+)?$' THEN
          v_norm := split_part(v_norm, '.', 1);
        END IF;
      END IF;
    END IF;

    IF v_norm IS NULL OR v_norm = '' THEN
      SELECT (
        EXISTS (
          SELECT 1
          FROM public.variant_size_warehouse_stock
          WHERE variant_id = v_psi.variant_id
          LIMIT 1
        )
        OR EXISTS (
          SELECT 1
          FROM public.variant_sizes
          WHERE variant_id = v_psi.variant_id
            AND TRIM(COALESCE(size, '')) <> ''
          LIMIT 1
        )
      )
      INTO v_has_size_model;

      IF COALESCE(v_has_size_model, false) THEN
        RAISE EXCEPTION 'La variante % usa talles. No se puede anular línea sin size.', v_psi.variant_id;
      END IF;

      IF v_psi.is_return THEN
        UPDATE public.variant_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND warehouse_id = v_wh_vp;
      ELSE
        INSERT INTO public.variant_warehouse_stock (variant_id, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_wh_vp, v_psi.qty)
        ON CONFLICT (variant_id, warehouse_id)
        DO UPDATE SET
          stock_qty = public.variant_warehouse_stock.stock_qty + v_psi.qty,
          updated_at = now();
      END IF;
      CONTINUE;
    END IF;

    IF v_psi.is_return THEN
      IF v_psi.qty_venta_publico > 0 THEN
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = greatest(0, stock_qty - v_psi.qty_venta_publico), updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
    ELSE
      IF v_psi.qty_venta_publico > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_vp, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_venta_publico, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_vp;
      END IF;
      IF v_psi.qty_general > 0 THEN
        INSERT INTO public.variant_size_warehouse_stock (variant_id, size, warehouse_id, stock_qty)
        VALUES (v_psi.variant_id, v_norm, v_wh_g, 0)
        ON CONFLICT (variant_id, size, warehouse_id) DO NOTHING;
        UPDATE public.variant_size_warehouse_stock
        SET stock_qty = stock_qty + v_psi.qty_general, updated_at = now()
        WHERE variant_id = v_psi.variant_id AND size = v_norm AND warehouse_id = v_wh_g;
      END IF;
    END IF;
  END LOOP;

  IF v_sale.customer_id IS NOT NULL AND coalesce(v_sale.credit_used, 0) > 0 THEN
    PERFORM public.rpc_add_customer_credit(
      v_sale.customer_id,
      v_sale.credit_used,
      'Crédito restaurado por anulación de venta ' || v_sale.sale_number
    );
  END IF;

  UPDATE public.public_sales
  SET voided_at = now()
  WHERE id = p_sale_id
    AND voided_at IS NULL;

  RETURN json_build_object(
    'success', true,
    'sale_number', v_sale.sale_number,
    'idempotent_noop', false
  );
END $$;

COMMENT ON FUNCTION public.rpc_void_public_sale(uuid) IS
  'Anula venta pública con lock FOR UPDATE e idempotencia (si ya estaba anulada devuelve success noop).';

SELECT pg_notify('pgrst', 'reload schema');
