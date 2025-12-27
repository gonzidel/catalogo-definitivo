# Solución: Módulo de Clientes no Funciona

## Problema
El módulo de gestión de clientes (`/admin/customers.html`) muestra "Cargando clientes..." pero no carga los datos.

## Solución Paso a Paso

### Paso 1: Ejecutar el Script SQL de Corrección

1. Abre tu proyecto en Supabase Dashboard
2. Ve a **SQL Editor** → **New query**
3. Copia y pega el contenido completo del archivo:
   ```
   supabase/canonical/36_fix_customers_admin_module.sql
   ```
4. Haz clic en **Run** (o presiona `Ctrl+Enter`)
5. Verifica que no haya errores en la ejecución

### Paso 2: Ejecutar el Script de Diagnóstico (Opcional)

Para verificar que todo esté correcto:

1. En SQL Editor, ejecuta:
   ```
   supabase/canonical/37_diagnose_customers_module.sql
   ```
2. Revisa los resultados y verifica que:
   - ✅ Las políticas RLS estén creadas
   - ✅ La columna `created_by_admin` exista
   - ✅ La función `rpc_create_admin_customer` exista
   - ✅ El trigger `assign_customer_number_trigger` exista

### Paso 3: Verificar en el Navegador

1. Abre `http://localhost:5500/admin/customers.html`
2. Abre la consola del navegador (F12)
3. Busca mensajes de error o advertencias
4. Los mensajes deberían mostrar:
   - ✅ "Usuario autenticado: [tu-email]"
   - ✅ "Usuario es admin: [rol]"
   - ✅ "Datos recibidos: X clientes"

### Paso 4: Si Sigue Sin Funcionar

#### Verificar Errores en la Consola

Si ves errores como:
- `PGRST301` o `permission denied`: Las políticas RLS no están correctas
- `23503` o `foreign key constraint`: La restricción con auth.users no se eliminó
- `column "created_by_admin" does not exist`: El script SQL no se ejecutó completamente

#### Solución Manual Rápida

Si el script SQL falla, ejecuta estos comandos uno por uno:

```sql
-- 1. Agregar columna created_by_admin
ALTER TABLE public.customers 
ADD COLUMN IF NOT EXISTS created_by_admin boolean DEFAULT false;

-- 2. Eliminar restricción de clave foránea (si existe)
ALTER TABLE public.customers 
DROP CONSTRAINT IF EXISTS customers_id_fkey;

-- 3. Crear políticas RLS para admins
DROP POLICY IF EXISTS customers_admin_select ON public.customers;
CREATE POLICY customers_admin_select
ON public.customers FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS customers_admin_insert ON public.customers;
CREATE POLICY customers_admin_insert
ON public.customers FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS customers_admin_update ON public.customers;
CREATE POLICY customers_admin_update
ON public.customers FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()))
WITH CHECK (EXISTS (SELECT 1 FROM public.admins WHERE user_id = auth.uid()));

-- 4. Recargar esquema
SELECT pg_notify('pgrst', 'reload schema');
```

### Paso 5: Verificar que Eres Admin

Asegúrate de que tu usuario esté en la tabla `admins`:

```sql
-- Verificar si eres admin
SELECT 
    a.id,
    a.user_id,
    a.role,
    au.email
FROM public.admins a
JOIN auth.users au ON au.id = a.user_id
WHERE a.user_id = auth.uid();
```

Si no aparece ningún resultado, necesitas agregarte como admin (ver `supabase/canonical/35_add_admin_user.sql`).

## Cambios Realizados en el Código

1. ✅ Eliminada referencia a columna `created_by_admin` inexistente en la consulta
2. ✅ Mejorado el manejo de errores con mensajes más descriptivos
3. ✅ Agregado logging detallado para diagnóstico
4. ✅ Corregida la sintaxis de búsqueda

## Archivos Modificados

- `admin/customers.js` - Mejoras en manejo de errores y logging
- `supabase/canonical/36_fix_customers_admin_module.sql` - Script de corrección completo
- `supabase/canonical/37_diagnose_customers_module.sql` - Script de diagnóstico

## Próximos Pasos

Después de aplicar la solución, deberías poder:
- ✅ Ver la lista de clientes
- ✅ Buscar clientes por nombre, DNI, teléfono, email o número
- ✅ Crear nuevos clientes
- ✅ Editar clientes existentes

