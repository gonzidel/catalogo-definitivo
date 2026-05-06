-- 192_publication_events_and_performance.sql
-- FASE 2 IA Operativa: historial real e inmutable de publicaciones.
-- Mantiene compatibilidad con FASE 1: NO elimina ni reemplaza last_published_at.

-- 1) Tabla de eventos
CREATE TABLE IF NOT EXISTS public.publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  channel text NOT NULL DEFAULT 'admin_publications',
  price_at_publish numeric(15, 2),
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_publication_events_product_published
  ON public.publication_events(product_id, published_at DESC);

CREATE INDEX IF NOT EXISTS ix_publication_events_variant_published
  ON public.publication_events(variant_id, published_at DESC)
  WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_publication_events_channel_published
  ON public.publication_events(channel, published_at DESC);

CREATE INDEX IF NOT EXISTS ix_publication_events_created_by
  ON public.publication_events(created_by)
  WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.publication_events IS
  'Historial inmutable de publicaciones. Fuente oficial de FASE 2+ para frecuencia, canal y rendimiento por evento.';

COMMENT ON COLUMN public.publication_events.created_by IS
  'Usuario autenticado que registró el evento (auth.uid() al insertar).';

ALTER TABLE public.publication_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'publication_events'
      AND policyname = 'publication_events_admin_select'
  ) THEN
    CREATE POLICY publication_events_admin_select
      ON public.publication_events
      FOR SELECT
      TO authenticated
      USING (public.is_admin());
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'publication_events'
      AND policyname = 'publication_events_admin_insert'
  ) THEN
    CREATE POLICY publication_events_admin_insert
      ON public.publication_events
      FOR INSERT
      TO authenticated
      WITH CHECK (public.is_admin());
  END IF;
END $$;

GRANT SELECT, INSERT ON public.publication_events TO authenticated;

-- 2) Vista de rendimiento por evento de publicación (event-centric)
--    Ventanas de venta: 24h / 72h / 7d desde published_at.
CREATE OR REPLACE VIEW public.vw_publication_events_performance AS
WITH sales_b2b AS (
  SELECT
    pe.id AS publication_event_id,
    COALESCE(SUM(oi.quantity) FILTER (
      WHERE o.created_at >= pe.published_at
        AND o.created_at < pe.published_at + INTERVAL '24 hours'
    ), 0)::numeric AS sales_24h,
    COALESCE(SUM(oi.quantity) FILTER (
      WHERE o.created_at >= pe.published_at
        AND o.created_at < pe.published_at + INTERVAL '72 hours'
    ), 0)::numeric AS sales_72h,
    COALESCE(SUM(oi.quantity) FILTER (
      WHERE o.created_at >= pe.published_at
        AND o.created_at < pe.published_at + INTERVAL '7 days'
    ), 0)::numeric AS sales_7d
  FROM public.publication_events pe
  LEFT JOIN public.order_items oi
    ON oi.variant_id = pe.variant_id
   AND oi.status != 'cancelled'
  LEFT JOIN public.orders o
    ON o.id = oi.order_id
  GROUP BY pe.id
),
sales_public AS (
  SELECT
    pe.id AS publication_event_id,
    COALESCE(SUM(psi.qty) FILTER (
      WHERE psi.created_at >= pe.published_at
        AND psi.created_at < pe.published_at + INTERVAL '24 hours'
    ), 0)::numeric AS sales_24h,
    COALESCE(SUM(psi.qty) FILTER (
      WHERE psi.created_at >= pe.published_at
        AND psi.created_at < pe.published_at + INTERVAL '72 hours'
    ), 0)::numeric AS sales_72h,
    COALESCE(SUM(psi.qty) FILTER (
      WHERE psi.created_at >= pe.published_at
        AND psi.created_at < pe.published_at + INTERVAL '7 days'
    ), 0)::numeric AS sales_7d
  FROM public.publication_events pe
  LEFT JOIN public.public_sale_items psi
    ON psi.variant_id = pe.variant_id
   AND psi.is_return = false
  GROUP BY pe.id
)
SELECT
  pe.id,
  pe.product_id,
  p.name AS product_name,
  p.category,
  pe.variant_id,
  pv.color AS variant_color,
  pe.channel,
  pe.price_at_publish,
  pe.published_at,
  pe.created_by,
  pe.created_at,
  to_char(pe.published_at AT TIME ZONE 'America/Argentina/Buenos_Aires', 'TMDay') AS weekday_name,
  EXTRACT(ISODOW FROM pe.published_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::int AS weekday_iso,
  CASE
    WHEN EXTRACT(DAY FROM pe.published_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= 10 THEN 'inicio'
    WHEN EXTRACT(DAY FROM pe.published_at AT TIME ZONE 'America/Argentina/Buenos_Aires') <= 20 THEN 'medio'
    ELSE 'fin'
  END AS month_stage,
  ROW_NUMBER() OVER (PARTITION BY pe.product_id ORDER BY pe.published_at DESC) AS product_event_rank,
  COUNT(*) OVER (PARTITION BY pe.product_id) AS product_publication_count,
  COALESCE(sb.sales_24h, 0) + COALESCE(sp.sales_24h, 0) AS sales_24h,
  COALESCE(sb.sales_72h, 0) + COALESCE(sp.sales_72h, 0) AS sales_72h,
  COALESCE(sb.sales_7d, 0) + COALESCE(sp.sales_7d, 0) AS sales_7d
FROM public.publication_events pe
JOIN public.products p ON p.id = pe.product_id
LEFT JOIN public.product_variants pv ON pv.id = pe.variant_id
LEFT JOIN sales_b2b sb ON sb.publication_event_id = pe.id
LEFT JOIN sales_public sp ON sp.publication_event_id = pe.id;

GRANT SELECT ON public.vw_publication_events_performance TO authenticated;

COMMENT ON VIEW public.vw_publication_events_performance IS
  'Rendimiento por evento de publicación (24h/72h/7d) con canal, día de semana y etapa del mes. FASE 2.';
