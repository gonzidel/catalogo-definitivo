-- 119_order_item_operational_and_empty_order_maint.sql
-- Whitelist cerrada order_items.status (FYL), borrado coherente de pedidos sin ítems operacionales,
-- auditoría, índice único parcial (un solo pedido abierto por cliente) y trigger en order_items.
-- Debe aplicarse antes de 125/127/140 (dependencias).

-- ---------------------------------------------------------------------------
-- Clasificación operacional (listas cerradas; mismo texto en COMMENT abajo)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_item_status_is_operacional(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT CASE lower(trim(coalesce(p_status, '')))
    WHEN 'cancelled' THEN false
    WHEN 'expired' THEN false
    WHEN 'reserved' THEN true
    WHEN 'waiting' THEN true
    WHEN 'picked' THEN true
    WHEN 'missing' THEN true
    ELSE true
  END;
$$;

COMMENT ON FUNCTION public.order_item_status_is_operacional(text) IS
  'Ítem operacional: true si lower(trim(coalesce(p_status, espacio vacío))) es exactamente uno de: reserved, waiting, picked, missing. '
  'false si es exactamente cancelled o expired. '
  'Fuera de esos seis literales (NULL, cadena vacía, typo): true. '
  'missing mantiene vivo el pedido (operacional hasta eliminar la línea).';

CREATE OR REPLACE FUNCTION public.order_eligible_for_empty_deletion(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    WHERE oi.order_id = p_order_id
      AND public.order_item_status_is_operacional(oi.status)
  );
$$;

COMMENT ON FUNCTION public.order_eligible_for_empty_deletion(uuid) IS
  'true si no existe ninguna fila order_items para ese order_id con order_item_status_is_operacional(oi.status)=true; si no hay filas en order_items, true.';

-- ---------------------------------------------------------------------------
-- Auditoría de borrados automáticos / RPC interna
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_empty_deletion_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  customer_id uuid,
  deleted_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  order_number text
);

ALTER TABLE public.order_empty_deletion_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_empty_deletion_audit_admin_read ON public.order_empty_deletion_audit;
CREATE POLICY order_empty_deletion_audit_admin_read ON public.order_empty_deletion_audit
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));

COMMENT ON TABLE public.order_empty_deletion_audit IS
  'Registro de pedidos eliminados por vacío operacional (trigger, RPC, migración). Sin FK a orders (fila ya borrada).';

CREATE OR REPLACE FUNCTION public.maint_try_delete_order_if_eligible(p_order_id uuid, p_source text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_order_number text;
BEGIN
  IF p_order_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.id = p_order_id) THEN
    RETURN false;
  END IF;

  IF NOT public.order_eligible_for_empty_deletion(p_order_id) THEN
    RETURN false;
  END IF;

  SELECT o.customer_id, o.order_number INTO v_customer_id, v_order_number
  FROM public.orders o
  WHERE o.id = p_order_id;

  IF v_customer_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO public.order_empty_deletion_audit (order_id, customer_id, source, order_number)
  VALUES (p_order_id, v_customer_id, coalesce(nullif(trim(p_source), ''), 'unknown'), v_order_number);

  DELETE FROM public.orders WHERE id = p_order_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.maint_try_delete_order_if_eligible(uuid, text) IS
  'SECURITY DEFINER: si order_eligible_for_empty_deletion, INSERT en order_empty_deletion_audit y DELETE del pedido en la misma transacción.';

REVOKE ALL ON FUNCTION public.maint_try_delete_order_if_eligible(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Trigger: no invoca rpc_delete_empty_order (pública)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_order_items_after_delete_try_empty_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  PERFORM public.maint_try_delete_order_if_eligible(OLD.order_id, 'trigger_order_items_after_delete');
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS order_items_after_delete_empty_order ON public.order_items;
CREATE TRIGGER order_items_after_delete_empty_order
  AFTER DELETE ON public.order_items
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_order_items_after_delete_try_empty_order();

-- ---------------------------------------------------------------------------
-- Migración conservadora: vaciar elegibles; fallar si siguen duplicados abiertos
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT o.id
    FROM public.orders o
    WHERE public.order_eligible_for_empty_deletion(o.id)
  LOOP
    PERFORM public.maint_try_delete_order_if_eligible(r.id, 'migration_119_cleanup');
  END LOOP;
END $$;

DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*)::int INTO v_bad
  FROM (
    SELECT customer_id
    FROM public.orders
    WHERE status IN ('active', 'closing_soon')
    GROUP BY customer_id
    HAVING count(*) > 1
  ) t;

  IF coalesce(v_bad, 0) > 0 THEN
    RAISE EXCEPTION
      '119_order_item_operational: hay % cliente(s) con más de un pedido en active/closing_soon. Resolver manualmente antes de crear el índice único.',
      v_bad;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_per_customer_idx
  ON public.orders (customer_id)
  WHERE (status IN ('active', 'closing_soon'));

COMMENT ON INDEX public.orders_one_open_per_customer_idx IS
  'Un solo pedido abierto (active o closing_soon) por customer_id.';

SELECT pg_notify('pgrst', 'reload schema');
