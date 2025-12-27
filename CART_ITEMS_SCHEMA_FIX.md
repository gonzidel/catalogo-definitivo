# 🔧 Solución al Error de Esquema de cart_items

## ❌ **Error Identificado:**

```
column "status" of relation "cart_items" does not exist
```

### **Causa del Problema:**

La tabla `cart_items` en la base de datos no tiene la columna `status` que el código está intentando usar. Esto indica que el esquema de la base de datos no está actualizado.

---

## ✅ **Solución Implementada:**

### **1. Script de Corrección SQL (`supabase/fix_cart_items_schema.sql`)**

- ✅ **Verificación** de columnas faltantes
- ✅ **Agregado** de columna `status` si no existe
- ✅ **Agregado** de columna `price_snapshot` si no existe
- ✅ **Agregado** de columna `reserved_qty` en `product_variants` si no existe
- ✅ **Verificación** de estructura completa

### **2. Script de Diagnóstico (`scripts/check-cart-schema.js`)**

- ✅ **Verificación** del esquema de `cart_items`
- ✅ **Verificación** de tablas requeridas
- ✅ **Diagnóstico** completo con mensajes informativos
- ✅ **Detección** automática de problemas

---

## 🚀 **Pasos para Solucionar:**

### **Paso 1: Ejecutar Script SQL en Supabase**

1. **Ir a Supabase Dashboard**
2. **Navegar a SQL Editor**
3. **Copiar y pegar** el contenido de `supabase/fix_cart_items_schema.sql`
4. **Ejecutar** el script
5. **Verificar** que no haya errores

### **Paso 2: Verificar desde el Cliente**

1. **Abrir consola** del navegador (F12)
2. **Ejecutar** diagnóstico:
   ```javascript
   window.diagnoseSchema();
   ```
3. **Verificar** que todas las tablas estén accesibles

### **Paso 3: Probar Funcionalidad**

1. **Recargar** la página
2. **Intentar** agregar un producto al carrito
3. **Verificar** que no aparezca el error

---

## 🔍 **Diagnóstico Automático:**

### **Verificar Esquema:**

```javascript
// En la consola del navegador
window.checkCartItemsSchema();
```

### **Verificar Tablas:**

```javascript
// Verificar todas las tablas requeridas
window.checkRequiredTables();
```

### **Diagnóstico Completo:**

```javascript
// Diagnóstico completo del esquema
window.diagnoseSchema();
```

---

## 📋 **Estructura Esperada de cart_items:**

### **Columnas Requeridas:**

```sql
CREATE TABLE public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
  qty int NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT 'reserved',  -- ← COLUMNA FALTANTE
  price_snapshot numeric,                    -- ← COLUMNA FALTANTE
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

### **Valores de Status:**

- `'reserved'` - Item reservado en el carrito
- `'confirmed'` - Item confirmado en el pedido
- `'rejected'` - Item rechazado

---

## 🚨 **Si el Problema Persiste:**

### **Verificación Manual:**

1. **Ir a Supabase Dashboard**
2. **Navegar a Table Editor**
3. **Seleccionar** tabla `cart_items`
4. **Verificar** que existan las columnas:
   - `id`
   - `cart_id`
   - `variant_id`
   - `qty`
   - `status` ← **IMPORTANTE**
   - `price_snapshot` ← **IMPORTANTE**
   - `created_at`
   - `updated_at`

### **Recrear Tabla si es Necesario:**

```sql
-- Solo si es absolutamente necesario
DROP TABLE IF EXISTS public.cart_items CASCADE;
-- Luego ejecutar el script completo de creación
```

---

## ✅ **Beneficios de la Solución:**

1. **🔧 Corrección** automática del esquema
2. **📊 Diagnóstico** detallado de problemas
3. **🛡️ Verificación** de integridad de datos
4. **🔄 Funcionamiento** correcto del carrito
5. **📱 Experiencia** sin errores para el usuario
6. **⚡ Rendimiento** optimizado

---

## 🚀 **Próximos Pasos:**

1. **Ejecutar** el script SQL en Supabase
2. **Verificar** que el diagnóstico sea exitoso
3. **Probar** agregar productos al carrito
4. **Confirmar** que no aparezcan errores
5. **Verificar** que la funcionalidad del carrito funcione

---

## 📞 **Soporte Adicional:**

### **Si Necesitas Ayuda:**

1. **Ejecutar** `window.diagnoseSchema()` en consola
2. **Copiar** los logs de error
3. **Verificar** que el script SQL se ejecutó correctamente
4. **Confirmar** que las columnas existen en Supabase

---

**El error de esquema se soluciona ejecutando el script SQL para agregar las columnas faltantes a la tabla cart_items.**
