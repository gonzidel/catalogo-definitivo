# Configuración de Certificado QZ Tray

## 📦 Generar Certificados

**Requisito**: Necesitas tener OpenSSL instalado. Si no lo tienes:
- **Windows**: Descarga desde https://slproweb.com/products/Win32OpenSSL.html (versión Light es suficiente)
- **O usa Git Bash** (incluye OpenSSL): `C:\Program Files\Git\usr\bin\openssl.exe`

### Opción 1: Usar el script Node.js (genera llaves, requiere OpenSSL para certificado)
```bash
node scripts/generate-qz-cert.js
```

### Opción 2: Generar manualmente con OpenSSL

1. **Generar llave privada**:
```bash
openssl genrsa -out qz-private-key.pem 2048
```

2. **Convertir a PKCS#8 DER**:
```bash
openssl pkcs8 -topk8 -nocrypt -in qz-private-key.pem -outform DER -out qz-private.pk8.der
```

3. **Convertir DER a base64** (para Supabase Secret):
```bash
# Windows PowerShell:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("qz-private.pk8.der")) | Out-File -Encoding ASCII qz-private.pk8.der.b64

# Linux/Mac/Git Bash:
base64 -w 0 qz-private.pk8.der > qz-private.pk8.der.b64
```

4. **Generar certificado autofirmado (.crt)**:
```bash
openssl req -new -x509 -key qz-private-key.pem -out qz-certificate.crt -days 365 -subj "/CN=QZ Tray Certificate/O=Catalogo FYL/C=AR"
```

5. **Generar archivo PKCS#12 (.p12)**:
```bash
openssl pkcs12 -export -out qz-certificate.p12 -inkey qz-private-key.pem -in qz-certificate.crt -passout pass:changeit -name "QZ Tray Certificate"
```

## ✅ Verificación de Certificados Generados

