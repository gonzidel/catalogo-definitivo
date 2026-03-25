# Actualizar QZ_PRIVATE_KEY_B64 en Supabase

## ✅ Verificación Completada

**MD5 del certificado:** `f13f6a8d842d6fb781df9921a1f2b395`
**MD5 de la clave privada (del .p12):** `f13f6a8d842d6fb781df9921a1f2b395`

✅ **COINCIDEN** - El certificado y la clave privada son pareja correcta.

## 📋 Pasos para Actualizar QZ_PRIVATE_KEY_B64

### Paso 1: Generar Base64 de la Clave Privada

La clave privada ya fue extraída desde el .p12 a `qz-private-from-p12.pem`.

**Generar base64 (ejecutar en PowerShell desde la raíz del proyecto):**

```powershell
$pem = Get-Content "qz-private-from-p12.pem" -Raw
$bytes = [System.Text.Encoding]::UTF8.GetBytes($pem)
$b64 = [Convert]::ToBase64String($bytes)
$b64
```

**O usar el script Node.js:**

```bash
node -e "const fs = require('fs'); const pem = fs.readFileSync('qz-private-from-p12.pem', 'utf8'); console.log(Buffer.from(pem, 'utf8').toString('base64'))"
```

### Paso 2: Actualizar en Supabase

1. **Ir a Supabase Dashboard:**
   - URL: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions
   - O: Dashboard → Settings → Edge Functions → Secrets

2. **Buscar `QZ_PRIVATE_KEY_B64` en la lista de secrets**

3. **Click en el secret para editarlo** (o crear nuevo si no existe)

4. **Pegar el base64 generado** (el string completo, sin saltos de línea)

5. **Guardar**

### Paso 3: Redeployar Edge Function

```bash
supabase functions deploy qz-sign
```

## ⚠️ Importante

- El base64 debe ser del archivo `qz-private-from-p12.pem` (extraído del mismo .p12 que el certificado)
- NO usar `qz-private-key.pem` si es diferente
- El base64 debe incluir los headers `-----BEGIN PRIVATE KEY-----` y `-----END PRIVATE KEY-----`
- No debe tener saltos de línea en el base64 final

## 🔍 Verificación Post-Deploy

Después de actualizar y redeployar:

1. Abrir `http://localhost:5500/admin/labels.html`
2. Intentar imprimir
3. Verificar en logs de Supabase que la firma se genera correctamente
4. Verificar que QZ Tray NO muestre "anonymous request"
5. Verificar que "Remember this decision" esté habilitado

