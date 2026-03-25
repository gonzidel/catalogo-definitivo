# Configurar Subida de Imágenes en Producción

## Problema

Al intentar subir imágenes desde los dominios de producción (`https://catalogo-fyl-test.web.app/` o `fylmoda.com.ar`), recibes un error **403 (Forbidden)** o **500 (Internal Server Error)**.

## Causas Comunes

1. **Variables de entorno no configuradas**: La Edge Function necesita las credenciales de Cloudinary
2. **Usuario no es super_admin**: El usuario debe estar en la tabla `admins` con `role = 'super_admin'`
3. **Edge Function no desplegada**: La función debe estar desplegada en Supabase

## Solución Paso a Paso

### Paso 1: Configurar Variables de Entorno en Supabase

1. Ve a **Supabase Dashboard** → **Edge Functions** → `upload-image`
2. Haz clic en **Settings** (o **Secrets**)
3. Agrega las siguientes variables de entorno:

```
CLOUDINARY_CLOUD_NAME=dnuedzuzm
CLOUDINARY_API_KEY=tu_api_key_de_cloudinary
CLOUDINARY_API_SECRET=tu_api_secret_de_cloudinary
```

**Cómo obtener las credenciales de Cloudinary:**
- Ve a [Cloudinary Dashboard](https://console.cloudinary.com/)
- Ve a **Settings** → **Security**
- Copia `API Key` y `API Secret`

### Paso 2: Verificar que el Usuario es Super Admin

Ejecuta este script en **Supabase SQL Editor** (reemplaza `fylenvios@gmail.com` con tu email):

```sql
-- Verificar si eres super_admin
SELECT 
  u.id as user_id,
  u.email,
  a.role,
  CASE 
    WHEN a.role = 'super_admin' THEN '✅ Es super_admin'
    WHEN a.role IS NOT NULL THEN '⚠️ Es admin pero no super_admin'
    ELSE '❌ No es admin'
  END as status
FROM auth.users u
LEFT JOIN public.admins a ON a.user_id = u.id
WHERE u.email = 'fylenvios@gmail.com';

-- Si no eres super_admin, agregarte o actualizarte
INSERT INTO public.admins (user_id, email, role, created_at, updated_at)
SELECT 
  u.id,
  u.email,
  'super_admin',
  now(),
  now()
FROM auth.users u
WHERE u.email = 'fylenvios@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM public.admins a WHERE a.user_id = u.id
  )
ON CONFLICT (user_id) DO UPDATE
SET role = 'super_admin',
    updated_at = now();
```

### Paso 3: Desplegar la Edge Function

**Opción A: Desde Terminal (Recomendado)**

```bash
# Asegúrate de tener Supabase CLI instalado
supabase login

# Desplegar la función
supabase functions deploy upload-image --project-ref dtfznewwvsadkorxwzft
```

**Opción B: Desde Supabase Dashboard**

1. Ve a **Edge Functions** → `upload-image`
2. Si hay un botón **"Redeploy"** o **"Deploy"**, haz clic en él
3. O edita el código directamente en el dashboard y guarda

### Paso 4: Verificar que las Variables de Entorno Están Configuradas

Después de desplegar, verifica los logs:

1. Ve a **Edge Functions** → `upload-image` → **Logs**
2. Intenta subir una imagen
3. Revisa los logs - NO deberías ver:
   - `❌ Cloudinary credentials no están configuradas`
   - `CLOUDINARY_API_KEY: ❌ Faltante`
   - `CLOUDINARY_API_SECRET: ❌ Faltante`

Si ves estos mensajes, las variables de entorno no están configuradas correctamente.

### Paso 5: Probar en Producción

1. Abre `https://catalogo-fyl-test.web.app/admin/products.html` (o tu dominio)
2. Asegúrate de estar autenticado (deberías ver tu email en la consola)
3. Intenta subir una imagen
4. Revisa la consola del navegador para ver mensajes de error específicos

## Diagnóstico de Errores

### Error 403: "No tienes permisos de administrador"

**Solución:**
- Ejecuta el script SQL del Paso 2 para agregarte como `super_admin`
- Verifica que tu email coincida exactamente con el de tu cuenta de Supabase Auth

### Error 500: "Cloudinary credentials no están configuradas"

**Solución:**
- Ve a **Edge Functions** → `upload-image` → **Settings** → **Secrets**
- Agrega `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET`
- Redeploya la función después de agregar los secrets

### Error 401: "No autorizado" o "No autenticado"

**Solución:**
- Asegúrate de estar autenticado en la aplicación
- Recarga la página y vuelve a iniciar sesión
- Verifica que el token de autenticación se esté enviando correctamente

### Error 404: "variant_id no válido o no existe"

**Solución:**
- Asegúrate de que la variante exista en la base de datos
- Completa los campos requeridos (categoría, SKU base, color) antes de subir imágenes

## Verificación Final

Ejecuta este script en la consola del navegador (en la página de admin):

```javascript
// Verificar autenticación
const { data: { user } } = await supabase.auth.getUser();
console.log("Usuario:", user?.email);

// Verificar permisos de admin
const { data: isAdmin, error } = await supabase
  .rpc("is_super_admin", { check_user_id: user.id });
console.log("Es super_admin:", isAdmin);
console.log("Error:", error);
```

Deberías ver:
- `Usuario: tu-email@ejemplo.com`
- `Es super_admin: true`
- `Error: null`

## Checklist

- [ ] Variables de entorno de Cloudinary configuradas en Supabase
- [ ] Usuario agregado como `super_admin` en la tabla `admins`
- [ ] Edge Function desplegada correctamente
- [ ] Usuario autenticado en la aplicación de producción
- [ ] Logs de la Edge Function no muestran errores de configuración
- [ ] Prueba de subida de imagen exitosa

## Notas Importantes

- Las variables de entorno se configuran **por función**, no globalmente
- Después de agregar o modificar secrets, debes **redeployar** la función
- El email debe coincidir exactamente con el de tu cuenta de Supabase Auth
- Solo usuarios con `role = 'super_admin'` pueden subir imágenes

## Soporte Adicional

Si después de seguir estos pasos el problema persiste:

1. Revisa los logs de la Edge Function en tiempo real
2. Revisa la consola del navegador para mensajes de error específicos
3. Verifica que todas las variables de entorno estén configuradas correctamente
4. Asegúrate de que la función esté desplegada en la última versión
