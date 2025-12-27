# Protocolo: Problema con Creación de Clientes desde Admin Panel

## 📋 Resumen Ejecutivo

**Problema Principal:** No se puede crear clientes manualmente desde el panel de administración debido a una violación de foreign key constraint (`customers_id_fkey`).

**Objetivo:** Implementar un sistema que permita:
1. Crear clientes desde el panel admin (sin que tengan cuenta en `auth.users`)
2. Evitar duplicación cuando esos mismos clientes se registren luego con Google OAuth
3. Vincular automáticamente las identidades cuando haya coincidencias (email, teléfono, DNI)

**Estado Actual:** La constraint FK fue eliminada, pero el error persiste. La función RPC necesita ser actualizada o hay un problema de caché.

---

## 🎯 Contexto del Problema

### Situación Inicial

El usuario necesita poder crear clientes manualmente desde el panel de administración. Estos clientes son registros "temporales" que:
- No tienen cuenta en `auth.users` aún
- Se crearán con datos básicos (nombre, email, teléfono, DNI)
- Más tarde, cuando el cliente se registre con Google OAuth, deben vincularse automáticamente

### Problema Técnico

La tabla `customers` tiene una foreign key constraint:
```sql
id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
```

Esto significa que **cada registro en `customers` DEBE tener un `id` que exista en `auth.users`**. Cuando intentamos crear un cliente desde admin con un UUID temporal que no existe en `auth.users`, PostgreSQL lanza el error:

```
ERROR: insert or update on table "customers" violates foreign key constraint "customers_id_fkey"
Key is not present in table "users"
```

---

## 🔄 Soluciones Intentadas

### 1. Intentar usar DEFERRABLE INITIALLY DEFERRED

**Enfoque:** Hacer la constraint FK "diferible", es decir, que la validación se haga al final de la transacción en lugar de inmediatamente.

**Scripts creados:**
- `22_part1_fix_fk.sql` - Intenta modificar la constraint a DEFERRABLE
- `22_simple_fix_fk.sql` - Versión simplificada
- `22_verify_and_fix_fk.sql` - Script de diagnóstico y corrección

**Resultado:** ❌ **NO FUNCIONÓ**
- La constraint se configuró correctamente como DEFERRABLE (verificado con queries)
- Pero el error persistió porque en funciones `SECURITY DEFINER` de Supabase, las constraints DEFERRABLE no funcionan como se espera
- `SET CONSTRAINTS` dentro de funciones RPC no tiene efecto

### 2. Eliminar la Foreign Key Constraint

**Enfoque:** Eliminar completamente la constraint FK y usar validación manual con triggers.

**Scripts creados:**
- `22_solucion_final_remove_fk.sql` - Elimina FK y crea trigger de validación
- `22_eliminar_fk_definitivo.sql` - Versión más robusta con verificaciones

**Resultado:** ✅ **CONSTRAINT ELIMINADA**
- Verificado con: `SELECT COUNT(*) FROM pg_constraint WHERE ...` → Devuelve `0`
- La constraint ya no existe en la base de datos

**Pero:** ❌ **EL ERROR PERSISTE**
- Posibles causas:
  1. La función RPC no se actualizó correctamente
  2. Hay caché en Supabase que mantiene la versión anterior
  3. Hay otra constraint o validación que no se detectó

### 3. Actualizar la Función RPC

**Enfoque:** Recrear completamente la función `rpc_create_admin_customer` sin ninguna lógica relacionada con FK.

**Scripts creados:**
- `22_part4_create_admin_function.sql` - Función inicial
- `22_solucion_definitiva_funcion.sql` - Versión final con limpieza de caché

**Resultado:** ⚠️ **NO VERIFICADO COMPLETAMENTE**
- La función debería funcionar ahora que la FK no existe
- Pero no se confirmó si el error persiste

---

## 🏗️ Implementación del Sistema de Vinculación

### Arquitectura Propuesta

El sistema diseñado incluye:

#### 1. Tabla `customer_auth_links`
Vincula clientes con cuentas de autenticación:
```sql
CREATE TABLE customer_auth_links (
  id uuid PRIMARY KEY,
  customer_id uuid REFERENCES customers(id),
  auth_user_id uuid REFERENCES auth.users(id),
  linked_at timestamptz,
  match_type text -- 'email', 'phone', 'dni', 'new', 'manual'
);
```

#### 2. Funciones RPC Principales

**`rpc_create_admin_customer`** - Crear cliente desde admin
- Genera UUID temporal
- Inserta en `customers` con `created_by_admin = true`
- No requiere que el UUID exista en `auth.users`

