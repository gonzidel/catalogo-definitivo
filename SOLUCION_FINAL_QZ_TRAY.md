# Solución Final - QZ Tray "Anonymous Request"

## ✅ Verificaciones Completadas

### 1. Certificado y Clave Privada Coinciden

**MD5 del certificado:** `f13f6a8d842d6fb781df9921a1f2b395`
**MD5 de la clave privada (del .p12):** `f13f6a8d842d6fb781df9921a1f2b395`

✅ **COINCIDEN** - Son pareja correcta.

### 2. Transporte del toSign

✅ **Todos los archivos cliente** envían `text/plain` (no JSON)
✅ **Edge Function** lee como `text/plain` (no JSON parse)
✅ **Edge Function** NO hace `trim()` antes de firmar

### 3. Algoritmo SHA-512

✅ **Todos los archivos cliente** configuran `setSignatureAlgorithm("SHA512")`
✅ **Edge Function** usa `hash: "SHA-512"` para firmar

### 4. Certificado Público

✅ Certificado extraído a `certs/qz-site.crt`
✅ Accesible vía HTTP en `/certs/qz-site.crt`
✅ Se precarga antes de conectar

## 🔧 Acción Requerida: Actualizar QZ_PRIVATE_KEY_B64

### Paso 1: Generar Base64

Ejecutar:
```bash
node scripts/generate-private-key-b64.js
```

Esto mostrará el base64 de `qz-private-from-p12.pem` (la clave privada extraída del mismo .p12 que el certificado).

### Paso 2: Actualizar en Supabase

1. Ir a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions
2. Buscar `QZ_PRIVATE_KEY_B64` en Secrets
3. Editar y pegar el base64 generado
4. Guardar

### Paso 3: Redeployar Edge Function

```bash
supabase functions deploy qz-sign
```

## 📋 Estado Actual de los Archivos

### Cliente (Todos los archivos)
- ✅ Importan `SUPABASE_URL` y `QZ_SIGN_SECRET` desde `config.js`
- ✅ Configuran `setSignatureAlgorithm("SHA512")`
- ✅ Precargan certificado antes de conectar
- ✅ Envían `toSign` como `text/plain` (no JSON)
- ✅ Logs detallados para debugging

### Edge Function
- ✅ Lee `toSign` como `text/plain` (no JSON parse)
- ✅ NO hace `trim()` antes de firmar
- ✅ Usa `hash: "SHA-512"` para firmar
- ✅ Logs detallados del `toSign` recibido
- ✅ Respuesta en texto plano (base64 limpio)

## 🎯 Resultado Esperado

Después de actualizar `QZ_PRIVATE_KEY_B64` y redeployar:

1. ✅ QZ Tray reconoce el certificado (no "anonymous")
2. ✅ "Remember this decision" está habilitado
3. ✅ La firma se genera correctamente con SHA-512
4. ✅ El `toSign` llega sin alteraciones
5. ✅ Después de aceptar una vez, no aparecen más popups

## 🔍 Verificación Post-Deploy

1. **Abrir:** `http://localhost:5500/admin/closed-orders.html`
2. **Abrir consola (F12)**
3. **Intentar imprimir**
4. **Verificar logs:**
   - Debe aparecer: "✅ Algoritmo de firma configurado: SHA512"
   - Debe aparecer: "✅ Certificado y firma remota configurados"
   - NO debe aparecer: "Error: Failed to sign request"
5. **Verificar QZ Tray popup:**
   - NO debe mostrar "anonymous request"
   - Debe mostrar el certificado válido
   - "Remember this decision" debe estar habilitado
   - Click "Allow" y marcar "Remember"

## 📝 Archivos Corregidos

- ✅ `admin/labels.js`
- ✅ `admin/closed-orders.js`
- ✅ `admin/sent-orders.js`
- ✅ `admin/public-sales.js`
- ✅ `admin/public-sales-caja2.js`
- ✅ `admin/public-sales-caja3.js`
- ✅ `supabase/functions/qz-sign/index.ts`

Todos los archivos ahora tienen la misma implementación robusta y consistente.

