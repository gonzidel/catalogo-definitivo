# Flujo Completo de Carga de Imágenes

## Resumen

El sistema permite subir imágenes a Cloudinary por variante (color) y guardarlas en la base de datos con `public_id`, `secure_url`, posición y marca de imagen principal.

---

## 1. Arquitectura General

```
Frontend (admin/products.html) 
  → Edge Function (upload-image)
    → Cloudinary API
      → Guardar en variant_images (Supabase)
```

---

## 2. Flujo Detallado Paso a Paso

### A) Preparación: Guardar Variante

**Antes de subir imágenes, la variante DEBE existir:**

1. Usuario completa el formulario de variante:
   - Color (obligatorio)
   - SKU base
   - Precio, costo, etc.

2. Usuario hace click en **"Guardar variante"**

3. Se ejecuta `ensureVariantId(row)`:
   ```javascript
   // Crea el producto draft si no existe
   // Crea product_variant SOLO con color (sin size)
   // Retorna variant_id
   ```

4. Si todo OK:
   - `row.dataset.variantId` se setea con el UUID
   - Estado cambia a "Guardada"
   - Botón "Subir imágenes" se habilita

### B) Subida de Imágenes

1. Usuario hace click en **"Subir imágenes"**

2. Se abre el file picker del navegador (múltiple)

3. Usuario selecciona 1-N imágenes (JPG, PNG, WebP, máx 5MB c/u)

4. Se ejecuta `uploadImagesToCloudinary(row, files)`:

#### Paso 4.1: Validaciones Previas
```javascript
// 1. Asegurar variant_id existe
const variantId = await ensureVariantId(row);
if (!variantId) {
  alert("No se pudo guardar la variante");
  return false;
}

// 2. Validar campos requeridos
const category = document.getElementById("category")?.value;
const skuBase = row.querySelector(".v-skuBase")?.value?.trim();
const color = row.querySelector(".v-color")?.value?.trim();
```

#### Paso 4.2: Loop por cada archivo
```javascript
for (let i = 0; i < fileArray.length; i++) {
  const file = fileArray[i];
  
  // 4.2a. Validar tipo y tamaño
  if (!file.type.match(/^image\/(jpeg|jpg|png|webp)$/)) continue;
  if (file.size > 5 * 1024 * 1024) continue;
  
  // 4.2b. Convertir a base64
  const base64 = await fileToBase64(file);
  // Resultado: "data:image/jpeg;base64,/9j/4AAQ..."
  
  // 4.2c. Llamar Edge Function
  const { data, error } = await supabase.functions.invoke("upload-image", {
    body: {
      variant_id: variantId,
      file: base64,
      category: category,
      sku_base: skuBase,
      color: color,
      position: i + 1,
    },
  });
  
  // 4.2d. Guardar respuesta
  uploadedImages.push({
    public_id: data.public_id,
    secure_url: data.secure_url,
    url: data.secure_url,
    position: i + 1,
  });
}
```

### C) Edge Function (upload-image)

La Edge Function recibe el request y:

1. **Validaciones de seguridad:**
   - Verifica autenticación (token JWT)
   - Verifica que el usuario es admin (`is_super_admin()`)
   - Verifica que `variant_id` existe en DB

2. **Validaciones de archivo:**
   - Parsea base64: `data:image/jpeg;base64,...`
   - Valida tipo: solo JPG, PNG, WebP
   - Valida tamaño: máximo 5MB

3. **Genera public_id:**
   ```javascript
   // Formato: {category}/{sku_base}/{color}/{variant_id}-{position}
   // Ejemplo: "calzado/bota-001/negro/550e8400-e29b-41d4-a716-446655440000-1"
   const folder = `${normalizedCategory}/${normalizedSkuBase}/${normalizedColor}`;
   const public_id = `${folder}/${variant_id}-${imageIndex}`;
   ```

4. **Sube a Cloudinary:**
   ```javascript
   const formData = new FormData();
   formData.append("file", file); // data URI
   formData.append("public_id", public_id);
   formData.append("context", JSON.stringify({
     sku: sku_base,
     color: color,
     variant_id: variant_id,
     category: category,
   }));
   
   // Signed upload con signature
   formData.append("timestamp", timestamp_cloudinary);
   formData.append("signature", signature);
   formData.append("api_key", CLOUDINARY_API_KEY);
   
   const response = await fetch(CLOUDINARY_UPLOAD_URL, {
     method: "POST",
     body: formData,
   });
   ```

5. **Retorna respuesta:**
   ```json
   {
     "public_id": "calzado/bota-001/negro/550e8400-...-1",
     "secure_url": "https://res.cloudinary.com/.../image/upload/v123/...",
     "url": "https://res.cloudinary.com/.../image/upload/v123/..."
   }
   ```

### D) Guardar en Base de Datos

Después de que todas las imágenes se subieron:

```javascript
const imagesPayload = uploadedImages.map(img => ({
  variant_id: variantId,
  public_id: img.public_id,
  secure_url: img.secure_url,
  url: img.secure_url, // url = secure_url para compatibilidad
  position: img.position,
  is_main: img.position === 1, // La primera es principal
}));

const { error } = await supabase
  .from("variant_images")
  .insert(imagesPayload);
```

