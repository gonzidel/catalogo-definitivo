// admin/variant-image-upload.js — subida de imágenes de variante (misma lógica que products.js)
import { supabase } from "../scripts/supabase-client.js?v=m260607";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js?v=m260607";

const MAX_IMAGES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPE_RE = /^image\/(jpeg|jpg|png|webp)$/;

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("Error leyendo archivo"));
    };
    reader.onerror = () => reject(new Error("Error leyendo archivo"));
    reader.readAsDataURL(file);
  });
}

export function validateImageFiles(files) {
  const fileArray = Array.from(files || []);
  if (fileArray.length === 0) {
    return { validFiles: [], error: "No hay archivos seleccionados." };
  }
  if (fileArray.length > MAX_IMAGES) {
    return { validFiles: [], error: `Máximo ${MAX_IMAGES} imágenes permitidas.` };
  }
  const validFiles = [];
  for (const file of fileArray) {
    if (!IMAGE_TYPE_RE.test(file.type)) continue;
    if (file.size > MAX_FILE_BYTES) continue;
    validFiles.push(file);
  }
  if (validFiles.length === 0) {
    return {
      validFiles: [],
      error: "No hay imágenes válidas (jpeg, png o webp, máx. 10 MB c/u).",
    };
  }
  return { validFiles, error: null };
}

/** Reordena archivos poniendo la imagen principal primero (misma regla que subir en orden en products). */
export function orderFilesWithMainFirst(files, mainIndex = 0) {
  const arr = Array.from(files);
  if (arr.length <= 1) return arr;
  const idx = Math.min(Math.max(0, mainIndex), arr.length - 1);
  if (idx === 0) return arr;
  const main = arr[idx];
  const rest = arr.filter((_, i) => i !== idx);
  return [main, ...rest];
}

export async function ensureProductsEditPermission(errorMessage) {
  const { user } = await preloadAuthState();
  if (!user) {
    if (errorMessage) alert(errorMessage);
    return false;
  }
  if (!isAdminUser()) {
    alert("No tenés permisos para editar productos.");
    return false;
  }
  if (!can("products", "edit") && !can("products", "delete")) {
    alert("No tenés permisos para editar productos.");
    return false;
  }
  return true;
}

/**
 * Tags1/Tags2 deben estar guardados en product_tags (completar en Productos).
 */
export async function assertProductHasTagsForImageUpload(productId) {
  if (!productId) {
    alert(
      "Completá Tags1 y Tags2 del producto en Productos y guardalo antes de subir imágenes."
    );
    return false;
  }

  const { data: productTags, error } = await supabase
    .from("product_tags")
    .select("tag1_id, tag2_id")
    .eq("product_id", productId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    console.warn("assertProductHasTagsForImageUpload:", error);
  }

  if (productTags?.tag1_id != null && productTags?.tag2_id != null) {
    return true;
  }

  alert(
    "Tenés que cargar y guardar Tags1 y Tags2 del producto en Productos antes de subir imágenes."
  );
  return false;
}

async function refreshSessionIfNeeded() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session) {
    return { session: null, error: sessionError || new Error("Sin sesión") };
  }
  const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
  const timeUntilExpiry = expiresAt - Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  if (timeUntilExpiry < fiveMinutes && timeUntilExpiry > 0) {
    await supabase.auth.refreshSession();
  }
  return { session, error: null };
}

/**
 * @param {Object} params
 * @param {string} params.variantId
 * @param {string} params.productId — para activación opcional del producto
 * @param {string} params.category
 * @param {string} params.skuBase
 * @param {string} params.color
 * @param {File[]} params.files — ya validados y ordenados (principal primero)
 * @param {(msg: string) => void} [params.onStatus]
 * @returns {Promise<{ ok: boolean, successCount: number, errorCount: number }>}
 */
