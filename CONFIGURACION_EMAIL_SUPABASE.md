# Configuración de Email en Supabase

## Problema: Los correos de confirmación no se están enviando

Si al registrarte como desarrollador no recibes el correo de confirmación, sigue estos pasos:

### Opción 1: Deshabilitar confirmación de email (Recomendado para desarrollo)

1. Ve a tu proyecto en Supabase Dashboard
2. Navega a **Authentication** → **Settings**
3. Busca la sección **"Email Auth"**
4. **Desactiva** la opción **"Enable email confirmations"**
5. Guarda los cambios

Con esto, los usuarios podrán iniciar sesión inmediatamente después de registrarse, sin necesidad de confirmar el email.

### Opción 2: Configurar SMTP personalizado (Para producción)

Si necesitas que los emails se envíen realmente:

1. Ve a **Authentication** → **Settings** → **SMTP Settings**
2. Configura un proveedor de email SMTP:
   - **Gmail**: Requiere una "App Password" de Google
   - **SendGrid**: Requiere una API key
   - **Mailgun**: Requiere credenciales de API
   - **Otro proveedor SMTP**: Configura con tus credenciales

3. **Habilita** "Enable email confirmations" si lo desactivas

### Opción 3: Verificar configuración de Email Templates

1. Ve a **Authentication** → **Email Templates**
2. Verifica que las plantillas de email estén configuradas correctamente
3. Asegúrate de que el template "Confirm signup" tenga el contenido correcto

### Verificación rápida

Para verificar si el problema es de configuración:

1. Intenta registrarte con un email válido
2. Revisa la consola del navegador (F12) para ver si hay errores
3. Revisa los logs de Supabase en **Logs** → **Auth Logs** para ver si hay errores al enviar el email

### Nota importante

- En el **plan gratuito de Supabase**, el envío de emails puede tener limitaciones
- Para desarrollo local, es recomendable **deshabilitar la confirmación de email**
- Para producción, configura un **SMTP personalizado** para garantizar la entrega de emails


