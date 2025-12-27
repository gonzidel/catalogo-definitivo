# 🚀 Importación Directa de Clientes

## ✅ Solución al Error "Query is too large"

Cuando el archivo SQL generado es demasiado grande para el editor de Supabase, usa estos scripts Node.js que se conectan directamente a la base de datos.

## 📋 Opciones de Importación

### Opción 1: Desde Google Sheets (Recomendado) ⭐
Lee directamente desde Google Sheets sin necesidad de descargar el CSV.

### Opción 2: Desde archivo CSV local
Importa desde un archivo CSV descargado en tu computadora.

## 📋 Requisitos Previos

1. **Node.js instalado** (versión 18 o superior)
2. **Service Role Key de Supabase** (clave de administrador)

## 🔧 Configuración

### Paso 1: Obtener Service Role Key

1. Ve a tu proyecto en **Supabase Dashboard**
2. Navega a **Settings → API**
3. Busca la sección **Project API keys**
4. Copia la clave **`service_role` (secret)** ⚠️ **NUNCA la compartas públicamente**

### Paso 2: Configurar credenciales

1. Si no existe, crea el archivo `scripts/config.local.js`:
   ```bash
   cp scripts/config.local.example.js scripts/config.local.js
   ```

2. Edita `scripts/config.local.js` y agrega tu **SERVICE_ROLE_KEY**:
   ```javascript
   export const SUPABASE_URL = "https://dtfznewwvsadkorxwzft.supabase.co";
   export const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR0ZnpuZXd3dnNhZGtvcnh3emZ0Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MDUxMjI3NSwiZXhwIjoyMDc2MDg4Mjc1fQ.dhPbWno7b5ejkAmabn95gfp_eviHBr37V6dShrv2YYo";
   ```

   ⚠️ **IMPORTANTE**: Esta clave tiene acceso completo a tu base de datos. Mantén este archivo privado y nunca lo subas a Git.

## 🚀 Uso

### Opción 1: Importar desde Google Sheets ⭐

**Ventajas:**
- ✅ No necesitas descargar el CSV
- ✅ Siempre lee los datos más actualizados
- ✅ Más rápido y conveniente

**Pasos:**

1. **Compartir el Google Sheet** (si no está público):
   - Abre tu Google Sheet
   - Haz clic en "Compartir" → "Cambiar a cualquiera con el enlace"
   - Selecciona "Lector" y copia el enlace

2. **Ejecutar el script:**
   ```bash
   node scripts/import-customers-from-sheets.js "URL_DEL_GOOGLE_SHEET"
   ```

   **Ejemplo:**
   ```bash
   node scripts/import-customers-from-sheets.js "https://docs.google.com/spreadsheets/d/1Zw7D2eeN8bF0NOspWAd1ssPxjogWpUv1pzVedKPgVTw/edit?usp=sharing"
   ```

### Opción 2: Importar desde archivo CSV local

**Pasos:**

1. **Descargar el CSV desde Google Sheets:**
   - Abre tu Google Sheet
   - Archivo → Descargar → Valores separados por comas (.csv)

2. **Ejecutar el script:**
   ```bash
   node scripts/import-customers.js "C:\Users\gonzi\Downloads\Clientes3.csv"
   ```

   **O desde la carpeta del proyecto:**
   ```bash
   cd "E:\PROYECTOS\CATALOGO DEFINITIVO"
   node scripts/import-customers.js "C:\Users\gonzi\Downloads\Clientes3.csv"
   ```

### Qué hace el script

1. ✅ Lee el archivo CSV
2. ✅ Parsea las columnas A, B, C, D, E (nombre, teléfono, ciudad, provincia, dirección)
3. ✅ Valida los datos (nombre, teléfono, dirección, ciudad y provincia requeridos)
4. ✅ Normaliza las provincias (FORMOSA → Formosa, etc.)
5. ✅ Importa en lotes de 100 clientes automáticamente
6. ✅ Muestra el progreso en tiempo real
7. ✅ Reporta el resumen final (creados, errores)

### Ejemplo de salida

```
🚀 Iniciando importación de clientes...

📁 Leyendo archivo: C:\Users\gonzi\Downloads\Clientes3.csv
✅ Archivo leído (123456 caracteres)

🔍 Parseando CSV...
✅ 6493 clientes encontrados en el CSV

🔍 Validando clientes...
✅ 6479 clientes válidos
⚠️  14 clientes con errores:
   Fila 525: Datos incompletos - omitida
   ...

📊 Resumen:
   Total en CSV: 6493
   Válidos: 6479
   Con errores: 14

🔍 Normalizando provincias...
✅ Datos preparados para importación

📦 Importando en lotes de 100...

📦 Procesando lote 1/65 (100 clientes)...
   ✅ 100 creados, 0 errores, 100 procesados

📦 Procesando lote 2/65 (100 clientes)...
   ✅ 100 creados, 0 errores, 100 procesados

...

✅ Importación completada:
   Total creados: 6479
   Total errores: 0
   Total procesados: 6479
```

## ⚠️ Notas Importantes

1. **Service Role Key**: Esta clave bypasea todas las políticas RLS (Row Level Security). Úsala solo para scripts de administración.

2. **Seguridad**: 
   - Nunca compartas tu `config.local.js`
   - Agrega `scripts/config.local.js` a tu `.gitignore`
   - No subas esta clave a repositorios públicos

3. **Formato CSV**: El script espera columnas en este orden:
   - **Columna A**: Nombre y apellido
   - **Columna B**: Teléfono
   - **Columna C**: Localidad (ciudad)
   - **Columna D**: Provincia
   - **Columna E**: Dirección

4. **Validación**: Se omiten clientes que no tengan:
   - Nombre completo
   - Teléfono
   - Dirección
   - Ciudad
   - Provincia

## 🆘 Solución de Problemas

### Error: "SUPABASE_SERVICE_ROLE_KEY debe estar configurado"
- Verifica que `scripts/config.local.js` existe
- Verifica que `SUPABASE_SERVICE_ROLE_KEY` está configurada correctamente

### Error: "Debes proporcionar la ruta al archivo CSV"
- Asegúrate de pasar la ruta completa del archivo CSV como argumento
- En Windows, usa comillas si la ruta tiene espacios

### Error de conexión
- Verifica que `SUPABASE_URL` es correcta
- Verifica que la `SERVICE_ROLE_KEY` es válida
- Verifica tu conexión a internet

### Errores durante la importación
- El script mostrará detalles de los errores
- Revisa los mensajes de error para identificar problemas específicos
- Algunos clientes pueden fallar por duplicados (teléfono o nombre existente)