export async function uploadVariantImages({
  variantId,
  productId,
  category,
  skuBase,
  color,
  files,
  onStatus,
}) {
  if (!variantId || !category || !skuBase || !color) {
    const msg = "Faltan datos de la variante (categoría, SKU o color).";
    onStatus?.(msg);
    return { ok: false, successCount: 0, errorCount: 0 };
  }

  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    return { ok: false, successCount: 0, errorCount: 0 };
  }

  onStatus?.(`Subiendo ${fileArray.length} imagen(es)...`);

  const uploadedImages = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];
    try {
      const { session, error: sessionError } = await refreshSessionIfNeeded();
      if (sessionError || !session) {
        onStatus?.("Tu sesión expiró. Recargá la página e iniciá sesión nuevamente.");
        errorCount++;
        continue;
      }

      const base64 = await fileToBase64(file);
      let data;
      let error;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = await supabase.functions.invoke("upload-image", {
          body: {
            variant_id: variantId,
            file: base64,
            category,
            sku_base: skuBase,
            color,
            position: i + 1,
          },
        });
        data = result.data;
        error = result.error;
        const isConnectionError =
          error?.message?.includes("Failed to send") ||
          error?.message?.includes("fetch");
        if (!error || !isConnectionError || attempt === maxRetries) break;
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }

      if (error || !data) {
        console.error(`Error subiendo ${file.name}:`, error);
        errorCount++;
        continue;
      }

      uploadedImages.push({
        public_id: data.public_id,
        secure_url: data.secure_url,
        url: data.url || data.secure_url,
        position: i + 1,
      });
      successCount++;
    } catch (err) {
      console.error(`Error procesando ${file.name}:`, err);
      errorCount++;
    }
  }

  if (uploadedImages.length === 0) {
    return { ok: false, successCount, errorCount };
  }

  const { data: existingImages } = await supabase
    .from("variant_images")
    .select("id, is_main")
    .eq("variant_id", variantId);

  const isReplacing =
    existingImages?.length === 1 && uploadedImages.length === 1;
  if (isReplacing) {
    await supabase.from("variant_images").delete().eq("id", existingImages[0].id);
  }

  const hasMainImage = isReplacing
    ? false
    : existingImages?.some((img) => img.is_main === true) || false;

  const imagesPayload = uploadedImages.map((img) => ({
    variant_id: variantId,
    public_id: img.public_id,
    secure_url: img.secure_url,
    url: img.secure_url,
    position: img.position,
    is_main: !hasMainImage && img.position === 1,
  }));

  const { error: insertError } = await supabase
    .from("variant_images")
    .insert(imagesPayload);

  if (insertError) {
    console.error("Error guardando imágenes en DB:", insertError);
    onStatus?.(`Imágenes subidas pero error en base de datos: ${insertError.message}`);
    return { ok: false, successCount, errorCount: errorCount + 1 };
  }

  if (productId) {
    await tryActivateProductIfStockAndImages(productId, variantId);
  }

  if (successCount > 0) {
    onStatus?.(`✅ ${successCount} imagen(es) guardada(s) correctamente`);
  }

  return { ok: successCount > 0, successCount, errorCount };
}

async function tryActivateProductIfStockAndImages(productId, variantId) {
  try {
    const { data: variants } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", productId)
      .eq("active", true);
    const variantIds = (variants || []).map((v) => v.id);
    if (!variantIds.length) return;

    const { data: sizeRows } = await supabase
      .from("variant_size_warehouse_stock")
      .select("stock_qty")
      .in("variant_id", variantIds)
      .gt("stock_qty", 0)
      .limit(1);
    if (!sizeRows?.length) return;

    const { data: imgRows } = await supabase
      .from("variant_images")
      .select("id")
      .in("variant_id", variantIds)
      .limit(1);
    if (!imgRows?.length) return;

    const { data: product } = await supabase
      .from("products")
      .select("status")
      .eq("id", productId)
      .single();
    if (product?.status === "active") return;

    await supabase
      .from("products")
      .update({ status: "active" })
      .eq("id", productId);
  } catch (e) {
    console.warn("tryActivateProductIfStockAndImages:", e);
  }
}
