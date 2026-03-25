# Correcciones Aplicadas - QZ Tray en Todos los Archivos

## ✅ Archivos Corregidos

Se aplicaron las mismas correcciones críticas a todos los archivos que usan QZ Tray:

1. ✅ `admin/labels.js` - Ya estaba corregido
2. ✅ `admin/closed-orders.js` - **CORREGIDO**
3. ✅ `admin/sent-orders.js` - **CORREGIDO**
4. ✅ `admin/public-sales.js` - **CORREGIDO**
5. ✅ `admin/public-sales-caja2.js` - **CORREGIDO**
6. ✅ `admin/public-sales-caja3.js` - **CORREGIDO**

## 🔧 Correcciones Aplicadas en Cada Archivo

### 1. Import de Configuración

**Antes:**
```javascript
// No importaba SUPABASE_URL ni QZ_SIGN_SECRET
let supabaseUrl = window.SUPABASE_URL || "";
```

**Después:**
```javascript
import { SUPABASE_URL, QZ_SIGN_SECRET } from "../scripts/config.js";
```

### 2. Agregado `setSignatureAlgorithm("SHA512")`

**Agregado en todos los archivos:**
```javascript
// IMPORTANTE: Configurar algoritmo SHA-512 (requerido por QZ Tray 2.1+)
qz.security.setSignatureAlgorithm("SHA512");
console.log("✅ Algoritmo de firma configurado: SHA512");
```

### 3. Mejora en Precarga de Certificado

**Antes:**
```javascript
const certResponse = await fetch("/certs/qz-site.crt", { cache: "no-store" });
const certText = await certResponse.text();
// Configuraba inmediatamente sin logs
```

**Después:**
```javascript
console.log("📜 setCertificatePromise: cargando /certs/qz-site.crt");
const certResponse = await fetch("/certs/qz-site.crt", { cache: "no-store" });
const certText = await certResponse.text();
console.log("✅ cert cargado, len=", certText.length, "begin=", certText.includes("BEGIN CERTIFICATE"));
```

### 4. Logs Detallados en setSignaturePromise

**Agregado en todos los archivos:**
- Log del `toSign` recibido
- Log del `toSign` enviado
- Log de la respuesta HTTP
- Log de la firma generada

### 5. Mejor Manejo de Errores

**Antes:**
```javascript
if (!res.ok) throw new Error(await res.text());
```

**Después:**
```javascript
if (!res.ok) {
  const errorText = await res.text();
  console.error("❌ Error HTTP:", res.status, errorText);
  throw new Error(`Error en firma: ${res.status} - ${errorText}`);
}
```

### 6. Uso Correcto de Variables de Config

**Antes:**
```javascript
const secret = window.QZ_SIGN_SECRET || "fallback";
let supabaseUrl = window.SUPABASE_URL || "";
if (!supabaseUrl && typeof SUPABASE_URL !== 'undefined') supabaseUrl = SUPABASE_URL;
```

**Después:**
```javascript
const secret = QZ_SIGN_SECRET || 
  (typeof window !== 'undefined' ? window.QZ_SIGN_SECRET : "") ||
  "fallback";

const supabaseUrl = SUPABASE_URL || 
  (typeof window !== 'undefined' ? window.SUPABASE_URL : "");
```

## 📋 Problema Resuelto

### Error Original en `closed-orders.html`:
```
Error: SUPABASE_URL no definido
Error: Failed to sign request
```

### Causa:
- No se estaba importando `SUPABASE_URL` desde `config.js`
- Dependía de `window.SUPABASE_URL` que no estaba disponible
- No tenía `setSignatureAlgorithm("SHA512")`

### Solución:
- ✅ Import correcto de `SUPABASE_URL` y `QZ_SIGN_SECRET`
- ✅ `setSignatureAlgorithm("SHA512")` agregado
- ✅ Logs mejorados para debugging
- ✅ Manejo de errores mejorado

## 🚀 Próximos Pasos

1. **Probar cada área:**
   - `http://localhost:5500/admin/labels.html` ✅
   - `http://localhost:5500/admin/closed-orders.html` ⚠️ **PROBAR**
   - `http://localhost:5500/admin/sent-orders.html` ⚠️ **PROBAR**
   - `http://localhost:5500/admin/public-sales.html` ⚠️ **PROBAR**
   - `http://localhost:5500/admin/public-sales-caja2.html` ⚠️ **PROBAR**
   - `http://localhost:5500/admin/public-sales-caja3.html` ⚠️ **PROBAR**

2. **Verificar en consola:**
   - Debe aparecer: "✅ Algoritmo de firma configurado: SHA512"
   - Debe aparecer: "✅ Certificado y firma remota configurados para QZ Tray"
   - NO debe aparecer: "Error: SUPABASE_URL no definido"
   - NO debe aparecer: "Error: Failed to sign request"

3. **Verificar QZ Tray:**
   - NO debe mostrar "anonymous request"
   - "Remember this decision" debe estar habilitado
   - La impresión debe funcionar sin errores

## ✅ Checklist de Verificación

Para cada archivo corregido:
- [x] Import de `SUPABASE_URL` y `QZ_SIGN_SECRET` agregado
- [x] `setSignatureAlgorithm("SHA512")` agregado
- [x] Logs detallados agregados
- [x] Manejo de errores mejorado
- [x] Precarga de certificado con logs
- [ ] Probado y funcionando

## 📝 Notas

Todos los archivos ahora tienen la misma implementación robusta que `labels.js`, lo que asegura:
- Consistencia en toda la aplicación
- Mismo comportamiento en todas las áreas
- Fácil debugging con logs detallados
- Compatibilidad con QZ Tray 2.1+ (SHA-512)


