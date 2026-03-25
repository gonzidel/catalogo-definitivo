# Diagnóstico: Error 403 en Producción (Credenciales Correctas)

## Situación

Las credenciales de Cloudinary están configuradas correctamente y antes funcionaba, pero ahora recibes error 403 al intentar subir imágenes desde producción.

## Posibles Causas

### 1. Sesión de Autenticación Expirada

**Síntoma:** Error 401 o 403, especialmente después de un tiempo sin usar la aplicación.

**Solución:**
1. Recarga la página completamente (Ctrl+F5 o Cmd+Shift+R)
2. Cierra sesión y vuelve a iniciar sesión
3. Verifica que veas tu email en la consola: `✅ Usuario autenticado: tu-email@ejemplo.com`

**Verificación en consola:**
```javascript
// Ejecutar en la consola del navegador
const { data: { session } } = await supabase.auth.getSession();
console.log("Sesión activa:", !!session);
console.log("Usuario:", session?.user?.email);
console.log("Token expira:", session?.expires_at ? new Date(session.expires_at * 1000) : 'N/A');
```

### 2. Usuario No es Super Admin

**Síntoma:** Error 403 con mensaje "No tienes permisos de administrador"

**Solución:**
Ejecuta en Supabase SQL Editor (reemplaza el email):

```sql
-- Verificar si eres super_admin
SELECT 
  u.email,
  a.role,
  CASE 
    WHEN a.role = 'super_admin' THEN '✅ Es super_admin'
    ELSE '❌ No es super_admin'
  END as status
FROM auth.users u
LEFT JOIN public.admins a ON a.user_id = u.id
WHERE u.email = 'tu-email@ejemplo.com';

-- Si no eres super_admin, agregarte
INSERT INTO public.admins (user_id, email, role, created_at, updated_at)
SELECT 
  u.id,
  u.email,
  'super_admin',
  now(),
  now()
FROM auth.users u
WHERE u.email = 'tu-email@ejemplo.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.admins a WHERE a.user_id = u.id
  )
ON CONFLICT (user_id) DO UPDATE
SET role = 'super_admin',
    updated_at = now();
```

### 3. Token No Se Está Enviando Correctamente

**Síntoma:** Error 401 o 403, pero estás autenticado en la página.

**Solución:**
El código ahora verifica y refresca el token automáticamente antes de subir. Si el problema persiste:

1. Abre la consola del navegador (F12)
2. Ve a la pestaña **Network** (Red)
3. Intenta subir una imagen
4. Busca la petición a `upload-image`
5. Revisa los **Headers** de la petición
6. Verifica que haya un header `Authorization: Bearer ...`

**Si no hay header Authorization:**
- El cliente de Supabase no se inicializó correctamente
- Recarga la página completamente
- Verifica que `scripts/supabase-client.js` se cargue correctamente

### 4. Edge Function No Tiene las Variables de Entorno

**Síntoma:** Error 500 con mensaje sobre credenciales de Cloudinary.

**Solución:**
1. Ve a **Supabase Dashboard** → **Edge Functions** → `upload-image` → **Settings** → **Secrets**
2. Verifica que existan:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
3. Si faltan, agrégalas
4. **IMPORTANTE:** Después de agregar secrets, redeploya la función:
   ```bash
   supabase functions deploy upload-image --project-ref dtfznewwvsadkorxwzft
   ```

### 5. Problema con el Dominio de Producción

**Síntoma:** Funciona en localhost pero no en producción.

**Posibles causas:**
- CORS no configurado correctamente
- El dominio no está permitido en Supabase
- Problemas con cookies/localStorage en producción

**Solución:**
1. Verifica que el dominio esté en la lista de dominios permitidos en Supabase (si aplica)
2. Revisa la consola del navegador para errores de CORS
3. Prueba en modo incógnito para descartar problemas de cache/cookies

## Diagnóstico Paso a Paso

### Paso 1: Verificar Autenticación

