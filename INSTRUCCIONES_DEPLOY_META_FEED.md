# Instrucciones para Desplegar Edge Function meta-feed

## Paso a Paso en Supabase Dashboard

### 1. Crear la función

1. Ve a [Supabase Dashboard](https://supabase.com/dashboard)
2. Selecciona tu proyecto
3. En el menú lateral, ve a **Edge Functions**
4. Haz clic en **Create a new function** (botón verde)
5. **Nombre de la función:** `meta-feed` (importante: debe ser exactamente este nombre)
6. Haz clic en **Create function**

### 2. Copiar el código

1. Abre el archivo `supabase/functions/meta-feed/index.ts` en tu editor
2. Selecciona TODO el contenido (Ctrl+A)
3. Cópialo (Ctrl+C)
4. En Supabase Dashboard, en el editor de código de la función `meta-feed`
5. Reemplaza TODO el contenido por defecto con el código copiado
6. Haz clic en **Deploy** (botón verde arriba a la derecha)

### 3. Configuración importante

Después de desplegar, ve a la pestaña **Settings** de la función:

1. **Verify JWT with legacy secret:** Debe estar **OFF** (toggle apagado/gris)
   - Esto permite que la función sea accesible sin JWT obligatorio
   - El código ya maneja la autenticación internamente

2. **Variables de entorno** (opcional, en Settings → Secrets):
   - `META_FEED_TOKEN`: Token opcional para proteger el feed
   - `BASE_URL`: URL base para los links (ej: `https://fylmoda.com.ar`)

### 4. Verificar que funciona

1. Ve a la pestaña **Invoke** de la función
2. Prueba con este comando cURL (reemplaza `SUPABASE_ANON_KEY` con tu clave):

```bash
curl -L -X GET 'https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/meta-feed?format=json&limit=5' \
-H 'apikey: TU_SUPABASE_ANON_KEY'
```

Deberías recibir un JSON con datos del feed.

### 5. Probar desde el admin

1. Abre `http://localhost:5500/admin/meta-feed.html`
2. Abre la consola del navegador (F12)
3. Haz clic en "Probar feed (preview)"
4. Deberías ver datos en lugar de errores CORS

## Si ya creaste "dynamic-endpoint" por error

Puedes:
- **Opción A:** Eliminarla y crear `meta-feed` correctamente
- **Opción B:** Renombrarla a `meta-feed` (pero el slug no cambia, mejor crear una nueva)

## Nota sobre el nombre

El nombre de la función debe ser **exactamente** `meta-feed` (con guión, sin espacios, minúsculas) porque:
- La URL será: `https://...supabase.co/functions/v1/meta-feed`
- El código del admin busca esa URL específica

