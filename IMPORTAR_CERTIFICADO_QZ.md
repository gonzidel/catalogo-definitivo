# Cómo Importar el Certificado en QZ Tray

## ⚠️ IMPORTANTE:
- **NO uses el asistente de Windows** que aparece al hacer doble click en el archivo
- **NO uses "certmgr.msc"** (Administrador de certificados de Windows)
- **DEBES usar el Site Manager de QZ Tray** para importar el certificado

## 📍 Ubicación del archivo:
```
E:\PROYECTOS\CATALOGO DEFINITIVO\qz-certificate.p12
```

## 🔧 Pasos correctos para importar:

### Paso 1: Abrir el Site Manager de QZ Tray
1. Click derecho en el icono de QZ Tray (en la bandeja del sistema)
2. Selecciona: **Advanced** → **Site Manager...**

### Paso 2: Importar el certificado desde QZ Tray
1. En el Site Manager, haz click en el botón que abre el menú (el que tiene el "+" o el menú desplegable)
2. Selecciona **"Browse..."** (NO "Create New...")
3. En el diálogo de archivos de QZ Tray:
   - En la barra de direcciones (arriba), pega: `E:\PROYECTOS\CATALOGO DEFINITIVO`
   - Presiona Enter
   - Cambia el filtro "Tipo de archivo:" a **"Todos los archivos (*.*)"**
   - Busca el archivo `qz-certificate.p12` en la lista
   - Selecciónalo y haz click en "Abrir"

### Paso 3: Si no aparece en la lista
- En el campo "Nombre de archivo:" (abajo del diálogo), escribe:
  ```
  E:\PROYECTOS\CATALOGO DEFINITIVO\qz-certificate.p12
  ```
- Presiona Enter o haz click en "Abrir"

### Paso 4: Contraseña
- Cuando QZ Tray pida contraseña, ingresa: `changeit`

## ⚠️ Notas importantes:

- **"Browse..."** = Para importar un archivo existente (lo que necesitas)
- **"Create New..."** = Para crear un certificado nuevo (NO lo uses)
- **NO hagas doble click** en el archivo `.p12` - eso abre el asistente de Windows (incorrecto)
- **DEBES usar el Site Manager de QZ Tray** para importar el certificado

## 🔄 Solución: Archivo copiado al Escritorio

El archivo ya está copiado en tu **Escritorio** para facilitar el acceso.

### Cómo encontrarlo en el diálogo de QZ Tray:

1. **En el Site Manager de QZ Tray, haz click en "Browse..."**

2. **En el diálogo de archivos:**
   - En el panel izquierdo, busca y haz click en **"Escritorio"** o **"Desktop"**
   - O navega usando las carpetas: **"Este equipo"** → **"C:"** → **"Users"** → **"gonzi"** → **"OneDrive"** → **"Escritorio"**
   - Cambia el filtro "Tipo de archivo:" a **"Todos los archivos (*.*)"**
   - Deberías ver `qz-certificate.p12` en la lista

3. **Si no aparece:**
   - Asegúrate de que el filtro esté en "Todos los archivos (*.*)"
   - Verifica que estés en la carpeta correcta (Escritorio)
   - El archivo se llama exactamente: `qz-certificate.p12`

### Ubicaciones del archivo:

- **Escritorio:** `C:\Users\gonzi\OneDrive\Escritorio\qz-certificate.p12` ✅ (MÁS FÁCIL)
- **Original:** `E:\PROYECTOS\CATALOGO DEFINITIVO\qz-certificate.p12`

