# Instrucciones: Generar Base64 Válido para QZ_PRIVATE_KEY_B64

## ✅ Script Creado

**Archivo:** `scripts/generate-qz-private-key-b64.mjs`

**Características:**
- ✅ Usa ES Modules (import, no require)
- ✅ Extrae automáticamente el bloque PEM limpio (elimina "Bag Attributes")
- ✅ Valida que el PEM comience con `-----BEGIN PRIVATE KEY-----` o `-----BEGIN RSA PRIVATE KEY-----`
- ✅ Valida que NO contenga metadata de PKCS12 ("Bag Attributes", "localKeyID")
- ✅ Valida que el base64 decodificado sea correcto
- ✅ Aborta con error claro si algo está mal

## 🚀 Ejecución en Windows (PowerShell)

### Opción 1: Usar archivo automático (recomendado)

```powershell
cd "E:\PROYECTOS\CATALOGO DEFINITIVO"
node scripts/generate-qz-private-key-b64.mjs
```

El script buscará automáticamente:
1. `qz-private-key.pem` (prioridad)
2. `qz-private-from-p12.pem` (fallback)

### Opción 2: Especificar archivo manualmente

```powershell
cd "E:\PROYECTOS\CATALOGO DEFINITIVO"
node scripts/generate-qz-private-key-b64.mjs ruta/al/archivo.pem
```

## 📋 Output Esperado

El script mostrará:

```
🔐 Generador de Base64 para QZ_PRIVATE_KEY_B64

📄 Leyendo archivo: E:\PROYECTOS\CATALOGO DEFINITIVO\qz-private-key.pem

✅ PEM válido detectado
   Tipo: PKCS#8
   Longitud: 1703 caracteres
   Primeras líneas:
   -----BEGIN PRIVATE KEY-----
   MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDqgrDBLNKfZ9gd
   ...
   Últimas líneas:
   ...
   -----END PRIVATE KEY-----

✅ Base64 generado y validado correctamente
   Longitud base64: 2272 caracteres
   Validación: Decodifica a PEM válido que comienza con -----BEGIN

📋 Copia este valor y pégalo en Supabase Secrets como QZ_PRIVATE_KEY_B64:

────────────────────────────────────────────────────────────────────────────────
[Base64 aquí]
────────────────────────────────────────────────────────────────────────────────
```

## ⚠️ Validaciones Automáticas

El script valida automáticamente:

1. ✅ **Archivo existe** - Si no existe, muestra error con archivos buscados
2. ✅ **PEM válido** - Extrae solo el bloque BEGIN/END PRIVATE KEY
3. ✅ **Sin metadata** - Rechaza PEMs con "Bag Attributes" o "localKeyID"
4. ✅ **Formato correcto** - Verifica que comience con `-----BEGIN` y termine con `-----END`
5. ✅ **Base64 válido** - Decodifica y verifica que el resultado sea un PEM válido
6. ✅ **Round-trip** - Verifica que el PEM decodificado sea igual al original

## ❌ Errores Comunes y Soluciones

### Error: "No se encontró archivo PEM válido"

**Solución:**
1. Extraer clave privada desde .p12:
   ```bash
   openssl pkcs12 -in C:\qz\qz-certificate.p12 -nocerts -nodes -out qz-private-key.pem -passin pass:changeit
   ```
2. O especificar ruta manualmente:
   ```powershell
   node scripts/generate-qz-private-key-b64.mjs C:\ruta\al\archivo.pem
   ```

### Error: "PEM contiene metadata de PKCS12 (Bag Attributes)"

**Causa:** El archivo PEM extraído desde .p12 incluye metadata.

**Solución:** El script automáticamente extrae solo el bloque BEGIN/END. Si aún falla:
1. Abrir el archivo PEM en un editor de texto
2. Copiar SOLO el bloque entre `-----BEGIN PRIVATE KEY-----` y `-----END PRIVATE KEY-----`
3. Guardar en un nuevo archivo
4. Ejecutar el script con ese archivo limpio

### Error: "El base64 generado NO decodifica a un PEM válido"

**Causa:** El archivo PEM está corrupto o no es válido.

**Solución:**
1. Verificar que el PEM sea válido con OpenSSL:
   ```bash
   openssl pkey -in qz-private-key.pem -check
   ```
2. Si falla, regenerar desde el .p12

## 📝 Pasos Post-Generación

1. **Copiar el base64** mostrado por el script (sin saltos de línea)

2. **Ir a Supabase Dashboard:**
   - URL: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions
   - O: Dashboard → Settings → Edge Functions → Secrets

3. **Buscar o crear `QZ_PRIVATE_KEY_B64`**

4. **Pegar el base64** (el string completo, sin espacios ni saltos de línea)

5. **Guardar**

6. **Redeployar Edge Function:**
   ```bash
   supabase functions deploy qz-sign
   ```

## ✅ Verificación Final

Después de actualizar y redeployar:

1. Abrir `http://localhost:5500/admin/closed-orders.html`
2. Abrir consola (F12)
3. Intentar imprimir
4. Verificar que NO aparezca "Error: Failed to sign request"
5. Verificar que QZ Tray NO muestre "anonymous request"
6. Verificar que "Remember this decision" esté habilitado

## 🔍 Base64 Generado (Ejemplo)

El base64 generado debe:
- Tener ~2272 caracteres (para RSA-2048)
- Decodificar a un PEM que comience con `-----BEGIN PRIVATE KEY-----`
- NO contener saltos de línea en el base64 mismo
- Ser un string continuo sin espacios

**Ejemplo de formato correcto:**
```
LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRRHFnckRCTE5LZlo5Z2QKV2tSSHBxSWJuRVVRa3lhTHd2T1lKcnBrdXVwZ1lGZzJ0WDM4SkRnMTVkSDcvUUxaL2l2R0hUTVNjM3BqdExYUQo...
```

## 📌 Notas Técnicas

### Por qué es crítico el formato

- `crypto.subtle.importKey()` requiere un PEM limpio sin metadata
- "Bag Attributes" es metadata del PKCS12, no parte del PEM válido
- Si el base64 incluye metadata, `importKey()` fallará con error críptico
- El script valida esto automáticamente para evitar errores en producción

### Diferencia entre PEMs

- **PKCS#1 (RSA):** `-----BEGIN RSA PRIVATE KEY-----`
- **PKCS#8:** `-----BEGIN PRIVATE KEY-----` ← **Este es el que usa el script**
- Ambos son válidos, pero PKCS#8 es más moderno

El script detecta automáticamente el tipo y lo reporta en el output.

