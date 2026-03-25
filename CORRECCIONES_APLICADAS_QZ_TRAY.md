# Correcciones Aplicadas - QZ Tray 2.x

## ✅ Cambios Realizados

### 1. Agregado `setSignatureAlgorithm("SHA512")` en Cliente

**Archivo:** `admin/labels.js` (línea ~571)

**Cambio:**
```javascript
// IMPORTANTE: Configurar algoritmo SHA-512 (requerido por QZ Tray 2.1+)
// Según documentación oficial, QZ Tray 2.x espera SHA-512 por defecto
qz.security.setSignatureAlgorithm("SHA512");
console.log("✅ Algoritmo de firma configurado: SHA512");
```

**Ubicación:** Después de configurar el certificado, antes de `setSignaturePromise`

**Razón:** Según documentación oficial, QZ Tray 2.1+ requiere SHA-512 explícitamente configurado.

### 2. Cambiado Edge Function de SHA-256 a SHA-512

**Archivo:** `supabase/functions/qz-sign/index.ts` (línea ~147)

**Cambio:**
```typescript
// ANTES:
{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }

// DESPUÉS:
{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }
```

**Razón:** QZ Tray 2.x espera firmas SHA-512, no SHA-256. Si la Edge Function firma con SHA-256, QZ Tray rechazará la firma como inválida.

### 3. Agregados Logs Detallados en Edge Function

**Archivo:** `supabase/functions/qz-sign/index.ts`

**Logs agregados:**
- `📥 Request parseado como JSON/texto plano. toSign recibido (len=XXX): ...`
- `✅ toSign validado. Longitud final: XXX Primeros 50 chars: ...`
- `🔐 Firmando toSign con SHA-512. Longitud: XXX`
- `✅ Firma generada. Longitud base64: XXX Primeros 50 chars: ...`

**Razón:** Facilitar debugging y verificar que el `toSign` llega correctamente y que la firma se genera con SHA-512.

### 4. Certificado .crt Extraído

**Archivo:** `certs/qz-site.crt`

**Acción:** Extraído desde `C:\qz\qz-certificate.p12` usando OpenSSL

**Comando usado:**
```bash
openssl pkcs12 -in C:\qz\qz-certificate.p12 -nokeys -out certs/qz-site.crt -passin pass:changeit
```

**Verificación:**
- ✅ Archivo existe en `certs/qz-site.crt`
- ✅ Contiene bloque `BEGIN CERTIFICATE` / `END CERTIFICATE`

## 📋 Estado Final

### Cliente (`admin/labels.js`)
- ✅ Certificado se precarga antes de conectar
- ✅ `setCertificatePromise` configurado correctamente
- ✅ **NUEVO:** `setSignatureAlgorithm("SHA512")` configurado
- ✅ `setSignaturePromise` configurado
- ✅ Logs del `toSign` enviado

### Edge Function (`supabase/functions/qz-sign/index.ts`)
- ✅ **NUEVO:** Usa SHA-512 en lugar de SHA-256
- ✅ **NUEVO:** Logs detallados del `toSign` recibido
- ✅ **NUEVO:** Logs de la firma generada
- ✅ Respuesta en texto plano (base64 limpio)
- ✅ Shared Secret configurado

### Certificados
- ✅ Certificado `.p12` existe en `C:\qz\qz-certificate.p12`
- ✅ **NUEVO:** Certificado `.crt` existe en `certs/qz-site.crt`
- ✅ Certificado accesible vía HTTP en `/certs/qz-site.crt`

## 🚀 Próximos Pasos

### 1. Redeployar Edge Function

```bash
supabase functions deploy qz-sign
```

**Nota:** Si tu versión de Supabase CLI no soporta el comando sin flags, usa:
```bash
supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
```

### 2. Verificar Configuración en Supabase

1. Ir a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions
2. Verificar que estos secrets estén configurados:
   - `QZ_PRIVATE_KEY_B64` - Clave privada en base64
   - `QZ_SIGN_SECRET` - Secret compartido (debe coincidir con `config.local.js`)

### 3. Probar la Conexión

1. **Reiniciar QZ Tray completamente:**
   - Cerrar QZ Tray (Exit)
   - Reiniciar QZ Tray (como usuario normal, NO como admin)

2. **Abrir la aplicación:**
   - Navegar a: `http://localhost:5500/admin/labels.html`
   - Abrir consola del navegador (F12)

3. **Verificar logs en consola:**
   ```
   🔧 Configurando certificado y firma remota de QZ Tray...
   📜 setCertificatePromise: cargando /certs/qz-site.crt
   ✅ cert cargado, len= XXX begin= true
   ✅ Certificado público configurado
   ✅ Algoritmo de firma configurado: SHA512
   ✅ Certificado y firma remota configurados para QZ Tray
   🚀 conectando QZ...
   ✅ QZ Tray conectado
   ```

4. **Intentar imprimir una etiqueta:**
   - Deberías ver logs del `toSign` y la firma
   - QZ Tray debería mostrar el popup con tu certificado (NO "anonymous request")
   - **"Remember this decision" debe estar HABILITADO**

5. **Verificar logs en Supabase Dashboard:**
   - Ir a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/functions/qz-sign/logs
   - Deberías ver:
     ```
     📥 Request parseado como JSON. toSign recibido (len=XXX): ...
     ✅ toSign validado. Longitud final: XXX Primeros 50 chars: ...
     🔐 Firmando toSign con SHA-512. Longitud: XXX
     ✅ Firma generada. Longitud base64: XXX Primeros 50 chars: ...
     ```

## ✅ Checklist Final

- [x] `setSignatureAlgorithm("SHA512")` agregado en cliente
- [x] Edge Function cambiada a SHA-512
- [x] Logs detallados agregados en Edge Function
- [x] Certificado `.crt` extraído y disponible
- [ ] Edge Function redeployada
- [ ] Secrets verificados en Supabase
- [ ] QZ Tray probado y funcionando
- [ ] "Remember this decision" habilitado
- [ ] No más "anonymous request"

## 🎯 Resultado Esperado

Después de estas correcciones y el redeploy:

1. ✅ QZ Tray reconoce el certificado (no "anonymous")
2. ✅ "Remember this decision" está habilitado
3. ✅ La firma se genera con SHA-512 (compatible con QZ Tray 2.x)
4. ✅ Los logs permiten verificar que todo funciona correctamente
5. ✅ Después de aceptar una vez, no aparecen más popups

## 📝 Notas Técnicas

### Por qué SHA-512 es crítico

Según la documentación oficial de QZ Tray:
- QZ Tray 2.0 usaba SHA-1 (deprecated)
- QZ Tray 2.1+ cambió a SHA-512 por defecto
- Si la firma no usa SHA-512, QZ Tray la rechazará como inválida
- Esto causa que "Remember this decision" esté deshabilitado

### Verificación de Algoritmo

Para verificar que la Edge Function está usando SHA-512:
1. Ver logs en Supabase Dashboard
2. Buscar el log: `🔐 Firmando toSign con SHA-512. Longitud: XXX`
3. Si aparece, está usando SHA-512 correctamente