**Tabla variant_images:**
- `id`: UUID (auto)
- `variant_id`: UUID → FK a `product_variants`
- `public_id`: Text → `"calzado/bota-001/negro/{variant_id}-1"`
- `secure_url`: Text → URL HTTPS de Cloudinary
- `url`: Text → Igual a `secure_url` (compatibilidad)
- `position`: Integer → 1, 2, 3, ...
- `is_main`: Boolean → Solo una `true` por variante
- `created_at`: Timestamp

### E) Actualizar UI

```javascript
// Refrescar la grilla de imágenes
await loadVariantImages(row, variantId);
```

`loadVariantImages()` hace:
1. Query: `SELECT * FROM variant_images WHERE variant_id = ? ORDER BY position`
2. Llama a `renderVariantImages(row, images)`
3. Muestra thumbnails con badges, botones mover/eliminar

---

## 3. Reglas y Validaciones

### Validaciones Frontend:
- ✅ Variante debe estar guardada (`variant_id` existe)
- ✅ Categoría, SKU base y color deben estar completos
- ✅ Máximo 10 imágenes por variante
- ✅ Tipos permitidos: JPG, PNG, WebP
- ✅ Tamaño máximo: 5MB por imagen

### Validaciones Backend (Edge Function):
- ✅ Usuario autenticado
- ✅ Usuario es admin (`is_super_admin`)
- ✅ `variant_id` existe en DB
- ✅ Archivo es imagen válida
- ✅ Tamaño máximo 5MB

### Reglas de Base de Datos:
- ✅ Máximo 1 imagen con `is_main = true` por `variant_id` (unique partial index)
- ✅ `position` debe ser único por `variant_id` (o manejado por lógica)
- ✅ Si se elimina la imagen principal, la siguiente por posición pasa a ser principal

---

## 4. Estructura en Cloudinary

```
{categoria}/
  └── {sku_base}/
      └── {color}/
          ├── {variant_id}-1
          ├── {variant_id}-2
          └── {variant_id}-3
```

**Ejemplo:**
```
calzado/
  └── bota-001/
      ├── negro/
      │   ├── 550e8400-e29b-41d4-a716-446655440000-1
      │   └── 550e8400-e29b-41d4-a716-446655440000-2
      └── beige/
          └── 550e8400-e29b-41d4-a716-446655440001-1
```

---

## 5. Renderizado de Imágenes

### Helpers (admin/products.js y scripts/main-supabase.js):

```javascript
function cloudinaryOptimizedFromPublicId(public_id, width) {
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto,c_scale,w_${width}/${public_id}`;
}

function getImgThumb(img) {
  if (img.public_id) {
    return cloudinaryOptimizedFromPublicId(img.public_id, 200);
  }
  return img.url || img.secure_url || "";
}

function getImgFull(img) {
  if (img.public_id) {
    return cloudinaryOptimizedFromPublicId(img.public_id, 800);
  }
  return img.url || img.secure_url || "";
}
```

### Lógica:
- Si existe `public_id` → Genera URL optimizada desde `public_id`
- Si no existe (imágenes legacy) → Usa `url` o `secure_url` como fallback

---

## 6. Orden y Imagen Principal

### Reglas:
1. `position = 1` → `is_main = true` (por defecto)
2. Solo una imagen con `is_main = true` por variante
3. Si se reordena y otra imagen pasa a `position = 1` → esa pasa a `is_main = true`
4. Si se elimina la principal → la siguiente por posición pasa a ser principal

### Funciones:
- `reorderVariantImages(variant_id, orderedImageIds)`: Reordena y actualiza `is_main`
- `deleteVariantImage(image_id)`: Elimina y recalcula posiciones e `is_main`

---

## 7. Troubleshooting

### Error: "variant_id es obligatorio"
- **Causa**: La variante no fue guardada antes de subir imágenes
- **Solución**: Click en "Guardar variante" primero

### Error: "No tienes permisos de administrador"
- **Causa**: El usuario no es admin
- **Solución**: Verificar que el usuario esté en tabla `admins` y sea super admin

### Error: "Cloudinary credentials no están configuradas"
- **Causa**: Los secrets no están en Supabase Dashboard
- **Solución**: Configurar `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`

### Imagen no aparece en Cloudinary
- Revisar logs de Edge Function
- Verificar que la signature sea correcta
- Verificar que el `public_id` no tenga caracteres inválidos

### Imagen aparece en Cloudinary pero no en DB
- Revisar consola del navegador
- Verificar permisos RLS en `variant_images`
- Verificar que `uploadImagesToCloudinary()` complete correctamente

---

## 8. Diagrama de Flujo Simplificado

```
Usuario → [Guardar Variante] → ensureVariantId() → variant_id creado
                                              ↓
Usuario → [Subir Imágenes] → uploadImagesToCloudinary()
                                              ↓
                          Loop por cada archivo:
                                              ↓
                    [Validar archivo] → [Convertir base64] 
                                              ↓
                    [Llamar Edge Function] → upload-image/index.ts
                                              ↓
                          [Validar admin + variant_id]
                                              ↓
                          [Generar public_id]
                                              ↓
                          [Subir a Cloudinary]
                                              ↓
                          [Retornar public_id + secure_url]
                                              ↓
                    [Insertar en variant_images]
                                              ↓
                          [Refrescar UI]
```

---

¡Listo! Este es el flujo completo. Si tienes dudas sobre algún paso específico, avísame.

