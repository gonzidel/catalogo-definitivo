# 🚀 Guía de Despliegue - Catálogo FYL en Firebase Hosting

Esta guía te ayudará a desplegar tu catálogo FYL en Firebase Hosting con un dominio gratuito para la etapa de pruebas.

## 📋 Requisitos Previos

Antes de comenzar, asegúrate de tener:

- ✅ Cuenta de Google (para Firebase)
- ✅ Node.js instalado (versión 14 o superior)
- ✅ Proyecto de Supabase configurado con productos
- ✅ Claves de Supabase (URL y ANON_KEY)

## 🔧 Paso 1: Instalar Firebase CLI

### Windows (PowerShell)

```powershell
npm install -g firebase-tools
```

### Verificar instalación

```powershell
firebase --version
```

Deberías ver un número de versión (ej: `13.0.0`).

## 🔐 Paso 2: Iniciar Sesión en Firebase

Ejecuta el siguiente comando y sigue las instrucciones en el navegador:

```powershell
firebase login
```

Esto abrirá tu navegador para autenticarte con tu cuenta de Google.

## 📦 Paso 3: Configurar el Proyecto

Si aún no has inicializado Firebase en tu proyecto, ejecuta:

```powershell
firebase init hosting
```

Cuando te pregunte:
- **Selecciona el proyecto**: Elige `catalogo-fyl` o crea uno nuevo
- **Directorio público**: Presiona Enter (usa `.` que es el directorio actual)
- **Configurar como SPA**: Responde **No** (ya está configurado en `firebase.json`)
- **Archivos a ignorar**: Presiona Enter (ya está configurado)

Si ya tienes `.firebaserc` configurado, puedes omitir este paso.

## 🔑 Paso 4: Configurar Variables de Entorno

Necesitas configurar las variables de entorno con tus credenciales de Supabase antes de desplegar.

### Obtener las Credenciales de Supabase

