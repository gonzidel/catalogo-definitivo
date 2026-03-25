# Deploy y Verificación de qz-sign Edge Function

## 🚀 Comando Exacto para Redeploy

```bash
supabase functions deploy qz-sign --project-ref dtfznewwvsadkorxwzft
```

**Ubicación:** Ejecutar desde la raíz del proyecto (`E:\PROYECTOS\CATALOGO DEFINITIVO`)

## 📋 Verificación de Logs

### 1. Ver Logs en Tiempo Real (Supabase Dashboard)

1. **Ir a Supabase Dashboard:**
   - URL: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/functions/qz-sign
   - O: Dashboard → Edge Functions → qz-sign

2. **Click en "Logs"** (pestaña en la parte superior)

3. **Los logs mostrarán:**
   ```
   📥 Request parseado como JSON. toSign recibido (len=XXX): [primeros 100 chars]
   ✅ toSign validado. Longitud final: XXX Primeros 50 chars: [primeros 50 chars]
   🔐 Firmando toSign. Bytes a firmar: XXX
   ✅ Firma generada. Longitud base64: XXX Primeros 50 chars: [primeros 50 chars]
   ```

### 2. Ver Logs desde CLI

```bash
supabase functions logs qz-sign --project-ref dtfznewwvsadkorxwzft --follow
```

**Nota:** `--follow` muestra logs en tiempo real (similar a `tail -f`)

### 3. Ver Logs en Consola del Navegador

Al intentar imprimir desde `labels.html`, en la consola del navegador (F12) verás:

```
🔐 QZ Tray solicitó firma. Longitud: XXX
📡 Enviando request de firma a Edge Function...
📤 toSign a enviar (len=XXX): [primeros 100 chars]
📥 Respuesta recibida. Status: 200
✅ Firma generada correctamente. Longitud: XXX
```

## 🔍 Qué Verificar en los Logs

### En Supabase Dashboard (Edge Function):

1. **toSign recibido:**
   - Debe mostrar la longitud correcta
   - Debe mostrar los primeros caracteres del string
   - NO debe tener espacios extra al inicio/final

2. **toSign validado:**
   - Debe confirmar la longitud final (después de trim)
   - Debe mostrar los primeros 50 caracteres

3. **Firma generada:**
   - Debe mostrar la longitud de la firma base64
   - Debe mostrar los primeros 50 caracteres de la firma
   - La firma debe ser base64 válido (solo caracteres A-Z, a-z, 0-9, +, /, =)

### En Consola del Navegador:

1. **toSign a enviar:**
   - Debe coincidir con lo que QZ Tray solicitó
   - La longitud debe ser la misma que la solicitada por QZ Tray

2. **Firma recibida:**
   - Debe ser un string base64 válido
   - NO debe tener saltos de línea
   - NO debe tener comillas
   - Debe tener una longitud razonable (típicamente 344 caracteres para RSA-2048)

## ⚠️ Problemas Comunes y Soluciones

### Problema: "toSign es obligatorio y debe ser string no vacío"

**Causa:** El body no se está parseando correctamente o está vacío.

**Solución:**
- Verificar en logs de Supabase qué llegó en el request
- Verificar que el cliente esté enviando `JSON.stringify({ toSign })`

### Problema: toSign en cliente ≠ toSign en Edge Function

**Causa:** El string se está modificando durante el transporte.

**Solución:**
- Comparar los logs del cliente con los logs de la Edge Function
- Verificar que no haya transformaciones en el body
- Verificar que `Content-Type: application/json` esté correcto

### Problema: Firma base64 tiene saltos de línea

**Causa:** La función `uint8ToB64` está generando saltos de línea.

**Solución:**
- Ya está resuelto: se aplica `.replace(/\s+/g, "").trim()` antes de devolver

### Problema: QZ Tray sigue mostrando "anonymous"

**Causa:** El toSign que se firma no coincide con el que QZ Tray espera.

**Solución:**
1. Comparar el toSign que QZ Tray solicita (en consola del navegador)
2. Comparar el toSign que llega a la Edge Function (en logs de Supabase)
3. Deben ser EXACTAMENTE iguales (mismo string, misma longitud)
4. Si difieren, revisar cómo se está enviando desde el cliente

## 📊 Ejemplo de Logs Correctos

### En Consola del Navegador:
```
🔐 QZ Tray solicitó firma. Longitud: 1234
📡 Enviando request de firma a Edge Function...
📤 toSign a enviar (len=1234): abc123def456...
📥 Respuesta recibida. Status: 200
✅ Firma generada correctamente. Longitud: 344
```

### En Supabase Dashboard (Edge Function):
```
📥 Request parseado como JSON. toSign recibido (len=1234): abc123def456...
✅ toSign validado. Longitud final: 1234 Primeros 50 chars: abc123def456...
🔐 Firmando toSign. Bytes a firmar: 1234
✅ Firma generada. Longitud base64: 344 Primeros 50 chars: MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
```

## ✅ Checklist de Verificación

- [ ] Edge Function deployada correctamente
- [ ] Logs de Supabase muestran toSign recibido
- [ ] toSign en cliente coincide con toSign en Edge Function
- [ ] Firma base64 generada correctamente (sin saltos de línea)
- [ ] Respuesta es texto plano (no JSON)
- [ ] QZ Tray recibe la firma correctamente
- [ ] QZ Tray NO muestra "anonymous request"



