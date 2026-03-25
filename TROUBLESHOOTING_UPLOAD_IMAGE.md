# Troubleshooting: Error 500 en upload-image Edge Function

## Errores Comunes y Soluciones

### 1. Error 500: "Edge Function returned a non-2xx status code"

**Posibles causas:**

#### A) Secrets de Cloudinary no configurados
**Síntoma:** La función falla inmediatamente al intentar validar credenciales.

**Solución:**
1. Ir a **Supabase Dashboard** → Tu Proyecto → **Settings** → **Edge Functions** → **Secrets**
2. Verificar que existan:
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`

#### B) Error en verificación de admin (`is_super_admin`)
**Síntoma:** El usuario es admin pero la función falla al verificar.

**Diagnóstico:**
1. Verificar logs de Edge Function en Supabase Dashboard
2. Verificar que la función `is_super_admin` existe en la DB:
   ```sql
   SELECT routine_name 
   FROM information_schema.routines 
   WHERE routine_schema = 'public' 
   AND routine_name = 'is_super_admin';
   ```
3. Probar la función manualmente:
   ```sql
   SELECT public.is_super_admin(auth.uid());
   ```

**Solución:**
- Si la función no existe, ejecutar `supabase/canonical/11_admins_and_permissions.sql`
- Verificar que el usuario esté en la tabla `admins`:
  ```sql
  SELECT * FROM admins WHERE user_id = auth.uid();
  ```

#### C) Cloudinary rechaza el upload
**Síntoma:** La función llega hasta Cloudinary pero recibe un error.

**Diagnóstico:**
1. Revisar logs de Edge Function para ver el error específico de Cloudinary
2. Verificar que la signature sea correcta
3. Verificar que el `public_id` no tenga caracteres inválidos

**Solución:**
- Verificar que `CLOUDINARY_API_SECRET` sea correcto
- Verificar que el formato del `public_id` sea válido (sin caracteres especiales)
- Probar con un archivo más pequeño primero

#### D) Problema con el formato del archivo
**Síntoma:** La función falla al procesar el data URI.

**Diagnóstico:**
- El frontend envía: `data:image/jpeg;base64,...`
- La función parsea: `file.match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/)`

**Solución:**
- Verificar que el archivo sea realmente una imagen (JPG, PNG, WebP)
- Verificar que el tamaño no exceda 5MB
- Verificar que el base64 sea válido

---

## Cómo Revisar los Logs de la Edge Function

1. **Supabase Dashboard:**
   - Ir a: **Edge Functions** → `upload-image` → **Logs**
   - Ver los logs en tiempo real o históricos

2. **Buscar mensajes de error específicos:**
   - `Error verificando admin:` → Problema con `is_super_admin`
   - `Error Cloudinary:` → Problema con el upload a Cloudinary
   - `Error en upload-image:` → Error general (ver stack trace)

---

## Prueba Rápida

### 1. Verificar que la función existe y funciona:
```sql
-- En Supabase SQL Editor
SELECT public.is_super_admin(auth.uid());
```

### 2. Verificar que el usuario es admin:
```sql
SELECT * FROM admins WHERE user_id = auth.uid();
```

### 3. Verificar secrets configurados:
- En Supabase Dashboard → Edge Functions → Secrets
- Debe haber 3 secrets: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

### 4. Probar con curl (desde tu máquina local):
```bash
curl -X POST https://dtfznewwvsadkorxwzft.supabase.co/functions/v1/upload-image \
  -H "Authorization: Bearer TU_TOKEN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "variant_id": "UN_VARIANT_ID_VALIDO",
    "file": "data:image/jpeg;base64,/9j/4AAQSkZJRg...",
    "category": "calzado",
    "sku_base": "test-001",
    "color": "negro",
    "position": 1
  }'
```

---

## Errores Específicos del Código

### Si `is_super_admin` retorna null o error:
- La función puede estar fallando silenciosamente
- Agregar más logging en la Edge Function
- Verificar que la función RPC esté correctamente definida

### Si Cloudinary retorna error:
- Verificar que la signature sea correcta
- Verificar que todos los parámetros requeridos estén presentes
- Verificar que el `public_id` no tenga caracteres especiales problemáticos

---

## Siguiente Paso

**Si después de verificar todo lo anterior sigue fallando:**

1. **Revisar logs de Edge Function** en Supabase Dashboard
2. **Compartir el error específico** que aparece en los logs
3. **Verificar que los secrets estén correctos** (pueden tener espacios al inicio/final)
4. **Probar con un archivo de imagen simple** (pequeño, formato JPG estándar)

---

## Nota Importante

El error 500 indica que hay una excepción no manejada en la Edge Function. Los cambios recientes mejoran el manejo de errores, pero necesitas **redeployar la función** para que los cambios surtan efecto:

```bash
supabase functions deploy upload-image --project-ref dtfznewwvsadkorxwzft
```

