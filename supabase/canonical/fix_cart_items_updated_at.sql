-- fix_cart_items_updated_at.sql - Asegurar que cart_items tiene updated_at
-- Ejecutar este script en Supabase SQL Editor si hay errores con updated_at

-- Asegurar que la columna updated_at existe en cart_items
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'cart_items' 
        AND column_name = 'updated_at'
        AND table_schema = 'public'
    ) THEN
        ALTER TABLE public.cart_items 
        ADD COLUMN updated_at timestamptz DEFAULT now();
        
        -- Actualizar todos los registros existentes con la fecha actual
        UPDATE public.cart_items 
        SET updated_at = now() 
        WHERE updated_at IS NULL;
        
        RAISE NOTICE 'Columna updated_at agregada a cart_items';
    ELSE
        RAISE NOTICE 'Columna updated_at ya existe en cart_items';
    END IF;
END $$;

-- Asegurar que la función set_updated_at() verifica correctamente
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    -- Verificar si la columna existe usando information_schema
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = TG_TABLE_SCHEMA 
        AND table_name = TG_TABLE_NAME 
        AND column_name = 'updated_at'
    ) THEN
        NEW.updated_at = now();
    END IF;
    RETURN NEW;
END $$;

-- Recrear el trigger si es necesario
DROP TRIGGER IF EXISTS cart_items_set_updated_at ON public.cart_items;
CREATE TRIGGER cart_items_set_updated_at
    BEFORE UPDATE ON public.cart_items
    FOR EACH ROW
    EXECUTE FUNCTION public.set_updated_at();

-- Notificar a PostgREST para recargar el esquema
SELECT pg_notify('pgrst', 'reload schema');

