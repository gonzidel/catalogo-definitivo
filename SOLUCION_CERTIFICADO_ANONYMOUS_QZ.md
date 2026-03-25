# Solución: QZ Tray "Anonymous Request" - Certificado No Entregado

## 🔴 Problema Identificado

QZ Tray muestra:
- **Signature**: Not Required
- **Validity**: Invalid Certificate
- **Common Name**: An anonymous request
- **Fingerprint**: UNKNOWN REQUEST

**Causa raíz:** El JavaScript NO está entregando el certificado público durante el handshake inicial de QZ Tray.

## ✅ Solución Implementada

Se modificó `admin/labels.js` para incluir `qz.security.setCertificatePromise()` **ANTES** de `setSignaturePromise()`.

### Cambios Realizados

1. **Agregado `setCertificatePromise`** que carga el certificado público (.crt) vía HTTP
2. **Orden correcto de configuración:**
   - Primero: Certificado (identidad)
   - Segundo: Firma (validación)
3. **Múltiples rutas de búsqueda** para el certificado:
   - `/certs/qz-site.crt`
   - `/certs/qz-certificate.crt`
   - Rutas relativas alternativas

## 📋 Pasos para Completar la Configuración

### Paso 1: Extraer Certificado Público desde .p12

El certificado público (.crt) debe estar accesible vía HTTP. Si no existe, extraerlo desde el .p12:

**Opción A: Usando el script Node.js (recomendado)**
```bash
node scripts/extract-cert-from-p12.js
```

**Opción B: Usando OpenSSL manualmente**
```bash
openssl pkcs12 -in C:\qz\qz-certificate.p12 -nokeys -out certs/qz-site.crt -passin pass:changeit
```

**Opción C: Si ya tienes qz-certificate.crt en la raíz**
```bash
# Copiar a carpeta certs/
mkdir certs
copy qz-certificate.crt certs\qz-site.crt
```

### Paso 2: Verificar que el Certificado Esté Accesible vía HTTP

El certificado debe ser servido por tu servidor web. Verifica:

1. **Si usas Live Server (VS Code):**
   - El archivo debe estar en `certs/qz-site.crt`
   - Accesible en: `http://localhost:5500/certs/qz-site.crt`

2. **Si usas otro servidor:**
   - Asegúrate de que la carpeta `certs/` sea accesible
   - El archivo debe poder descargarse vía HTTP

3. **Verificar acceso:**
   - Abre en navegador: `http://localhost:5500/certs/qz-site.crt`
   - Debe mostrar el contenido del certificado (texto con `BEGIN CERTIFICATE`)

### Paso 3: Reiniciar QZ Tray

1. Cerrar QZ Tray completamente
2. Reiniciar QZ Tray (como usuario normal, NO como admin)
3. Abrir la aplicación: `http://localhost:5500/admin/labels.html`

### Paso 4: Verificar en Consola del Navegador

Al cargar la página, deberías ver en la consola (F12):

```
🔧 Configurando certificado y firma remota de QZ Tray...
📜 Cargando certificado público desde servidor...
✅ Certificado cargado desde: /certs/qz-site.crt
✅ Certificado público configurado correctamente
✅ Certificado público configurado
✅ Certificado y firma remota configurados para QZ Tray
```

### Paso 5: Verificar en QZ Tray

Al intentar imprimir, el popup de QZ Tray debe mostrar:

- **Signature**: Required (o similar)
- **Validity**: Valid Certificate
- **Common Name**: QZ Tray Certificate (o el CN del certificado)
- **Fingerprint**: [hash del certificado]
- **"Remember this decision"**: HABILITADO (no gris)

## 🔧 Troubleshooting

### Error: "Certificado público no disponible"

**Causa:** El archivo .crt no está accesible vía HTTP.

**Solución:**
1. Verificar que `certs/qz-site.crt` existe
2. Verificar que el servidor web sirve la carpeta `certs/`
3. Probar acceso directo: `http://localhost:5500/certs/qz-site.crt`
4. Si no funciona, copiar el certificado a la raíz y ajustar la ruta en el código

### Error: "Certificado inválido o vacío"

**Causa:** El archivo .crt está corrupto o no es un certificado válido.

**Solución:**
1. Regenerar el certificado desde el .p12
2. Verificar que el archivo contiene `-----BEGIN CERTIFICATE-----` y `-----END CERTIFICATE-----`

### QZ Tray sigue mostrando "Anonymous Request"

**Causa:** El certificado no se está cargando correctamente.

**Solución:**
1. Verificar en consola del navegador si hay errores al cargar el certificado
2. Verificar que `setCertificatePromise` se ejecuta ANTES de `setSignaturePromise`
3. Verificar que el certificado se carga correctamente (ver logs en consola)
4. Verificar que QZ Tray NO está corriendo como administrador

### El certificado se carga pero QZ Tray no lo acepta

**Causa:** El certificado no coincide con la clave privada usada para firmar.

**Solución:**
1. Asegúrate de que el .crt y el .p12 fueron generados juntos
2. Si regeneraste el .p12, también regenera el .crt
3. Verifica que el CN (Common Name) del certificado sea correcto

## 📝 Notas Técnicas

### Orden de Configuración

El orden es crítico:
1. **Primero:** `setCertificatePromise()` - Identifica la conexión
2. **Segundo:** `setSignaturePromise()` - Valida la conexión

Si se invierte el orden, QZ Tray puede no reconocer el certificado.

### Formato del Certificado

QZ Tray espera el certificado en formato PEM:
```
-----BEGIN CERTIFICATE-----
[contenido base64]
-----END CERTIFICATE-----
```

El script de extracción genera este formato automáticamente.

### Firma Remota vs Certificado Local

- **Certificado (.crt):** Identifica la conexión, evita "anonymous"
- **Firma remota:** Valida la conexión usando la clave privada en Supabase

Ambos son necesarios para que "Remember this decision" funcione.

## ✅ Resultado Esperado

Después de completar estos pasos:

- ✅ QZ Tray reconoce la conexión con certificado válido
- ✅ "Remember this decision" está habilitado
- ✅ El sitio queda marcado como trusted
- ✅ No más popups después de aceptar una vez
- ✅ La impresión funciona sin bloqueos

## 🔍 Verificación Final

1. **Consola del navegador:** Muestra certificado cargado correctamente
2. **QZ Tray popup:** Muestra certificado válido (no "anonymous")
3. **"Remember this decision":** Habilitado y funcional
4. **Impresión:** Funciona sin bloqueos

Si todo está correcto, el problema de "anonymous request" está resuelto.



