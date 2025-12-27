# 🔧 Solución al Error de RLS (Row Level Security)

## ❌ **Problema Identificado**

El error `"new row violates row-level security policy for table "products"` indica que las políticas de seguridad de Supabase están bloqueando la inserción de datos.

## ✅ **Solución Paso a Paso**

### **1. Ejecutar el Script SQL de Corrección**

1. **Abrir Supabase Dashboard:**

   - Ve a tu proyecto en [supabase.com](https://supabase.com)
   - Navega a **SQL Editor**

2. **Ejecutar el Script:**
   - Copia y pega el contenido del archivo `supabase/fix_rls_policies.sql`
   - Ejecuta el script completo
   - Verifica que no hay errores

### **2. Verificar las Políticas Creadas**

Después de ejecutar el script, verifica que las políticas se crearon:

```sql
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
```

### **3. Probar la Funcionalidad**

1. **Recarga la página** del panel de administración
2. **Intenta crear un producto** nuevamente
3. **Verifica en la consola** que no hay errores de RLS

### **4. Diagnóstico Adicional**

Si el problema persiste, ejecuta el diagnóstico:

1. **Abre la consola del navegador** (F12)
2. **Ejecuta:** `window.runDiagnostic()`
3. **Revisa los logs** para identificar problemas específicos

## 🔍 **Verificaciones Adicionales**

### **Verificar Autenticación:**

```javascript
// En la consola del navegador
const { data } = await supabase.auth.getSession();
console.log("Usuario autenticado:", data?.session?.user?.email);
```

### **Verificar Permisos:**

```javascript
// Probar acceso a la tabla products
const { data, error } = await supabase
  .from("products")
  .select("id, name")
  .limit(1);
console.log("Acceso a products:", error ? "❌ Error" : "✅ OK");
```

## 🚨 **Si el Problema Persiste**

### **Opción 1: Deshabilitar RLS Temporalmente**

```sql
-- ⚠️ SOLO PARA DESARROLLO - NO USAR EN PRODUCCIÓN
ALTER TABLE products DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants DISABLE ROW LEVEL SECURITY;
ALTER TABLE variant_images DISABLE ROW LEVEL SECURITY;
ALTER TABLE product_tags DISABLE ROW LEVEL SECURITY;
```

### **Opción 2: Verificar Configuración de Usuario**

1. **Verificar que el usuario esté en la tabla `auth.users`**
2. **Verificar que tenga el rol correcto**
3. **Verificar que la sesión esté activa**

## 📋 **Checklist de Verificación**

- [ ] Script SQL ejecutado sin errores
- [ ] Políticas RLS creadas correctamente
- [ ] Usuario autenticado correctamente
- [ ] Sesión activa en el navegador
- [ ] Permisos verificados con diagnóstico
- [ ] Producto se puede crear sin errores

## 🆘 **Soporte Adicional**

Si el problema persiste después de seguir estos pasos:

1. **Revisa los logs de Supabase** en el dashboard
2. **Verifica la configuración de autenticación**
3. **Contacta al administrador del sistema**

---

**Nota:** Este error es común en proyectos nuevos de Supabase donde las políticas RLS no están configuradas correctamente para usuarios autenticados.
