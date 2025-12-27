# Instrucciones de Deploy - Passkeys/WebAuthn

## 1. Ejecutar SQL Migration

Ejecutar el archivo `supabase/canonical/29_passkeys_webauthn.sql` en el Supabase SQL Editor:

1. Ir a Supabase Dashboard → SQL Editor
2. Crear nueva query
3. Copiar y pegar el contenido de `supabase/canonical/29_passkeys_webauthn.sql`
4. Ejecutar la query

Esto creará:
- Tabla `public.passkeys`
- Tabla `public.webauthn_challenges`
- RLS policies
- RPC function `rpc_get_user_id_by_email`

## 2. Configurar Secrets en Supabase CLI

Ejecutar los siguientes comandos (reemplazar con tus valores reales):

```bash
supabase secrets set SUPABASE_URL=https://dtfznewwvsadkorxwzft.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=tu_service_role_key_aqui
supabase secrets set RP_ID=fylmoda.com.ar
supabase secrets set ORIGIN_PROD=https://fylmoda.com.ar
supabase secrets set ORIGIN_DEV=http://localhost:5500
```

**Nota:** Para obtener `SUPABASE_SERVICE_ROLE_KEY`:
1. Ir a Supabase Dashboard → Settings → API
2. Copiar "service_role" key (secret)

## 3. Deploy Edge Function

```bash
supabase functions deploy passkeys
```

## 4. Configurar Redirect URLs en Supabase Dashboard

Ir a Supabase Dashboard → Authentication → URL Configuration → Redirect URLs

Agregar:
- `https://fylmoda.com.ar/client/dashboard.html`
- `https://fylmoda.com.ar/admin/index.html`
- `https://fylmoda.com.ar/admin/reset-password.html`
- `http://localhost:5500/client/dashboard.html`
- `http://localhost:5500/client/login.html`

## 5. Verificar CORS

La Edge Function ya incluye manejo de CORS, pero verificar en Supabase Dashboard → Edge Functions → passkeys → Settings que CORS esté habilitado.

## 6. Testing

### En localhost (puerto 5500):
1. Abrir `http://localhost:5500/client/login.html`
2. Hacer login con Google
3. En dashboard, debería aparecer modal para activar biométrico
4. Activar passkey
5. Cerrar sesión
6. Volver a login y probar "Entrar con huella/rostro"

### En producción:
1. Repetir los mismos pasos en `https://fylmoda.com.ar`

## Troubleshooting

### Error: "WebAuthn library no disponible"
- Verificar que `@simplewebauthn/server` se pueda importar en Deno
- Si falla, implementar Plan B con WebCrypto nativo

### Error: "Origin no permitido"
- Verificar que el origin del request coincida con ORIGIN_PROD o ORIGIN_DEV
- Verificar secrets configurados correctamente

### Error: "Challenge inválido o expirado"
- Los challenges expiran en 5 minutos
- Verificar que la hora del servidor sea correcta

### Error: "No existe cuenta para ese email"
- El usuario debe haber hecho login con Google al menos una vez antes
- Verificar que el email esté normalizado (lowercase/trim)

