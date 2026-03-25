# Sincronizar Pedidos Enviados con Daily Sales

## Problema

Los pedidos en estado "sent" (enviados) no aparecen automáticamente en `daily-sales.html` porque:

1. **El trigger no se ejecuta correctamente**: El trigger `register_envio_to_daily_sales()` debería ejecutarse automáticamente cuando se marca un pedido como enviado, pero puede no estar funcionando correctamente.

2. **Pedidos antiguos sin sincronizar**: Los pedidos que ya estaban en estado "sent" sin `sent_at` establecido o que se marcaron antes de que el trigger funcionara correctamente no tienen registros en `daily_sales`.

## Solución Completa

### Paso 1: Corregir el Trigger (IMPORTANTE - Hacer primero)

Este paso asegura que los **próximos pedidos se carguen automáticamente**:

1. Abre el **SQL Editor** en Supabase
2. Copia y pega el contenido de `supabase/canonical/53_fix_trigger_daily_sales_automatic.sql`
3. Ejecuta el script completo
4. Verifica que aparezcan los mensajes de confirmación

Este script:
- Elimina y recrea el trigger con la versión correcta
- Actualiza la función del trigger para que funcione correctamente
- Verifica que todo esté configurado correctamente

**Después de ejecutar este script, los nuevos pedidos se cargarán automáticamente cuando se marquen como enviados.**

### Paso 2: Sincronizar Pedidos Faltantes

Para sincronizar los pedidos que ya están enviados pero no aparecen en `daily_sales`:

#### Opción 1: Script Simple (Recomendado)

1. Abre el **SQL Editor** en Supabase
2. Copia y pega el contenido de `supabase/canonical/52_quick_sync_day_30.sql`
3. Ejecuta el script completo
4. Verifica los resultados en la última consulta SELECT

Este script:
- Corrige pedidos con `sent_at` NULL del día 30
- Sincroniza todos los pedidos enviados con `daily_sales`
- Muestra los registros creados para el día 30

#### Opción 2: Script Completo con Diagnóstico

Si necesitas más información sobre el estado de los pedidos:

1. Abre el **SQL Editor** en Supabase
2. Copia y pega el contenido de `supabase/canonical/51_sync_daily_sales_day_30.sql`
3. Ejecuta el script completo
4. Revisa cada paso para ver el estado de los pedidos

## Verificación

Después de ejecutar el script:

1. Abre `http://localhost:5500/admin/daily-sales.html`
2. Selecciona la fecha **30/12/2025** en el selector de fecha
3. Deberías ver los 3 pedidos enviados en la tabla de ventas

## Si el Problema Persiste

Si después de ejecutar el script los pedidos aún no aparecen:

1. Verifica que los pedidos tengan `sent_at` establecido:
   ```sql
   SELECT id, order_number, status, sent_at, total_amount
   FROM public.orders
   WHERE status IN ('sent', 'devolución')
     AND sent_at::date = '2025-12-30'
   ORDER BY sent_at DESC;
   ```

2. Verifica que existan registros en `daily_sales`:
   ```sql
   SELECT * FROM public.daily_sales
   WHERE sale_type = 'envios'
     AND sale_date = '2025-12-30'
   ORDER BY sale_time DESC;
   ```

3. Si los pedidos tienen `sent_at` pero no aparecen en `daily_sales`, ejecuta manualmente:
   ```sql
   SELECT rpc_sync_sent_orders_to_daily_sales();
   ```

## Notas Técnicas

- La función `rpc_sync_sent_orders_to_daily_sales()` sincroniza todos los pedidos enviados que no están en `daily_sales`
- El trigger `register_envio_to_daily_sales()` se ejecuta automáticamente cuando se marca un pedido como enviado
- Los pedidos con status "devolución" también se registran en `daily_sales` como envíos

## Archivos Creados

