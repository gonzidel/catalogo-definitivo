-- Agregar campos de publicación a la tabla products
-- Ejecutar en el SQL Editor de Supabase

-- Agregar columna last_published_at (fecha de última publicación)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS last_published_at timestamptz;

-- Agregar columna publication_status (estado de publicación)
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS publication_status text DEFAULT 'nuevo';

-- Actualizar productos existentes: si no tienen last_published_at, son 'nuevo'
UPDATE public.products
SET publication_status = 'nuevo'
WHERE last_published_at IS NULL AND (publication_status IS NULL OR publication_status = '');

-- Crear índice para consultas eficientes por fecha de publicación
CREATE INDEX IF NOT EXISTS idx_products_last_published_at 
ON public.products(last_published_at);

CREATE INDEX IF NOT EXISTS idx_products_publication_status 
ON public.products(publication_status);

-- Notificar a PostgREST para recargar el esquema
SELECT pg_notify('pgrst', 'reload schema');

