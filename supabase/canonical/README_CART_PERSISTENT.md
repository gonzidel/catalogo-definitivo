# 🛒 Carrito Persistente - Esquema de Base de Datos

## 📋 Descripción

Este documento describe los cambios realizados en la base de datos para soportar el sistema de carrito persistente que funciona entre recargas de página y se sincroniza automáticamente con Supabase.

## 🗂️ Archivos SQL Creados

### **08_cart_items_flexible.sql**

- **Propósito**: Hacer el esquema de `cart_items` más flexible
- **Cambios**:
  - Agrega columnas: `product_name`, `color`, `size`, `quantity`, `status`, `price_snapshot`
  - Crea trigger para sincronizar `qty` con `quantity`
  - Crea funciones auxiliares para manejo del carrito
  - Actualiza políticas RLS

### **09_cart_persistent_functions.sql**

- **Propósito**: Funciones específicas para el carrito persistente
- **Funciones principales**:
  - `get_or_create_user_cart()` - Obtener o crear carrito del usuario
  - `sync_cart_from_local()` - Sincronizar desde localStorage
  - `get_user_cart_complete()` - Obtener carrito completo
  - `update_cart_item_quantity()` - Actualizar cantidad
  - `remove_cart_item()` - Remover item
  - `get_cart_summary()` - Resumen del carrito
  - `clear_user_cart()` - Limpiar carrito
  - `change_cart_status()` - Cambiar estado

## 🔧 Estructura de Tablas

### **Tabla `carts`**

```sql
CREATE TABLE public.carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

### **Tabla `cart_items` (Actualizada)**

```sql
CREATE TABLE public.cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES public.carts(id) ON DELETE CASCADE,
  variant_id uuid REFERENCES public.product_variants(id) ON DELETE CASCADE, -- Opcional
  product_name text, -- Nuevo
  color text, -- Nuevo
  size text, -- Nuevo
  qty int NOT NULL CHECK (qty > 0), -- Original
  quantity int, -- Nuevo (sincronizado con qty)
  status text NOT NULL DEFAULT 'reserved',
  price_snapshot numeric,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

## 🔐 Políticas RLS

### **Política para `carts`**

```sql
CREATE POLICY carts_self_access ON public.carts
  FOR ALL TO authenticated
  USING (customer_id = auth.uid())
  WITH CHECK (customer_id = auth.uid());
```

### **Política para `cart_items`**

```sql
CREATE POLICY cart_items_self_access ON public.cart_items
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.carts c
      WHERE c.id = cart_id
      AND c.customer_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.carts c
      WHERE c.id = cart_id
      AND c.customer_id = auth.uid()
    )
  );
```

## 🚀 Funciones Principales

### **1. `get_or_create_user_cart(user_id uuid)`**

- **Propósito**: Obtener carrito abierto del usuario o crear uno nuevo
- **Retorna**: `uuid` del carrito
- **Uso**: `SELECT get_or_create_user_cart(auth.uid());`

### **2. `sync_cart_from_local(user_id uuid, cart_data jsonb)`**

- **Propósito**: Sincronizar carrito desde datos de localStorage
- **Parámetros**:
  - `user_id`: ID del usuario
  - `cart_data`: Array JSON con items del carrito
- **Uso**: `SELECT sync_cart_from_local(auth.uid(), '[{"articulo":"Producto","color":"Negro","talle":"M","cantidad":1,"precio":10000}]'::jsonb);`

### **3. `get_user_cart_complete(user_id uuid)`**

- **Propósito**: Obtener carrito completo con todos sus items
- **Retorna**: Tabla con datos del carrito e items
- **Uso**: `SELECT * FROM get_user_cart_complete(auth.uid());`

### **4. `get_cart_summary(user_id uuid)`**

- **Propósito**: Obtener resumen del carrito (total items, productos únicos, precio total)
- **Retorna**: `(total_items int, unique_products int, total_price numeric)`
- **Uso**: `SELECT * FROM get_cart_summary(auth.uid());`

## 📊 Vista `user_cart_view`

Vista que combina datos de `carts` y `cart_items` para fácil acceso:

```sql
CREATE VIEW user_cart_view AS
SELECT
    c.id as cart_id,
    c.customer_id,
    c.status as cart_status,
    c.created_at as cart_created_at,
    ci.id as item_id,
    ci.product_name,
    ci.color,
    ci.size,
    COALESCE(ci.quantity, ci.qty) as quantity,
    ci.price_snapshot,
    ci.status as item_status,
    ci.created_at as item_created_at
FROM public.carts c
LEFT JOIN public.cart_items ci ON c.id = ci.cart_id
WHERE c.customer_id = auth.uid()
AND c.status = 'open';
```

## 🔄 Flujo de Sincronización

### **1. Usuario no autenticado**

- Carrito se guarda solo en `localStorage`
- No hay sincronización con Supabase

### **2. Usuario se autentica**

- Se ejecuta `syncCartWithSupabase()`
- Se llama a `sync_cart_from_local()`
- Carrito se sincroniza con Supabase

### **3. Usuario recarga página**

- Se ejecuta `loadCartFromSupabase()`
- Se llama a `get_user_cart_complete()`
- Carrito se carga desde Supabase

## 🧪 Pruebas

### **Verificar funciones disponibles**

```sql
-- Verificar que las funciones existen
SELECT proname FROM pg_proc
WHERE proname IN (
    'get_or_create_user_cart',
    'sync_cart_from_local',
    'get_user_cart_complete',
    'get_cart_summary'
);
```

### **Probar carrito de usuario**

```sql
-- Crear carrito de prueba
SELECT get_or_create_user_cart(auth.uid());

-- Agregar items de prueba
SELECT sync_cart_from_local(
    auth.uid(),
    '[{"articulo":"Producto Test","color":"Negro","talle":"M","cantidad":2,"precio":15000}]'::jsonb
);

-- Ver carrito completo
SELECT * FROM get_user_cart_complete(auth.uid());

-- Ver resumen
SELECT * FROM get_cart_summary(auth.uid());
```

## 📝 Notas Importantes

1. **Compatibilidad**: El esquema mantiene compatibilidad con el sistema original usando `variant_id`
2. **Flexibilidad**: Permite productos sin `variant_id` usando `product_name`, `color`, `size`
3. **Sincronización**: Las columnas `qty` y `quantity` se mantienen sincronizadas
4. **Seguridad**: Todas las funciones usan `SECURITY DEFINER` y verifican permisos
5. **RLS**: Las políticas aseguran que los usuarios solo accedan a sus propios carritos

## 🔧 Mantenimiento

### **Verificar estado del esquema**

```sql
-- Verificar columnas de cart_items
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'cart_items'
AND table_schema = 'public'
ORDER BY ordinal_position;
```

### **Limpiar carritos antiguos**

```sql
-- Eliminar carritos vacíos de más de 30 días
DELETE FROM public.carts
WHERE status = 'open'
AND created_at < now() - interval '30 days'
AND NOT EXISTS (
    SELECT 1 FROM public.cart_items
    WHERE cart_id = public.carts.id
);
```

---

**Versión**: 1.0  
**Fecha**: Diciembre 2024  
**Estado**: ✅ Implementado y funcionando
