-- supabase/fix_rls_policies.sql
-- Políticas RLS para permitir a usuarios autenticados crear/editar productos

-- 1. Habilitar RLS en las tablas principales
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE variant_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_tags ENABLE ROW LEVEL SECURITY;

-- 2. Políticas para la tabla products
-- Permitir lectura a todos los usuarios autenticados
CREATE POLICY "Allow authenticated users to read products" ON products
    FOR SELECT USING (auth.role() = 'authenticated');

-- Permitir inserción a usuarios autenticados
CREATE POLICY "Allow authenticated users to insert products" ON products
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Permitir actualización a usuarios autenticados
CREATE POLICY "Allow authenticated users to update products" ON products
    FOR UPDATE USING (auth.role() = 'authenticated');

-- Permitir eliminación a usuarios autenticados
CREATE POLICY "Allow authenticated users to delete products" ON products
    FOR DELETE USING (auth.role() = 'authenticated');

-- 3. Políticas para la tabla product_variants
-- Permitir lectura a todos los usuarios autenticados
CREATE POLICY "Allow authenticated users to read product_variants" ON product_variants
    FOR SELECT USING (auth.role() = 'authenticated');

-- Permitir inserción a usuarios autenticados
CREATE POLICY "Allow authenticated users to insert product_variants" ON product_variants
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Permitir actualización a usuarios autenticados
CREATE POLICY "Allow authenticated users to update product_variants" ON product_variants
    FOR UPDATE USING (auth.role() = 'authenticated');

-- Permitir eliminación a usuarios autenticados
CREATE POLICY "Allow authenticated users to delete product_variants" ON product_variants
    FOR DELETE USING (auth.role() = 'authenticated');

-- 4. Políticas para la tabla variant_images
-- Permitir lectura a todos los usuarios autenticados
CREATE POLICY "Allow authenticated users to read variant_images" ON variant_images
    FOR SELECT USING (auth.role() = 'authenticated');

-- Permitir inserción a usuarios autenticados
CREATE POLICY "Allow authenticated users to insert variant_images" ON variant_images
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Permitir actualización a usuarios autenticados
CREATE POLICY "Allow authenticated users to update variant_images" ON variant_images
    FOR UPDATE USING (auth.role() = 'authenticated');

-- Permitir eliminación a usuarios autenticados
CREATE POLICY "Allow authenticated users to delete variant_images" ON variant_images
    FOR DELETE USING (auth.role() = 'authenticated');

-- 5. Políticas para la tabla product_tags
-- Permitir lectura a todos los usuarios autenticados
CREATE POLICY "Allow authenticated users to read product_tags" ON product_tags
    FOR SELECT USING (auth.role() = 'authenticated');

-- Permitir inserción a usuarios autenticados
CREATE POLICY "Allow authenticated users to insert product_tags" ON product_tags
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- Permitir actualización a usuarios autenticados
CREATE POLICY "Allow authenticated users to update product_tags" ON product_tags
    FOR UPDATE USING (auth.role() = 'authenticated');

-- Permitir eliminación a usuarios autenticados
CREATE POLICY "Allow authenticated users to delete product_tags" ON product_tags
    FOR DELETE USING (auth.role() = 'authenticated');

-- 6. Políticas para la tabla colors (solo lectura para usuarios autenticados)
CREATE POLICY "Allow authenticated users to read colors" ON colors
    FOR SELECT USING (auth.role() = 'authenticated');

-- Permitir inserción a usuarios autenticados (para agregar nuevos colores)
CREATE POLICY "Allow authenticated users to insert colors" ON colors
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- 7. Políticas para la tabla tags (solo lectura para usuarios autenticados)
CREATE POLICY "Allow authenticated users to read tags" ON tags
    FOR SELECT USING (auth.role() = 'authenticated');

-- Permitir inserción a usuarios autenticados (para agregar nuevos tags)
CREATE POLICY "Allow authenticated users to insert tags" ON tags
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- 8. Verificar que las políticas se crearon correctamente
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual
FROM pg_policies 
WHERE schemaname = 'public' 
AND tablename IN ('products', 'product_variants', 'variant_images', 'product_tags', 'colors', 'tags')
ORDER BY tablename, policyname;