Ejecuta en la consola del navegador (en la página de admin):

```javascript
// Verificar autenticación
const { data: { user }, error: userError } = await supabase.auth.getUser();
console.log("Usuario:", user?.email);
console.log("Error:", userError);

// Verificar sesión
const { data: { session }, error: sessionError } = await supabase.auth.getSession();
console.log("Sesión activa:", !!session);
console.log("Error de sesión:", sessionError);
```

**Resultado esperado:**
- `Usuario: tu-email@ejemplo.com`
- `Error: null`
- `Sesión activa: true`

### Paso 2: Verificar Permisos de Admin

```javascript
// Verificar permisos
const { data: { user } } = await supabase.auth.getUser();
const { data: isAdmin, error: adminError } = await supabase
  .rpc("is_super_admin", { check_user_id: user.id });
console.log("Es super_admin:", isAdmin);
console.log("Error:", adminError);
```

**Resultado esperado:**
- `Es super_admin: true`
- `Error: null`

### Paso 3: Verificar Cliente de Supabase

```javascript
// Verificar cliente
console.log("Supabase disponible:", !!supabase);
console.log("Tiene funciones:", typeof supabase.functions?.invoke === 'function');
```

**Resultado esperado:**
- `Supabase disponible: true`
- `Tiene funciones: true`

### Paso 4: Probar Llamada a Edge Function

```javascript
// Probar llamada (sin subir archivo)
const { data, error } = await supabase.functions.invoke("upload-image", {
  body: {
    variant_id: "test-id",
    file: "data:image/jpeg;base64,test",
    category: "test",
    sku_base: "test",
    color: "test",
    position: 1,
  },
});
console.log("Respuesta:", data);
console.log("Error:", error);
```

Esto debería fallar con un error específico que te dirá qué está mal (variant_id inválido, permisos, etc.).

## Soluciones Rápidas

### Solución 1: Refrescar Sesión

1. Cierra sesión completamente
2. Recarga la página (Ctrl+F5)
3. Inicia sesión nuevamente
4. Intenta subir la imagen

### Solución 2: Limpiar Cache y Cookies

1. Abre la consola (F12)
2. Ve a **Application** (Aplicación) → **Storage** (Almacenamiento)
3. Haz clic en **Clear site data** (Limpiar datos del sitio)
4. Recarga la página
5. Inicia sesión nuevamente

### Solución 3: Verificar en Modo Incógnito

1. Abre la página en modo incógnito
2. Inicia sesión
3. Intenta subir una imagen
4. Si funciona en incógnito, el problema es cache/cookies

## Revisar Logs de la Edge Function

1. Ve a **Supabase Dashboard** → **Edge Functions** → `upload-image` → **Logs**
2. Intenta subir una imagen
3. Revisa los logs inmediatamente después
4. Busca mensajes de error específicos:
   - `❌ Cloudinary credentials no están configuradas` → Falta configurar secrets
   - `Error verificando admin:` → Problema con `is_super_admin`
   - `No autorizado` → Problema de autenticación
   - `No tienes permisos de administrador` → Usuario no es super_admin

## Cambios Recientes en el Código

He mejorado el código para que:

1. **Verifique la sesión antes de subir** - Evita errores de sesión expirada
2. **Refresque el token automáticamente** - Si está cerca de expirar, lo refresca
3. **Mejore los mensajes de error** - Te dice exactamente qué está mal
4. **Agregue diagnóstico** - Logs útiles en la consola

**IMPORTANTE:** Después de estos cambios, asegúrate de:
- Recargar la página completamente
- Verificar que el nuevo código se haya cargado (revisa la consola)
- Probar nuevamente la subida de imágenes

## Si Nada Funciona

1. **Revisa los logs de la Edge Function** en tiempo real mientras intentas subir
2. **Revisa la consola del navegador** para mensajes de error específicos
3. **Comparte los logs** con el mensaje de error exacto que aparece
4. **Verifica que la Edge Function esté desplegada** con la última versión
