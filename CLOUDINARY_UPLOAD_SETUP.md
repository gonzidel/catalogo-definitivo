# Configuración y Testing de Upload a Cloudinary

## 1. Configurar Secrets en Supabase

### Pasos:
1. Ir a **Supabase Dashboard** → **Project Settings** → **Edge Functions** → **Secrets**
2. Agregar los siguientes secrets:
   - `CLOUDINARY_CLOUD_NAME`: Tu Cloud Name de Cloudinary (ej: `dnuedzuzm`)
   - `CLOUDINARY_API_KEY`: Tu API Key de Cloudinary
   - `CLOUDINARY_API_SECRET`: Tu API Secret de Cloudinary

### Verificación:
```sql
-- En Supabase SQL Editor, verificar que la función is_super_admin existe:
SELECT public.is_super_admin(auth.uid());
```

## 2. Desplegar Edge Function

### Desde el terminal:
```bash
# Asegúrate de estar en el directorio del proyecto
cd "E:\PROYECTOS\CATALOGO DEFINITIVO"

# Desplegar la función (requiere Supabase CLI)
supabase functions deploy upload-image
```

### Verificar deployment:
- Ir a **Supabase Dashboard** → **Edge Functions**
- Debe aparecer `upload-image` en la lista

## 3. Testing del Upload

### A) Preparar un producto y variante

1. **Abrir el admin panel**: `admin/products.html`
2. **Autenticarse** como admin (usuario con permisos de super admin)
3. **Crear o editar un producto**:
   - Completar: Categoría, Nombre, Handle
   - Agregar una variante:
     - Color: ej. "Negro"
     - SKU Base: ej. "BOTA-001"
     - Precio, Costo, etc.
4. **Guardar la variante**:
   - Click en "Guardar variante" en la fila
   - Verificar que aparece "✅ Variante guardada"
   - El botón "Subir imágenes" debe habilitarse

### B) Subir una imagen

1. **Click en "Subir imágenes"** en la fila de la variante
2. **Seleccionar 1 imagen** (JPG, PNG o WebP, máximo 5MB)
3. **Esperar**:
   - Debe aparecer: "Subiendo 1 imagen(es)..."
   - Luego: "✅ 1 imagen(es) subida(s) y guardada(s) correctamente"
4. **Verificar en la UI**:
   - La imagen debe aparecer en la grilla de imágenes de la variante
   - Debe tener badge "Principal" si es la primera

### C) Verificar en Cloudinary

1. **Ir a Cloudinary Dashboard** → **Media Library**
2. **Buscar la carpeta**: `{categoria}/{sku_base}/{color}/`
   - Ejemplo: `calzado/bota-001/negro/`
3. **Verificar**:
   - Debe existir la imagen con nombre: `{variant_id}-1`
   - El `public_id` completo debe ser: `{categoria}/{sku_base}/{color}/{variant_id}-1`

### D) Verificar en Base de Datos

1. **Ir a Supabase Dashboard** → **Table Editor** → `variant_images`
2. **Filtrar por** `variant_id` (el UUID de la variante)
3. **Verificar la fila**:
   - `variant_id`: UUID de la variante
   - `public_id`: Debe ser `{categoria}/{sku_base}/{color}/{variant_id}-1`
   - `secure_url`: URL HTTPS de Cloudinary
   - `url`: Debe ser igual a `secure_url`
   - `position`: `1`
   - `is_main`: `true`

### Query SQL para verificar:
```sql
SELECT 
  vi.id,
  vi.variant_id,
  vi.public_id,
  vi.secure_url,
  vi.url,
  vi.position,
  vi.is_main,
  pv.color,
  p.name as product_name
FROM variant_images vi
JOIN product_variants pv ON pv.id = vi.variant_id
JOIN products p ON p.id = pv.product_id
WHERE vi.variant_id = 'TU_VARIANT_ID_AQUI'
ORDER BY vi.position;
```

## 4. Troubleshooting

### Error: "Cloudinary credentials no están configuradas"
- **Solución**: Verificar que los secrets estén configurados en Supabase Edge Functions

### Error: "No tienes permisos de administrador"
- **Solución**: Verificar que el usuario esté en la tabla `admins` y sea super admin
- Query: `SELECT * FROM admins WHERE user_id = auth.uid();`

### Error: "variant_id no válido o no existe"
- **Solución**: Asegurarse de guardar la variante antes de subir imágenes

### Error: "Error subiendo imagen: [mensaje de Cloudinary]"
- **Solución**: 
  - Verificar que `CLOUDINARY_API_KEY` y `CLOUDINARY_API_SECRET` sean correctos
  - Verificar que el `CLOUDINARY_CLOUD_NAME` sea correcto
  - Revisar los logs de la Edge Function en Supabase Dashboard

### La imagen no aparece en Cloudinary
- **Solución**:
  - Revisar los logs de la Edge Function
  - Verificar que la signature de Cloudinary se genere correctamente
  - Verificar que el formato del `public_id` sea válido (sin caracteres especiales)

### La imagen aparece en Cloudinary pero no en la DB
- **Solución**:
  - Revisar la consola del navegador para errores
  - Verificar que `uploadImagesToCloudinary()` complete correctamente
  - Verificar permisos RLS en `variant_images`

## 5. Verificación de Seguridad

### ✅ Checklist:
- [ ] `CLOUDINARY_API_SECRET` NO está en el frontend
- [ ] Solo usuarios admin pueden subir (verificado con `is_super_admin`)
- [ ] `variant_id` se valida antes de subir
- [ ] Tipos de archivo validados (solo JPG, PNG, WebP)
- [ ] Tamaño máximo validado (5MB)
- [ ] Upload usa signed upload de Cloudinary

## 6. Estructura de Carpetas en Cloudinary

El sistema crea carpetas automáticamente con esta estructura:
```
{categoria}/
  └── {sku_base}/
      └── {color}/
          ├── {variant_id}-1
          ├── {variant_id}-2
          └── {variant_id}-3
```

Ejemplo real:
```
calzado/
  └── bota-001/
      ├── negro/
      │   ├── 550e8400-e29b-41d4-a716-446655440000-1
      │   └── 550e8400-e29b-41d4-a716-446655440000-2
      └── beige/
          └── 550e8400-e29b-41d4-a716-446655440001-1
```

## 7. Próximos Pasos

Una vez verificado que el upload funciona:
- [ ] Probar subir múltiples imágenes (2-3)
- [ ] Verificar que las posiciones se asignen correctamente
- [ ] Probar reordenar imágenes
- [ ] Probar eliminar imágenes
- [ ] Verificar que la imagen principal se actualice correctamente

