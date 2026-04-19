-- 160_allow_product_deletion.sql
-- Objetivo: permitir borrar/archivar productos y variantes sin romper historial de pedidos/ventas.
-- Estrategia:
-- - Agregar campos snapshot en tablas de historial (sku/color/size/imagen).
-- - Cambiar FKs bloqueantes para que DELETE de variantes/pedidos deje historial intacto (SET NULL).
-- - Asegurar que eliminar un producto elimine sus variantes (CASCADE) y el resto de dependencias por FK.

-- -----------------------------
-- 1) Columns snapshot: order_items / local_order_items
-- -----------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='order_items' AND column_name='variant_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='order_items' AND column_name='sku'
  ) THEN
    ALTER TABLE public.order_items ADD COLUMN sku text;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='local_order_items' AND column_name='variant_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='local_order_items' AND column_name='sku'
  ) THEN
    ALTER TABLE public.local_order_items ADD COLUMN sku text;
  END IF;
END $$;

-- -----------------------------
-- 2) Columns snapshot: public_sale_items
-- -----------------------------
DO $$
BEGIN
  -- product_name ya suele existir (fixes previos), pero lo aseguramos.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_sale_items' AND column_name='product_name'
  ) THEN
    ALTER TABLE public.public_sale_items ADD COLUMN product_name text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_sale_items' AND column_name='color'
  ) THEN
    ALTER TABLE public.public_sale_items ADD COLUMN color text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_sale_items' AND column_name='size'
  ) THEN
    ALTER TABLE public.public_sale_items ADD COLUMN size text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_sale_items' AND column_name='sku'
  ) THEN
    ALTER TABLE public.public_sale_items ADD COLUMN sku text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_sale_items' AND column_name='imagen'
  ) THEN
    ALTER TABLE public.public_sale_items ADD COLUMN imagen text;
  END IF;
END $$;

-- -----------------------------
-- 3) Backfill snapshot en public_sale_items
-- -----------------------------
-- Para permitir SET NULL en variant_id sin romper CHECKs existentes,
-- garantizamos que product_name/color/size/sku queden persistidos.
DO $$
BEGIN
  -- Backfill para items normales (variant_id IS NOT NULL)
  UPDATE public.public_sale_items psi
  SET
    product_name = COALESCE(psi.product_name, p.name),
    color = COALESCE(psi.color, pv.color),
    size = COALESCE(psi.size, pv.size),
    sku = COALESCE(psi.sku, pv.sku),
    imagen = COALESCE(
      psi.imagen,
      (
        SELECT COALESCE(vi.secure_url, vi.url)
        FROM public.variant_images vi
        WHERE vi.variant_id = pv.id
        ORDER BY COALESCE(vi.position, 999999) ASC
        LIMIT 1
      )
    )
  FROM public.product_variants pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE psi.variant_id IS NOT NULL
    AND psi.variant_id = pv.id;

  -- Backfill para extras (variant_id IS NULL)
  UPDATE public.public_sale_items
  SET
    sku = COALESCE(sku, product_name)
  WHERE variant_id IS NULL;
END $$;

-- -----------------------------
-- 4) Backfill snapshot sku en order_items/local_order_items
-- -----------------------------
DO $$
BEGIN
  UPDATE public.order_items oi
  SET sku = pv.sku
  FROM public.product_variants pv
  WHERE oi.variant_id IS NOT NULL
    AND oi.variant_id = pv.id
    AND oi.sku IS NULL;

  UPDATE public.local_order_items loi
  SET sku = pv.sku
  FROM public.product_variants pv
  WHERE loi.variant_id IS NOT NULL
    AND loi.variant_id = pv.id
    AND loi.sku IS NULL;
END $$;

-- -----------------------------
-- 5) FK adjustments: SET NULL en historial de pedidos/ventas
-- -----------------------------

-- Helper pattern: asegurar que variant_id sea nullable (si no lo es)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='order_items' AND column_name='variant_id' AND is_nullable='NO'
  ) THEN
    ALTER TABLE public.order_items ALTER COLUMN variant_id DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='local_order_items' AND column_name='variant_id' AND is_nullable='NO'
  ) THEN
    ALTER TABLE public.local_order_items ALTER COLUMN variant_id DROP NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='public_sale_items' AND column_name='variant_id' AND is_nullable='NO'
  ) THEN
    ALTER TABLE public.public_sale_items ALTER COLUMN variant_id DROP NOT NULL;
  END IF;
END $$;

