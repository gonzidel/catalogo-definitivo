# Importación de Certificado QZ Tray - Guía Precisa

## 🔍 Diagnóstico del Estado Actual

**Certificado:**
- ✅ Ubicación: `C:\qz\qz-certificate.p12`
- ✅ Formato: PKCS#12 (.p12)
- ✅ Contraseña: `changeit`
- ✅ Generado con OpenSSL (válido)

**Problema identificado:**
- QZ Tray Site Manager requiere importación explícita del certificado
- El certificado debe asociarse al dominio/sitio para habilitar "Remember this decision"
- Conflicto potencial: permisos de ejecución (admin vs usuario normal)

---

## ✅ Checklist de Importación (Paso a Paso)

### Paso 1: Verificar QZ Tray en Ejecución

1. **Verificar que QZ Tray esté corriendo:**
   - Buscar icono de QZ Tray en la bandeja del sistema (systray)
   - Si no está, iniciarlo normalmente (NO como administrador)

2. **Verificar versión de QZ Tray:**
   - Click derecho en QZ Tray → **About**
   - Anotar versión (debe ser 2.2.0 o superior)

### Paso 2: Abrir Site Manager

1. **Click derecho en el icono de QZ Tray** (bandeja del sistema)
2. **Seleccionar:** `Advanced` → `Site Manager...`
3. Se abrirá la ventana "Site Manager"

### Paso 3: Importar Certificado (Método Correcto)

**⚠️ IMPORTANTE: Usar "Browse", NO "Create New"**

1. **En la ventana Site Manager, buscar el botón "Add" o "+"**
   - Generalmente está en la parte superior o inferior de la lista
   - Si no hay botón visible, buscar menú contextual (click derecho en lista vacía)

2. **Click en "Add" o "+"**
   - Aparecerán opciones:
     - **"Browse..."** (icono de carpeta verde) ← **USAR ESTA**
     - **"Create New..."** (icono de engranaje verde) ← NO usar

3. **Seleccionar "Browse..."**
   - Se abrirá el diálogo de selección de archivos

4. **Navegar a `C:\qz\`**
   - En el diálogo de archivos, ir a `C:\qz\`
   - **Si no ves el archivo:**
     - Cambiar filtro a "All Files (*.*)" o "PKCS12 (*.p12)"
     - Escribir manualmente: `qz-certificate.p12` en el campo de nombre

5. **Seleccionar `qz-certificate.p12` y click "Open"**

6. **Ingresar contraseña:**
   - Cuando pida contraseña, ingresar: `changeit`
   - Marcar "Remember password" si aparece la opción

7. **Verificar importación:**
   - El certificado debe aparecer en la lista de "Sites permanently allowed access"
   - Debe mostrar detalles: Organization, Common Name, etc.

### Paso 4: Configurar el Sitio (Si es Necesario)

**Si el certificado aparece pero el sitio no está asociado:**

1. **Identificar el dominio de tu aplicación:**
   - `http://localhost:5500` (desarrollo)
   - `https://catalogo-fyl.web.app` (producción)
   - O el dominio que uses

2. **En Site Manager:**
   - Buscar el sitio en la lista (puede estar como "localhost" o el dominio)
   - Si no existe, agregarlo manualmente:
     - Click "Add" → "Create New..."
     - Ingresar el dominio (ej: `localhost:5500`)
     - Seleccionar el certificado importado

3. **Asociar certificado al sitio:**
   - Doble click en el sitio de la lista
   - O click derecho → "Properties" / "Edit"
   - Seleccionar el certificado importado en "Certificate" o "Site Certificate"
   - Guardar

### Paso 5: Reiniciar QZ Tray

1. **Cerrar QZ Tray completamente:**
   - Click derecho en QZ Tray → **Exit**
   - Verificar que el proceso se cerró (Task Manager si es necesario)

2. **Reiniciar QZ Tray:**
   - Iniciar QZ Tray normalmente (NO como administrador)
   - Verificar que el icono aparezca en la bandeja

### Paso 6: Verificar Funcionamiento

1. **Abrir la aplicación web:**
   - Navegar a `http://localhost:5500/admin/labels.html`
   - Abrir consola del navegador (F12)

2. **Intentar imprimir una etiqueta**

3. **Verificar en consola:**
   ```
   ✅ Firma remota configurada para QZ Tray
   🔐 QZ Tray solicitó firma. Longitud: [número]
   ✅ Firma generada correctamente
   ✅ QZ Tray conectado
   ```

4. **Verificar en popup de QZ Tray:**
   - Debe aparecer popup de confirmación
   - **"Remember this decision" debe estar HABILITADO** (no gris)
   - Marcar la casilla y click "Allow"