**`rpc_link_or_create_customer`** - Vincular o crear cuando usuario se registra con Google
- Busca coincidencias por email, teléfono o DNI
- Si encuentra cliente admin-created, lo vincula y migra datos
- Si no encuentra, crea nuevo cliente con `auth.users.id`
- Prioridad: email > teléfono > DNI

**`get_customer_id_for_user`** - Helper para obtener customer_id desde auth_user_id
- Usado en frontend para consultas que antes usaban `user.id` directamente

#### 3. Campos Agregados a `customers`

```sql
ALTER TABLE customers ADD COLUMN created_by_admin boolean DEFAULT false;
ALTER TABLE customers ADD COLUMN linked_at timestamptz;
ALTER TABLE customers ADD COLUMN auth_provider text; -- 'google', 'admin'
```

#### 4. Triggers de Validación Manual

Como alternativa a la FK, se propuso un trigger que valida manualmente:
```sql
CREATE TRIGGER validate_customer_user_trigger
  BEFORE INSERT OR UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION validate_customer_user_on_insert_update();
```

Este trigger solo valida si `created_by_admin = false`, permitiendo que clientes admin tengan UUIDs temporales.

---

## 📁 Archivos Modificados

### Frontend (JavaScript)

**`scripts/cart-persistent.js`**
- `ensureCustomerRecord()` - Ahora usa `rpc_link_or_create_customer`
- `getCustomerIdForUser()` - Nueva función helper para obtener customer_id
- `getOrCreateOpenCart()` - Actualizado para usar el helper

**`admin/order-creator.js`**
- `saveNewCustomer()` - Nueva función que llama a `rpc_create_admin_customer`
- `openCreateCustomerModal()` - Modal para crear clientes
- `selectCustomerById()` - Seleccionar cliente después de crearlo

**`admin/orders.html`**
- Modal HTML para formulario de creación de clientes

### Backend (SQL)

**Archivo principal:** `supabase/canonical/22_customer_auth_linking.sql` (eliminado)
- Contenía toda la implementación completa del sistema
- Incluía tablas, funciones RPC, triggers, y políticas RLS

**Archivos de corrección (todos eliminados):**
- Múltiples scripts de intentos para corregir el problema de FK
- Scripts de diagnóstico y verificación

---

## 🔍 Estado Actual del Problema

### Verificaciones Realizadas

1. ✅ **Constraint FK eliminada:**
   ```sql
   SELECT COUNT(*) FROM pg_constraint 
   WHERE conrelid = 'public.customers'::regclass
     AND contype = 'f' 
     AND confrelid = 'auth.users'::regclass;
   -- Resultado: 0
   ```

2. ❓ **Función RPC:** No se confirmó si está actualizada correctamente

3. ❓ **Caché de Supabase:** Puede estar manteniendo esquema anterior

### Error Actual

```
Error: insert or update on table "customers" violates foreign key constraint "customers_id_fkey"
Key is not present in table "users"
```

Este error **NO debería aparecer** si la constraint realmente no existe. Posibles explicaciones:

1. **Caché de Supabase:** El esquema en memoria aún tiene la constraint
2. **Función antigua:** La función RPC sigue usando lógica que asume la FK
3. **Otra constraint:** Puede haber otra constraint con nombre diferente
4. **Validación en otro lugar:** Trigger, vista materializada, o función que valida

---

## 🔧 Pasos para Continuar la Solución

### Paso 1: Verificar Estado Real de la Base de Datos

```sql
-- Ver TODAS las constraints en customers
SELECT 
    conname, 
    contype, 
    pg_get_constraintdef(oid) as definition
FROM pg_constraint
WHERE conrelid = 'public.customers'::regclass;

-- Ver la definición actual de la tabla
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'customers'
ORDER BY ordinal_position;
```

### Paso 2: Verificar la Función RPC Actual

```sql
-- Ver código fuente de la función
SELECT proname, prosrc 
FROM pg_proc 
WHERE proname = 'rpc_create_admin_customer';

-- Ver si existe y sus parámetros
SELECT 
    p.proname,
    pg_get_function_arguments(p.oid) as arguments,
    pg_get_functiondef(p.oid) as definition
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
  AND p.proname = 'rpc_create_admin_customer';
```

### Paso 3: Recrear la Función Sin FK

```sql
-- Eliminar función anterior
DROP FUNCTION IF EXISTS public.rpc_create_admin_customer CASCADE;

-- Crear función nueva (ver implementación en siguiente sección)
CREATE FUNCTION public.rpc_create_admin_customer(...)
-- [Código completo más abajo]
```

### Paso 4: Limpiar Caché de Supabase

```sql
-- Forzar recarga del esquema
SELECT pg_notify('pgrst', 'reload schema');
NOTIFY pgrst, 'reload schema';

-- Esperar 10-15 segundos después de esto
```

