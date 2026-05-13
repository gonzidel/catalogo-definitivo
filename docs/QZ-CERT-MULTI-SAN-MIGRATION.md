# Migración: certificado QZ Tray multi-SAN (trust por origen)

Cuando la firma ya es válida pero QZ muestra **Untrusted Website**, **Remember this decision** no persiste y **Site Manager** queda vacío, el navegador **no confía** en que el certificado entregado por HTTPS (`/certs/qz-site.crt`) corresponde al **origen** real de la página (`https://host/admin/...`). La solución es un certificado X.509 con **Subject Alternative Name (SAN)** que incluya **todos** los hostnames desde los que se usa el admin con QZ.

Este documento no modifica el frontend ni `qz-connect`; describe solo certificados, secretos y despliegue.

---

## FASE 1 — Auditoría de orígenes (FYL)

Orígenes **relevantes para QZ** (el **Origin** del documento que abre `qz-tray.js`; QZ compara el sitio con el certificado servido).

| Origen | Uso | Incluir en SAN |
|--------|-----|----------------|
| `http://localhost` (p. ej. :5500, :8080) | Live Server / dev | `localhost`, `*.localhost`, `127.0.0.1` |
| `http://127.0.0.1` | Dev | `127.0.0.1` |
| `https://catalogo-fyl.web.app` | Firebase Hosting prod | Sí |
| `https://catalogo-fyl.firebaseapp.com` | Alias Firebase prod | Sí |
| `https://catalogo-fyl-test.web.app` | Firebase Hosting test | Sí |
| `https://catalogo-fyl-test.firebaseapp.com` | Alias Firebase test | Sí |
| `https://fylmoda.com.ar` | Dominio custom (si sirve el mismo hosting) | Sí |
| `https://www.fylmoda.com.ar` | Variante www | Sí |
| `*.web.app` / `*.firebaseapp.com` (wildcard DNS en SAN) | Previews u otros subdominios Firebase | Opcional recomendado |

**No** hace falta poner `*.supabase.co` en el certificado del **sitio**: el usuario no navega la Edge Function como “origen” de la página; el origen sigue siendo Firebase / dominio custom. El certificado QZ es el que sirve **tu hosting** en `/certs/qz-site.crt`.

**CORS de `qz-sign` (Edge Function):** si imprimís desde un origen HTTPS nuevo (p. ej. solo `https://fylmoda.com.ar`), además del SAN hay que tener ese origen en `ALLOWED_ORIGINS` en `supabase/functions/qz-sign/index.ts`; si no, el fetch a firmar falla por CORS **antes** de que QZ valide el certificado.

---

## FASE 2 — Generar nuevo set (OpenSSL)

Archivos en repo:

- `scripts/openssl-qz-tray-san.cnf` — lista SAN editable.
- `scripts/generate-qz-tray-cert-bundle.ps1` — genera todo en una carpeta segura y opcionalmente copia certs públicos.

### Comando recomendado (una sola pasada)

Desde la raíz del repo, en PowerShell:

```powershell
.\scripts\generate-qz-tray-cert-bundle.ps1 -DeployPublicCerts
```

- Crea una carpeta bajo `%TEMP%` con: `qz-tray-private.pem`, `qz-certificate.p12`, `QZ_PRIVATE_KEY_B64.txt`, etc.
- Copia el **mismo** PEM del certificado a `certs/qz-site.crt` y `certs/override.crt` (PEM limpio, apto para Firebase y para `authcert.override`).

**Antes de ejecutar:** revisá `scripts/openssl-qz-tray-san.cnf` y agregá DNS si tenés otro dominio (preview channel, etc.).

### Qué se genera

| Artefacto | Descripción |
|-----------|-------------|
| `qz-tray-private.pem` | RSA 2048 — **no** subir a git (`.gitignore` cubre `*.pem`) |
| `qz-tray-cert.pem` | Certificado autofirmado con SAN |
| `qz-certificate.p12` | PKCS#12 (password por defecto `changeit`) para import en QZ Tray / respaldo |
| `private.pk8.der` + `QZ_PRIVATE_KEY_B64.txt` | PKCS#8 DER en Base64 → secreto `QZ_PRIVATE_KEY_B64` en Supabase |
| `certs/qz-site.crt` | Cert público servido por Hosting |
| `certs/override.crt` | Igual que el PEM del cert (provisioning local QZ) |

Compatibilidad:

- **Deno** `crypto.subtle.importKey("pkcs8", ...)` — el `.txt` es DER PKCS#8 en Base64, igual que el flujo actual.
- **Edge Function** — sin cambios de lógica; solo rotás el secreto.
- **Localhost / prod** — SAN cubre dev y hosts listados.

---

## FASE 3 — Regenerar secreto Supabase