- `supabase/canonical/61_DIAGNOSTICO_TRIGGER_COMPLETO.sql` - **EJECUTAR PRIMERO**: Diagnóstico completo para entender el problema
- `supabase/canonical/60_FIX_RLS_TRIGGER.sql` - **CRÍTICO - EJECUTAR SEGUNDO**: Corrige la política RLS que bloquea inserciones desde triggers
- `supabase/canonical/57_TRIGGER_SIMPLE_FUNCIONAL.sql` - **EJECUTAR SEGUNDO**: Solución definitiva basada en el trigger original que funcionaba
- `supabase/canonical/59_TEST_TRIGGER_DIRECTO.sql` - **OPCIONAL**: Prueba el trigger directamente para verificar que funcione
- `supabase/canonical/58_DIAGNOSTICO_PEDIDOS.sql` - **DIAGNÓSTICO**: Muestra todos los pedidos recientes para entender el problema
- `supabase/canonical/55_sync_today_orders.sql` - Sincroniza pedidos de HOY (busca por sent_at O updated_at de hoy)
- `supabase/canonical/54_test_trigger_daily_sales.sql` - Verifica que el trigger esté funcionando correctamente
- `supabase/canonical/53_fix_trigger_daily_sales_automatic.sql` - Versión anterior (usar 56_FIX_TRIGGER_DEFINITIVO.sql en su lugar)
- `supabase/canonical/52_quick_sync_day_30.sql` - Script simple para sincronizar pedidos faltantes del día 30

## Orden de Ejecución (SOLUCIÓN DEFINITIVA - ACTUALIZADA)

### Paso 1: Diagnóstico Completo (PRIMERO - Para entender el problema)

**Ejecuta `61_DIAGNOSTICO_TRIGGER_COMPLETO.sql`** - Este script te mostrará:
- Si el trigger está activo
- Si la política RLS está correcta
- Prueba el trigger manualmente y te dice si funciona
- Te indica exactamente dónde está el problema

### Paso 2: Corregir Política RLS (CRÍTICO - Hacer después del diagnóstico)

**Ejecuta `60_FIX_RLS_TRIGGER.sql`** - Este es el paso MÁS IMPORTANTE
- Corrige la política RLS que estaba bloqueando las inserciones desde el trigger
- Permite inserciones cuando `created_by` es NULL (normal en triggers con SECURITY DEFINER)
- También permite operaciones de admins autenticados
- **SIN ESTE PASO, EL TRIGGER NO FUNCIONARÁ**

### Paso 3: Asegurar Trigger Activo

**Ejecuta `57_TRIGGER_SIMPLE_FUNCIONAL.sql`**
- Reemplaza el trigger con una versión simple y funcional
- Basado en el trigger original que funcionaba, pero con el cálculo del monto corregido
- Incluye logs de debugging y manejo de errores robusto
- Se ejecuta siempre que `status = 'sent'` y `sent_at IS NOT NULL`

### Paso 4: Probar el Trigger

**Ejecuta `59_TEST_TRIGGER_DIRECTO.sql`** (opcional, para verificar)
- Prueba el trigger directamente
- Simula lo que hace `rpc_mark_order_as_sent`
- Verifica que se crea el registro en `daily_sales`
- Revierte el cambio para que puedas probarlo manualmente

### Paso 5: Sincronizar Pedidos Faltantes (si es necesario)

**Ejecuta `55_sync_today_orders.sql`** para sincronizar pedidos de HOY que ya finalizaste
- Busca pedidos por `sent_at` de hoy O por `updated_at` de hoy
- Corrige automáticamente pedidos que tienen status 'sent' pero `sent_at` es NULL
- Inserta los pedidos que faltan en `daily_sales`

3. **Verificar**: 
   - Recarga `daily-sales.html` y verifica que aparecen los pedidos de hoy
   - Finaliza un pedido NUEVO y verifica que aparece automáticamente sin necesidad de ejecutar scripts

## Si los Pedidos No Aparecen Después de Finalizarlos

Si finalizas pedidos y no aparecen en `daily-sales.html`:

1. **Ejecuta el diagnóstico**: `58_DIAGNOSTICO_PEDIDOS.sql`
   - Este script te mostrará qué pedidos existen y por qué no se están reconociendo
   - Revisa si los pedidos tienen `sent_at` o si el problema es otro

2. **Ejecuta el script de sincronización de hoy**: `55_sync_today_orders.sql`
   - Este script ahora busca pedidos por `sent_at` de hoy O por `updated_at` de hoy
   - Corrige automáticamente pedidos con `sent_at` NULL
   - Inserta los pedidos que faltan en `daily_sales`
   
3. **Verifica el trigger**: Ejecuta `54_test_trigger_daily_sales.sql`
   - Este script verifica que el trigger esté activo y funcionando
   
4. **Recarga la página**: Después de ejecutar los scripts, recarga `daily-sales.html`