### Paso 5: Probar Creación de Cliente

Desde el frontend, intentar crear un cliente y revisar:
- Consola del navegador (F12) para errores JavaScript
- Network tab para ver la respuesta del RPC
- Logs de Supabase si están disponibles

---

## 💻 Código de la Función RPC Propuesta

```sql
CREATE OR REPLACE FUNCTION public.rpc_create_admin_customer(
  p_full_name text,
  p_email text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_dni text DEFAULT NULL,
  p_address text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_province text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_customer_id uuid;
  v_customer_number text;
  v_temp_uuid uuid;
BEGIN
  -- Validación
  IF p_full_name IS NULL OR trim(p_full_name) = '' THEN
    RETURN json_build_object(
      'success', false,
      'error', 'validation_error',
      'message', 'El nombre completo es obligatorio'
    );
  END IF;
  
  -- Generar UUID temporal (NO necesita existir en auth.users)
  v_temp_uuid := gen_random_uuid();
  
  -- Insertar directamente - NO hay FK que validar
  INSERT INTO public.customers (
    id, full_name, email, phone, dni, 
    address, city, province,
    customer_number, created_by_admin, auth_provider
  )
  VALUES (
    v_temp_uuid, 
    trim(p_full_name), 
    nullif(trim(COALESCE(p_email, '')), ''),
    nullif(trim(COALESCE(p_phone, '')), ''), 
    nullif(trim(COALESCE(p_dni, '')), ''),
    nullif(trim(COALESCE(p_address, '')), ''), 
    nullif(trim(COALESCE(p_city, '')), ''),
    nullif(trim(COALESCE(p_province, '')), ''), 
    public.generate_customer_number(), -- Asumiendo que esta función existe
    true, 
    'admin'
  )
  RETURNING id, customer_number INTO v_customer_id, v_customer_number;
  
  RETURN json_build_object(
    'success', true,
    'customer_id', v_customer_id,
    'customer_number', v_customer_number,
    'message', 'Cliente creado exitosamente'
  );
  
EXCEPTION 
  WHEN OTHERS THEN
    RETURN json_build_object(
      'success', false,
      'error', SQLSTATE,
      'error_message', SQLERRM,
      'message', 'Error al crear cliente: ' || SQLERRM
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_create_admin_customer(text, text, text, text, text, text, text) 
  TO authenticated, anon;
```

---

## 🧪 Casos de Prueba

### Caso 1: Crear Cliente desde Admin
1. Admin abre panel de pedidos
2. Clic en "Crear Cliente"
3. Completa formulario (nombre obligatorio, resto opcional)
4. Guarda
5. **Resultado esperado:** Cliente creado con UUID temporal, `created_by_admin = true`

### Caso 2: Cliente se Registra con Google (con coincidencia)
1. Cliente creado por admin con email `test@example.com`
2. Cliente se registra con Google usando el mismo email
3. Sistema busca coincidencias por email
4. **Resultado esperado:** Vincula el cliente admin-created con la cuenta de Google

### Caso 3: Cliente se Registra sin Coincidencia
1. Cliente se registra con Google (email nuevo)
2. No hay coincidencias en la base
3. **Resultado esperado:** Crea nuevo cliente con `auth.users.id`

---

## 📝 Notas Importantes

1. **Función `generate_customer_number()`:** Se asume que existe. Si no existe, debe crearse o modificarse la función para no requerirla.

2. **RLS Policies:** Pueden necesitar actualizarse para permitir que admins vean/editen clientes admin-created.

3. **Migración de Datos:** Cuando se vincula un cliente admin-created con Google OAuth, los pedidos/carritos existentes deben migrarse al nuevo `customer_id`.

4. **Validación Manual:** Si se usa el enfoque de trigger, debe validarse que los clientes NO admin siempre tengan `id` válido en `auth.users`.

---

## 🔗 Referencias

- Archivos modificados: `scripts/cart-persistent.js`, `admin/order-creator.js`, `admin/orders.html`
- Sistema de autenticación: Google OAuth via Supabase Auth
- Base de datos: PostgreSQL en Supabase
- API: Supabase REST API con funciones RPC

---

## ❓ Preguntas Pendientes

1. ¿La función `generate_customer_number()` existe en la base de datos?
2. ¿Hay otras tablas que referencien `customers.id` con FK que puedan estar causando el problema?
3. ¿Hay triggers o vistas que validen la existencia en `auth.users`?
4. ¿El error viene realmente de la constraint FK o de otro lugar (RLS, trigger, etc.)?

---

**Última actualización:** Después de múltiples intentos, la constraint FK fue eliminada pero el error persiste. Se necesita investigar si:
- Hay caché de Supabase
- La función RPC no se actualizó
- Hay otra validación que no se detectó
