# Diff: Solución QZ Tray "Anonymous Request"

## Cambios Realizados

### 1. `admin/labels.js` - Función `setupQZSignature()`

**Cambio principal:** Convertir a `async` y precargar el certificado ANTES de configurar `setCertificatePromise`.

**Antes:**
```javascript
function setupQZSignature() {
  // ...
  qz.security.setCertificatePromise((resolve, reject) => {
    console.log("📜 setCertificatePromise: cargando /certs/qz-site.crt");
    fetch("/certs/qz-site.crt", { cache: "no-store" })
      .then(r => r.text())
      .then(cert => {
        console.log("✅ cert cargado, len=", cert.length, "begin=", cert.includes("BEGIN CERTIFICATE"));
        resolve(cert);
      })
      .catch(err => {
        console.error("❌ error cargando cert", err);
        reject(err);
      });
  });
  // ...
  const json = await res.json();
  return json.signature;
}
```

**Después:**
```javascript
async function setupQZSignature() {
  // ...
  // PASO 1: Precargar certificado ANTES de configurar setCertificatePromise
  console.log("📜 setCertificatePromise: cargando /certs/qz-site.crt");
  const certResponse = await fetch("/certs/qz-site.crt", { cache: "no-store" });
  const certText = await certResponse.text();
  console.log("✅ cert cargado, len=", certText.length, "begin=", certText.includes("BEGIN CERTIFICATE"));
  
  // Configurar setCertificatePromise con el certificado ya cargado
  qz.security.setCertificatePromise((resolve, reject) => {
    console.log("📜 setCertificatePromise: resolviendo certificado precargado");
    if (certText && certText.includes("BEGIN CERTIFICATE")) {
      resolve(certText);
    } else {
      reject(new Error("Certificado inválido o vacío"));
    }
  });
  // ...
  // IMPORTANTE: Leer como texto plano y trim, NO como JSON
  const signature = (await res.text()).trim();
  return signature;
}
```

### 2. `admin/labels.js` - Función `qzConnect()`

**Cambio principal:** Esperar a que `setupQZSignature()` complete antes de conectar.

**Antes:**
```javascript
async function qzConnect() {
  // ...
  const signatureConfigured = setupQZSignature(); // NO espera
  // ...
  // Precargar certificado (duplicado)
  // ...
  console.log("🚀 conectando QZ...");
  await qz.websocket.connect();
}
```

**Después:**
```javascript
async function qzConnect() {
  // ...
  // Asegurar que el certificado y la firma estén configurados ANTES de conectar
  const signatureConfigured = await setupQZSignature(); // ESPERA
  // ...
  console.log("🚀 conectando QZ...");
  await qz.websocket.connect();
}
```

### 3. `supabase/functions/qz-sign/index.ts` - Respuesta de la Edge Function

**Cambio principal:** Devolver texto plano con solo la firma base64, NO JSON.

**Antes:**
```typescript
return new Response(
  JSON.stringify({ signature: signatureBase64 }),
  {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  }
);
```

**Después:**
```typescript
// IMPORTANTE: Devolver texto plano con solo la firma base64, NO JSON
// QZ Tray espera un string base64 directamente, no un objeto JSON
return new Response(
  signatureBase64,
  {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/plain" },
  }
);
```

## Orden de Ejecución Garantizado

Con estos cambios, el orden de ejecución es:

1. ✅ `setupQZSignature()` se ejecuta (async)
2. ✅ Certificado se precarga: `fetch("/certs/qz-site.crt")`
3. ✅ Log: "📜 setCertificatePromise: cargando /certs/qz-site.crt"
4. ✅ Log: "✅ cert cargado, len=..."
5. ✅ `setCertificatePromise()` se configura con certificado ya cargado
6. ✅ `setSignaturePromise()` se configura
7. ✅ `setupQZSignature()` retorna (certificado y firma listos)
8. ✅ Log: "🚀 conectando QZ..."
9. ✅ `qz.websocket.connect()` se ejecuta

## Verificación

Al cargar `labels.html`, en consola deberías ver:

```
🔧 Configurando certificado y firma remota de QZ Tray...
📜 setCertificatePromise: cargando /certs/qz-site.crt
✅ cert cargado, len= [número] begin= true
✅ Certificado público configurado
✅ Certificado y firma remota configurados para QZ Tray
🚀 conectando QZ...
✅ QZ Tray conectado
```

Cuando QZ Tray solicite el certificado durante el handshake:
```
📜 setCertificatePromise: resolviendo certificado precargado
```

Cuando QZ Tray solicite la firma:
```
🔐 QZ Tray solicitó firma. Longitud: [número]
🔍 Obteniendo sesión de Supabase...
📡 Enviando request de firma a Edge Function...
📥 Respuesta recibida. Status: 200
✅ Firma generada correctamente. Longitud: [número]
```

## Próximos Pasos

1. **Redeployar la Edge Function:**
   ```bash
   supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
   ```

2. **Verificar que el certificado esté accesible:**
   - Abrir: `http://localhost:5500/certs/qz-site.crt`
   - Debe mostrar el contenido del certificado

3. **Reiniciar QZ Tray y probar:**
   - Cerrar QZ Tray completamente
   - Reiniciar QZ Tray (como usuario normal)
   - Abrir: `http://localhost:5500/admin/labels.html`
   - Verificar en consola el orden de logs
   - Intentar imprimir y verificar que QZ Tray NO muestre "anonymous request"



