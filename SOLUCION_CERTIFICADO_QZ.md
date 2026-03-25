# Solución: "Failed to get certificate: undefined" en QZ Tray

## Problema
QZ Tray muestra el error "Failed to get certificate: undefined" aunque:
- ✅ El certificado está importado en Windows Certificate Manager
- ✅ La firma remota está configurada y funcionando
- ❌ "Remember this decision" sigue deshabilitado

## Causa
QZ Tray busca el certificado en su propio Site Manager, no en Windows Certificate Manager. Aunque el certificado está en Windows, QZ Tray no lo detecta automáticamente.

## Solución: Configurar QZ Tray para usar el certificado de Windows

### Opción 1: Importar el certificado en QZ Tray Site Manager (Recomendado)

1. **Abrir QZ Tray Site Manager**:
   - Click derecho en QZ Tray → **Advanced** → **Site Manager...**

2. **Agregar sitio confiable**:
   - Click en **"Add"** o **"+"** (si está disponible)
   - O busca un menú con opciones como **"Browse..."** o **"Import Certificate"**

3. **Si no hay opción de importar directamente**:
   - Intenta hacer doble click en un sitio existente
   - O busca un botón **"Edit"** o **"Properties"**
   - Busca una opción para **"Select Certificate"** o **"Choose Certificate"**

4. **Seleccionar certificado de Windows**:
   - Si aparece un diálogo de selección de certificado, busca **"QZ Tray Certificate"**
   - O busca el certificado con CN="QZ Tray Certificate", O="Catalogo FYL"

5. **Guardar y reiniciar QZ Tray**

### Opción 2: Configurar QZ Tray para usar certificado del almacén de Windows

1. **Abrir configuración avanzada de QZ Tray**:
   - Click derecho en QZ Tray → **Advanced** → **Preferences...** (si está disponible)

2. **Buscar opción de certificado**:
   - Busca una sección de **"Security"** o **"Certificates"**
   - Busca una opción como **"Use Windows Certificate Store"** o **"Auto-detect certificates"**

3. **Habilitar detección automática** (si está disponible)

### Opción 3: Verificar que el certificado esté en el almacén correcto

1. **Abrir Certificate Manager** (`certmgr.msc`)

2. **Verificar ubicación del certificado**:
   - El certificado debe estar en: **Personal** → **Certificados**
   - Si está en otro lugar, muévelo a **Personal**

3. **Verificar que el certificado tenga la llave privada**:
   - Click derecho en el certificado → **Todas las tareas** → **Administrar claves privadas**
   - Debe mostrar que tiene una llave privada asociada

### Opción 4: Regenerar e importar el certificado nuevamente

Si ninguna de las opciones anteriores funciona:

1. **Eliminar el certificado actual de Windows**:
   - Abrir `certmgr.msc`
   - Ir a **Personal** → **Certificados**
   - Eliminar "QZ Tray Certificate" si existe

2. **Regenerar el certificado**:
   ```bash
   cd "E:\PROYECTOS\CATALOGO DEFINITIVO"
   node scripts/generate-qz-cert.js
   ```

3. **Importar nuevamente en Windows** (siguiendo los pasos anteriores)

4. **Intentar importar en QZ Tray Site Manager** nuevamente

## Verificación

Después de aplicar la solución:

1. **Reiniciar QZ Tray completamente**
2. **Abrir** `http://localhost:5500/admin/labels.html`
3. **Intentar imprimir una etiqueta**
4. **Verificar en la consola**:
   - No debe aparecer "Failed to get certificate: undefined"
   - Debe aparecer "Firma remota configurada"
   - Debe aparecer "Firmando request QZ"
   - Debe aparecer "Firma generada correctamente"
5. **Verificar en el popup de QZ Tray**:
   - "Remember this decision" debe estar **habilitado** (no gris)
   - Debe poder marcarse

## Nota Importante

Si después de todos estos pasos el error persiste:
- ✅ La **firma remota seguirá funcionando** (puedes imprimir)
- ❌ "Remember this decision" puede seguir deshabilitado
- Esto es una limitación de QZ Tray cuando no puede detectar el certificado localmente

En este caso, tendrás que aceptar los popups cada vez, pero la impresión funcionará correctamente.






