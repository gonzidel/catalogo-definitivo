# Catálogo FYL

Pequeña PWA que muestra un catálogo de productos usando Google Sheets (OpenSheet) o Supabase como origen de datos. Incluye soporte PWA (service worker), optimizaciones Cloudinary y utilidades de descarga/compartir.

Contenido relevante:

- `index.html` - punto de entrada del frontend.
- `scripts/` - lógica de la aplicación (config, cliente Supabase, data-source, main, etc.).
- `sw.js` - service worker para cache y modo offline.
- `manifest.json` - manifiesto PWA.
- `cloudinary-optimize/` - utilidad Node para optimizar imágenes vía Cloudinary.
- `clave/` - contiene credenciales privadas (NO subir a repositorio).

Cómo probar localmente (estático):

1. Servir la carpeta con un servidor estático.

Opciones en PowerShell (Windows):

```powershell
# Si tienes Python instalado, usa el lanzador `py` (recomendado en Windows):
py -3 -m http.server 8080

# Si `py`/`python` no está disponible, puedes usar Node (si tienes npm):
npx http-server . -p 8080

# O instala http-server globalmente y luego ejecútalo:
# npm install -g http-server
# http-server . -p 8080
```

2. Abrir `http://localhost:8080` y comprobar que la app carga.

Diagnóstico rápido en PowerShell si el comando falla:

1. "no se encontró Python" o mensaje sobre alias:

   - Asegúrate de tener Python instalado: https://www.python.org/downloads/
   - En el instalador de Windows activa "Add Python to PATH" o usa `py -3`.

2. Si usas Node y `npx` no funciona:

   - Instala Node.js desde https://nodejs.org/ y vuelve a intentarlo.

3. Puerto en uso:
   - Si `8080` está ocupado, prueba con otro puerto, por ejemplo `8081`.

Ejemplo final (PowerShell):

```powershell
py -3 -m http.server 8080
# o
npx http-server . -p 8080
```

Advertencias y notas:

- `clave/` contiene un archivo JSON con credenciales de Firebase admin. Mantener fuera del control de versiones.
- `scripts/config.js` contiene las claves públicas de Supabase (anon). Si quieres desactivar Supabase, borra o deja vacías `SUPABASE_URL` y `SUPABASE_ANON_KEY`.
- `scripts/config.js` NO debe contener claves sensibles. Para claves locales, copia `scripts/config.local.example.js` a `scripts/config.local.js` y completa las variables (este archivo está en `.gitignore` y no se subirá al repo).
- El service worker cachea muchas rutas. Revisa `sw.js` si necesitas actualizar archivos cacheados.

Siguientes pasos recomendados:

- Añadir tests mínimos si deseas automatizar builds.
- Opcional: separar configuración sensible en variables de entorno para despliegues.

## Husky pre-commit (escaneo de secretos)

Si querés prevenir commits que contengan secretos, podés habilitar el hook pre-commit que ejecuta el escaneo básico antes de cada commit.

1. Instalar dependencias de desarrollo:

```powershell
npm install
```

2. Habilitar Husky (crea los hooks locales):

```powershell
npm run prepare
```

A partir de ese momento, antes de cada commit se ejecutará `npm run test:secrets`. Si el escaneo encuentra coincidencias, el commit será cancelado y deberás resolver los secretos detectados.

Nota: los hooks son locales a tu copia del repo y no se ejecutarán en otras máquinas hasta que hagan `npm install` y `npm run prepare`.

## QZ Tray - Firma Digital

El proyecto usa QZ Tray para imprimir etiquetas y tickets. Para eliminar los popups de seguridad y habilitar "Remember this decision", se implementó firma digital usando certificado propio.

### Generar Certificado y Llave Privada

**Comandos OpenSSL**:

```bash
# 1. Generar llave privada RSA 2048 bits (PKCS#1 inicialmente)
openssl genrsa -out qz-private-key.pem 2048

# 2. Convertir a PKCS#8 en formato DER (binario, requerido por WebCrypto)
openssl pkcs8 -topk8 -nocrypt -in qz-private-key.pem -outform DER -out qz-private.pk8.der

# 3. Generar certificado autofirmado válido por 10 años
# IMPORTANTE: Cambiar CN=localhost por tu dominio real en producción
openssl req -new -x509 -key qz-private-key.pem -out qz-certificate.crt -days 3650 -subj "/CN=localhost/O=CatalogoFYL/OU=IT"

# 4. Convertir a formato PKCS#12 (.p12) para importar en QZ Tray
openssl pkcs12 -export -out qz-certificate.p12 -inkey qz-private-key.pem -in qz-certificate.crt -passout pass:changeit

# 5. Convertir PKCS#8 DER a base64 para Supabase Secrets
base64 -w 0 qz-private.pk8.der > qz-private.pk8.der.b64

# En Windows PowerShell (si base64 no está disponible):
# [Convert]::ToBase64String([System.IO.File]::ReadAllBytes("qz-private.pk8.der")) | Out-File -Encoding ASCII qz-private.pk8.der.b64 -NoNewline
```

**Nota**: Para producción, el CN debe coincidir con el dominio desde donde se sirve la app (ej: `CN=tu-dominio.com`).

### Configurar Secret en Supabase

**Comando**:

```bash
# Leer el archivo base64 del DER y configurar en Supabase
supabase secrets set QZ_PRIVATE_KEY_B64="$(cat qz-private.pk8.der.b64)"
```

O desde Supabase Dashboard: Settings → Edge Functions → Secrets → Agregar `QZ_PRIVATE_KEY_B64` con el contenido del archivo `qz-private.pk8.der.b64`.

**IMPORTANTE**:
- ✅ Usar formato PKCS#8 en DER (binario, no PEM)
- ✅ Guardar DER como base64 en secret (QZ_PRIVATE_KEY_B64)
- ✅ WebCrypto importKey("pkcs8") requiere DER, no PEM
- ❌ NO usar formato PEM para WebCrypto
- ❌ NO usar formato PKCS#1 directamente

### Instalar Certificado en QZ Tray

**Pasos**:

1. Abrir QZ Tray
2. Click derecho en icono de bandeja → Advanced → Security → Certificates
3. Click "Import" → Seleccionar `qz-certificate.p12`
4. Password: `changeit` (o el que usaste al crear el .p12)
5. Verificar que aparece en la lista de certificados confiables

### Deploy Edge Function

```bash
supabase functions deploy qz-sign
```

### Validación

1. **Verificar firma remota**: Abrir consola del navegador, cargar página admin, verificar que no hay errores de firma
2. **Conectar a QZ**: Hacer clic en imprimir, verificar que aparece popup "Remember this decision" habilitado
3. **Aceptar una vez**: Aceptar permisos y marcar "Remember this decision"
4. **Imprimir nuevamente**: Verificar que NO aparecen más popups
5. **Listar impresoras**: Verificar que `qz.printers.find()` funciona sin popups
6. **Imprimir prueba**: Ejecutar impresión real y verificar éxito

### Consideraciones de Seguridad

- ✅ Llave privada NUNCA en frontend (solo en Supabase secrets como base64)
- ✅ Formato PKCS#8 DER (binario) requerido por WebCrypto (no PEM, no PKCS#1)
- ✅ Almacenamiento como base64 del DER evita problemas de saltos de línea
- ✅ Endpoint requiere autenticación (verificar session válida)
- ✅ Certificado autofirmado es aceptable para uso interno
- ✅ Para producción, considerar certificado firmado por CA para mejor seguridad