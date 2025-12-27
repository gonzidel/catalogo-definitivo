# Corrección de Search Path Mutable en Funciones

Este documento explica cómo corregir las advertencias de seguridad relacionadas con `search_path` mutable en funciones de PostgreSQL/Supabase.

## 🔴 Problema: Function Search Path Mutable

### ¿Qué es el problema?

Las funciones de PostgreSQL que no tienen `search_path` configurado son vulnerables a ataques de inyección SQL mediante la manipulación del `search_path`. Un atacante podría crear esquemas maliciosos y hacer que las funciones ejecuten código no deseado.

### ¿Por qué es importante?

- **Seguridad**: Previene ataques de inyección SQL
- **Confiabilidad**: Asegura que las funciones siempre busquen objetos en los esquemas correctos
- **Mejores prácticas**: Es una recomendación estándar de seguridad en PostgreSQL

## ✅ Solución

### Opción 1: Script Automático (Recomendado)

Ejecuta el script `supabase/fix_all_functions_search_path.sql` que actualiza automáticamente todas las funciones:

```sql
-- Este script agrega SET search_path = public, pg_catalog a todas las funciones
-- que no lo tienen configurado
```

**Pasos:**
1. Abre Supabase Dashboard → SQL Editor
2. Copia y pega el contenido de `supabase/fix_all_functions_search_path.sql`
3. Ejecuta el script
4. Revisa el resumen de funciones actualizadas

### Opción 2: Actualización Manual

Si prefieres actualizar funciones específicas manualmente, agrega `SET search_path` a cada función:

**Antes:**
```sql
CREATE OR REPLACE FUNCTION public.mi_funcion()
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
BEGIN
  -- código de la función
END $$;
```

**Después:**
```sql
CREATE OR REPLACE FUNCTION public.mi_funcion()
RETURNS void 
LANGUAGE plpgsql 
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  -- código de la función
END $$;
```

## 📋 Funciones que Necesitan Corrección

Según las advertencias detectadas, estas son algunas de las funciones que necesitan corrección:

### Funciones de Carrito y Pedidos
- `rpc_get_or_create_cart`
- `rpc_reserve_item`
- `rpc_submit_cart`
- `rpc_admin_set_item_status`
- `rpc_close_cart`
- `get_or_create_user_cart`
- `get_user_cart`
- `get_cart_items_simple`
- `add_cart_item`
- `remove_cart_item`
- `update_cart_item_quantity`
- `clear_cart_items`
- `clear_user_cart`
- `get_cart_summary`
- `change_cart_status`
- `sync_cart_from_local`
- `get_user_cart_complete`

### Funciones de Productos e Imágenes
- `get_product_image`
- `get_product_image_any_color`
- `get_product_images`
- `get_effective_price`
- `get_active_promotions_for_variants`

### Funciones de Clientes
- `generate_customer_number`
- `assign_customer_number`
- `assign_customer_numbers_to_existing`
- `rpc_create_public_customer`
- `rpc_search_public_customer`
- `rpc_get_customer_credits`
- `rpc_get_customer_total_credit`
- `rpc_add_customer_credit`
- `rpc_add_return_credit`
- `rpc_get_customer_sales_history`

### Funciones de Pedidos y Ventas
- `generate_order_number`
- `generate_sale_number`
- `assign_order_number`
- `assign_order_numbers_to_existing`
- `rpc_create_public_sale`
- `rpc_get_public_sales_history`
- `rpc_get_public_sale_details`
- `rpc_update_order_item_status`
- `rpc_close_order`
- `rpc_mark_order_as_sent`
- `rpc_cancel_order_item`
- `has_all_items_picked`

### Funciones de Utilidades
- `set_updated_at` (trigger function)
- `set_timestamp_orders`
- `has_permission`
- `get_order_number_config`
- `get_total_stock`
- `get_variant_stock_by_warehouse`
- `rpc_move_stock`
- `rpc_checkout_cart`
- `rpc_get_user_emails`
- `rpc_cleanup_expired_credits`
- `populate_existing_customer_emails`
- `sync_cart_item_quantities`

## 🔍 Verificación Post-Corrección

Después de ejecutar el script, verifica que las funciones estén correctamente configuradas:

```sql
SELECT 
    p.proname AS function_name,
    pg_get_function_identity_arguments(p.oid) AS function_args,
    CASE 
        WHEN array_to_string(p.proconfig, ',') LIKE '%search_path%' 
        THEN '✅ Configurado'
        ELSE '❌ NO configurado'
    END AS status
FROM pg_proc p
JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public'
AND p.prokind = 'f'
ORDER BY p.proname;
```

## 🔐 Protección de Contraseñas Filtradas

Además de las funciones, también hay una advertencia sobre protección de contraseñas filtradas. Para activarla:

1. Ve a **Supabase Dashboard → Authentication → Settings**
2. Busca la sección **Password**
3. Activa **"Check for compromised passwords"**
4. Esto habilitará la verificación contra HaveIBeenPwned.org

## 📝 Archivos Actualizados

- ✅ `supabase/fix_all_functions_search_path.sql` - Script automático completo
- ✅ `supabase/canonical/05_orders.sql` - Funciones de pedidos actualizadas

## ⚠️ Notas Importantes

1. **No rompe funcionalidad**: Agregar `SET search_path` no cambia el comportamiento de las funciones, solo mejora la seguridad.

2. **Idempotente**: El script se puede ejecutar múltiples veces sin problemas.

3. **Compatibilidad**: `SET search_path = public, pg_catalog` es compatible con todas las funciones estándar de PostgreSQL.

4. **Funciones de sistema**: `pg_catalog` se incluye para asegurar acceso a funciones del sistema de PostgreSQL.

## 🚨 Si algo sale mal

Si encuentras errores al ejecutar el script:

1. **Revisa los mensajes de error** en la salida del script
2. **Verifica que las funciones existan**:
   ```sql
   SELECT proname FROM pg_proc WHERE proname = 'nombre_funcion';
   ```
3. **Actualiza manualmente** las funciones que fallaron usando la Opción 2

## 📚 Referencias

- [Supabase Database Linter - Function Search Path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
- [PostgreSQL SET search_path Documentation](https://www.postgresql.org/docs/current/sql-createfunction.html)
- [OWASP SQL Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html)

---

**Última actualización**: Script creado para corregir todas las advertencias de search_path mutable.

