# 🔐 Solución para Problemas de Login en el Admin

## Problema Identificado

El login en el área de administración (`https://catalogo-fyl-test.web.app/admin/index.html`) no está funcionando correctamente.

## Causas Posibles

1. **URLs de redirección no configuradas en Supabase** - El nuevo dominio `catalogo-fyl-test.web.app` no está en la lista de URLs permitidas
2. **Usuario no registrado** - El usuario no existe en Supabase o las credenciales son incorrectas
3. **Configuración de autenticación** - Problemas con la configuración de email/password o OAuth

## Solución Paso a Paso

### 1. Configurar URLs de Redirección en Supabase

1. Ve a tu proyecto en [Supabase Dashboard](https://supabase.com/dashboard)
2. Navega a **Authentication** → **URL Configuration**
3. En la sección **Site URL**, agrega:
   ```
   https://catalogo-fyl-test.web.app
   ```
4. En **Redirect URLs**, agrega las siguientes URLs (una por línea):
   ```
   https://catalogo-fyl-test.web.app/admin/index.html
   https://catalogo-fyl-test.web.app/admin/**
   https://catalogo-fyl-test.web.app/client/dashboard.html
   https://catalogo-fyl-test.web.app/client/**
   https://catalogo-fyl-test.web.app/**
   ```
5. Haz clic en **Save**

### 2. Verificar que el Usuario Exista

#### Opción A: Si ya tienes cuenta

1. Intenta hacer login con tus credenciales existentes
2. Si olvidaste la contraseña, usa el botón "Olvidé mi contraseña"

#### Opción B: Si necesitas crear una cuenta nueva

1. En la página de login del admin, haz clic en "Registrarme (dev)"
2. Completa el formulario con tu email y contraseña
3. **IMPORTANTE**: Después de registrarte, un super administrador debe autorizarte como colaborador desde la página de Colaboradores

### 3. Si el Usuario se Registró con Google

Si te registraste usando Google OAuth en el área de clientes, necesitas establecer una contraseña para poder hacer login en el admin:

1. Ve al área de clientes: `https://catalogo-fyl-test.web.app/client/dashboard.html`
2. En tu perfil, busca la opción para establecer una contraseña
3. O solicita un reset de contraseña desde el admin

### 4. Verificar Configuración de Email en Supabase

1. Ve a **Authentication** → **Email Templates** en Supabase
2. Verifica que los templates estén configurados correctamente
3. Si usas un proveedor de email externo (SendGrid, Mailgun, etc.), verifica que esté configurado en **Settings** → **Auth** → **SMTP Settings**

### 5. Verificar Configuración de OAuth (si usas Google)

Si quieres usar Google OAuth también en el admin:

1. Ve a **Authentication** → **Providers** en Supabase
2. Verifica que Google esté habilitado
3. Verifica que las credenciales de Google OAuth estén configuradas
4. En **Redirect URLs**, agrega:
   ```
   https://catalogo-fyl-test.web.app/admin/index.html
   ```

## Verificación Rápida

1. Abre la consola del navegador (F12)
2. Intenta hacer login
3. Revisa los mensajes de error en la consola
4. Los errores comunes son:
   - `Invalid login credentials` - Usuario/contraseña incorrectos o usuario no existe
   - `Email not confirmed` - Necesitas confirmar tu email
   - `Redirect URL not allowed` - Falta configurar la URL en Supabase

## Solución Rápida: Crear Super Admin Directamente

Si tienes acceso a la base de datos de Supabase, puedes crear un super admin directamente:

```sql
-- 1. Primero crea el usuario en Supabase Auth (desde el dashboard)
-- 2. Luego ejecuta esto en SQL Editor de Supabase:

INSERT INTO public.admins (user_id, email, role, created_at)
VALUES (
  'ID_DEL_USUARIO_AQUI',  -- Reemplaza con el ID del usuario de Supabase Auth
  'tu-email@ejemplo.com',  -- Reemplaza con tu email
  'super_admin',
  NOW()
)
ON CONFLICT (user_id) DO UPDATE
SET role = 'super_admin';
```

Para obtener el ID del usuario:
1. Ve a **Authentication** → **Users** en Supabase
2. Busca tu usuario
3. Copia el **User UID**

## Contacto

Si el problema persiste después de seguir estos pasos, verifica:
- Que `config.local.js` tenga las credenciales correctas de Supabase
- Que la conexión a internet funcione correctamente
- Que no haya bloqueadores de contenido o extensiones que interfieran

