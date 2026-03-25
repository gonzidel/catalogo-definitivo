# Solución: Error 403 al Subir Imágenes

## Problema

Al intentar subir una imagen desde:
- `http://localhost:5500/admin/products.html` (local)
- `https://catalogo-fyl-test.web.app/admin/products.html` (producción)
- `fylmoda.com.ar/admin/products.html` (producción)

Recibes un error **403 (Forbidden)**. Este error indica que la Edge Function `upload-image` está rechazando la solicitud porque no tienes permisos de administrador o hay problemas de configuración.

## Causa

La Edge Function `upload-image` verifica que el usuario sea un **super_admin** antes de permitir la subida de imágenes. Si tu usuario no está configurado como `super_admin` en la tabla `admins`, recibirás este error.

## Solución

### Paso 1: Verificar tu usuario en la tabla admins

1. Ve a **Supabase Dashboard** → **SQL Editor**
2. Ejecuta esta consulta (reemplaza `fylenvios@gmail.com` con tu email):

```sql
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
```

### Paso 2: Agregar o actualizar tu usuario como super_admin

Ejecuta el script completo `supabase/fix_admin_permissions.sql` en el SQL Editor, o ejecuta estos comandos manualmente (reemplaza `fylenvios@gmail.com` con tu email):

```sql
-- Agregar usuario como super_admin si no existe
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
  );

-- Actualizar a super_admin si ya existe pero con otro rol
UPDATE public.admins
SET role = 'super_admin',
    updated_at = now()
WHERE email = 'fylenvios@gmail.com'
  AND role != 'super_admin';
```

### Paso 3: Verificar que funciona

Ejecuta esta consulta para verificar que ahora eres super_admin:

```sql
SELECT public.is_super_admin(auth.uid()) as is_current_user_super_admin;
```

Debería devolver `true`.

### Paso 4: Recargar la página y probar

1. Cierra y vuelve a abrir `http://localhost:5500/admin/products.html`
2. Asegúrate de estar autenticado (deberías ver tu email en la consola)
3. Intenta subir una imagen nuevamente

## Mejoras Implementadas

He mejorado el código para que:

1. **Verifique autenticación y permisos antes de subir**: Ahora el sistema verifica que estés autenticado y que tengas permisos de admin antes de intentar subir imágenes.

2. **Mensajes de error más claros**: Si recibes un error 403, verás un mensaje específico indicando que necesitas permisos de administrador.

3. **Validación previa**: El sistema verifica tus permisos antes de hacer la llamada a la Edge Function, ahorrando tiempo y mostrando errores más claros.

## Verificación Adicional

Si después de seguir estos pasos sigues teniendo problemas:

1. **Verifica que estás autenticado**: Abre la consola del navegador y verifica que veas "✅ Usuario autenticado: tu-email@ejemplo.com"

2. **Verifica la función is_super_admin**: Ejecuta en SQL Editor:
   ```sql
   SELECT public.is_super_admin((SELECT id FROM auth.users WHERE email = 'fylenvios@gmail.com'));
   ```

3. **Revisa los logs de la Edge Function**: Ve a **Supabase Dashboard** → **Edge Functions** → `upload-image` → **Logs** para ver errores detallados.

## Problemas Específicos de Producción

Si el error ocurre **solo en producción** (no en localhost), verifica:

1. **Variables de entorno no configuradas**: 
   - Ve a **Supabase Dashboard** → **Edge Functions** → `upload-image` → **Settings** → **Secrets**
   - Agrega: `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_CLOUD_NAME`
   - **IMPORTANTE**: Después de agregar secrets, debes **redeployar** la función

2. **Edge Function no desplegada**:
   ```bash
   supabase functions deploy upload-image --project-ref dtfznewwvsadkorxwzft
   ```

3. **CORS o autenticación en producción**:
   - Verifica que estés autenticado correctamente en el dominio de producción
   - Revisa la consola del navegador para ver si hay errores de autenticación

Para más detalles sobre configuración en producción, consulta: **`CONFIGURAR_PRODUCCION_UPLOAD.md`**

## Notas

- El email que uses debe coincidir exactamente con el email de tu cuenta de Supabase Auth
- Si cambias de email, necesitarás actualizar la tabla `admins` con el nuevo email
- Solo usuarios con `role = 'super_admin'` pueden subir imágenes
- Las variables de entorno se configuran **por función** en Supabase, no globalmente
- Después de agregar o modificar secrets, **siempre redeploya** la función
