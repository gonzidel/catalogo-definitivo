# ⚠️ IMPORTANTE: Crear función de importación masiva

## Problema

El error `Could not find the function public.rpc_bulk_create_customers` indica que la función RPC no existe en tu base de datos de Supabase.

## Solución

Necesitas ejecutar el script SQL que crea esta función.

### Pasos:

1. **Abre Supabase Dashboard** → Tu proyecto → **SQL Editor**

2. **Crea una nueva query** (New query)

3. **Copia y pega** el contenido del archivo `supabase/canonical/40_bulk_create_customers.sql`

4. **Ejecuta el script** (Run o F5)

5. **Verifica que se creó correctamente:**
   - Deberías ver un mensaje de éxito
   - La función `rpc_bulk_create_customers` debería estar disponible

### Alternativa: Ejecutar directamente

Si prefieres, puedes ejecutar este SQL directamente:

```sql
-- Copia todo el contenido de supabase/canonical/40_bulk_create_customers.sql
-- y ejecútalo en Supabase SQL Editor
```

### Después de ejecutar

Una vez que la función esté creada, podrás ejecutar el script de importación sin errores:

```bash
node scripts/import-customers.js "C:\ruta\a\tu\archivo.csv"
```

o

```bash
node scripts/import-customers-from-sheets.js "URL_DEL_GOOGLE_SHEET"
```

## Nota

Esta función solo necesita crearse **una vez**. Después de crearla, podrás usarla para todas las importaciones futuras.