Los siguientes archivos deben existir en la raíz del proyecto:
- `qz-certificate.crt` - Certificado público
- `qz-certificate.p12` - Certificado PKCS#12 para importar en QZ Tray
- `qz-private-key.pem` - Llave privada (PKCS#1)
- `qz-private.pk8.der` - Llave privada (PKCS#8 DER)
- `qz-private.pk8.der.b64` - Llave privada en base64 (para Supabase Secret)

## 🔐 Importar Certificado en QZ Tray

**⚠️ IMPORTANTE**: Aunque la **firma remota** funciona correctamente (genera las firmas), **QZ Tray NO permitirá "Remember this decision"** a menos que el certificado esté importado localmente.

**Sin importar el certificado**:
- ✅ La firma remota funciona (genera firmas correctamente)
- ✅ Puedes imprimir
- ❌ **NO puedes habilitar "Remember this decision"**
- ❌ Los popups seguirán apareciendo cada vez

**Con el certificado importado**:
- ✅ La firma remota funciona
- ✅ Puedes imprimir
- ✅ **"Remember this decision" queda habilitado**
- ✅ Los popups desaparecen después de aceptar una vez

**Si decides importar el certificado** (opcional), puedes usar uno de los métodos siguientes:

### Pasos para importar:

1. **Abrir QZ Tray** (debe estar ejecutándose)

2. **Acceder al Site Manager**:
   - Click derecho en el icono de QZ Tray (en la bandeja del sistema)
   - Seleccionar: **Advanced** → **Site Manager...**

3. **Agregar un nuevo sitio confiable**:
   - En la ventana "Site Manager", busca el botón que dice **"Add"** o tiene un icono de **"+"** (generalmente está arriba o abajo de la lista de sitios)
   - Si no ves un botón "Add", busca un menú desplegable o un botón con tres puntos (**"..."**)
   - Al hacer click, deberías ver opciones como:
     - **"Browse..."** (con icono de carpeta verde) - **USA ESTA OPCIÓN**
     - **"Create New..."** (con icono de engranaje verde)

4. **Importar el certificado**:
   - Click en **"Browse..."** (o la opción equivalente para importar)
   - En el diálogo de archivos, seleccionar el archivo `qz-certificate.p12`
   - Cuando pida contraseña, ingresar: `changeit`
   - Click en **"Open"** o **"Abrir"**

5. **Verificar que el sitio aparezca en la lista**:
   - Después de importar, deberías ver tu certificado en la lista de "Sites permanently allowed access"
   - El certificado debería mostrar los detalles (Organization, Common Name, etc.)
   - Si aparece, significa que está correctamente importado
   - **Nota**: El certificado aparecerá con el nombre que le diste al generarlo, no necesariamente con la URL del sitio

### Método Alternativo (si Site Manager da "Import failed"):

Si QZ Tray muestra "Import failed", intenta estos métodos:

#### Opción 1: Importar en el almacén de certificados de Windows
1. **Abrir el Administrador de Certificados**:
   - Presionar `Win + R`, escribir `certmgr.msc` y presionar Enter
   - En el panel izquierdo, expandir **"Personal"** → **"Certificados"**
   - Click derecho en **"Certificados"** → **"Todas las tareas"** → **"Importar"**
   - Seleccionar `qz-certificate.p12`
   - Contraseña: `changeit`
   - Marcar "Habilitar protección segura de clave privada"
   - Completar el asistente

2. **Reiniciar QZ Tray** después de importar

#### Opción 2: Verificar logs de QZ Tray
1. **Abrir logs de QZ Tray**:
   - Click derecho en QZ Tray → **Diagnostic** → **View logs (live feed)...**
   - Buscar errores relacionados con "certificate" o "import"
   - También puedes usar: **Diagnostic** → **Zip logs (to Desktop)** para obtener un archivo completo

2. **Compartir los logs** si el error persiste para diagnosticar el problema específico

2. **Verificar logs de QZ Tray**:
   - Click derecho en QZ Tray → **Diagnostic** → **View logs (live feed)...**
   - Buscar errores relacionados con certificados
   - También puedes usar: **Diagnostic** → **Zip logs (to Desktop)** para obtener un archivo completo

3. **Verificar que QZ Tray reconozca el certificado**:
   - Después de importar, reiniciar QZ Tray completamente
   - Intentar conectar desde la aplicación web
   - Revisar los logs para ver si hay mensajes sobre certificados

## 🧪 Verificar que Funciona

1. **Abrir la consola del navegador** (F12)

2. **Navegar a** `admin/labels.html`

3. **Intentar imprimir una etiqueta**

4. **En la consola deberías ver**:
   ```
   🔧 Configurando firma remota de QZ Tray...
   ✅ Firma remota configurada para QZ Tray
   🔐 QZ Tray solicitó firma. Longitud: [número]
   🔍 Obteniendo sesión de Supabase...
   📡 Enviando request de firma a Edge Function...
   📥 Respuesta recibida. Status: 200
   📦 Respuesta JSON recibida: ["signature"]
   ✅ Firma generada correctamente. Longitud: [número]
   ✅ QZ Tray conectado
   ```

5. **Si ves errores**:
   - `Failed to get certificate: undefined` → La función de firma remota está fallando (NO es problema del certificado importado)
   - `Connection blocked by client` → La firma remota falló o hay problema de autenticación
   - `No session token` → Debes estar autenticado en la aplicación
   - `Error HTTP: 401` → Problema de autenticación con Supabase
   - `Error HTTP: 500` → Problema con la Edge Function o el secreto QZ_PRIVATE_KEY_B64
   - `Import failed` en QZ Tray → Verifica que el certificado `.p12` fue generado correctamente

## 🔧 Troubleshooting

### Error: "Import failed" en QZ Tray
**Causa**: QZ Tray rechazó el certificado al intentar importarlo. Esto puede deberse a:
- Algoritmos de cifrado incompatibles
- Estructura del certificado no reconocida
- Problemas con certificados autofirmados en algunas versiones de QZ Tray

**Solución**:
1. **Verificar que el archivo `.p12` existe** - Debe estar en la raíz del proyecto
2. **Regenerar el certificado** con los comandos actualizados (ya se hizo automáticamente)
3. **Intentar importar en el almacén de certificados de Windows** (ver "Método Alternativo" arriba)
4. **Verificar logs de QZ Tray** para ver el error específico:
   - Click derecho en QZ Tray → **Diagnostic** → **View logs (live feed)...**
   - Buscar líneas con "certificate" o "import"
5. **Si el error persiste**: 
   - **IMPORTANTE**: La firma remota funciona sin importar el certificado
   - El único problema es que "Remember this decision" no estará disponible
   - Puedes continuar usando la aplicación, solo tendrás que aceptar los popups cada vez
   - O actualizar QZ Tray a la versión más reciente

### Error: "Failed to get certificate: undefined"
**Causa**: La función de firma remota está fallando o retornando undefined. **NO es problema del certificado importado** - el problema está en la función de firma.

**Solución**:
1. **Verificar que estés autenticado** - Debes tener una sesión activa de Supabase
2. **Revisar la consola del navegador** - Busca errores que empiecen con 🔐, 📡, o ❌
3. **Verificar que la Edge Function esté funcionando**:
   - Revisa los logs en Supabase Dashboard → Functions → qz-sign → Logs
   - Verifica que el secreto `QZ_PRIVATE_KEY_B64` esté configurado
4. **Verificar CORS** - Asegúrate de que tu dominio esté en `allowedOrigins` en la Edge Function

### Error: "Connection blocked by client"
**Causa**: QZ Tray está rechazando la conexión porque no puede obtener la firma.

**Solución**:
1. Verificar que el certificado esté importado
2. Verificar que la Edge Function esté funcionando (revisar logs en Supabase Dashboard)
3. Verificar que el secreto `QZ_PRIVATE_KEY_B64` esté configurado en Supabase
4. Verificar que estés autenticado (debe haber sesión activa)

### Error: "No session token"
**Causa**: No hay sesión activa de Supabase.

**Solución**:
1. Iniciar sesión en la aplicación
2. Verificar que la sesión esté activa antes de intentar imprimir

### Error: CORS preflight
**Causa**: El origen no está en la lista de permitidos.

**Solución**:
1. Verificar que el dominio esté en `allowedOrigins` en `supabase/functions/qz-sign/index.ts`
2. Redeployar la Edge Function después de agregar el dominio

## 📋 Checklist de Configuración

- [ ] Certificado `.p12` generado
- [ ] Certificado importado en QZ Tray
- [ ] QZ Tray reiniciado después de importar
- [ ] Secreto `QZ_PRIVATE_KEY_B64` configurado en Supabase
- [ ] Edge Function `qz-sign` deployada
- [ ] Dominio agregado a `allowedOrigins` en la Edge Function
- [ ] Usuario autenticado en la aplicación
- [ ] Consola del navegador sin errores

## 🚀 Comandos Útiles

### Verificar secretos en Supabase:
```bash
supabase secrets list --project-ref dtfznewwvsadkorxwzft
```

### Redeployar Edge Function:
```bash
supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
```

### Ver logs de la Edge Function:
- Ir a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/functions/qz-sign/logs

