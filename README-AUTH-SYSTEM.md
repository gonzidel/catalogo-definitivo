# 🔐 Sistema de Autenticación - Catálogo FYL

## 📋 Descripción General

Este documento describe el sistema de autenticación implementado para el área de clientes del catálogo FYL. El sistema utiliza Google OAuth con Supabase y proporciona una experiencia de usuario moderna con avatar dinámico, dashboard sin bloqueos y navegación fluida.

---

## 🎯 Funcionalidades Principales

### ✅ **Avatar Dinámico de Google**

- Detecta automáticamente cuando el usuario está logueado
- Muestra el avatar de Google junto al nombre del usuario
- Fallback inteligente si no hay avatar disponible
- Actualización en tiempo real al cambiar sesión

### ✅ **Dropdown de Usuario**

- Aparece solo al hacer click (no en hover)
- Menú completo con opciones:
  - 🏠 Mi Dashboard
  - 👤 Mi Perfil
  - 🛒 Mi Carrito
  - 🚪 Cerrar Sesión
- Cierre automático al hacer click fuera

### ✅ **Dashboard Sin Bloqueos**

- Carga instantánea del contenido
- Acceso básico para usuarios sin perfil completo
- Manejo robusto de errores
- Timeouts inteligentes para evitar cargas infinitas

### ✅ **Carrito Persistente**

- Sincronización automática con Supabase
- Persistencia entre recargas de página
- Contador en tiempo real
- Sincronización al autenticarse

---

## 🏗️ Arquitectura del Sistema

### **Componentes Principales**

```
📁 Sistema de Autenticación
├── 🔧 scripts/auth-status.js          # Manejo de autenticación
├── 🏠 client/dashboard-instant.js      # Dashboard sin bloqueos
├── 🛠️ client/client-utils.js          # Utilidades del cliente
├── 📄 index.html                      # Página principal con avatar
└── 🔐 client/login.html               # Página de login
```

### **Flujo de Autenticación**

```mermaid
graph TD
    A[Usuario en index.html] --> B{¿Está logueado?}
    B -->|Sí| C[Mostrar Avatar + Dropdown]
    B -->|No| D[Mostrar "Área de Clientes"]
    C --> E[Click en Avatar]
    D --> F[Click en Botón]
    E --> G[Mostrar Dropdown]
    F --> H[Ir a Login]
    G --> I[Navegar a Sección]
    H --> J[Login con Google]
    J --> K[Redirigir a Dashboard]
```

---

## 📁 Archivos Clave

### **1. `scripts/auth-status.js`**

**Propósito**: Manejo del estado de autenticación en la página principal

**Funciones principales**:

- `updateClientAreaLink()` - Actualiza el botón según el estado de sesión
- `showAuthenticatedUser()` - Muestra avatar y nombre del usuario
- `toggleUserDropdown()` - Maneja el dropdown del usuario
- `handleClientAreaClick()` - Gestiona clicks en el botón

**Características**:

- Detección automática de sesión
- Override de funciones problemáticas
- Prevención de propagación de eventos
- Timeouts robustos

### **2. `client/dashboard-instant.js`**

**Propósito**: Dashboard que funciona inmediatamente sin bloqueos

**Funciones principales**:

- `initDashboard()` - Inicialización inmediata
- `hideLoader()` - Ocultación agresiva del loader
- `showContent()` - Muestra contenido básico
- `loadData()` - Carga datos en segundo plano

**Características**:

- Carga instantánea del contenido
- Acceso básico para usuarios sin perfil
- Manejo de errores sin bloquear interfaz
- Timeouts para evitar cargas infinitas

### **3. `client/client-utils.js`**

**Propósito**: Utilidades para el área de clientes

**Funciones disponibles**:

- `formatDate()` - Formateo de fechas
- `formatPrice()` - Formateo de precios
- `showToast()` - Notificaciones toast
- `validateEmail()` - Validación de email
- `validatePhone()` - Validación de teléfono
- `validateDNI()` - Validación de DNI
- `debounce()` - Debounce para búsquedas
- `copyToClipboard()` - Copia al portapapeles

### **4. `scripts/cart-persistent.js`**

**Propósito**: Sistema de carrito persistente con sincronización automática

**Funciones principales**:

- `addToCart()` - Agregar productos al carrito
- `removeFromCart()` - Remover productos del carrito
- `syncCartWithSupabase()` - Sincronizar con base de datos
- `loadCartFromSupabase()` - Cargar carrito desde Supabase
- `updateCartCount()` - Actualizar contador

**Características**:

- Persistencia en localStorage
- Sincronización automática con Supabase
- Contador en tiempo real
- Sincronización al autenticarse

---

## 🔧 Configuración Técnica

### **Dependencias Requeridas**

```json
{
  "supabase": "^2.x.x",
  "google-oauth": "Integrado en Supabase",
  "vanilla-js": "ES6 modules"
}
```

### **Variables de Entorno**

```javascript
// scripts/config.js
const SUPABASE_URL = "tu-url-supabase";
const SUPABASE_ANON_KEY = "tu-clave-anonima";
```

### **Estructura de Base de Datos**

