-- ═══════════════════════════════════════════════════════════════════════════
-- BORRADOR FASE 2 — NO EJECUTAR EN PRODUCCIÓN HASTA REVISIÓN Y MIGRACIÓN FORMAL
-- Tabla propuesta: historial inmutable de publicaciones para habilitar frecuencia,
-- republicación y rendimiento por campaña/canal. Después de crearla, publications.js
-- debe INSERT por evento y dejar de sobrescribir como única fuente de verdad
-- (last_published_at puede mantenerse como denormalización/cache).
-- ═══════════════════════════════════════════════════════════════════════════

/*
CREATE TABLE IF NOT EXISTS public.publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  channel text,
  -- Canal libre p.ej. 'instagram', 'facebook', 'sheet', 'multi'
  price_at_publish numeric(15, 2),
  -- Snapshot del precio de variante/producto al publicar (opcional)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_publication_events_product_published
  ON public.publication_events(product_id, published_at DESC);

CREATE INDEX IF NOT EXISTS ix_publication_events_variant_published
  ON public.publication_events(variant_id, published_at DESC)
  WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_publication_events_published_at
  ON public.publication_events(published_at DESC);

COMMENT ON TABLE public.publication_events IS
  'Eventos de publicación inmutables. FASE 3: vistas vw_* deben priorizar esta tabla sobre last_published_at.';

ALTER TABLE public.publication_events ENABLE ROW LEVEL SECURITY;
-- Políticas: admin/authenticated según estándar FYL (definir al implementar).

GRANT SELECT ON public.publication_events TO authenticated;
-- GRANT INSERT ... según política de solo admin para escritura desde publications.js
*/