1. Abrí el archivo `QZ_PRIVATE_KEY_B64.txt` generado en la carpeta `%TEMP%` (la ruta la imprime el script).
2. En Supabase Dashboard: **Project Settings → Edge Functions → Secrets**.
3. Actualizá **`QZ_PRIVATE_KEY_B64`** con el contenido **completo** del archivo (una línea, sin espacios).

**No** pegues la clave PEM; debe ser el Base64 del DER PKCS#8.

---

## FASE 4 — Redeploy

1. **Firebase Hosting** — desplegá para publicar el nuevo `certs/qz-site.crt`:

   ```bash
   firebase deploy --only hosting
   ```

   (o tu flujo habitual; `firebase.json` ya permite `certs/qz-site.crt`.)

2. **Edge Function `qz-sign`** — para que el runtime tome el nuevo secreto:

   ```bash
   supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
   ```

3. **CORS** — si usás orígenes que no están en `ALLOWED_ORIGINS`, agregá líneas en `supabase/functions/qz-sign/index.ts` y volvé a desplegar la función. Ejemplo:

   - `https://fylmoda.com.ar`
   - `https://www.fylmoda.com.ar`

---

## FASE 5 — Plan de migración operativa

### 1. Archivos a reemplazar / actualizar

| Qué | Dónde |
|-----|--------|
| Certificado público | `certs/qz-site.crt` (repo + deploy Hosting) |
| Override local QZ | `certs/override.crt` (repo; copia local en PC → `authcert.override` en QZ) |
| PKCS#12 de referencia | Copiar `qz-certificate.p12` del `%TEMP%` a `C:\qz\` (u otra ruta que uses) — **no** suele ir al repo (`firebase.json` ignora `*.p12`) |
| Secreto | `QZ_PRIVATE_KEY_B64` en Supabase |

### 2. Secret

Solo **`QZ_PRIVATE_KEY_B64`** (nuevo valor desde el bundle). **`QZ_SIGN_SECRET`** no cambia salvo que lo rotes vos.

### 3. Redeploy

- `firebase deploy --only hosting`
- `supabase functions deploy qz-sign --project-ref <tu-ref>`

### 4. Limpiar trust viejo (Windows)

1. Cerrar **QZ Tray** por completo.
2. Opcional: respaldar `%APPDATA%\qz` y luego eliminar o renombrar `allowed.dat` / datos de sitios según versión (forzar que QZ vuelva a aprender el sitio).
3. Actualizar **`qz-tray.properties`** si usás `authcert.override` — debe apuntar al **nuevo** `override.crt` (misma huella que el nuevo `qz-site.crt` desplegado).
4. Copiar el nuevo `override.crt` a la ruta que usa QZ (p. ej. `C:\Program Files\QZ Tray\auth\override.crt`).
5. Reiniciar **QZ Tray** como administrador si cambiaste archivos bajo Program Files.

### 5. Validación

| Comprobación | Criterio |
|--------------|----------|
| **Remember persiste** | Tras “Allow”, cerrar el diálogo y recargar la página: no debe pedir de nuevo para el mismo origen (certificado coincide con SAN del host). |
| **`allowed.dat`** | En `%APPDATA%\qz` debería actualizarse al aceptar el sitio (nombre exacto según versión de QZ). |
| **Site Manager** | Debería listar el sitio/origen tras confiar o importar `.p12`. |
| **Untrusted Website** | Debe desaparecer cuando el host de la barra de direcciones está en el SAN y servís el cert nuevo en `/certs/qz-site.crt`. |
| **Firma** | Sigue válida si clave y cert son del mismo bundle (`MATCH` en script de regeneración desde `.p12`). |

### Verificación rápida del cert desplegado

```powershell
Invoke-WebRequest "https://TU-DOMINIO/certs/qz-site.crt" -OutFile $env:TEMP\qz-site-remote.crt
openssl x509 -in $env:TEMP\qz-site-remote.crt -noout -text | findstr /i "Subject Alternative Name"
```

Debe listar tus DNS e IP esperados.

---

## Notas importantes

- **Wildcard `*.web.app`**: cubre un solo etiqueta (ej. `catalogo-fyl.web.app`). No sustituye enumerar dominios custom (`fylmoda.com.ar`).
- **Un solo par clave/cert**: si regenerás el cert en Hosting pero olvidás actualizar `QZ_PRIVATE_KEY_B64`, volverá **Invalid Signature**.
- Este flujo **no** sustituye políticas del navegador ni modo incógnito; “Remember” puede no persistir si el perfil bloquea almacenamiento o hay políticas corporativas.

---

## Referencias internas

- Provisioning local: `docs/QZ-TRAY-LOCAL-TRUST-WINDOWS.md`
- Regenerar solo B64 desde `.p12` existente: `scripts/regenerate-qz-private-key-b64-from-p12.ps1`