5. **Verificar persistencia:**
   - Cerrar y reabrir la aplicación
   - Intentar imprimir nuevamente
   - **NO debe aparecer popup** (si "Remember" funcionó)

---

## ⚠️ Conflictos Potenciales y Soluciones

### Conflicto 1: QZ Tray como Admin vs Navegador Normal

**Problema:**
- Si QZ Tray corre como administrador y el navegador como usuario normal, hay conflicto de permisos
- El certificado importado puede no ser visible para el navegador

**Solución:**
- **QZ Tray debe correr como usuario normal** (NO como administrador)
- Si está como admin, cerrarlo y reiniciarlo normalmente
- Verificar en Task Manager: proceso `qz-tray.exe` debe estar bajo tu usuario, no SYSTEM

### Conflicto 2: Ubicación del Certificado

**Problema:**
- QZ Tray puede no encontrar el certificado si está en rutas con espacios o caracteres especiales
- Ya está resuelto: certificado en `C:\qz\` (ruta simple)

**Verificación:**
- El certificado en `C:\qz\qz-certificate.p12` es accesible
- No requiere cambios adicionales

### Conflicto 3: Formato PKCS12

**Problema:**
- Algunas versiones de QZ Tray pueden tener problemas con certificados PKCS12 generados con algoritmos específicos

**Verificación:**
- El certificado fue generado con OpenSSL estándar
- Si falla la importación, puede ser necesario regenerar con parámetros específicos

**Si falla la importación:**
```bash
# Regenerar con algoritmo específico
openssl pkcs12 -export -out C:\qz\qz-certificate.p12 -inkey qz-private-key.pem -in qz-certificate.crt -passout pass:changeit -name "QZ Tray Certificate" -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1
```

### Conflicto 4: Certificado No Asociado al Sitio

**Problema:**
- El certificado está importado pero no asociado al dominio específico
- QZ Tray no sabe qué certificado usar para qué sitio

**Solución:**
- Verificar en Site Manager que el sitio (localhost:5500 o tu dominio) tenga el certificado asociado
- Si no, seguir Paso 4 arriba

---

## 🔧 Troubleshooting Específico

### Error: "Import failed" en Site Manager

**Causa:** QZ Tray rechazó el certificado

**Solución:**
1. Verificar que el archivo no esté corrupto:
   ```powershell
   Get-FileHash C:\qz\qz-certificate.p12
   ```
2. Verificar permisos del archivo:
   ```powershell
   icacls C:\qz\qz-certificate.p12
   ```
   Debe mostrar acceso de lectura para tu usuario
3. Si persiste, regenerar certificado (ver Conflicto 3)

### Error: "Remember this decision" sigue deshabilitado

**Causa:** Certificado no está correctamente asociado al sitio

**Solución:**
1. Verificar en Site Manager que el sitio tenga certificado asociado
2. Verificar que QZ Tray NO esté corriendo como administrador
3. Reiniciar QZ Tray completamente
4. Si persiste, puede ser limitación de QZ Tray con firma remota (la impresión funcionará igual)

### Error: "Failed to get certificate: undefined"

**Causa:** Problema con la firma remota, NO con el certificado importado

**Solución:**
- Este error es de la Edge Function de Supabase, no del certificado local
- Verificar que `QZ_PRIVATE_KEY_B64` esté configurado en Supabase
- Verificar que la Edge Function `qz-sign` esté deployada
- Ver `CONFIGURACION_SUPABASE_QZ.md` para más detalles

---

## 📋 Resumen de Pasos Críticos

1. ✅ Certificado en `C:\qz\qz-certificate.p12` (válido)
2. ✅ QZ Tray corriendo como usuario normal (NO admin)
3. ✅ Site Manager → Add → **Browse** (NO Create New)
4. ✅ Seleccionar `C:\qz\qz-certificate.p12`
5. ✅ Contraseña: `changeit`
6. ✅ Asociar certificado al sitio (localhost:5500 o tu dominio)
7. ✅ Reiniciar QZ Tray completamente
8. ✅ Verificar que "Remember this decision" esté habilitado

---

## 🎯 Resultado Esperado

Después de seguir estos pasos:

- ✅ Certificado importado en Site Manager
- ✅ Sitio marcado como trusted
- ✅ "Remember this decision" habilitado en popups
- ✅ Impresión funciona sin bloqueos
- ✅ Popups desaparecen después de aceptar una vez

Si después de todos estos pasos "Remember this decision" sigue deshabilitado, es una limitación conocida de QZ Tray cuando usa firma remota. La impresión funcionará correctamente, solo tendrás que aceptar los popups cada vez.



