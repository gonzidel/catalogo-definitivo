-- 231_stock_immobile_variants.sql
-- Alerta operativa en admin/stock.html: variantes activas con stock >= 1
-- sin movimiento (modificaciones, ventas, traslados) en >= 14 días.
-- Complementa vw_stock_dead_products (184, 90d, nivel producto) sin modificarla.

-- ---------------------------------------------------------------------------
-- 1) Tabla de postergación por variante (snooze estacional)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stock_immobile_snooze (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id   uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  season       text NOT NULL CHECK (season IN ('verano', 'invierno')),
  snooze_until date NOT NULL,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_immobile_snooze_variant
  ON public.stock_immobile_snooze(variant_id);

CREATE INDEX IF NOT EXISTS idx_stock_immobile_snooze_active
  ON public.stock_immobile_snooze(variant_id, snooze_until)
  WHERE snooze_until >= CURRENT_DATE;

COMMENT ON TABLE public.stock_immobile_snooze IS
  'Postergación del aviso de stock inmovilizado por variante/color. '
  'No afecta catálogo ni index; solo oculta la variante en vw_stock_immobile_variants hasta snooze_until.';

ALTER TABLE public.stock_immobile_snooze ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_immobile_snooze'
      AND policyname = 'admin_select_stock_immobile_snooze'
  ) THEN
    CREATE POLICY admin_select_stock_immobile_snooze ON public.stock_immobile_snooze
      FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_immobile_snooze'
      AND policyname = 'admin_insert_stock_immobile_snooze'
  ) THEN
    CREATE POLICY admin_insert_stock_immobile_snooze ON public.stock_immobile_snooze
      FOR INSERT TO authenticated
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'stock_immobile_snooze'
      AND policyname = 'admin_delete_stock_immobile_snooze'
  ) THEN
    CREATE POLICY admin_delete_stock_immobile_snooze ON public.stock_immobile_snooze
      FOR DELETE TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Vista: variantes inmovilizadas >= 14 días
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_stock_immobile_variants AS
WITH
  variant_stock AS (
    SELECT
      pv.id AS variant_id,
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.variant_sizes vs WHERE vs.variant_id = pv.id
        ) THEN (
          SELECT COALESCE(SUM(vsws.stock_qty), 0)::int
          FROM public.variant_size_warehouse_stock vsws
          WHERE vsws.variant_id = pv.id
        )
        ELSE (
          SELECT COALESCE(SUM(vws.stock_qty), 0)::int
          FROM public.variant_warehouse_stock vws
          WHERE vws.variant_id = pv.id
        )
      END AS stock_total
    FROM public.product_variants pv
    WHERE pv.active = true
  ),

  last_history AS (
    SELECT variant_id, MAX(created_at) AS last_at
    FROM public.stock_history
    WHERE variant_id IS NOT NULL
    GROUP BY variant_id
  ),

  last_movement AS (
    SELECT variant_id, MAX(created_at) AS last_at
    FROM public.stock_movements
    WHERE variant_id IS NOT NULL
    GROUP BY variant_id
  ),

  last_b2b AS (
    SELECT
      oi.variant_id,
      MAX(o.created_at) AS last_at
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE oi.variant_id IS NOT NULL
    GROUP BY oi.variant_id
  ),

  last_public AS (
    SELECT
      psi.variant_id,
      MAX(psi.created_at) AS last_at
    FROM public.public_sale_items psi
    WHERE psi.is_return = false
      AND psi.variant_id IS NOT NULL
    GROUP BY psi.variant_id
  ),

  activity AS (
    SELECT
      pv.id AS variant_id,
      pv.product_id,
      pv.color,
      pv.created_at AS variant_created_at,
      GREATEST(
        lh.last_at,
        lm.last_at,
        lb.last_at,
        lp.last_at,
        pv.created_at
      ) AS ultima_actividad,
      CASE
        WHEN lh.last_at IS NOT NULL
         AND lh.last_at >= COALESCE(lm.last_at, '-infinity'::timestamptz)
         AND lh.last_at >= COALESCE(lb.last_at, '-infinity'::timestamptz)
         AND lh.last_at >= COALESCE(lp.last_at, '-infinity'::timestamptz)
         AND lh.last_at >= pv.created_at
          THEN 'stock_history'
        WHEN lm.last_at IS NOT NULL
         AND lm.last_at >= COALESCE(lb.last_at, '-infinity'::timestamptz)
         AND lm.last_at >= COALESCE(lp.last_at, '-infinity'::timestamptz)
         AND lm.last_at >= pv.created_at
          THEN 'stock_movement'
        WHEN lb.last_at IS NOT NULL
         AND lb.last_at >= COALESCE(lp.last_at, '-infinity'::timestamptz)
         AND lb.last_at >= pv.created_at
          THEN 'order'
        WHEN lp.last_at IS NOT NULL
         AND lp.last_at >= pv.created_at
          THEN 'public_sale'
        ELSE 'created_at'
      END AS fuente_actividad
    FROM public.product_variants pv
    LEFT JOIN last_history  lh ON lh.variant_id = pv.id
    LEFT JOIN last_movement lm ON lm.variant_id = pv.id
    LEFT JOIN last_b2b      lb ON lb.variant_id = pv.id
    LEFT JOIN last_public   lp ON lp.variant_id = pv.id
    WHERE pv.active = true
  )

