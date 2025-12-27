-- supabase/permissive_rls_policies.sql
-- Políticas RLS más permisivas para desarrollo

-- 1. Eliminar políticas existentes si las hay
DROP POLICY IF EXISTS "Allow authenticated users to read products" ON products;
DROP POLICY IF EXISTS "Allow authenticated users to insert products" ON products;
DROP POLICY IF EXISTS "Allow authenticated users to update products" ON products;
DROP POLICY IF EXISTS "Allow authenticated users to delete products" ON products;

DROP POLICY IF EXISTS "Allow authenticated users to read product_variants" ON product_variants;
DROP POLICY IF EXISTS "Allow authenticated users to insert product_variants" ON product_variants;
DROP POLICY IF EXISTS "Allow authenticated users to update product_variants" ON product_variants;
DROP POLICY IF EXISTS "Allow authenticated users to delete product_variants" ON product_variants;

DROP POLICY IF EXISTS "Allow authenticated users to read variant_images" ON variant_images;
DROP POLICY IF EXISTS "Allow authenticated users to insert variant_images" ON variant_images;
DROP POLICY IF EXISTS "Allow authenticated users to update variant_images" ON variant_images;
DROP POLICY IF EXISTS "Allow authenticated users to delete variant_images" ON variant_images;

DROP POLICY IF EXISTS "Allow authenticated users to read product_tags" ON product_tags;
DROP POLICY IF EXISTS "Allow authenticated users to insert product_tags" ON product_tags;
DROP POLICY IF EXISTS "Allow authenticated users to update product_tags" ON product_tags;
DROP POLICY IF EXISTS "Allow authenticated users to delete product_tags" ON product_tags;

DROP POLICY IF EXISTS "Allow authenticated users to read colors" ON colors;
DROP POLICY IF EXISTS "Allow authenticated users to insert colors" ON colors;

DROP POLICY IF EXISTS "Allow authenticated users to read tags" ON tags;
DROP POLICY IF EXISTS "Allow authenticated users to insert tags" ON tags;

-- 2. Crear políticas más permisivas
-- PRODUCTS - Permitir todo a usuarios autenticados
CREATE POLICY "products_all_access" ON products
    FOR ALL USING (auth.role() = 'authenticated');

-- PRODUCT_VARIANTS - Permitir todo a usuarios autenticados
CREATE POLICY "product_variants_all_access" ON product_variants
    FOR ALL USING (auth.role() = 'authenticated');

-- VARIANT_IMAGES - Permitir todo a usuarios autenticados
CREATE POLICY "variant_images_all_access" ON variant_images
    FOR ALL USING (auth.role() = 'authenticated');

-- PRODUCT_TAGS - Permitir todo a usuarios autenticados
CREATE POLICY "product_tags_all_access" ON product_tags
    FOR ALL USING (auth.role() = 'authenticated');

-- COLORS - Permitir todo a usuarios autenticados
CREATE POLICY "colors_all_access" ON colors
    FOR ALL USING (auth.role() = 'authenticated');

-- TAGS - Permitir todo a usuarios autenticados
CREATE POLICY "tags_all_access" ON tags
    FOR ALL USING (auth.role() = 'authenticated');

-- 3. Verificar que las políticas se crearon
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd
FROM pg_policies 
WHERE schemaname = 'public' 
AND tablename IN ('products', 'product_variants', 'variant_images', 'product_tags', 'colors', 'tags')
ORDER BY tablename, policyname;