```sql
-- Tabla de clientes
CREATE TABLE customers (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  full_name TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  dni TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de carrito
CREATE TABLE cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID REFERENCES auth.users(id),
  product_id TEXT,
  quantity INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de pedidos
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES auth.users(id),
  status TEXT DEFAULT 'pending',
  total_amount DECIMAL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## 🚀 Instalación y Configuración

### **Paso 1: Configurar Supabase**

1. Crear proyecto en Supabase
2. Configurar Google OAuth
3. Crear tablas con RLS habilitado
4. Actualizar variables en `scripts/config.js`

### **Paso 2: Configurar Google OAuth**

1. Ir a Google Cloud Console
2. Crear credenciales OAuth 2.0
3. Configurar URLs de redirección
4. Agregar credenciales en Supabase

### **Paso 3: Implementar Archivos**

1. Copiar archivos del sistema
2. Verificar rutas de scripts
3. Probar autenticación
4. Verificar avatar dinámico

---

## 🐛 Problemas Comunes y Soluciones

### **1. Avatar No Aparece**

**Síntomas**: Botón muestra "Área de Clientes" en lugar del avatar
**Causa**: Script no detecta sesión activa
**Solución**:

```javascript
// En la consola del navegador
window.debugSession();
window.forceUpdateAuth();
```

### **2. Dashboard Se Queda Cargando**

**Síntomas**: Loader infinito en dashboard
**Causa**: Consultas a base de datos bloquean
**Solución**: Usar `dashboard-instant.js` en lugar de `dashboard.js`

### **3. Redirección Doble**

**Síntomas**: Click muestra dropdown Y redirige al login
**Causa**: Listeners duplicados o HTML con onclick
**Solución**:

```javascript
// Limpiar listeners
window.clearAllListeners();
window.initializeAuth();
```

### **4. Dropdown Aparece en Hover**

**Síntomas**: Dropdown se muestra al pasar mouse
**Causa**: Eventos de hover interfieren
**Solución**: Verificar CSS anti-hover en `index.html`

### **5. Carrito No Persiste**

**Síntomas**: Productos desaparecen al recargar página
**Causa**: Carrito solo en localStorage, no sincronizado
**Solución**:

```javascript
// Verificar sincronización
window.syncCartWithSupabase();
window.loadCartFromSupabase();
```

### **6. Contador de Carrito No Actualiza**

**Síntomas**: Contador no refleja productos agregados
**Causa**: Función de actualización no se ejecuta
**Solución**:

```javascript
// Forzar actualización
window.updateCartCount();
```

---

## 🔍 Funciones de Debug

### **Funciones Disponibles en Consola**

```javascript
// Verificar sesión actual
window.debugSession();

// Forzar actualización del botón
window.forceUpdateAuth();

// Limpiar todos los listeners
window.clearAllListeners();

// Reconfigurar completamente
window.initializeAuth();

// Debug completo del botón
window.debugButton();

// Verificar carrito persistente
window.syncCartWithSupabase();
window.loadCartFromSupabase();
window.updateCartCount();
```

### **Logs Importantes**

- `✅ Usuario autenticado` - Sesión activa detectada
- `👤 No hay sesión` - Usuario no logueado
- `🔄 Toggle dropdown` - Dropdown activado
- `❌ Error` - Problemas detectados

---

## 📱 Estados del Sistema

### **Estado 1: Usuario No Logueado**

```
👤 Área de Clientes → Click → Página de Login
```

### **Estado 2: Usuario Logueado**

```
[🖼️ Avatar] [Nombre] [▼] → Click → Dropdown
├── 🏠 Mi Dashboard
├── 👤 Mi Perfil
├── 🛒 Mi Carrito
└── 🚪 Cerrar Sesión
```

### **Estado 3: Dashboard Cargando**

```
Loader → Contenido Básico → Datos en Segundo Plano
```

---

## 🎨 Personalización

### **Cambiar Colores del Avatar**

```css
.cliente-link img {
  border: 2px solid #TU_COLOR; /* Cambiar color del borde */
}
```

### **Modificar Dropdown**

```javascript
// En scripts/auth-status.js, función createUserDropdown()
// Agregar o quitar opciones del menú
```

### **Ajustar Timeouts**

```javascript
// En scripts/auth-status.js
const timeoutPromise = new Promise(
  (_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000) // Cambiar 3000ms
);
```

---

## 📊 Métricas de Rendimiento

### **Tiempos Objetivo**

- Dashboard: < 100ms (carga instantánea)
- Avatar: < 200ms (detección de sesión)
- Dropdown: < 50ms (aparición)
- Navegación: < 300ms (cambio de página)

### **Optimizaciones Implementadas**

- Timeouts de 2-3 segundos para evitar bloqueos
- Carga en segundo plano para datos no críticos
- Fallbacks para todos los casos de error
- Limpieza automática de listeners

---

## 🔄 Mantenimiento

### **Verificaciones Regulares**

1. **Logs de consola** - Revisar errores
2. **Autenticación** - Probar login/logout
3. **Avatar** - Verificar que aparece correctamente
4. **Dropdown** - Confirmar navegación

### **Actualizaciones**

1. **Dependencias** - Mantener Supabase actualizado
2. **Configuración** - Revisar variables de entorno
3. **Base de datos** - Verificar RLS y permisos
4. **OAuth** - Renovar credenciales si es necesario

---

## 📞 Soporte

### **Para Desarrolladores**

- Revisar logs en consola del navegador
- Usar funciones de debug disponibles
- Verificar configuración de Supabase
- Probar en modo incógnito

### **Para Usuarios**

- Limpiar caché del navegador
- Verificar conexión a internet
- Intentar en modo incógnito
- Contactar soporte técnico

---

## 📚 Recursos Adicionales

### **Documentación**

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Google OAuth](https://developers.google.com/identity/protocols/oauth2)
- [PWA Guide](https://web.dev/progressive-web-apps/)

### **Archivos de Referencia**

- `debug-auth.html` - Diagnóstico de autenticación
- `test-button-fix.html` - Prueba de botón
- `test-dropdown-click.html` - Prueba de dropdown
- `test-cart-persistence.html` - Prueba de carrito persistente

---

**Versión**: 1.0  
**Última actualización**: Diciembre 2024  
**Estado**: ✅ Funcionando correctamente
