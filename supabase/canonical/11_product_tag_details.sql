-- 11_product_tag_details.sql — Tabla para details ilimitados de Tags3

-- Crear tabla product_tag_details para details ilimitados
CREATE TABLE IF NOT EXISTS public.product_tag_details (
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  tag3_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (product_id, tag3_id)
);

-- Índices para performance
-- PK ya cubre (product_id, tag3_id), agregar índices adicionales
CREATE INDEX IF NOT EXISTS idx_product_tag_details_tag3_id 
  ON public.product_tag_details(tag3_id);

-- Índice para acelerar compute_similarity (WHERE product_id = ?)
CREATE INDEX IF NOT EXISTS idx_product_tag_details_product_id 
  ON public.product_tag_details(product_id);

-- Trigger: Validar que tag3_id sea level=3 (antes de INSERT/UPDATE)
CREATE OR REPLACE FUNCTION validate_tag3_level()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tags 
    WHERE id = NEW.tag3_id AND level = 3
  ) THEN
    RAISE EXCEPTION 'tag3_id debe referenciar un tag con level=3';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_validate_tag3_level ON public.product_tag_details;
CREATE TRIGGER trigger_validate_tag3_level
  BEFORE INSERT OR UPDATE OF tag3_id ON public.product_tag_details
  FOR EACH ROW
  EXECUTE FUNCTION validate_tag3_level();

-- RLS
ALTER TABLE public.product_tag_details ENABLE ROW LEVEL SECURITY;

-- Política de lectura (pública - catálogo es público)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='product_tag_details' 
    AND policyname='anon_select_product_tag_details'
  ) THEN
    CREATE POLICY anon_select_product_tag_details 
      ON public.product_tag_details FOR SELECT TO anon USING (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='product_tag_details' 
    AND policyname='authenticated_select_product_tag_details'
  ) THEN
    CREATE POLICY authenticated_select_product_tag_details 
      ON public.product_tag_details FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Política de escritura (solo admins - usando public.admins)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname='public' AND tablename='product_tag_details' 
    AND policyname='admin_write_product_tag_details'
  ) THEN
    CREATE POLICY admin_write_product_tag_details 
      ON public.product_tag_details FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()))
      WITH CHECK (EXISTS (SELECT 1 FROM public.admins a WHERE a.user_id = auth.uid()));
  END IF;
END $$;

-- Migración: Poblar product_tag_details con los tag3_ids existentes (highlights)
INSERT INTO public.product_tag_details (product_id, tag3_id)
SELECT 
  pt.product_id,
  unnest(pt.tag3_ids) as tag3_id
FROM public.product_tags pt
WHERE pt.tag3_ids IS NOT NULL 
  AND array_length(pt.tag3_ids, 1) > 0
ON CONFLICT (product_id, tag3_id) DO NOTHING;

-- Trigger: Sincronizar automáticamente tag3_ids a product_tag_details
-- Solo INSERT (highlights ⊂ details), nunca DELETE
-- La eliminación de details debe hacerse desde admin/flujo específico
CREATE OR REPLACE FUNCTION sync_tag3_ids_to_details()
RETURNS TRIGGER AS $$
BEGIN
  -- Insertar todos los tag3_ids del array en product_tag_details
  INSERT INTO public.product_tag_details (product_id, tag3_id)
  SELECT NEW.product_id, unnest(NEW.tag3_ids)
  WHERE NEW.tag3_ids IS NOT NULL 
    AND array_length(NEW.tag3_ids, 1) > 0
  ON CONFLICT (product_id, tag3_id) DO NOTHING;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_tag3_ids_to_details ON public.product_tags;
CREATE TRIGGER trigger_sync_tag3_ids_to_details
  AFTER INSERT OR UPDATE OF tag3_ids ON public.product_tags
  FOR EACH ROW
  EXECUTE FUNCTION sync_tag3_ids_to_details();

-- Función helper opcional: Sincronizar highlights a details manualmente
CREATE OR REPLACE FUNCTION sync_highlights_to_details(product_id_param uuid)
RETURNS void AS $$
BEGIN
  INSERT INTO public.product_tag_details (product_id, tag3_id)
  SELECT product_id_param, unnest(tag3_ids)
  FROM public.product_tags
  WHERE product_id = product_id_param
    AND tag3_ids IS NOT NULL
    AND array_length(tag3_ids, 1) > 0
  ON CONFLICT (product_id, tag3_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

select pg_notify('pgrst','reload schema');

