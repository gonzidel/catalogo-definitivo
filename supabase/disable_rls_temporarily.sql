-- supabase/disable_rls_temporarily.sql
-- ⚠️ SOLUCIÓN TEMPORAL - Deshabilitar RLS para permitir operaciones
-- ⚠️ SOLO USAR EN DESARROLLO - NO USAR EN PRODUCCIÓN

-- Deshabilitar RLS en todas las tablas principales
ALTER TABLE products DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants DISABLE ROW LEVEL SECURITY;
ALTER TABLE variant_images DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_tags DISABLE ROW LEVEL SECURITY;
ALTER TABLE colors DISABLE ROW LEVEL SECURITY;
ALTER TABLE tags DISABLE ROW LEVEL SECURITY;

-- Verificar que RLS está deshabilitado
SELECT 
    schemaname,
    tablename,
    rowsecurity as rls_enabled
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename IN ('products', 'product_variants', 'variant_images', 'product_tags', 'colors', 'tags')
ORDER BY tablename;
