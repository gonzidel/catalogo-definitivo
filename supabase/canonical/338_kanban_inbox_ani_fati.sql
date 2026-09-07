-- 338_kanban_inbox_ani_fati.sql
-- Inbox Ani / Fati en /nj/admin/orders (Pedidos).
-- Dueña por clienta (customers.kanban_inbox_owner), asignación uno-y-uno
-- al primer pedido de alcance Pedidos, RPC para reasignar desde la tarjeta.
-- No toca rpc_checkout_cart ni Retiro.

-- ---------------------------------------------------------------------------
-- 1) Columnas en customers
-- ---------------------------------------------------------------------------
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS kanban_inbox_owner text NULL,
  ADD COLUMN IF NOT EXISTS kanban_inbox_assigned_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customers_kanban_inbox_owner_chk'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_kanban_inbox_owner_chk
      CHECK (
        kanban_inbox_owner IS NULL
        OR kanban_inbox_owner IN ('ani', 'fati')
      );
  END IF;
END $$;

COMMENT ON COLUMN public.customers.kanban_inbox_owner IS
  'Dueña WhatsApp/inbox en Pedidos: ani | fati. NULL = sin asignar. canonical:338.';
COMMENT ON COLUMN public.customers.kanban_inbox_assigned_at IS
  'Cuándo se asignó kanban_inbox_owner. canonical:338.';

CREATE INDEX IF NOT EXISTS idx_customers_kanban_inbox_owner
  ON public.customers (kanban_inbox_owner)
  WHERE kanban_inbox_owner IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Round-robin de 1 fila
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kanban_inbox_rr (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_owner text NOT NULL DEFAULT 'ani'
    CHECK (next_owner IN ('ani', 'fati')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.kanban_inbox_rr (id, next_owner)
VALUES (1, 'ani')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.kanban_inbox_rr IS
  'Siguiente dueña Ani/Fati para clientas nuevas en Pedidos. canonical:338.';

ALTER TABLE public.kanban_inbox_rr ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'kanban_inbox_rr'
      AND policyname = 'kanban_inbox_rr_admin_all'
  ) THEN
    CREATE POLICY kanban_inbox_rr_admin_all
      ON public.kanban_inbox_rr
      FOR ALL TO authenticated
      USING (public.is_admin())
      WITH CHECK (public.is_admin());
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Helpers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_order_is_shipping_kanban_inbox(p_order public.orders)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_notes jsonb;
  v_scope text;
BEGIN
  -- Retiro / pickup local: no asignar inbox Pedidos
  IF coalesce(p_order.local_deferred_pickup, false) THEN
    RETURN false;
  END IF;

  BEGIN
    v_notes := CASE
      WHEN p_order.notes IS NULL OR btrim(p_order.notes) = '' THEN '{}'::jsonb
      WHEN left(btrim(p_order.notes), 1) = '{' THEN p_order.notes::jsonb
      ELSE '{}'::jsonb
    END;
  EXCEPTION WHEN others THEN
    v_notes := '{}'::jsonb;
  END;

  v_scope := lower(nullif(trim(coalesce(v_notes->>'kanban_scope', '')), ''));
  IF v_scope = 'local_pickup' THEN
    RETURN false;
  END IF;
  IF v_scope = 'shipping' THEN
    RETURN true;
  END IF;

  IF coalesce(v_notes->>'mirrored_from_local_order', '') IN ('true', 't', '1') THEN
    RETURN false;
  END IF;

  IF nullif(trim(coalesce(v_notes->>'retiro_origin', '')), '') IS NOT NULL THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.fn_order_is_shipping_kanban_inbox(public.orders) IS
  'True si el pedido pertenece al tablero Pedidos (no Retiro). canonical:338.';

CREATE OR REPLACE FUNCTION public.fn_customers_protect_kanban_inbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.kanban_inbox_owner IS DISTINCT FROM OLD.kanban_inbox_owner
       OR NEW.kanban_inbox_assigned_at IS DISTINCT FROM OLD.kanban_inbox_assigned_at
     )
     AND current_setting('fyl.kanban_inbox_write', true) IS DISTINCT FROM '1'
  THEN
    -- Clienta / updates normales no pueden tocar la dueña.
    -- Admin vía RPC y trigger de assign setean fyl.kanban_inbox_write=1.
    IF NOT public.is_admin() THEN
      NEW.kanban_inbox_owner := OLD.kanban_inbox_owner;
      NEW.kanban_inbox_assigned_at := OLD.kanban_inbox_assigned_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_protect_kanban_inbox ON public.customers;
CREATE TRIGGER trg_customers_protect_kanban_inbox
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_customers_protect_kanban_inbox();

