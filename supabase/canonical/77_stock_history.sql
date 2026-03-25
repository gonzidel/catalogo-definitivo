-- 77_stock_history.sql — Tabla y función para historial de stock (idempotente)

-- 1) Crear tabla de historial de stock
CREATE TABLE IF NOT EXISTS public.stock_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid REFERENCES public.products(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.product_variants(id) ON DELETE CASCADE,
  size text,
  warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE SET NULL,
  change_type text NOT NULL, -- 'load', 'move_to_general', 'move_to_venta_publico', 'adjustment', 'initial_load'
  stock_before int DEFAULT 0,
  stock_after int DEFAULT 0,
  quantity_changed int NOT NULL, -- cantidad que cambió (puede ser negativo)
  from_warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE SET NULL, -- para movimientos
  to_warehouse_id uuid REFERENCES public.warehouses(id) ON DELETE SET NULL, -- para movimientos
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- 2) Crear índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_stock_history_product ON public.stock_history(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_history_variant ON public.stock_history(variant_id);
CREATE INDEX IF NOT EXISTS idx_stock_history_created_at ON public.stock_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_history_warehouse ON public.stock_history(warehouse_id);

-- 3) Función para registrar cambios de stock
CREATE OR REPLACE FUNCTION public.log_stock_change(
  p_product_id uuid,
  p_variant_id uuid,
  p_size text,
  p_warehouse_id uuid,
  p_change_type text,
  p_stock_before int,
  p_stock_after int,
  p_from_warehouse_id uuid DEFAULT NULL,
  p_to_warehouse_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_history_id uuid;
  v_user_id uuid;
BEGIN
  -- Obtener usuario actual
  v_user_id := auth.uid();
  
  -- Calcular cantidad cambiada
  INSERT INTO public.stock_history (
    product_id, variant_id, size, warehouse_id, change_type,
    stock_before, stock_after, quantity_changed,
    from_warehouse_id, to_warehouse_id, user_id, notes
  ) VALUES (
    p_product_id, p_variant_id, p_size, p_warehouse_id, p_change_type,
    p_stock_before, p_stock_after, p_stock_after - p_stock_before,
    p_from_warehouse_id, p_to_warehouse_id, v_user_id, p_notes
  )
  RETURNING id INTO v_history_id;
  
  RETURN v_history_id;
END;
$$;

-- 4) Habilitar RLS
ALTER TABLE public.stock_history ENABLE ROW LEVEL SECURITY;

-- 5) Políticas RLS: Solo admins pueden ver y crear historial
DO $$
BEGIN
  -- Política para lectura (solo admins)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename = 'stock_history' 
    AND policyname = 'admin_select_stock_history'
  ) THEN
    CREATE POLICY admin_select_stock_history ON public.stock_history
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.admins 
          WHERE user_id = auth.uid()
        )
      );
  END IF;

  -- Política para inserción (solo admins)
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' 
    AND tablename = 'stock_history' 
    AND policyname = 'admin_insert_stock_history'
  ) THEN
    CREATE POLICY admin_insert_stock_history ON public.stock_history
      FOR INSERT
      TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.admins 
          WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- 6) Recargar el esquema del API REST
SELECT pg_notify('pgrst','reload schema');
