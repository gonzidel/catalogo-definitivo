# Análisis del Documento QZ Tray 2.x vs Estado Actual

## 🔴 Problemas Críticos Identificados

### 1. **FALTA: `setSignatureAlgorithm("SHA512")`**

**Según el documento:**
> "A partir de QZ Tray 2.1, el algoritmo por defecto para la firma cambió a SHA-512 (antes era SHA-1 en 2.0). Es importante establecer esto en la configuración JavaScript. Asegúrate de llamar a: `qz.security.setSignatureAlgorithm("SHA512");` antes de la promesa de firma."

**Estado actual:**
- ❌ NO se está configurando `setSignatureAlgorithm("SHA512")` en `admin/labels.js`
- Esto puede causar que QZ Tray espere SHA-512 pero reciba SHA-256, resultando en firma inválida

### 2. **Edge Function usa SHA-256 en lugar de SHA-512**

**Según el documento:**
> "QZ Tray 2.x (especialmente 2.2.5) espera firmas SHA-512 por defecto."

**Estado actual:**
- ❌ `supabase/functions/qz-sign/index.ts` línea 144 usa `hash: "SHA-256"`
- Debe cambiarse a `hash: "SHA-512"`

### 3. **Certificado debe estar accesible vía HTTP**

**Según el documento:**
> "El certificado (en texto) debe estar disponible vía HTTP(S) para ser leído por la página. Asegúrate de que el contenido que se envía a resolve() sea exactamente el texto PEM del certificado (incluyendo las líneas ---BEGIN CERTIFICATE--- y ---END CERTIFICATE---)."

**Estado actual:**
- ✅ Se está cargando desde `/certs/qz-site.crt`
- ✅ Se está sanitizando correctamente (extrae solo el bloque BEGIN/END)
- ❌ **PROBLEMA:** El archivo `certs/qz-site.crt` NO existe (verificado con Test-Path)

### 4. **Orden de Configuración**

**Según el documento:**
> "Primero se carga el certificado con `setCertificatePromise` (esto ocurre al establecer la conexión WebSocket inicial con QZ Tray). Luego, cada vez que se envía un comando de impresión, QZ Tray invocará la función definida en `setSignaturePromise`."

**Estado actual:**
- ✅ El certificado se precarga antes de conectar
- ✅ `setCertificatePromise` se configura antes de `setSignaturePromise`
- ✅ `qzConnect()` espera a que `setupQZSignature()` complete

### 5. **Verificación de Pareja Certificado/Clave Privada**

**Según el documento:**
> "Es crucial que el certificado y la clave privada sean pareja. QZ Tray verificará que la firma provenga de la clave privada asociada a ese certificado. Si hay desajuste, la firma será inválida y QZ la tratará como no confiable."

**Estado actual:**
- ✅ El usuario confirmó que los modulus MD5 coinciden
- ✅ El par es correcto

## ✅ Lo que Está Bien Implementado

1. ✅ Certificado se sanitiza correctamente (extrae solo BEGIN/END CERTIFICATE)
2. ✅ Certificado se precarga antes de conectar
3. ✅ Orden correcto: certificado primero, luego firma
4. ✅ Respuesta en texto plano (base64)
5. ✅ Shared Secret configurado correctamente
6. ✅ Logs del toSign en cliente

## 🔧 Correcciones Necesarias

### Corrección 1: Agregar `setSignatureAlgorithm("SHA512")`

**Ubicación:** `admin/labels.js` después de configurar el certificado, antes de `setSignaturePromise`

```javascript
qz.security.setSignatureAlgorithm("SHA512");
```

### Corrección 2: Cambiar Edge Function a SHA-512

**Ubicación:** `supabase/functions/qz-sign/index.ts` línea 144

**Cambiar:**
```typescript
{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
```

**Por:**
```typescript
{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }
```

### Corrección 3: Extraer Certificado .crt

**Acción:** Ejecutar script para extraer certificado desde .p12

```bash
node scripts/extract-cert-from-p12.js
```

O manualmente:
```bash
openssl pkcs12 -in C:\qz\qz-certificate.p12 -nokeys -out certs/qz-site.crt -passin pass:changeit
```

## 📋 Checklist Según el Documento

- [ ] Extraer y publicar certificado público (.crt) - **PENDIENTE**
- [ ] Configurar `setCertificatePromise` correctamente - ✅ **HECHO**
- [ ] Configurar `setSignatureAlgorithm("SHA512")` - ❌ **FALTA**
- [ ] Configurar `setSignaturePromise` - ✅ **HECHO**
- [ ] Edge Function usa SHA-512 - ❌ **FALTA (usa SHA-256)**
- [ ] Verificar variables de entorno en Supabase - ⚠️ **VERIFICAR**
- [ ] Agregar logs de depuración - ⚠️ **PARCIAL (falta en Edge Function)**
- [ ] Probar impresión con QZ Tray - ⚠️ **PENDIENTE**

## 🎯 Causa Probable del "Anonymous Request"

Según el documento:
> "Si 'Remember' está deshabilitado, es indicio de certificado/firma inválidos. Causas típicas: el certificado no se está cargando correctamente, la firma se está generando con el algoritmo equivocado (SHA-1 en vez de SHA-512), o la firma no corresponde al contenido."

**Problemas identificados que pueden causar "anonymous":**

1. ❌ **Algoritmo incorrecto:** Edge Function usa SHA-256, QZ Tray espera SHA-512
2. ❌ **Falta configuración explícita:** No se está llamando `setSignatureAlgorithm("SHA512")`
3. ❌ **Certificado no accesible:** `certs/qz-site.crt` no existe

## 🚀 Prioridad de Correcciones

1. **CRÍTICO:** Cambiar Edge Function a SHA-512
2. **CRÍTICO:** Agregar `setSignatureAlgorithm("SHA512")` en cliente
3. **CRÍTICO:** Extraer certificado .crt desde .p12
4. **IMPORTANTE:** Agregar logs detallados en Edge Function
5. **VERIFICAR:** Confirmar que `QZ_SIGN_SECRET` coincide en cliente y servidor


