# Solución: Error "Invalid API key" en el sitio desplegado

## Problema Detectado

El error "Invalid API key" indica que `scripts/config.local.js` no se está cargando correctamente en el sitio desplegado, por lo que la aplicación está usando los valores por defecto de `config.js` donde `SUPABASE_ANON_KEY = ""` (vacío).

## Causas Posibles

1. **El archivo no se está desplegando**: Aunque `config.local.js` se genera antes del deploy, puede que no se esté incluyendo en el deploy de Firebase Hosting.
2. **El import dinámico falla**: El import dinámico de `config.local.js` puede estar fallando silenciosamente y usando valores por defecto.

## Solución Rápida

### Paso 1: Verificar que el archivo existe en el servidor

Abre en tu navegador:
```
https://catalogo-fyl-test.web.app/scripts/config.local.js
```

**Si ves el contenido del archivo con la clave de Supabase**: El archivo está desplegado, el problema es con el import.

**Si ves un error 404 o contenido diferente**: El archivo NO está siendo desplegado.

### Paso 2: Si el archivo NO está desplegado

Asegúrate de que el archivo se genere correctamente antes del deploy ejecutando:

```powershell
# Verificar que existe localmente
Get-Content scripts/config.local.js

# Si no existe, generarlo
npm run build

# Luego desplegar
npm run deploy:ps
```

### Paso 3: Si el archivo SÍ está desplegado pero sigue el error

El problema es que el import dinámico está fallando. Verifica en la consola del navegador (F12) si ves el mensaje:
```
config.local.js loaded: overrides applied
```

Si NO ves este mensaje, el import está fallando. En este caso:

1. **Abre la consola del navegador** (F12)
2. **Ejecuta manualmente**:
   ```javascript
   import('./scripts/config.local.js').then(m => console.log('Config cargado:', m))
   ```
3. Si ves un error, anótalo para diagnosticarlo.

## Solución Definitiva

Si el problema persiste, podemos modificar el código para que use las variables de entorno directamente sin necesidad de `config.local.js`, pero esto requeriría cambios en la configuración del servidor.

## Verificación Post-Deploy

Después de desplegar, verifica:

1. **Accede al archivo directamente**: https://catalogo-fyl-test.web.app/scripts/config.local.js
2. **Abre la consola del navegador** en https://catalogo-fyl-test.web.app
3. **Verifica que no haya errores** relacionados con `config.local.js`
4. **Busca el mensaje**: `config.local.js loaded: overrides applied`

Si todo esto está correcto y aún así ves "Invalid API key", el problema puede estar en:
- La clave de Supabase en sí (podría estar expirada o incorrecta)
- La configuración de Supabase (RLS, permisos, etc.)