-- ---------------------------------------------------------------------------
-- 4) Trigger: primer pedido Pedidos → asignar dueña + rotar RR
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_orders_assign_kanban_inbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_owner text;
  v_next text;
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT public.fn_order_is_shipping_kanban_inbox(NEW) THEN
    RETURN NEW;
  END IF;

  -- Ya tiene dueña → no tocar
  IF EXISTS (
    SELECT 1
    FROM public.customers c
    WHERE c.id = NEW.customer_id
      AND c.kanban_inbox_owner IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM set_config('fyl.kanban_inbox_write', '1', true);

  SELECT next_owner INTO v_owner
  FROM public.kanban_inbox_rr
  WHERE id = 1
  FOR UPDATE;

  IF v_owner IS NULL OR v_owner NOT IN ('ani', 'fati') THEN
    v_owner := 'ani';
  END IF;

  UPDATE public.customers
  SET
    kanban_inbox_owner = v_owner,
    kanban_inbox_assigned_at = now()
  WHERE id = NEW.customer_id
    AND kanban_inbox_owner IS NULL;

  v_next := CASE WHEN v_owner = 'ani' THEN 'fati' ELSE 'ani' END;

  INSERT INTO public.kanban_inbox_rr (id, next_owner, updated_at)
  VALUES (1, v_next, now())
  ON CONFLICT (id) DO UPDATE
  SET next_owner = EXCLUDED.next_owner,
      updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_assign_kanban_inbox ON public.orders;
CREATE TRIGGER trg_orders_assign_kanban_inbox
  AFTER INSERT ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_orders_assign_kanban_inbox();

COMMENT ON FUNCTION public.fn_orders_assign_kanban_inbox() IS
  'Asigna Ani/Fati uno-y-uno al primer pedido de Pedidos de una clienta. canonical:338.';

-- ---------------------------------------------------------------------------
-- 5) RPC admin: reasignar dueña desde la tarjeta
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_set_kanban_inbox_owner(
  p_customer_id uuid,
  p_owner text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_owner text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo admin puede reasignar inbox Ani/Fati'
      USING ERRCODE = '42501';
  END IF;

  v_owner := lower(nullif(trim(coalesce(p_owner, '')), ''));
  IF v_owner IS NULL OR v_owner NOT IN ('ani', 'fati') THEN
    RAISE EXCEPTION 'p_owner debe ser ani o fati'
      USING ERRCODE = '22023';
  END IF;

  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'p_customer_id requerido'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = p_customer_id) THEN
    RAISE EXCEPTION 'Cliente no encontrado'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM set_config('fyl.kanban_inbox_write', '1', true);

  UPDATE public.customers
  SET
    kanban_inbox_owner = v_owner,
    kanban_inbox_assigned_at = now()
  WHERE id = p_customer_id;

  RETURN jsonb_build_object(
    'ok', true,
    'customer_id', p_customer_id,
    'owner', v_owner
  );
END;
$$;

COMMENT ON FUNCTION public.rpc_set_kanban_inbox_owner(uuid, text) IS
  'Admin: asigna/reasigna clienta a Ani o Fati. canonical:338.';

GRANT EXECUTE ON FUNCTION public.rpc_set_kanban_inbox_owner(uuid, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.rpc_set_kanban_inbox_owner(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_set_kanban_inbox_owner(uuid, text) FROM anon;

-- ---------------------------------------------------------------------------
-- 6) Backfill: clientas con pedido Pedidos, por primer created_at, Ani/Fati
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_owner text := 'ani';
  v_count int := 0;
BEGIN
  PERFORM set_config('fyl.kanban_inbox_write', '1', true);

  FOR r IN
    SELECT c.id AS customer_id, min(o.created_at) AS first_at
    FROM public.customers c
    JOIN public.orders o ON o.customer_id = c.id
    WHERE c.kanban_inbox_owner IS NULL
      AND public.fn_order_is_shipping_kanban_inbox(o)
    GROUP BY c.id
    ORDER BY min(o.created_at) ASC, c.id ASC
  LOOP
    UPDATE public.customers
    SET
      kanban_inbox_owner = v_owner,
      kanban_inbox_assigned_at = coalesce(r.first_at, now())
    WHERE id = r.customer_id
      AND kanban_inbox_owner IS NULL;

    v_count := v_count + 1;
    v_owner := CASE WHEN v_owner = 'ani' THEN 'fati' ELSE 'ani' END;
  END LOOP;

  UPDATE public.kanban_inbox_rr
  SET next_owner = v_owner,
      updated_at = now()
  WHERE id = 1;

  RAISE NOTICE '338 backfill: % clientas asignadas; next_owner=%', v_count, v_owner;
END $$;