-- order_items.variant_id -> product_variants(id) ON DELETE SET NULL
DO $$
DECLARE
  fk record;
  v_attnum int;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.order_items'::regclass
    AND attname = 'variant_id'
  LIMIT 1;

  IF v_attnum IS NULL THEN
    RETURN;
  END IF;

  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE contype='f'
      AND conrelid='public.order_items'::regclass
      AND confrelid='public.product_variants'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = v_attnum
  LOOP
    EXECUTE format('ALTER TABLE public.order_items DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  ALTER TABLE public.order_items
    DROP CONSTRAINT IF EXISTS order_items_variant_id_fkey_set_null;

  ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_variant_id_fkey_set_null
    FOREIGN KEY (variant_id)
    REFERENCES public.product_variants(id)
    ON DELETE SET NULL;
END $$;

-- local_order_items.variant_id -> product_variants(id) ON DELETE SET NULL
DO $$
DECLARE
  fk record;
  v_attnum int;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.local_order_items'::regclass
    AND attname = 'variant_id'
  LIMIT 1;

  IF v_attnum IS NULL THEN
    RETURN;
  END IF;

  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE contype='f'
      AND conrelid='public.local_order_items'::regclass
      AND confrelid='public.product_variants'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = v_attnum
  LOOP
    EXECUTE format('ALTER TABLE public.local_order_items DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  ALTER TABLE public.local_order_items
    DROP CONSTRAINT IF EXISTS local_order_items_variant_id_fkey_set_null;

  ALTER TABLE public.local_order_items
    ADD CONSTRAINT local_order_items_variant_id_fkey_set_null
    FOREIGN KEY (variant_id)
    REFERENCES public.product_variants(id)
    ON DELETE SET NULL;
END $$;

-- public_sale_items.variant_id -> product_variants(id) ON DELETE SET NULL
DO $$
DECLARE
  fk record;
  v_attnum int;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.public_sale_items'::regclass
    AND attname = 'variant_id'
  LIMIT 1;

  IF v_attnum IS NULL THEN
    RETURN;
  END IF;

  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE contype='f'
      AND conrelid='public.public_sale_items'::regclass
      AND confrelid='public.product_variants'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = v_attnum
  LOOP
    EXECUTE format('ALTER TABLE public.public_sale_items DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  ALTER TABLE public.public_sale_items
    DROP CONSTRAINT IF EXISTS public_sale_items_variant_id_fkey_set_null;

  ALTER TABLE public.public_sale_items
    ADD CONSTRAINT public_sale_items_variant_id_fkey_set_null
    FOREIGN KEY (variant_id)
    REFERENCES public.product_variants(id)
    ON DELETE SET NULL;
END $$;

-- -----------------------------
-- 6) Ensure product_variants.product_id -> products(id) uses ON DELETE CASCADE
-- -----------------------------
DO $$
DECLARE
  fk record;
  v_attnum int;
BEGIN
  SELECT attnum INTO v_attnum
  FROM pg_attribute
  WHERE attrelid = 'public.product_variants'::regclass
    AND attname = 'product_id'
  LIMIT 1;

  IF v_attnum IS NULL THEN
    RETURN;
  END IF;

  FOR fk IN
    SELECT conname
    FROM pg_constraint
    WHERE contype='f'
      AND conrelid='public.product_variants'::regclass
      AND confrelid='public.products'::regclass
      AND array_length(conkey, 1) = 1
      AND conkey[1] = v_attnum
  LOOP
    EXECUTE format('ALTER TABLE public.product_variants DROP CONSTRAINT %I', fk.conname);
  END LOOP;

  ALTER TABLE public.product_variants
    DROP CONSTRAINT IF EXISTS product_variants_product_id_fkey_cascade;

  ALTER TABLE public.product_variants
    ADD CONSTRAINT product_variants_product_id_fkey_cascade
    FOREIGN KEY (product_id)
    REFERENCES public.products(id)
    ON DELETE CASCADE;
END $$;

-- -----------------------------
-- 7) Triggers: completar snapshots al insertar (futuro historial)
-- -----------------------------

-- order_items: llenar sku desde product_variants
CREATE OR REPLACE FUNCTION public.set_order_items_sku_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL AND (NEW.sku IS NULL OR trim(NEW.sku) = '') THEN
    SELECT pv.sku
    INTO NEW.sku
    FROM public.product_variants pv
    WHERE pv.id = NEW.variant_id
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_items_set_sku_snapshot ON public.order_items;
CREATE TRIGGER order_items_set_sku_snapshot
BEFORE INSERT OR UPDATE ON public.order_items
FOR EACH ROW
EXECUTE FUNCTION public.set_order_items_sku_snapshot();

-- local_order_items: llenar sku desde product_variants
CREATE OR REPLACE FUNCTION public.set_local_order_items_sku_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.variant_id IS NOT NULL AND (NEW.sku IS NULL OR trim(NEW.sku) = '') THEN
    SELECT pv.sku
    INTO NEW.sku
    FROM public.product_variants pv
    WHERE pv.id = NEW.variant_id
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS local_order_items_set_sku_snapshot ON public.local_order_items;
CREATE TRIGGER local_order_items_set_sku_snapshot
BEFORE INSERT OR UPDATE ON public.local_order_items
FOR EACH ROW
EXECUTE FUNCTION public.set_local_order_items_sku_snapshot();

-- public_sale_items: persistir snapshots para que el historial no dependa de pv
CREATE OR REPLACE FUNCTION public.set_public_sale_items_snapshots()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_name text;
  v_color text;
  v_size text;
  v_sku text;
  v_imagen text;
BEGIN
  IF NEW.variant_id IS NOT NULL THEN
    SELECT
      p.name,
      pv.color,
      pv.size,
      pv.sku,
      (
        SELECT COALESCE(vi.secure_url, vi.url)
        FROM public.variant_images vi
        WHERE vi.variant_id = pv.id
        ORDER BY COALESCE(vi.position, 999999) ASC
        LIMIT 1
      )
    INTO v_name, v_color, v_size, v_sku, v_imagen
    FROM public.product_variants pv
    JOIN public.products p ON p.id = pv.product_id
    WHERE pv.id = NEW.variant_id
    LIMIT 1;

    NEW.product_name := COALESCE(NEW.product_name, v_name);
    NEW.color := COALESCE(NEW.color, v_color);
    NEW.size := COALESCE(NEW.size, v_size);
    NEW.sku := COALESCE(NEW.sku, v_sku);
    NEW.imagen := COALESCE(NEW.imagen, v_imagen);
  ELSE
    -- Extras: asegurar que haya product_name/sku para checks y consistencia.
    NEW.product_name := COALESCE(NEW.product_name, 'Extra especial');
    NEW.sku := COALESCE(NEW.sku, NEW.product_name);
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS public_sale_items_set_snapshots ON public.public_sale_items;
CREATE TRIGGER public_sale_items_set_snapshots
BEFORE INSERT OR UPDATE ON public.public_sale_items
FOR EACH ROW
EXECUTE FUNCTION public.set_public_sale_items_snapshots();

-- -----------------------------
-- 8) RPC: rpc_get_public_sale_details usando snapshots
-- -----------------------------
CREATE OR REPLACE FUNCTION public.rpc_get_public_sale_details(p_sale_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result json;
BEGIN
  SELECT json_build_object(
    'sale', json_build_object(
      'id', ps.id,
      'sale_number', ps.sale_number,
      'created_at', ps.created_at,
      'customer_name',
        CASE
          WHEN psc.first_name IS NOT NULL THEN psc.first_name || ' ' || coalesce(psc.last_name, '')
          ELSE NULL
        END,
      'total_amount', ps.total_amount,
      'item_count', ps.item_count,
      'credit_used', ps.credit_used,
      'notes', ps.notes
    ),
    'items', (
      SELECT json_agg(
        json_build_object(
          'id', psi.id,
          'sku', COALESCE(psi.sku, pv.sku, 'EXTRA-ESPECIAL'),
          'product_name', COALESCE(psi.product_name, p.name, 'Extra especial'),
          'color', COALESCE(psi.color, pv.color),
          'size', COALESCE(psi.size, pv.size),
          'imagen', psi.imagen,
          'qty', psi.qty,
          'price', psi.price_snapshot,
          'is_return', psi.is_return
        )
      )
      FROM public.public_sale_items psi
      LEFT JOIN public.product_variants pv ON pv.id = psi.variant_id
      LEFT JOIN public.products p ON p.id = pv.product_id
      WHERE psi.sale_id = p_sale_id
    )
  )
  INTO v_result
  FROM public.public_sales ps
  LEFT JOIN public.public_sales_customers psc ON psc.id = ps.customer_id
  WHERE ps.id = p_sale_id;

  RETURN v_result;
END $$;

-- Recargar esquema para PostgREST
SELECT pg_notify('pgrst', 'reload schema');