1. Ve a tu proyecto en [Supabase Dashboard](https://supabase.com/dashboard)
2. Navega a **Settings** → **API**
3. Copia los siguientes valores:
   - **Project URL** (ej: `https://xxxxx.supabase.co`)
   - **anon public** key (una clave JWT larga)

### Auth: URLs de redirección (OAuth y magic link)

El front envía `redirectTo` / `emailRedirectTo` con **`window.location.origin`** (misma máquina y puerto desde los que abriste la página). **Si esa URL no está en la lista de Supabase, Supabase la ignora y te manda al Site URL** (ej. `https://catalogo-fyl-test.web.app/#`) — por eso en localhost a veces “siempre” terminás en producción.

En **Authentication → URL configuration**:

- **Site URL**: puede ser tu dominio principal (ej. `https://catalogo-fyl-test.web.app`).
- **Redirect URLs**: agregá **todas** las que uses (producción + desarrollo), por ejemplo:
- `https://catalogo-fyl-test.web.app/index.html`
  - `https://catalogo-fyl-test.web.app/client/dashboard.html`
  - **En local, lo más simple:** `http://localhost:5500/**` y, si usás IP, `http://127.0.0.1:5500/**` (ajustá el puerto)
- O URLs exactas: `http://localhost:5500/index.html`, `http://localhost:5500/client/dashboard.html`, etc.

En consola (solo en localhost) el script imprime `[FYL Auth]` con la URL exacta que se está usando: copiala y agregala en Redirect URLs si falta.

También podés dejar entradas wildcard del tipo `https://catalogo-fyl-test.web.app/**` si tu plan lo permite (para dev, `http://localhost:5500/**` suele ayudar).

### Configurar Variables de Entorno

#### Opción A: Windows PowerShell (Recomendado)

Abre PowerShell en el directorio del proyecto y ejecuta:

```powershell
$env:SUPABASE_URL = "https://tu-proyecto.supabase.co"
$env:SUPABASE_ANON_KEY = "tu-clave-anon-aqui"
```

**⚠️ IMPORTANTE**: Estas variables solo duran mientras la sesión de PowerShell esté abierta. Si cierras PowerShell, tendrás que configurarlas de nuevo.

#### Opción B: Windows CMD

```cmd
set SUPABASE_URL=https://tu-proyecto.supabase.co
set SUPABASE_ANON_KEY=tu-clave-anon-aqui
```

#### Opción C: Linux/Mac

```bash
export SUPABASE_URL="https://tu-proyecto.supabase.co"
export SUPABASE_ANON_KEY="tu-clave-anon-aqui"
```

### Verificar que están configuradas

```powershell
# En PowerShell
echo $env:SUPABASE_URL
echo $env:SUPABASE_ANON_KEY

# En CMD
echo %SUPABASE_URL%
echo %SUPABASE_ANON_KEY%
```

## 🚀 Paso 5: Desplegar

### Método Simplificado (Recomendado)

**Primera vez:** Crea un archivo `.env.local` en la raíz del proyecto (mismo nivel que `package.json`) con tus credenciales:
```
SUPABASE_URL=https://dtfznewwvsadkorxwzft.supabase.co
SUPABASE_ANON_KEY=tu-clave-anon-completa-aqui
```

**📍 Ubicación del archivo**: Debe estar en la raíz del proyecto, junto a `package.json` y `firebase.json`

**Luego ejecuta:**
```powershell
npm run deploy:ps
```

O directamente:
```powershell
.\deploy.ps1
```

Este script:
1. ✅ Lee las credenciales desde `.env.local` (si existe)
2. ✅ Valida que las variables de entorno estén configuradas
3. ✅ Genera `scripts/config.local.js` con tus credenciales
4. ✅ Verifica que Firebase CLI esté instalado
5. ✅ Despliega tu sitio a Firebase Hosting

### Método Manual (Configurar variables cada vez)

Si prefieres configurar las variables cada vez:

```powershell
$env:SUPABASE_URL = "https://dtfznewwvsadkorxwzft.supabase.co"
$env:SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0ZnpuZXd3dnNhZGtvcnh3emZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA1MTIyNzUsImV4cCI6MjA3NjA4ODI3NX0.vJguBGhezUKtJbRA6GUkBxH8IltfdbMiPKWX9vHTlOo"
npm run deploy
```

### Primera vez - Confirmaciones

Si es tu primer despliegue, Firebase puede preguntarte:
- **¿Qué archivos quieres desplegar?** → Responde con Enter (acepta la configuración)
- **¿Configurar GitHub Actions?** → Responde **No** por ahora

## 🌐 Paso 6: Acceder a tu Sitio

Una vez completado el despliegue, tu catálogo estará disponible en:

- **Dominio principal**: `https://catalogo-fyl.web.app`
- **Dominio alternativo**: `https://catalogo-fyl.firebaseapp.com`

Ambos dominios son **gratuitos** y tienen **HTTPS automático**.

## 📝 Configurar Dominio Personalizado (Opcional)

Si quieres usar tu propio dominio:

1. Ve a [Firebase Console](https://console.firebase.google.com)
2. Selecciona tu proyecto `catalogo-fyl`
3. Navega a **Hosting** → **Agregar dominio personalizado**
4. Sigue las instrucciones para verificar tu dominio
5. Configura los registros DNS según las indicaciones

## 🔄 Actualizar el Sitio

### Opción A: Usar archivo .env.local (Recomendado - Una sola vez)

1. **Crea un archivo `.env.local`** en la raíz del proyecto:
   ```powershell
   # Crea el archivo .env.local con tu editor de texto favorito
   # O usa este comando:
   notepad .env.local
   ```

2. **Agrega tus credenciales** en el archivo:
   ```
   SUPABASE_URL=https://dtfznewwvsadkorxwzft.supabase.co
   SUPABASE_ANON_KEY=tu-clave-anon-completa-aqui
   ```

3. **Guarda el archivo** (está en `.gitignore`, no se subirá al repositorio)

4. **Ejecuta el deploy simplificado**:
   ```powershell
   npm run deploy:ps
   ```
   
   O directamente:
   ```powershell
   .\deploy.ps1
   ```

### Opción B: Configurar variables cada vez (Método anterior)

1. **Configura las variables de entorno**:
   ```powershell
   $env:SUPABASE_URL = "https://dtfznewwvsadkorxwzft.supabase.co"
   $env:SUPABASE_ANON_KEY = "tu-clave-anon-completa"
   ```

2. **Ejecuta el deploy**:
   ```powershell
   npm run deploy
   ```

Los cambios estarán disponibles en unos segundos.

## 🐛 Solución de Problemas

### Error: "Faltan SUPABASE_URL o SUPABASE_ANON_KEY"

**Solución**: Asegúrate de haber configurado las variables de entorno antes de ejecutar el deploy. Revisa el Paso 4.

### Error: "Firebase CLI no está instalado"

**Solución**: Instala Firebase CLI:
```powershell
npm install -g firebase-tools
```

### Error: "No se encuentra el proyecto"

**Solución**: Asegúrate de estar autenticado y tener el proyecto configurado:
```powershell
firebase login
firebase use catalogo-fyl
```

### Error: "Permiso denegado"

**Solución**: Verifica que tengas permisos de edición en el proyecto Firebase. Pide acceso al propietario del proyecto si es necesario.

### El sitio no carga productos

**Posibles causas**:
1. Las credenciales de Supabase no son correctas
2. La base de datos no tiene productos cargados
3. Las políticas RLS en Supabase están bloqueando el acceso

**Solución**: 
- Verifica las credenciales en `scripts/config.local.js` (se genera automáticamente)
- Revisa que tu proyecto Supabase tenga la tabla `catalog_public_view` con datos
- Verifica las políticas RLS en Supabase (deben permitir lectura pública para `anon`)

### El service worker no funciona

**Solución**: Asegúrate de acceder al sitio mediante HTTPS (Firebase lo proporciona automáticamente). El service worker no funciona en HTTP local.

## 📁 Estructura de Archivos Generados

Durante el deploy se genera:

- `scripts/config.local.js` - Contiene tus credenciales de Supabase (NO se sube al repositorio, está en `.gitignore`)

## 🔒 Seguridad

**⚠️ IMPORTANTE**:

- `scripts/config.local.js` está en `.gitignore` y NO se sube al repositorio
- Las credenciales se generan localmente durante el build
- Solo la clave `anon` (pública) se usa en el cliente - es segura para uso público
- NUNCA compartas tu `service_role` key públicamente

## 📚 Recursos Adicionales

- [Documentación de Firebase Hosting](https://firebase.google.com/docs/hosting)
- [Documentación de Supabase](https://supabase.com/docs)
- [Guía de PWAs](https://web.dev/progressive-web-apps/)

## ✅ Checklist de Despliegue

Antes de desplegar, verifica:

- [ ] Firebase CLI instalado (`firebase --version`)
- [ ] Autenticado en Firebase (`firebase login`)
- [ ] Variables de entorno configuradas (`SUPABASE_URL` y `SUPABASE_ANON_KEY`)
- [ ] Proyecto Firebase configurado (`.firebaserc` existe)
- [ ] Base de datos Supabase con productos
- [ ] Políticas RLS configuradas en Supabase

## 🎉 ¡Listo!

Una vez completado el despliegue, tu catálogo estará disponible en internet con un dominio gratuito. Puedes compartir el enlace con tus clientes para que prueben la aplicación durante la etapa de testeo.

Cuando estés listo para producción, simplemente configura tu dominio personalizado desde Firebase Console.

