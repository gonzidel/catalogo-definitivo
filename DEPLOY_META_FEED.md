# Desplegar Edge Function meta-feed

## Problema actual
La Edge Function `meta-feed` no está desplegada o tiene problemas de CORS, causando errores al acceder desde `http://localhost:5500`.

## Solución: Desplegar la Edge Function

### Opción 1: Usando Supabase CLI (Recomendado)

```bash
# Desde la raíz del proyecto
supabase functions deploy meta-feed
```

### Opción 2: Desde Supabase Dashboard

1. Ve a tu proyecto en [Supabase Dashboard](https://supabase.com/dashboard)
2. Navega a **Edge Functions**
3. Haz clic en **Create a new function** o busca `meta-feed` si ya existe
4. Nombre: `meta-feed`
5. Copia y pega el contenido completo de `supabase/functions/meta-feed/index.ts`
6. Haz clic en **Deploy**

### Opción 3: Verificar que la función existe

Si la función ya está desplegada pero no funciona:

1. Ve a **Edge Functions** en el dashboard
2. Verifica que `meta-feed` esté activa
3. Revisa los logs para ver errores
4. Actualiza/redespliega la función con el código actualizado

## Verificar que funciona

Después de desplegar, prueba:

1. Abre `http://localhost:5500/admin/meta-feed.html`
2. Abre la consola del navegador (F12)
3. Haz clic en "Probar feed (preview)"
4. Deberías ver datos en lugar de errores CORS

## Si el error persiste

1. **Verifica la URL de la función:**
   - Debe ser: `https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/meta-feed`
   - Verifica en el dashboard que la función esté activa

2. **Verifica CORS:**
   - El código ya incluye whitelist para `http://localhost:5500`
   - Verifica que el handler OPTIONS esté respondiendo correctamente

3. **Verifica variables de entorno:**
   - En Supabase Dashboard → Edge Functions → Settings
   - Verifica que `SUPABASE_URL` y `SERVICE_ROLE_KEY` estén configuradas
   - Opcional: `META_FEED_TOKEN` y `BASE_URL`

4. **Revisa logs:**
   - En Supabase Dashboard → Edge Functions → `meta-feed` → Logs
   - Busca errores específicos

