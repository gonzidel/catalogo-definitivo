# QZ Tray: trust local para certificado autofirmado (Windows)

FYL usa el mismo material público que `certs/qz-site.crt`. Este documento describe cómo registrar ese certificado como **override de autenticación** en QZ Tray **sin** recompilar QZ ni cambiar el sitio web.

Referencias oficiales: [Provisioning](https://qz.io/docs/provisioning) (tipo `ca` → `authcert.override`), [Command line](https://qz.io/docs/command-line) (`qz-tray.properties` en carpeta de la aplicación).

---

## FASE 1 — Archivo `override.crt` (repo)

- **Origen:** `certs/qz-site.crt` (mismo certificado X.509).
- **Generado en repo:** `certs/override.crt` — solo bloque PEM (`-----BEGIN CERTIFICATE-----` … `-----END CERTIFICATE-----`), sin *Bag Attributes* ni texto extra.
- **Verificación:** misma huella SHA-256 que `qz-site.crt`:

```text
sha256 Fingerprint=92:9C:01:5C:ED:4D:84:39:AF:71:B0:5D:FA:75:C2:98:49:CF:B2:46:9F:BA:ED:C5:73:BF:DF:C6:10:8F:8C:44
```

Comprobar en tu PC:

```powershell
openssl x509 -in certs\override.crt -noout -text -fingerprint -sha256
openssl x509 -in certs\qz-site.crt -noout -fingerprint -sha256
```

Las huellas deben coincidir.

---

## FASE 2 — Ubicación real de `qz-tray.properties` (Windows)

| Contexto | Ruta típica |
|----------|-------------|
| **Propiedades de instalación (system)** | `qz-tray.properties` en la carpeta de instalación de QZ Tray |
| **Instalación por defecto 64 bits** | `C:\Program Files\QZ Tray\` |
| **Instalación 32 bits (si aplica)** | `C:\Program Files (x86)\QZ Tray\` |
| **Datos de usuario** | `%APPDATA%\qz` (p. ej. `allowed.dat`, `prefs.properties`) — **no** es el lugar principal de `authcert.override` según documentación de *property* / provisioning |

En la aplicación: **QZ Tray → Advanced → Diagnostic → Browse App Folder** abre la carpeta donde debe estar `qz-tray.properties` (y donde conviene colocar recursos referenciados con ruta absoluta).

**Importante:** en Windows la propiedad debe usar **ruta absoluta** y, en el archivo `.properties`, barras invertidas **dobles**. Ejemplo:

```properties
authcert.override=C:\\Program Files\\QZ Tray\\auth\\override.crt
```

Si el archivo `qz-tray.properties` ya existe, **añadí solo esta línea** (o editá la existente). No reemplaces el archivo entero si contiene otras opciones.

Referencia: discusión en [qzind/tray#105](https://github.com/qzind/tray/issues/105) (rutas relativas / working directory).

---

## FASE 3 — Instalación local de `override.crt`

### Dónde copiar

Convención recomendada (una sola máquina / despliegue manual):

1. Crear carpeta si no existe: `C:\Program Files\QZ Tray\auth\`
2. Copiar el archivo del repo **`certs\override.crt`** a:  
   **`C:\Program Files\QZ Tray\auth\override.crt`**

### Permisos y administrador

- Escribir en **`C:\Program Files\QZ Tray\`** suele requerir **elevación (Ejecutar como administrador)** en el Explorador de archivos, PowerShell o `copy`.
- El usuario que usa el navegador y QZ Tray puede ser el mismo; no hace falta que sea admin para **usar** QZ después de copiar.

### Reinicio de QZ Tray

1. Clic derecho en el icono de QZ Tray → **Exit** / salir por completo.
2. Comprobar en el administrador de tareas que no quede proceso `QZ Tray` / Java asociado.
3. Iniciar QZ Tray de nuevo desde el menú Inicio.

Sin reinicio completo, los cambios en `qz-tray.properties` o el certificado override pueden no aplicarse.

---

## FASE 4 — Reset limpio de trust (si sigue comportamiento raro)

1. Cerrar QZ Tray por completo (pasos anteriores).
2. En QZ Tray (al volver a abrir): usar opciones de **Advanced** relacionadas con certificados / sitios si están disponibles en tu versión, o:
   - Revisar `%APPDATA%\qz` y respaldar luego **eliminar** (solo si sabés qué hacés) archivos como `allowed.dat` / entradas de sitios guardados — **preferible** hacer copia de respaldo de `%APPDATA%\qz` antes.
3. Documentación / soporte QZ también menciona limpieza de certificados guardados desde la UI (**Site Manager**, etc.) según versión.
4. Volver a colocar `override.crt` en `C:\Program Files\QZ Tray\auth\override.crt`.
5. Confirmar que `qz-tray.properties` contiene la línea `authcert.override=...` correcta.
6. Reiniciar QZ Tray.
7. Probar de nuevo desde el admin FYL (misma URL de siempre).

---

## FASE 5 — Validación

### Pasos exactos

1. Copiar `certs\override.crt` del repo → `C:\Program Files\QZ Tray\auth\override.crt` (admin).
2. Editar `C:\Program Files\QZ Tray\qz-tray.properties` y asegurar la línea `authcert.override` con ruta absoluta y `\\`.
3. Guardar; reiniciar QZ Tray.
4. Abrir consola del navegador; imprimir una vez; revisar si bajan avisos **Untrusted** / **Invalid Signature** (este último debería seguir ligado a firma/clave, no al override).

### Archivos y rutas (resumen)

| Archivo | Rol |
|---------|-----|
| Repo: `certs\override.crt` | PEM limpio = mismo cert que `qz-site.crt` |
| PC: `C:\Program Files\QZ Tray\auth\override.crt` | Copia local usada por QZ |
| PC: `C:\Program Files\QZ Tray\qz-tray.properties` | Debe contener `authcert.override=...` |

### Cómo saber si el override está activo

- Existe la línea en `qz-tray.properties` y la ruta apunta a un archivo PEM legible.
- Tras reinicio, en logs de QZ (Diagnostic / carpeta de logs de la app) suele constar carga de configuración; dependiendo de la versión, puede mencionarse certificado / override.
- Comportamiento esperado: menos bloqueos de **confianza** para el certificado **autofirmado** que coincide con el desplegado por FYL; **no** sustituye corregir `QZ_PRIVATE_KEY_B64` si hay **Invalid Signature** por clave incorrecta.

### Cómo confirmar que es el certificado FYL

- Huella SHA-256 del `override.crt` en disco debe ser:  
  `92:9C:01:5C:ED:4D:84:39:AF:71:B0:5D:FA:75:C2:98:49:CF:B2:46:9F:BA:ED:C5:73:BF:DF:C6:10:8F:8C:44`
- Debe coincidir con la del certificado servido en `https://<tu-dominio>/certs/qz-site.crt` (comando `openssl x509` sobre lo descargado).

---

## Plantilla: fragmento para `qz-tray.properties`

No sobrescribir el archivo completo. Añadir al final (o fusionar con lo existente):

```properties
# FYL: confiar certificado autofirmado del catálogo (mismo que qz-site.crt)
authcert.override=C:\\Program Files\\QZ Tray\\auth\\override.crt
```

Si tu instalación está en `Program Files (x86)`, ajustá **ambas** rutas de forma coherente.

---

## Notas FYL

- **No** sustituye **Site Manager** / aceptación explícita en algunos entornos; reduce fricción con certificados propios.
- Rotación de certificado en FYL: volver a generar `override.crt` desde el nuevo PEM, recopiar en las PCs y actualizar huellas esperadas.
- Este documento **no** modifica frontend, Edge Function ni `qzConnect` / firma remota.
