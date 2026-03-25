-- 71_AUTO_UPDATE_PRODUCT_STATUS.sql
-- Función y triggers para actualizar automáticamente el estado del producto
-- basado en stock, imágenes y tags de sus variantes
-- Orden de prioridad: pending_stock > draft > missing_tags > active

-- Función para calcular y actualizar el estado del producto
CREATE OR REPLACE FUNCTION update_product_status()
RETURNS TRIGGER AS $$
DECLARE
  product_id_val uuid;
  variant_id_val uuid;
  has_stock boolean := false;
  has_images boolean := false;
  has_tags boolean := false;
  new_status text;
  variants_with_stock uuid[];
  variants_with_images uuid[];
BEGIN
  -- Determinar product_id según la tabla que disparó el trigger
  IF TG_TABLE_NAME = 'variant_sizes' THEN
    -- Obtener product_id desde variant_id
    SELECT pv.product_id INTO product_id_val
    FROM product_variants pv
    WHERE pv.id = COALESCE(NEW.variant_id, OLD.variant_id);
    
    variant_id_val := COALESCE(NEW.variant_id, OLD.variant_id);
  ELSIF TG_TABLE_NAME = 'variant_images' THEN
    -- Obtener product_id desde variant_id
    SELECT pv.product_id INTO product_id_val
    FROM product_variants pv
    WHERE pv.id = COALESCE(NEW.variant_id, OLD.variant_id);
    
    variant_id_val := COALESCE(NEW.variant_id, OLD.variant_id);
  ELSIF TG_TABLE_NAME = 'product_variants' THEN
    product_id_val := COALESCE(NEW.product_id, OLD.product_id);
    variant_id_val := COALESCE(NEW.id, OLD.id);
  ELSIF TG_TABLE_NAME = 'product_tags' THEN
    product_id_val := COALESCE(NEW.product_id, OLD.product_id);
  ELSE
    -- No debería llegar aquí, pero por seguridad
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Si no hay product_id, no hacer nada
  IF product_id_val IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Obtener todas las variantes activas del producto
  -- Verificar stock: sumar stock de todos los talles de cada variante
  WITH variant_stock AS (
    SELECT 
      pv.id as variant_id,
      COALESCE(SUM(vs.stock_qty), 0) as total_stock
    FROM product_variants pv
    LEFT JOIN variant_sizes vs ON vs.variant_id = pv.id
    WHERE pv.product_id = product_id_val
      AND pv.active = true
    GROUP BY pv.id
  )
  SELECT 
    ARRAY_AGG(variant_id) FILTER (WHERE total_stock > 0)
  INTO variants_with_stock
  FROM variant_stock;

  -- Verificar si alguna variante tiene stock
  has_stock := (variants_with_stock IS NOT NULL AND array_length(variants_with_stock, 1) > 0);

  -- Si no hay stock, estado es pending_stock
  IF NOT has_stock THEN
    new_status := 'pending_stock';
  ELSE
    -- Verificar imágenes: verificar si alguna variante con stock tiene imágenes
    SELECT 
      ARRAY_AGG(DISTINCT vi.variant_id)
    INTO variants_with_images
    FROM variant_images vi
    WHERE vi.variant_id = ANY(variants_with_stock);

    -- Verificar si alguna variante con stock tiene imágenes
    has_images := (variants_with_images IS NOT NULL AND array_length(variants_with_images, 1) > 0);

    -- Si tiene stock pero no imágenes, estado es draft (PRIORIDAD 2)
    IF NOT has_images THEN
      new_status := 'draft';
    ELSE
      -- Verificar tags: Tags1 y Tags2 son requeridos
      SELECT 
        CASE 
          WHEN tag1_id IS NOT NULL AND tag2_id IS NOT NULL THEN true
          ELSE false
        END
      INTO has_tags
      FROM product_tags
      WHERE product_id = product_id_val;

      -- Si no se encontró registro de tags, asumir que faltan
      has_tags := COALESCE(has_tags, false);

      -- Si tiene stock e imágenes pero falta Tags1 o Tags2, estado es missing_tags (PRIORIDAD 3)
      IF NOT has_tags THEN
        new_status := 'missing_tags';
      ELSE
        -- Si tiene stock, imágenes y tags completos, estado es active
        new_status := 'active';
      END IF;
    END IF;
  END IF;

  -- Actualizar estado del producto
  UPDATE products
  SET status = new_status,
      updated_at = now()
  WHERE id = product_id_val;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger para variant_sizes (cuando se inserta/actualiza/elimina stock)
DROP TRIGGER IF EXISTS trigger_update_status_on_variant_sizes ON variant_sizes;
CREATE TRIGGER trigger_update_status_on_variant_sizes
  AFTER INSERT OR UPDATE OR DELETE ON variant_sizes
  FOR EACH ROW
  EXECUTE FUNCTION update_product_status();

-- Trigger para variant_images (cuando se inserta/elimina imágenes)
DROP TRIGGER IF EXISTS trigger_update_status_on_variant_images ON variant_images;
CREATE TRIGGER trigger_update_status_on_variant_images
  AFTER INSERT OR DELETE ON variant_images
  FOR EACH ROW
  EXECUTE FUNCTION update_product_status();

-- Trigger para product_variants (cuando se crea/actualiza/elimina una variante)
DROP TRIGGER IF EXISTS trigger_update_status_on_product_variants ON product_variants;
CREATE TRIGGER trigger_update_status_on_product_variants
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW
  EXECUTE FUNCTION update_product_status();

-- Trigger para product_tags (cuando se crea/actualiza/elimina tags)
DROP TRIGGER IF EXISTS trigger_update_status_on_product_tags ON product_tags;
CREATE TRIGGER trigger_update_status_on_product_tags
  AFTER INSERT OR UPDATE OR DELETE ON product_tags
  FOR EACH ROW
  EXECUTE FUNCTION update_product_status();

-- Notificar recarga de esquema
SELECT pg_notify('pgrst','reload schema');

