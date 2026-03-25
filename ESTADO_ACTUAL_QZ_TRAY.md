# Estado Actual del Proceso QZ Tray

## ✅ Cambios Implementados por el Usuario

### 1. Edge Function (`supabase/functions/qz-sign/index.ts`)

**Cambios principales:**
- ✅ Cambió de autenticación JWT a **Shared Secret** usando header `x-qz-secret`
- ✅ Normalización robusta de la clave privada (soporta PEM, DER, double base64)
- ✅ Respuesta en texto plano (base64 limpio)
- ✅ Manejo de errores mejorado con información de debug
- ❌ **FALTA:** Logs detallados del `toSign` recibido (que habíamos agregado antes)

**Estado actual:**
- Usa `QZ_SIGN_SECRET` desde variables de entorno
- Valida el header `x-qz-secret` en lugar de JWT
- Normaliza la clave privada automáticamente
- Responde con base64 limpio (sin saltos de línea)

### 2. Cliente (`admin/labels.js`)

**Cambios principales:**
- ✅ Usa `QZ_SIGN_SECRET` desde `config.js` o `config.local.js`
- ✅ Envía header `x-qz-secret` en lugar de `Authorization: Bearer`
- ✅ Sanitización del certificado (extrae solo el bloque BEGIN/END CERTIFICATE)
- ✅ Precarga el certificado antes de conectar
- ✅ Logs del `toSign` enviado

**Estado actual:**
- `setupQZSignature()` es async y precarga el certificado
- `qzConnect()` espera a que `setupQZSignature()` complete
- El certificado se sanitiza antes de pasarlo a QZ Tray
- Tiene fallback hardcoded del secret si no está en config

### 3. Configuración

**Archivos de configuración:**
- ✅ `scripts/config.js` - Exporta `QZ_SIGN_SECRET`
- ✅ `config.local.js` - Tiene el secret hardcoded
- ✅ `scripts/config.local.example.js` - Plantilla

**Variables de entorno necesarias en Supabase:**
- `QZ_PRIVATE_KEY_B64` - Clave privada en base64
- `QZ_SIGN_SECRET` - Secret compartido para autenticación

### 4. Certificados

**Estado:**
- ✅ Certificado `.p12` existe en `C:\qz\qz-certificate.p12`
- ❌ Certificado `.crt` NO existe en `certs/qz-site.crt`
- ⚠️ **ACCIÓN REQUERIDA:** Extraer el certificado `.crt` desde el `.p12`

## 🔧 Problemas Identificados

### 1. Certificado `.crt` Faltante

**Problema:** El certificado público no está disponible vía HTTP.

**Solución:**
```bash
# Opción 1: Usar el script
node scripts/extract-cert-from-p12.js

# Opción 2: Manual con OpenSSL
openssl pkcs12 -in C:\qz\qz-certificate.p12 -nokeys -out certs/qz-site.crt -passin pass:changeit
```

### 2. Comando de Deploy Incorrecto

**Problema:** El comando en `DEPLOY_VERIFICACION_QZ_SIGN.md` usa `--project-ref` que no existe.

**Comando correcto:**
```bash
# Opción 1: Si tienes supabase.json configurado
supabase functions deploy qz-sign

# Opción 2: Especificar proyecto directamente
supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
```

**Nota:** Parece que la versión de Supabase CLI que tienes no soporta `--project-ref` en `functions logs`. Usa el Dashboard para ver logs.

### 3. Logs Detallados Faltantes en Edge Function

**Problema:** La Edge Function actual no tiene los logs detallados que agregamos antes.

**Solución:** Agregar logs para debugging:
- Log del `toSign` recibido
- Log de la longitud del `toSign`
- Log de la firma generada

## 📋 Checklist de Estado Actual

### Completado ✅
- [x] Edge Function usa Shared Secret en lugar de JWT
- [x] Cliente envía `x-qz-secret` header
- [x] Normalización robusta de clave privada
- [x] Respuesta en texto plano (base64)
- [x] Sanitización del certificado en cliente
- [x] Precarga del certificado antes de conectar
- [x] Configuración de `QZ_SIGN_SECRET` en config files

### Pendiente ❌
- [ ] Extraer certificado `.crt` desde `.p12` a `certs/qz-site.crt`
- [ ] Agregar logs detallados en Edge Function
- [ ] Verificar que `QZ_SIGN_SECRET` esté configurado en Supabase
- [ ] Probar que QZ Tray NO muestre "anonymous request"
- [ ] Verificar que "Remember this decision" esté habilitado

## 🚀 Próximos Pasos Recomendados

1. **Extraer certificado `.crt`:**
   ```bash
   node scripts/extract-cert-from-p12.js
   ```

2. **Verificar configuración en Supabase:**
   - Dashboard → Settings → Edge Functions → Secrets
   - Verificar que `QZ_PRIVATE_KEY_B64` esté configurado
   - Verificar que `QZ_SIGN_SECRET` esté configurado

3. **Agregar logs detallados a Edge Function:**
   - Log del `toSign` recibido (primeros 100 chars)
   - Log de la longitud del `toSign`
   - Log de la firma generada (primeros 50 chars)

4. **Probar la conexión:**
   - Abrir `http://localhost:5500/admin/labels.html`
   - Verificar logs en consola del navegador
   - Verificar logs en Supabase Dashboard
   - Intentar imprimir y verificar que QZ Tray NO muestre "anonymous"

## 📝 Notas Técnicas

### Autenticación Cambiada

**Antes:** JWT con `Authorization: Bearer <token>`
**Ahora:** Shared Secret con `x-qz-secret: <secret>`

**Ventajas:**
- No requiere sesión de usuario
- Más simple para QZ Tray
- No depende de Supabase Auth

**Desventajas:**
- El secret debe estar en ambos lados (cliente y servidor)
- Menos seguro que JWT (pero suficiente para este caso)

### Normalización de Clave Privada

La Edge Function ahora soporta:
- Clave en formato PEM (con headers BEGIN/END)
- Clave en formato DER (base64 directo)
- Clave en "double base64" (base64 de un PEM)

Esto hace que sea más robusta ante diferentes formatos de entrada.


