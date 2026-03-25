# Verificar que la Edge Function está actualizada

## Pasos para verificar y redeployar

### 1. Verificar la versión actual desplegada

Ve a: **Supabase Dashboard** → **Edge Functions** → `upload-image` → **Logs**

Busca en los logs más recientes si aparece el mensaje:
```
Cloudinary upload params: { public_id: ..., timestamp: ..., ... }
```

Si NO aparece este mensaje, significa que la función NO fue redeployada con los últimos cambios.

### 2. Redeployar la función

**Opción A: Desde terminal**
```bash
supabase functions deploy upload-image --project-ref dtfznewwvsadkorxwzft
```

**Opción B: Desde Supabase Dashboard**
1. Ve a **Edge Functions** → `upload-image`
2. Si hay un botón "Redeploy" o "Deploy", úsalo
3. O edita el código directamente en el dashboard y guarda

### 3. Verificar que el deploy fue exitoso

Después del deploy, deberías ver un mensaje como:
```
Deployed Functions on project dtfznewwvsadkorxwzft: upload-image
```

### 4. Probar nuevamente

1. Intenta subir una imagen desde el admin panel
2. Revisa los logs de la Edge Function inmediatamente después
3. Deberías ver el log "Cloudinary upload params:" con los detalles

### 5. Si el error persiste

Comparte el log completo más reciente de la Edge Function, especialmente:
- El mensaje de error completo de Cloudinary
- El log "Cloudinary upload params:" si aparece
- Cualquier otro error en los logs

---

## Checklist rápido

- [ ] La función fue redeployada después de eliminar `context`
- [ ] Los secrets de Cloudinary están configurados correctamente
- [ ] El usuario está en la tabla `admins` como `super_admin`
- [ ] Se revisaron los logs más recientes de la Edge Function

