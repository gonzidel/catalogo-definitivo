# Configuración de Supabase para QZ Tray - Firma Digital

## ✅ Checklist de Configuración en Supabase

Para que la firma digital de QZ Tray funcione, necesitas verificar/configurar lo siguiente en Supabase:

### 1. **Edge Function `qz-sign` Deployada** ✅

**Verificar:**
- Ve a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/functions
- Debe aparecer la función `qz-sign` en la lista
- Debe estar en estado "Active" o "Deployed"

**Si NO está deployada:**
```bash
cd "E:\PROYECTOS\CATALOGO DEFINITIVO"
supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
```

### 2. **Secreto `QZ_PRIVATE_KEY_B64` Configurado** ✅

**Verificar:**
- Ve a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions
- O desde el menú: **Settings** → **Edge Functions** → **Secrets**
- Debe aparecer `QZ_PRIVATE_KEY_B64` en la lista

**Si NO está configurado:**
1. **Leer el archivo base64**:
   ```powershell
   cd "E:\PROYECTOS\CATALOGO DEFINITIVO"
   Get-Content qz-private.pk8.der.b64 -Raw
   ```
2. **Configurar en Supabase**:
   - Ve a: **Settings** → **Edge Functions** → **Secrets**
   - Click en **"Add new secret"**
   - **Name**: `QZ_PRIVATE_KEY_B64`
   - **Value**: Pega el contenido completo del archivo `qz-private.pk8.der.b64` (sin saltos de línea)
   - Click en **"Save"**

   **O desde la terminal:**
   ```bash
   supabase secrets set QZ_PRIVATE_KEY_B64="$(cat qz-private.pk8.der.b64)" --project-ref dtfznewwvsadkorxwzft
   ```

### 3. **Variables de Entorno Automáticas** ✅

Supabase Edge Functions tienen acceso automático a:
- `SUPABASE_URL` - Se configura automáticamente
- `SUPABASE_ANON_KEY` - Se configura automáticamente

**No necesitas configurarlas manualmente** - Supabase las inyecta automáticamente.

### 4. **CORS Configurado en la Edge Function** ✅

La Edge Function `qz-sign` ya tiene CORS configurado para:
- `http://localhost:5500`
- `http://localhost:8080`
- `http://127.0.0.1:5500`
- `http://127.0.0.1:8080`
- `https://catalogo-fyl-test.web.app`
- `https://catalogo-fyl.web.app`

**Si necesitas agregar más dominios:**
- Edita `supabase/functions/qz-sign/index.ts`
- Agrega el dominio al array `allowedOrigins`
- Redeploya la función

### 5. **Autenticación Habilitada** ✅

La Edge Function requiere autenticación (Bearer token). Asegúrate de que:
- El usuario esté autenticado en la aplicación
- La sesión de Supabase esté activa
- El token se envíe en el header `Authorization: Bearer <token>`

**Esto ya está implementado en el frontend** (`admin/labels.js`), no necesitas configurar nada adicional.

## 🔍 Cómo Verificar que Todo Está Configurado

### Paso 1: Verificar Edge Function
1. Ve a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/functions/qz-sign
2. Click en **"Logs"**
3. Debe mostrar logs recientes (si alguien intentó usar la función)

### Paso 2: Verificar Secreto
1. Ve a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions
2. Busca `QZ_PRIVATE_KEY_B64` en la lista de secrets
3. Debe aparecer con un icono de "eye" (ojo) para ver (pero no mostrar el valor por seguridad)

### Paso 3: Probar la Función
1. Abre `http://localhost:5500/admin/labels.html`
2. Abre la consola del navegador (F12)
3. Intenta imprimir una etiqueta
4. En la consola deberías ver:
   - `🔐 Firmando request QZ: ...`
   - `📡 Enviando request de firma a Edge Function...`
   - `📥 Respuesta recibida. Status: 200`
   - `✅ Firma generada correctamente`

### Paso 4: Verificar Logs de Supabase
1. Ve a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/functions/qz-sign/logs
2. Debe aparecer una entrada reciente con:
   - Status: `200` (si funcionó)
   - O un error específico (si algo falló)

## ❌ Errores Comunes

### Error: "QZ_PRIVATE_KEY_B64 no está configurado"
**Solución**: Configura el secreto en Supabase (ver paso 2 arriba)

### Error: "No autorizado" o "No autenticado"
**Solución**: 
- Verifica que el usuario esté autenticado en la aplicación
- Verifica que la sesión de Supabase esté activa
- Revisa la consola del navegador para ver si hay errores de autenticación

### Error: CORS preflight
**Solución**: 
- Verifica que tu dominio esté en `allowedOrigins` en `supabase/functions/qz-sign/index.ts`
- Redeploya la función después de agregar el dominio

### Error: "Failed to get certificate: undefined"
**Solución**: 
- Este error viene de QZ Tray, no de Supabase
- La Edge Function está funcionando correctamente
- El problema es que QZ Tray no encuentra el certificado local
- Ver `SOLUCION_CERTIFICADO_QZ.md` para más detalles

## 📋 Resumen

**Lo que SÍ necesitas configurar en Supabase:**
- ✅ Edge Function `qz-sign` deployada
- ✅ Secreto `QZ_PRIVATE_KEY_B64` configurado

**Lo que NO necesitas configurar (ya está automático):**
- ✅ `SUPABASE_URL` - Automático
- ✅ `SUPABASE_ANON_KEY` - Automático
- ✅ CORS - Ya configurado en el código
- ✅ Autenticación - Ya implementado en el frontend

**Si todo está configurado correctamente:**
- La firma remota funcionará
- Podrás imprimir sin problemas
- Los logs de Supabase mostrarán requests exitosos (status 200)