SELECT
  a.variant_id,
  a.product_id,
  p.name AS product_name,
  a.color,
  p.category,
  vs.stock_total,
  a.ultima_actividad,
  FLOOR(
    EXTRACT(EPOCH FROM (NOW() - a.ultima_actividad)) / 86400
  )::int AS dias_sin_movimiento,
  a.fuente_actividad
FROM activity a
JOIN public.products p ON p.id = a.product_id
JOIN variant_stock vs ON vs.variant_id = a.variant_id
WHERE
  p.status != 'archived'
  AND vs.stock_total >= 1
  AND FLOOR(
    EXTRACT(EPOCH FROM (NOW() - a.ultima_actividad)) / 86400
  ) >= 14
  AND NOT EXISTS (
    SELECT 1
    FROM public.stock_immobile_snooze s
    WHERE s.variant_id = a.variant_id
      AND s.snooze_until >= CURRENT_DATE
  );

ALTER VIEW public.vw_stock_immobile_variants SET (security_invoker = true);

GRANT SELECT ON public.vw_stock_immobile_variants TO authenticated;

COMMENT ON VIEW public.vw_stock_immobile_variants IS
  'Operativo stock admin: variantes activas con stock >= 1 y sin actividad >= 14 días. '
  'Fuentes: stock_history, stock_movements, orders, public_sale_items. '
  'Excluye variantes con snooze activo en stock_immobile_snooze.';

-- ---------------------------------------------------------------------------
-- 3) RPC: postergar aviso por variante (invierno / verano)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_stock_immobile_snooze(
  p_variant_id uuid,
  p_season     text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_product_id   uuid;
  v_local_date   date;
  v_month        int;
  v_year         int;
  v_snooze_until date;
  v_user_id      uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Solo administradores pueden postergar alertas de stock inmovilizado';
  END IF;

  IF p_variant_id IS NULL THEN
    RAISE EXCEPTION 'p_variant_id no puede ser null';
  END IF;

  IF p_season NOT IN ('verano', 'invierno') THEN
    RAISE EXCEPTION 'p_season debe ser verano o invierno';
  END IF;

  SELECT pv.product_id INTO v_product_id
  FROM public.product_variants pv
  WHERE pv.id = p_variant_id;

  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'Variante no encontrada: %', p_variant_id;
  END IF;

  v_local_date := (NOW() AT TIME ZONE 'America/Argentina/Cordoba')::date;
  v_month      := EXTRACT(MONTH FROM v_local_date)::int;
  v_year       := EXTRACT(YEAR FROM v_local_date)::int;

  IF p_season = 'verano' THEN
    IF v_month < 9 THEN
      v_snooze_until := make_date(v_year, 9, 1);
    ELSE
      v_snooze_until := make_date(v_year + 1, 9, 1);
    END IF;
  ELSE
    IF v_month < 3 THEN
      v_snooze_until := make_date(v_year, 3, 1);
    ELSE
      v_snooze_until := make_date(v_year + 1, 3, 1);
    END IF;
  END IF;

  v_user_id := auth.uid();

  DELETE FROM public.stock_immobile_snooze
  WHERE variant_id = p_variant_id
    AND snooze_until >= CURRENT_DATE;

  INSERT INTO public.stock_immobile_snooze (
    variant_id, product_id, season, snooze_until, created_by
  ) VALUES (
    p_variant_id, v_product_id, p_season, v_snooze_until, v_user_id
  );

  RETURN jsonb_build_object(
    'ok', true,
    'variant_id', p_variant_id,
    'product_id', v_product_id,
    'season', p_season,
    'snooze_until', v_snooze_until
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_stock_immobile_snooze(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_stock_immobile_snooze(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.rpc_stock_immobile_snooze IS
  'Posterga el aviso de stock inmovilizado para una variante hasta el inicio de temporada '
  '(1 mar invierno / 1 sept verano, TZ America/Argentina/Cordoba).';

SELECT pg_notify('pgrst', 'reload schema');
