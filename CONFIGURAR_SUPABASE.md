# 🗄️ CONFIGURAR SUPABASE - Catálogo FYL

## ✅ **PROBLEMA SOLUCIONADO**

He creado una versión que **prioriza Supabase** como fuente de datos principal, con Google Sheets como fallback automático.

## 🔧 **CAMBIOS REALIZADOS**

### 1. **Script Supabase Creado**

- ✅ `scripts/main-supabase.js` - Versión que prioriza Supabase
- ✅ Carga automática desde Supabase primero
- ✅ Fallback automático a Google Sheets si Supabase falla
- ✅ Diagnóstico mejorado que muestra la fuente de datos

### 2. **index.html Actualizado**

- ✅ Scripts de configuración y Supabase activados
- ✅ Script principal cambiado a versión Supabase

## 🚀 **CONFIGURACIÓN REQUERIDA**

### **Paso 1: Crear Archivo de Configuración Local**

1. **Copiar archivo de ejemplo:**

```bash
cp scripts/config.local.example.js scripts/config.local.js
```

2. **Editar `scripts/config.local.js`:**

```javascript
export const SUPABASE_URL = "https://dtfznewwvsadkorxwzft.supabase.co";
export const SUPABASE_ANON_KEY = "TU_CLAVE_ANONIMA_REAL_AQUI";
export const USE_SUPABASE = true;
export const USE_OPEN_SHEET_FALLBACK = true;
```

### **Paso 2: Obtener Clave de Supabase**

1. **Ir a tu proyecto en Supabase Dashboard**
2. **Settings → API**
3. **Copiar "anon public" key**
4. **Pegar en `config.local.js`**

### **Paso 3: Verificar Base de Datos**

Asegúrate de que en Supabase tengas:

- ✅ Tabla `catalog_public_view` creada
- ✅ Datos de productos cargados
- ✅ RLS (Row Level Security) configurado

## 🔍 **CÓMO VERIFICAR QUE FUNCIONA**

### **1. Abrir el Catálogo**

1. Abre `index.html` en tu navegador
2. Abre la consola (F12)
3. Verás el diagnóstico automático

### **2. Verificar el Diagnóstico**

En la consola deberías ver:

```
🔍 DIAGNÓSTICO RÁPIDO - CATÁLOGO FYL (SUPABASE)
================================================

1. 📋 CONFIGURACIÓN:
USE_SUPABASE: true
USE_OPEN_SHEET_FALLBACK: true
SUPABASE_URL: https://dtfznewwvsadkorxwzft.supabase.co
SUPABASE_ANON_KEY: Configurada

2. 🗄️ CLIENTE SUPABASE:
Cliente disponible: SÍ
Estado de conexión: Inicializado

3. 🔧 FUNCIONES DISPONIBLES:
cargarCategoria: function
cambiarCategoria: function
downloadImage: function

4. 🎯 ESTADO DEL CATÁLOGO:
Elemento catálogo: Encontrado
Elemento loader: Encontrado
Contenido del catálogo: [HTML de productos]

✅ Catálogo inicializado correctamente
📊 Fuente de datos: Supabase
```

### **3. Verificar Productos**

- Los productos deberían cargar desde Supabase
- En la consola verás: `✅ Datos cargados desde Supabase: X productos`
- Si Supabase falla, automáticamente usará Google Sheets

## ⚠️ **SI SUPABASE NO FUNCIONA**

### **Problema 1: No se encuentra config.local.js**

**Solución:**

1. Crear el archivo `scripts/config.local.js`
2. Copiar contenido de `config.local.example.js`
3. Configurar la clave de Supabase

### **Problema 2: Clave de Supabase incorrecta**

**Solución:**

1. Verificar en Supabase Dashboard
2. Copiar la clave "anon public" correcta
3. Actualizar `config.local.js`

### **Problema 3: Base de datos vacía**

**Solución:**

1. Ejecutar scripts SQL en `supabase/canonical/`
2. Importar datos de productos
3. Verificar que `catalog_public_view` tenga datos

### **Problema 4: Error de CORS o conexión**

**Solución:**

1. Verificar que la URL de Supabase sea correcta
2. Verificar que el proyecto esté activo
3. Verificar conexión a internet

## 🔄 **FUNCIONAMIENTO AUTOMÁTICO**

### **Flujo de Carga de Datos:**

1. **Intenta Supabase primero** - Si está configurado y funciona
2. **Si Supabase falla** - Automáticamente usa Google Sheets
3. **Si ambos fallan** - Muestra error al usuario

### **Ventajas de esta Configuración:**

- ✅ **Rendimiento**: Supabase es más rápido
- ✅ **Funcionalidades**: Acceso a autenticación, carrito persistente
- ✅ **Confiabilidad**: Fallback automático a Google Sheets
- ✅ **Flexibilidad**: Se puede deshabilitar Supabase si es necesario

## 📊 **FUNCIONALIDADES DISPONIBLES**

### ✅ **Con Supabase Configurado**

- [x] Carga de productos desde Supabase
- [x] Autenticación con Google
- [x] Carrito persistente en base de datos
- [x] Dashboard de usuario
- [x] Panel administrativo
- [x] Fallback automático a Google Sheets

### ✅ **Sin Supabase (Solo Google Sheets)**

- [x] Carga de productos desde Google Sheets
- [x] Carrito básico en localStorage
- [x] Funcionalidades básicas del catálogo

## 🎯 **PRÓXIMOS PASOS**

1. **INMEDIATO**: Configurar `config.local.js` con tu clave de Supabase
2. **VERIFICAR**: Que los productos se cargan desde Supabase
3. **OPCIONAL**: Configurar autenticación y funcionalidades avanzadas

## 📞 **SOPORTE**

Si tienes problemas:

1. Revisa la consola del navegador
2. Verifica que `config.local.js` esté configurado correctamente
3. Verifica que Supabase tenga datos
4. El sistema automáticamente usará Google Sheets como fallback

---

**¡Ahora el catálogo priorizará Supabase como fuente de datos! 🗄️**

