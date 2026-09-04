-- 304_sent_order_shipping_meta.sql
-- Metadatos de envío/reimpresión para sent-orders:
-- - original_sent_at: primera fecha de envío (no se pierde al reprogramar)
-- - sent_transport_id: transporte con el que se envió originalmente
-- - last_label_transport_id: transporte usado en la última impresión/reimpresión de rótulo
-- - labels_reprinted / last_reprinted_at: marca de reimpresión

-- ---------------------------------------------------------------------------
-- 1) Columnas
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'original_sent_at'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN original_sent_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'labels_reprinted'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN labels_reprinted boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'last_reprinted_at'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN last_reprinted_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sent_transport_id'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN sent_transport_id uuid REFERENCES public.transports(id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'last_label_transport_id'
  ) THEN
    ALTER TABLE public.orders ADD COLUMN last_label_transport_id uuid REFERENCES public.transports(id);
  END IF;
END $$;

COMMENT ON COLUMN public.orders.original_sent_at IS
  'Primera fecha de envío (sent). Se preserva al reprogramar sent_at.';
COMMENT ON COLUMN public.orders.labels_reprinted IS
  'True si se reimprimieron rótulos desde pedidos enviados.';
COMMENT ON COLUMN public.orders.last_reprinted_at IS
  'Última vez que se reimprimieron rótulos del pedido.';
COMMENT ON COLUMN public.orders.sent_transport_id IS
  'Transporte con el que se marcó/envió originalmente el pedido.';
COMMENT ON COLUMN public.orders.last_label_transport_id IS
  'Transporte usado en la última impresión/reimpresión de rótulo.';

-- ---------------------------------------------------------------------------
-- 2) Backfill seguro (solo datos conocidos; no inventa fechas previas a reprogramaciones históricas)
-- ---------------------------------------------------------------------------
UPDATE public.orders
SET original_sent_at = sent_at
WHERE original_sent_at IS NULL
  AND sent_at IS NOT NULL
  AND lower(coalesce(status, '')) IN ('sent', 'devolución');

UPDATE public.orders o
SET sent_transport_id = COALESCE(
  o.transport_id,
  (SELECT c.transport_id FROM public.customers c WHERE c.id = o.customer_id)
)
WHERE o.sent_transport_id IS NULL
  AND lower(coalesce(o.status, '')) IN ('sent', 'devolución')
  AND COALESCE(
    o.transport_id,
    (SELECT c.transport_id FROM public.customers c WHERE c.id = o.customer_id)
  ) IS NOT NULL;

UPDATE public.orders
SET last_label_transport_id = COALESCE(last_label_transport_id, sent_transport_id, transport_id)
WHERE last_label_transport_id IS NULL
  AND lower(coalesce(status, '')) IN ('sent', 'devolución')
  AND COALESCE(sent_transport_id, transport_id) IS NOT NULL;

UPDATE public.orders
SET labels_reprinted = false
WHERE labels_reprinted IS NULL;

-- ---------------------------------------------------------------------------
-- 3) rpc_mark_order_as_sent: snapshot de fecha y transporte al finalizar
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_mark_order_as_sent(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_transport_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden marcar pedidos como terminados';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = p_order_id
      AND status = 'closed'
  ) THEN
    RAISE EXCEPTION 'El pedido no existe o no está cerrado';
  END IF;

  SELECT COALESCE(o.transport_id, c.transport_id)
  INTO v_transport_id
  FROM public.orders o
  LEFT JOIN public.customers c ON c.id = o.customer_id
  WHERE o.id = p_order_id;

  UPDATE public.orders
  SET status = 'sent',
      sent_at = now(),
      original_sent_at = COALESCE(original_sent_at, now()),
      sent_transport_id = COALESCE(sent_transport_id, v_transport_id),
      last_label_transport_id = COALESCE(v_transport_id, last_label_transport_id),
      transport_id = COALESCE(transport_id, v_transport_id),
      updated_at = now()
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo marcar el pedido como terminado.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) rpc_reschedule_sent_order: preservar original_sent_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_reschedule_sent_order(
  p_order_id uuid,
  p_new_sent_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden reprogramar pedidos enviados';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = p_order_id
      AND status = 'sent'
  ) THEN
    RAISE EXCEPTION 'El pedido no existe o no está en estado enviado';
  END IF;

  UPDATE public.orders
  SET original_sent_at = COALESCE(original_sent_at, sent_at),
      sent_at = p_new_sent_at,
      updated_at = now()
  WHERE id = p_order_id
    AND status = 'sent';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No se pudo actualizar la fecha de envío';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) rpc_record_sent_order_label_reprint: marca reimpresión + transporte usado
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_record_sent_order_label_reprint(
  p_order_id uuid,
  p_transport_id uuid DEFAULT NULL,
  p_update_order_transport boolean DEFAULT true
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
  v_transport_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admins
    WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Solo administradores pueden registrar reimpresiones de rótulos';
  END IF;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id
    AND status IN ('sent', 'devolución');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'El pedido no existe o no está en estado enviado/devolución';
  END IF;

  v_transport_id := p_transport_id;
  IF v_transport_id IS NULL THEN
    SELECT COALESCE(v_order.transport_id, c.transport_id)
    INTO v_transport_id
    FROM public.customers c
    WHERE c.id = v_order.customer_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.transports WHERE id = v_transport_id
  ) THEN
    RAISE EXCEPTION 'Transporte no encontrado';
  END IF;

  UPDATE public.orders
  SET labels_reprinted = true,
      last_reprinted_at = now(),
      last_label_transport_id = COALESCE(v_transport_id, last_label_transport_id),
      sent_transport_id = COALESCE(sent_transport_id, transport_id, v_transport_id),
      original_sent_at = COALESCE(original_sent_at, sent_at),
      transport_id = CASE
        WHEN p_update_order_transport AND v_transport_id IS NOT NULL THEN v_transport_id
        ELSE transport_id
      END,
      updated_at = now()
  WHERE id = p_order_id;

  SELECT *
  INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  RETURN json_build_object(
    'id', v_order.id,
    'labels_reprinted', v_order.labels_reprinted,
    'last_reprinted_at', v_order.last_reprinted_at,
    'sent_transport_id', v_order.sent_transport_id,
    'last_label_transport_id', v_order.last_label_transport_id,
    'original_sent_at', v_order.original_sent_at,
    'sent_at', v_order.sent_at,
    'transport_id', v_order.transport_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_mark_order_as_sent(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_reschedule_sent_order(uuid, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_sent_order_label_reprint(uuid, uuid, boolean) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
