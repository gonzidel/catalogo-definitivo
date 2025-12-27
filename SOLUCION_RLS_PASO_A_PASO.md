# 🚨 Solución Paso a Paso para Error de RLS

## ❌ **Error Actual:**

```
Error de permisos: No tienes permisos para crear productos. Contacta al administrador.
new row violates row-level security policy for table "products"
```

## 🔧 **SOLUCIÓN INMEDIATA (Recomendada)**

### **Paso 1: Deshabilitar RLS Temporalmente**

1. **Abrir Supabase Dashboard:**

   - Ve a [supabase.com](https://supabase.com)
   - Selecciona tu proyecto
   - Ve a **SQL Editor**

2. **Ejecutar Script de Deshabilitación:**

   - Copia y pega el contenido de `supabase/disable_rls_temporarily.sql`
   - Haz clic en **"Run"** para ejecutar
   - Verifica que no hay errores

3. **Verificar que RLS está deshabilitado:**
   - Deberías ver `rls_enabled: false` para todas las tablas

### **Paso 2: Probar la Funcionalidad**

1. **Recarga la página** del panel de administración
2. **Intenta crear un producto** nuevamente
3. **Verifica que no aparezcan errores** de permisos

---

## 🔧 **SOLUCIÓN ALTERNATIVA (Si prefieres mantener RLS)**

### **Paso 1: Aplicar Políticas RLS Permisivas**

1. **En Supabase SQL Editor:**
   - Copia y pega el contenido de `supabase/permissive_rls_policies.sql`
   - Ejecuta el script completo
   - Verifica que no hay errores

### **Paso 2: Verificar las Políticas**

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

---

## 🧪 **Verificación de la Solución**

### **Opción 1: Script Automático**

1. **Abre la consola del navegador** (F12)
2. **Ejecuta:** `window.testConnection()`
3. **Verifica que aparezca:** `✅ Prueba de conexión exitosa`

### **Opción 2: Prueba Manual**

1. **Intenta crear un producto** en el panel
2. **Verifica que se guarde** sin errores
3. **Revisa la consola** para confirmar que no hay errores de RLS

---

## 🚨 **Si el Problema Persiste**

### **Verificaciones Adicionales:**

1. **Verificar Autenticación:**

   ```javascript
   // En la consola del navegador
   const { data } = await supabase.auth.getSession();
   console.log("Usuario:", data?.session?.user?.email);
   ```

2. **Verificar Permisos:**

   ```javascript
   // Probar acceso directo
   const { data, error } = await supabase
     .from("products")
     .select("id")
     .limit(1);
   console.log("Acceso:", error ? "❌ Error" : "✅ OK");
   ```

3. **Verificar Configuración de Supabase:**
   - Revisar que el proyecto esté activo
   - Verificar que las tablas existan
   - Confirmar que el usuario tenga permisos

---

## 📋 **Checklist de Verificación**

- [ ] Script SQL ejecutado sin errores
- [ ] RLS deshabilitado o políticas aplicadas
- [ ] Usuario autenticado correctamente
- [ ] Sesión activa en el navegador
- [ ] Prueba de conexión exitosa
- [ ] Producto se puede crear sin errores
- [ ] Stock se guarda correctamente

---

## 🆘 **Soporte Adicional**

Si después de seguir estos pasos el problema persiste:

1. **Revisa los logs de Supabase** en el dashboard
2. **Verifica la configuración de autenticación**
3. **Contacta al administrador del sistema**
4. **Considera usar la opción de deshabilitar RLS temporalmente**

---

**Nota:** La opción de deshabilitar RLS es la más rápida para desarrollo, pero en producción deberías usar políticas RLS apropiadas.
