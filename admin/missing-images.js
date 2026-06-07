// admin/missing-images.js
import { supabase, supabaseReady } from "../scripts/supabase-client.js?v=m260607";

console.log("🔧 missing-images.js cargado");

// Verificación simple de autenticación
let __currentUser = null;
async function checkAuth() {
  await supabaseReady;
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      __currentUser = data.session.user;
      console.log("✅ Usuario autenticado:", __currentUser?.email);
      return true;
    } else {
      console.log("⚠️ No hay sesión activa");
      return false;
    }
  } catch (e) {
    console.log("⚠️ Error de autenticación:", e.message);
    return false;
  }
}

checkAuth();

// Elementos del DOM
const productsCardsContainer = document.getElementById("products-cards-container");
const refreshBtn = document.getElementById("refresh-btn");
const showActiveCheckbox = document.getElementById("show-active");
const countDisplay = document.getElementById("count-display");
const statusMessage = document.getElementById("status-message");

// Estado
let currentVariants = [];
let showActive = false;
let groupedVariants = new Map(); // Map<productId, {product, variants[]}>

// Estado local de imágenes pendientes
// Estructura: pendingImages[productId][variantId] = { files: File[], urls: string[], mainImageIndex: number }
let pendingImages = {};

// Función auxiliar: convertir archivo a base64 (reutilizada de products.js)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new Error("Error leyendo archivo"));
      }
    };
    reader.onerror = () => reject(new Error("Error leyendo archivo"));
    reader.readAsDataURL(file);
  });
}

// Función auxiliar: obtener thumbnail de imagen
function getImgThumb(img) {
  if (img.secure_url) return img.secure_url;
  if (img.url) return img.url;
  if (img.public_id) {
    // Construir URL de Cloudinary para thumbnail
    return `https://res.cloudinary.com/dnuedzuzm/image/upload/w_100,h_100,c_fill/${img.public_id}`;
  }
  return "";
}

// Función auxiliar: cargar imágenes de una variante
async function loadVariantImages(variantId) {
  try {
    const { data: images, error } = await supabase
      .from("variant_images")
      .select("id, public_id, secure_url, url, position, is_main")
      .eq("variant_id", variantId)
      .order("position", { ascending: true });

    if (error) {
      console.error("❌ Error cargando imágenes:", error);
      return [];
    }

    return images || [];
  } catch (error) {
    console.error("❌ Error en loadVariantImages:", error);
    return [];
  }
}

// Funciones auxiliares para pendingImages
function getPendingImagesCount(productId) {
  if (!pendingImages[productId]) return 0;
  let count = 0;
  Object.values(pendingImages[productId]).forEach(variantData => {
    count += (variantData.files?.length || 0) + (variantData.urls?.length || 0);
  });
  return count;
}

function addPendingFiles(productId, variantId, files, mainImageIndex) {
  if (!pendingImages[productId]) {
    pendingImages[productId] = {};
  }
  if (!pendingImages[productId][variantId]) {
    pendingImages[productId][variantId] = { files: [], urls: [], mainImageIndex: 0 };
  }
  pendingImages[productId][variantId].files = Array.from(files);
  pendingImages[productId][variantId].mainImageIndex = mainImageIndex;
  updatePendingImagesDisplay(productId);
}

function addPendingUrls(productId, variantId, urls) {
  if (!pendingImages[productId]) {
    pendingImages[productId] = {};
  }
  if (!pendingImages[productId][variantId]) {
    pendingImages[productId][variantId] = { files: [], urls: [], mainImageIndex: 0 };
  }
  pendingImages[productId][variantId].urls = urls;
  updatePendingImagesDisplay(productId);
}

function removePendingImage(productId, variantId, type, index) {
  if (!pendingImages[productId]?.[variantId]) return;
  if (type === 'file') {
    pendingImages[productId][variantId].files.splice(index, 1);
    if (pendingImages[productId][variantId].files.length === 0 && 
        pendingImages[productId][variantId].urls.length === 0) {
      delete pendingImages[productId][variantId];
    }
  } else if (type === 'url') {
    pendingImages[productId][variantId].urls.splice(index, 1);
    if (pendingImages[productId][variantId].files.length === 0 && 
        pendingImages[productId][variantId].urls.length === 0) {
      delete pendingImages[productId][variantId];
    }
  }
  updatePendingImagesDisplay(productId);
}

function clearPendingImages(productId) {
  if (pendingImages[productId]) {
    delete pendingImages[productId];
  }
  updatePendingImagesDisplay(productId);
}

function updatePendingImagesDisplay(productId) {
  const pendingSection = document.getElementById(`pending-images-${productId}`);
  const pendingList = document.getElementById(`pending-images-list-${productId}`);
  const saveBtn = document.getElementById(`save-btn-${productId}`);

  if (!pendingSection || !pendingList || !saveBtn) return;

  const pending = pendingImages[productId];
  const hasPending = pending && Object.keys(pending).length > 0;

  if (hasPending) {
    pendingSection.classList.add("has-pending");
    saveBtn.classList.add("has-pending");
    saveBtn.disabled = false;

    // Renderizar previews
    pendingList.innerHTML = "";
    Object.entries(pending).forEach(([variantId, data]) => {
      // Preview de archivos
      if (data.files && data.files.length > 0) {
        data.files.forEach((file, index) => {
          const item = document.createElement("div");
          item.className = "pending-image-item";
          const img = document.createElement("img");
          img.src = URL.createObjectURL(file);
          const removeBtn = document.createElement("button");
          removeBtn.className = "remove-btn";
          removeBtn.textContent = "✕";
          removeBtn.onclick = () => {
            removePendingImage(productId, variantId, 'file', index);
            URL.revokeObjectURL(img.src);
          };
          const label = document.createElement("div");
          label.className = "pending-image-label";
          label.textContent = `Archivo ${index + 1}${index === data.mainImageIndex ? ' (Principal)' : ''}`;
          item.appendChild(img);
          item.appendChild(removeBtn);
          item.appendChild(label);
          pendingList.appendChild(item);
        });
      }

      // Preview de URLs
      if (data.urls && data.urls.length > 0) {
        data.urls.forEach((url, index) => {
          const item = document.createElement("div");
          item.className = "pending-image-item";
          const img = document.createElement("img");
          img.src = url;
          img.onerror = () => {
            img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23ddd' width='100' height='100'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999' font-size='12'%3EURL%3C/text%3E%3C/svg%3E";
          };
          const removeBtn = document.createElement("button");
          removeBtn.className = "remove-btn";
          removeBtn.textContent = "✕";
          removeBtn.onclick = () => {
            removePendingImage(productId, variantId, 'url', index);
          };
          const label = document.createElement("div");
          label.className = "pending-image-label";
          label.textContent = `URL ${index + 1}`;
          item.appendChild(img);
          item.appendChild(removeBtn);
          item.appendChild(label);
          pendingList.appendChild(item);
        });
      }
    });
  } else {
    pendingSection.classList.remove("has-pending");
    saveBtn.classList.remove("has-pending");
    saveBtn.disabled = true;
    pendingList.innerHTML = "";
  }
}

// Función para mostrar modal de preview y selección de imagen principal
async function showImagePreviewModal(variantId, files, category, skuBase, color, productId = null) {
  // Obtener productId si no se proporcionó
  if (!productId) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("product_id")
      .eq("id", variantId)
      .single();
    productId = variant?.product_id;
  }

  if (!productId) {
    showStatus("Error: No se pudo obtener el ID del producto", "err");
    return;
  }

  const modal = document.getElementById("image-preview-modal");
  const previewContainer = document.getElementById("image-preview-container");
  const finishBtn = document.getElementById("image-preview-finish");
  const cancelBtn = document.getElementById("image-preview-cancel");
  const modalClose = document.getElementById("image-preview-close");
  
  const fileArray = Array.from(files);
  const maxImages = 10;
  
  if (fileArray.length > maxImages) {
    showStatus(`Máximo ${maxImages} imágenes permitidas`, "err");
    return;
  }
  
  // Validar archivos
  const validFiles = [];
  for (const file of fileArray) {
    if (!file.type.match(/^image\/(jpeg|jpg|png|webp)$/)) {
      console.error(`Archivo ${file.name} no es una imagen válida`);
      continue;
    }
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      console.error(`Archivo ${file.name} excede 10MB`);
      continue;
    }
    validFiles.push(file);
  }
  
  if (validFiles.length === 0) {
    showStatus("No hay imágenes válidas para subir", "err");
    return;
  }
  
  let selectedMainIndex = 0; // Por defecto, la primera es la principal
  
  // Renderizar previews
  previewContainer.innerHTML = "";
  validFiles.forEach((file, index) => {
    const previewWrapper = document.createElement("div");
    previewWrapper.className = "image-preview-item";
    previewWrapper.dataset.index = index;
    
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.className = "preview-image";
    
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "main-image";
    radio.value = index;
    radio.id = `main-${index}`;
    radio.checked = index === 0;
    radio.addEventListener("change", () => {
      selectedMainIndex = parseInt(radio.value);
    });
    
    const label = document.createElement("label");
    label.htmlFor = `main-${index}`;
    label.textContent = "Imagen principal";
    label.className = "main-label";
    
    const labelWrapper = document.createElement("div");
    labelWrapper.className = "main-label-wrapper";
    labelWrapper.appendChild(radio);
    labelWrapper.appendChild(label);
    
    previewWrapper.appendChild(img);
    previewWrapper.appendChild(labelWrapper);
    previewContainer.appendChild(previewWrapper);
  });
  
  // Mostrar modal
  modal.classList.add("active");
  
  // Función para cerrar modal
  const closeModal = () => {
    modal.classList.remove("active");
    previewContainer.innerHTML = "";
    // Liberar URLs de objetos
    validFiles.forEach(file => {
      const url = URL.createObjectURL(file);
      URL.revokeObjectURL(url);
    });
  };

  // Función para terminar (agregar a pendingImages)
  const finishUpload = () => {
    // Agregar a pendingImages en lugar de subir inmediatamente
    addPendingFiles(productId, variantId, validFiles, selectedMainIndex);
    
    closeModal();
    showStatus(`✅ ${validFiles.length} imagen(es) agregada(s) a la cola. Presioná "Guardar" para subirlas.`, "ok");
  };
  
  // Event listeners
  modalClose.onclick = closeModal;
  cancelBtn.onclick = closeModal;
  finishBtn.onclick = finishUpload;
  
  // Cerrar con Escape
  const handleEscape = (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
      document.removeEventListener("keydown", handleEscape);
    }
  };
  document.addEventListener("keydown", handleEscape);
  
  // Cerrar al hacer clic fuera del modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };
}

// Función para guardar todas las imágenes pendientes de un producto
async function saveProductImages(productId) {
  if (!pendingImages[productId] || Object.keys(pendingImages[productId]).length === 0) {
    showStatus("No hay imágenes pendientes para guardar", "info");
    return;
  }

  const saveBtn = document.getElementById(`save-btn-${productId}`);
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "💾 Guardando...";
  }

  showStatus(`Guardando imágenes del producto...`, "info");

  let totalSuccess = 0;
  let totalErrors = 0;
  const productVariants = pendingImages[productId];

  // Procesar cada variante
  for (const [variantId, data] of Object.entries(productVariants)) {
    // Obtener información de la variante
    const { data: variant } = await supabase
      .from("product_variants")
      .select("sku, color, products!inner(category)")
      .eq("id", variantId)
      .single();

    if (!variant) {
      console.error(`Variante ${variantId} no encontrada`);
      continue;
    }

    const category = variant.products?.category || "";
    const skuBase = variant.sku || "";
    const color = variant.color || "";

    // Subir archivos
    if (data.files && data.files.length > 0) {
      const success = await uploadImagesToCloudinary(
        variantId,
        data.files,
        category,
        skuBase,
        color,
        data.mainImageIndex || 0,
        false // No refrescar después de cada upload
      );
      if (success) {
        totalSuccess += data.files.length;
      } else {
        totalErrors += data.files.length;
      }
    }

    // Cargar URLs
    if (data.urls && data.urls.length > 0) {
      const success = await loadImagesFromUrls(
        variantId,
        data.urls.join("\n"),
        false // No refrescar después de cada carga
      );
      if (success) {
        totalSuccess += data.urls.length;
      } else {
        totalErrors += data.urls.length;
      }
    }
  }

  // Limpiar pendingImages para este producto
  clearPendingImages(productId);

  // Verificar tags del producto (solo una vez)
  if (totalSuccess > 0) {
    const firstVariantId = Object.keys(productVariants)[0];
    await checkAndPromptTags(firstVariantId);
  }

  // Actualizar solo la tarjeta de este producto
  setTimeout(() => {
    loadVariants(productId);
  }, 1000);

  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = "💾 Guardar imágenes de este producto";
  }

  if (totalErrors > 0) {
    showStatus(
      `${totalSuccess > 0 ? "✅ " : ""}⚠️ ${totalSuccess} imagen(es) guardada(s), ${totalErrors} error(es)`,
      totalSuccess > 0 ? "info" : "err"
    );
  } else {
    showStatus(`✅ ${totalSuccess} imagen(es) guardada(s) correctamente`, "ok");
  }
}

// Función para subir imágenes a Cloudinary (modificada para aceptar imagen principal)
async function uploadImagesToCloudinary(variantId, files, category, skuBase, color, mainImageIndex = 0, refreshAfter = true) {
  if (!variantId) {
    showStatus("No se pudo obtener el ID de la variante", "err");
    return false;
  }

  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    return false;
  }

  showStatus(`Subiendo ${fileArray.length} imagen(es)...`, "info");

  const uploadedImages = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];

    try {
      // Convertir archivo a base64
      const base64 = await fileToBase64(file);

      // Llamar Edge Function
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

      if (error || !data) {
        console.error(`Error subiendo ${file.name}:`, error || data);
        errorCount++;
        continue;
      }

      uploadedImages.push({
        public_id: data.public_id,
        secure_url: data.secure_url,
        url: data.url || data.secure_url,
        position: i + 1,
        isMain: i === mainImageIndex,
      });

      successCount++;
      console.log(`✅ Imagen ${i + 1}/${fileArray.length} subida:`, data.public_id);

    } catch (err) {
      console.error(`Error procesando ${file.name}:`, err);
      errorCount++;
    }
  }

  // Guardar imágenes en variant_images después del upload
  if (uploadedImages.length > 0) {
    const imagesPayload = uploadedImages.map((img, index) => ({
      variant_id: variantId,
      public_id: img.public_id,
      secure_url: img.secure_url,
      url: img.secure_url,
      position: index + 1,
      is_main: img.isMain || index === mainImageIndex,
    }));

    const { error: insertError } = await supabase
      .from("variant_images")
      .insert(imagesPayload);

    if (insertError) {
      console.error("❌ Error guardando imágenes en DB:", insertError);
      showStatus(`⚠️ Imágenes subidas pero error guardando en DB: ${insertError.message}`, "err");
    } else {
      console.log(`✅ ${imagesPayload.length} imagen(es) guardada(s) en variant_images`);
      showStatus(`✅ ${successCount} imagen(es) subida(s) y guardada(s) correctamente`, "ok");
      
      // Solo refrescar si se solicita (no refrescar cuando se llama desde saveProductImages)
      if (refreshAfter) {
        // Verificar tags después de guardar
        await checkAndPromptTags(variantId);
        
        // Refrescar la lista después de un momento
        setTimeout(() => {
          loadVariants();
        }, 1000);
      }
    }
  }

  if (errorCount > 0) {
    showStatus(`${successCount > 0 ? "✅ " : ""}⚠️ ${errorCount} error(es) al procesar imágenes`, errorCount === fileArray.length ? "err" : "info");
  }

  return successCount > 0;
}

// Función para verificar tags y mostrar modal si faltan
async function checkAndPromptTags(variantId) {
  try {
    // Obtener el producto asociado a la variante
    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("products!inner(id)")
      .eq("id", variantId)
      .single();
    
    if (variantError || !variant?.products) {
      console.error("Error obteniendo producto de la variante:", variantError);
      return;
    }
    
    const productId = variant.products.id;
    
    // Verificar si el producto tiene tags
    const { data: productTags, error: tagsError } = await supabase
      .from("product_tags")
      .select("tag1_id, tag2_id")
      .eq("product_id", productId)
      .maybeSingle();
    
    if (tagsError) {
      console.error("Error verificando tags:", tagsError);
      return;
    }
    
    // Si no tiene tag1_id o tag2_id, mostrar modal obligatorio
    if (!productTags || !productTags.tag1_id || !productTags.tag2_id) {
      showTagsModal(productId);
    }
  } catch (error) {
    console.error("Error en checkAndPromptTags:", error);
  }
}

// Función para mostrar modal de URLs
async function showUrlModal(variantId, productId = null) {
  // Obtener productId si no se proporcionó
  if (!productId) {
    const { data: variant } = await supabase
      .from("product_variants")
      .select("product_id")
      .eq("id", variantId)
      .single();
    productId = variant?.product_id;
  }

  if (!productId) {
    showStatus("Error: No se pudo obtener el ID del producto", "err");
    return;
  }

  const modal = document.getElementById("url-modal");
  const urlsContainer = document.getElementById("url-inputs-container");
  const addUrlBtn = document.getElementById("add-url-btn");
  const modalClose = document.getElementById("modal-close");
  const modalCancel = document.getElementById("modal-cancel");
  const modalSubmit = document.getElementById("modal-submit");
  
  const MIN_URLS = 1;
  const MAX_URLS = 10;
  let urlInputs = [];
  
  // Función para crear un input de URL
  const createUrlInput = (index, canRemove = false) => {
    const wrapper = document.createElement("div");
    wrapper.className = "url-input-wrapper";
    wrapper.dataset.index = index;
    
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `URL ${index + 1}`;
    input.dataset.index = index;
    
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "✕ Eliminar";
    removeBtn.disabled = !canRemove;
    
    removeBtn.addEventListener("click", () => {
      wrapper.remove();
      urlInputs = urlInputs.filter((_, i) => i !== index);
      updateInputIndices();
      updateAddButton();
    });
    
    wrapper.appendChild(input);
    wrapper.appendChild(removeBtn);
    
    urlInputs.push({ wrapper, input, removeBtn });
    return wrapper;
  };
  
  // Función para actualizar índices después de eliminar
  const updateInputIndices = () => {
    urlInputs.forEach((item, newIndex) => {
      item.wrapper.dataset.index = newIndex;
      item.input.dataset.index = newIndex;
      item.input.placeholder = `URL ${newIndex + 1}`;
    });
  };
  
  // Función para actualizar estado del botón agregar
  const updateAddButton = () => {
    addUrlBtn.disabled = urlInputs.length >= MAX_URLS;
    if (urlInputs.length >= MAX_URLS) {
      addUrlBtn.textContent = `Máximo ${MAX_URLS} URLs`;
      addUrlBtn.style.opacity = "0.5";
      addUrlBtn.style.cursor = "not-allowed";
    } else {
      addUrlBtn.textContent = "➕ Agregar URL";
      addUrlBtn.style.opacity = "1";
      addUrlBtn.style.cursor = "pointer";
    }
  };
  
  // Función para agregar un nuevo input
  const addUrlInput = () => {
    if (urlInputs.length >= MAX_URLS) return;
    
    const newIndex = urlInputs.length;
    const canRemove = urlInputs.length >= MIN_URLS;
    const wrapper = createUrlInput(newIndex, canRemove);
    urlsContainer.appendChild(wrapper);
    updateAddButton();
    wrapper.querySelector("input").focus();
  };
  
  // Inicializar con mínimo de inputs
  urlsContainer.innerHTML = "";
  urlInputs = [];
  for (let i = 0; i < MIN_URLS; i++) {
    const wrapper = createUrlInput(i, false);
    urlsContainer.appendChild(wrapper);
  }
  updateAddButton();
  
  // Event listener para botón agregar
  addUrlBtn.onclick = addUrlInput;
  
  // Mostrar modal
  modal.classList.add("active");
  if (urlInputs.length > 0) {
    urlInputs[0].input.focus();
  }
  
  // Función para cerrar modal
  const closeModal = () => {
    modal.classList.remove("active");
    urlsContainer.innerHTML = "";
    urlInputs = [];
  };
  
  // Función para procesar URLs
  const processUrls = () => {
    const urls = urlInputs
      .map(item => item.input.value.trim())
      .filter(url => url.length > 0 && (url.startsWith("http://") || url.startsWith("https://")));
    
    if (urls.length === 0) {
      showStatus("Por favor ingresá al menos una URL válida", "err");
      return;
    }
    
    if (urls.length < MIN_URLS) {
      showStatus(`Se requiere al menos ${MIN_URLS} URL${MIN_URLS > 1 ? 's' : ''}`, "err");
      return;
    }

    closeModal();
    
    // Agregar a pendingImages en lugar de guardar inmediatamente
    addPendingUrls(productId, variantId, urls);
    showStatus(`✅ ${urls.length} URL(s) agregada(s) a la cola. Presioná "Guardar" para cargarlas.`, "ok");
  };
  
  // Event listeners
  modalClose.onclick = closeModal;
  modalCancel.onclick = closeModal;
  modalSubmit.onclick = processUrls;
  
  // Cerrar con Escape
  const handleEscape = (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
      document.removeEventListener("keydown", handleEscape);
    }
  };
  document.addEventListener("keydown", handleEscape);
  
  // Cerrar al hacer clic fuera del modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };
}

// Estado para modal de tags
let tagsModalProductId = null;
let tagsModalSelectedTag1Id = null;
let tagsModalSelectedTag2Id = null;
let tagsModalSelectedTag3Ids = [];
let tagsModalProductCategory = null;

// Función para mostrar modal de tags jerárquicos
async function showTagsModal(productId) {
  const modal = document.getElementById("tags-modal");
  const tag1Select = document.getElementById("tags-modal-tag1-select");
  const tag2Select = document.getElementById("tags-modal-tag2-select");
  const tag3Select = document.getElementById("tags-modal-tag3-select");
  const tag1New = document.getElementById("tags-modal-tag1-new");
  const tag2New = document.getElementById("tags-modal-tag2-new");
  const tag3New = document.getElementById("tags-modal-tag3-new");
  const tag1Create = document.getElementById("tags-modal-tag1-create");
  const tag2Create = document.getElementById("tags-modal-tag2-create");
  const tag3Create = document.getElementById("tags-modal-tag3-create");
  const tag3Chips = document.getElementById("tags-modal-tag3-chips");
  const autoTagsBtn = document.getElementById("tags-modal-auto-tags-btn");
  const autoTagsStatus = document.getElementById("tags-modal-auto-tags-status");
  const saveTagsBtn = document.getElementById("tags-modal-save-btn");
  const cancelTagsBtn = document.getElementById("tags-modal-cancel-btn");
  
  tagsModalProductId = productId;
  tagsModalSelectedTag1Id = null;
  tagsModalSelectedTag2Id = null;
  tagsModalSelectedTag3Ids = [];
  
  // Obtener categoría del producto
  const { data: product } = await supabase
    .from("products")
    .select("category")
    .eq("id", productId)
    .single();
  
  tagsModalProductCategory = product?.category || "";
  
  // Cargar tags existentes
  const { data: productTags } = await supabase
    .from("product_tags")
    .select("tag1_id, tag2_id, tag3_ids")
    .eq("product_id", productId)
    .maybeSingle();
  
  if (productTags) {
    tagsModalSelectedTag1Id = productTags.tag1_id;
    tagsModalSelectedTag2Id = productTags.tag2_id;
    tagsModalSelectedTag3Ids = productTags.tag3_ids || [];
  }
  
  // Renderizar tags
  await renderTagsModalTags1();
  await renderTagsModalTags2();
  await renderTagsModalTags3();
  
  // Mostrar modal
  modal.classList.add("active");
  
  // Función para actualizar estado de campos de creación (se define antes de los event listeners)
  const updateCreateFieldsState = () => {
    // Tags1: siempre habilitado
    tag1New.disabled = false;
    tag1Create.disabled = false;
    
    // Tags2: habilitado solo si hay Tags1 seleccionado
    const hasTag1 = !!tagsModalSelectedTag1Id;
    tag2New.disabled = !hasTag1;
    tag2Create.disabled = !hasTag1;
    
    // Tags3: habilitado solo si hay Tags1 y Tags2 seleccionados, y no se alcanzó el máximo
    const hasTag2 = !!tagsModalSelectedTag2Id;
    const canAddTag3 = hasTag1 && hasTag2 && tagsModalSelectedTag3Ids.length < 2;
    tag3New.disabled = !canAddTag3;
    tag3Create.disabled = !canAddTag3;
  };
  
  // Función para crear Tags1
  const createTag1 = async () => {
    const name = tag1New.value.trim();
    if (!name) {
      tag1New.focus();
      return;
    }
    const newTag = await createTagModal(name, 1, tagsModalProductCategory, null);
    if (newTag) {
      tag1New.value = "";
      await renderTagsModalTags1();
      tag1Select.value = newTag.id;
      tagsModalSelectedTag1Id = newTag.id;
      await renderTagsModalTags2();
      await renderTagsModalTags3();
      updateCreateFieldsState();
      showStatus(`✅ Tags1 "${newTag.name}" creado y seleccionado`, "ok");
    }
  };
  
  // Función para crear Tags2
  const createTag2 = async () => {
    const name = tag2New.value.trim();
    if (!tagsModalSelectedTag1Id || !name) {
      if (!tagsModalSelectedTag1Id) {
        showStatus("⚠️ Primero debes seleccionar o crear un Tags1", "err");
      } else {
        tag2New.focus();
      }
      return;
    }
    const newTag = await createTagModal(name, 2, tagsModalProductCategory, tagsModalSelectedTag1Id);
    if (newTag) {
      tag2New.value = "";
      await renderTagsModalTags2();
      tag2Select.value = newTag.id;
      tagsModalSelectedTag2Id = newTag.id;
      await renderTagsModalTags3();
      updateCreateFieldsState();
      showStatus(`✅ Tags2 "${newTag.name}" creado y seleccionado`, "ok");
    }
  };
  
  // Función para crear Tags3
  const createTag3 = async () => {
    const name = tag3New.value.trim();
    if (!tagsModalSelectedTag1Id || !tagsModalSelectedTag2Id || !name) {
      if (!tagsModalSelectedTag1Id || !tagsModalSelectedTag2Id) {
        showStatus("⚠️ Primero debes seleccionar Tags1 y Tags2", "err");
      } else {
        tag3New.focus();
      }
      return;
    }
    if (tagsModalSelectedTag3Ids.length >= 2) {
      showStatus("⚠️ Ya has seleccionado el máximo de 2 Tags3", "err");
      tag3New.value = "";
      return;
    }
    const newTag = await createTagModal(name, 3, tagsModalProductCategory, tagsModalSelectedTag2Id);
    if (newTag) {
      tag3New.value = "";
      tagsModalSelectedTag3Ids.push(newTag.id);
      await renderTagsModalTags3();
      renderTagsModalTag3Chips();
      updateCreateFieldsState();
      showStatus(`✅ Tags3 "${newTag.name}" creado y agregado`, "ok");
    }
  };
  
  // Event listeners
  tag1Select.onchange = async () => {
    tagsModalSelectedTag1Id = tag1Select.value || null;
    tagsModalSelectedTag2Id = null;
    tagsModalSelectedTag3Ids = [];
    await renderTagsModalTags2();
    await renderTagsModalTags3();
    updateCreateFieldsState();
  };
  
  tag2Select.onchange = async () => {
    tagsModalSelectedTag2Id = tag2Select.value || null;
    tagsModalSelectedTag3Ids = [];
    await renderTagsModalTags3();
    updateCreateFieldsState();
  };
  
  tag3Select.onchange = () => {
    const selected = Array.from(tag3Select.selectedOptions).map(opt => opt.value);
    tagsModalSelectedTag3Ids = selected.filter(v => v);
    renderTagsModalTag3Chips();
    updateCreateFieldsState();
  };
  
  // Crear tags - botones
  tag1Create.onclick = createTag1;
  tag2Create.onclick = createTag2;
  tag3Create.onclick = createTag3;
  
  // Crear tags - Enter en campos de texto
  tag1New.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createTag1();
    }
  });
  
  tag2New.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createTag2();
    }
  });
  
  tag3New.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      createTag3();
    }
  });
  
  // Inicializar estado de campos
  updateCreateFieldsState();
  
  // Auto-tags
  autoTagsBtn.onclick = async () => {
    await handleAutoTagsModal();
  };
  
  // Guardar
  saveTagsBtn.onclick = async () => {
    await saveTagsModal();
  };
  
  // Cancelar
  const closeModal = () => {
    modal.classList.remove("active");
  };
  
  cancelTagsBtn.onclick = closeModal;
  document.getElementById("tags-modal-close").onclick = closeModal;
  
  // Cerrar con Escape
  const handleEscape = (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      closeModal();
      document.removeEventListener("keydown", handleEscape);
    }
  };
  document.addEventListener("keydown", handleEscape);
  
  // Cerrar al hacer clic fuera del modal
  modal.onclick = (e) => {
    if (e.target === modal) {
      closeModal();
    }
  };
}

// Funciones auxiliares para tags modal
async function loadTagsModalTags1(category) {
  if (!category) return [];
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("category", category)
    .eq("level", 1)
    .is("parent_id", null)
    .order("name");
  return error ? [] : (data || []);
}

async function loadTagsModalTags2(tag1Id) {
  if (!tag1Id) return [];
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("parent_id", tag1Id)
    .eq("level", 2)
    .order("name");
  return error ? [] : (data || []);
}

async function loadTagsModalTags3(tag1Id) {
  if (!tag1Id) return [];
  const { data: tags2, error: err2 } = await supabase
    .from("tags")
    .select("id")
    .eq("parent_id", tag1Id)
    .eq("level", 2);
  if (err2 || !tags2 || tags2.length === 0) return [];
  const tag2Ids = tags2.map(t => t.id);
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .in("parent_id", tag2Ids)
    .eq("level", 3)
    .order("name");
  return error ? [] : (data || []);
}

async function createTagModal(name, level, category, parentId) {
  const { data, error } = await supabase
    .from("tags")
    .insert([{ name, level, category, parent_id: parentId }])
    .select("id, name")
    .single();
  if (error) {
    console.error("Error creando tag:", error);
    showStatus("Error creando tag: " + error.message, "err");
    return null;
  }
  return data;
}

async function renderTagsModalTags1() {
  const tag1Select = document.getElementById("tags-modal-tag1-select");
  const tags1 = await loadTagsModalTags1(tagsModalProductCategory);
  
  // Eliminar duplicados por nombre normalizado
  const seen = new Set();
  const uniqueTags = [];
  tags1.forEach(tag => {
    const normalized = normalizeName(tag.name);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueTags.push(tag);
    }
  });
  
  tag1Select.innerHTML = '<option value="">-- Seleccionar Tags1 --</option>';
  uniqueTags.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    tag1Select.appendChild(opt);
  });
  if (tagsModalSelectedTag1Id) {
    tag1Select.value = tagsModalSelectedTag1Id;
  }
}

async function renderTagsModalTags2() {
  const tag2Select = document.getElementById("tags-modal-tag2-select");
  const tag2New = document.getElementById("tags-modal-tag2-new");
  const tag2Create = document.getElementById("tags-modal-tag2-create");
  
  if (!tagsModalSelectedTag1Id) {
    tag2Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag2Select.disabled = true;
    tag2New.disabled = true;
    tag2Create.disabled = true;
    return;
  }
  const tags2 = await loadTagsModalTags2(tagsModalSelectedTag1Id);
  tag2Select.innerHTML = '<option value="">-- Seleccionar Tags2 --</option>';
  tags2.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    tag2Select.appendChild(opt);
  });
  tag2Select.disabled = false;
  tag2New.disabled = false;
  tag2Create.disabled = false;
  if (tagsModalSelectedTag2Id) {
    tag2Select.value = tagsModalSelectedTag2Id;
  }
}

async function renderTagsModalTags3() {
  const tag3Select = document.getElementById("tags-modal-tag3-select");
  const tag3New = document.getElementById("tags-modal-tag3-new");
  const tag3Create = document.getElementById("tags-modal-tag3-create");
  
  if (!tagsModalSelectedTag1Id) {
    tag3Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag3Select.disabled = true;
    tag3New.disabled = true;
    tag3Create.disabled = true;
    renderTagsModalTag3Chips();
    return;
  }
  if (!tagsModalSelectedTag2Id) {
    tag3Select.innerHTML = '<option value="">-- Primero selecciona Tags2 --</option>';
    tag3Select.disabled = true;
    tag3New.disabled = true;
    tag3Create.disabled = true;
    renderTagsModalTag3Chips();
    return;
  }
  const tags3 = await loadTagsModalTags3(tagsModalSelectedTag1Id);
  tag3Select.innerHTML = "";
  tags3.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    opt.selected = tagsModalSelectedTag3Ids.includes(tag.id);
    tag3Select.appendChild(opt);
  });
  tag3Select.disabled = false;
  const canAddTag3 = tagsModalSelectedTag3Ids.length < 2;
  tag3New.disabled = !canAddTag3;
  tag3Create.disabled = !canAddTag3;
  renderTagsModalTag3Chips();
}

function renderTagsModalTag3Chips() {
  const tag3Chips = document.getElementById("tags-modal-tag3-chips");
  const tag3New = document.getElementById("tags-modal-tag3-new");
  const tag3Create = document.getElementById("tags-modal-tag3-create");
  
  if (!tagsModalSelectedTag1Id || tagsModalSelectedTag3Ids.length === 0) {
    tag3Chips.innerHTML = "";
    // Actualizar estado de campos si hay Tags1 y Tags2 pero no Tags3
    if (tagsModalSelectedTag1Id && tagsModalSelectedTag2Id) {
      tag3New.disabled = false;
      tag3Create.disabled = false;
    }
    return;
  }
  Promise.all(tagsModalSelectedTag3Ids.map(id => 
    supabase.from("tags").select("name").eq("id", id).single()
  )).then(results => {
    tag3Chips.innerHTML = "";
    results.forEach((result, idx) => {
      if (result.data) {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = result.data.name;
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "✕";
        x.addEventListener("click", () => {
          tagsModalSelectedTag3Ids = tagsModalSelectedTag3Ids.filter((_, i) => i !== idx);
          renderTagsModalTags3();
        });
        chip.appendChild(x);
        tag3Chips.appendChild(chip);
      }
    });
    // Actualizar estado de campos después de renderizar chips
    const canAddTag3 = tagsModalSelectedTag3Ids.length < 2;
    tag3New.disabled = !canAddTag3;
    tag3Create.disabled = !canAddTag3;
  });
}

async function handleAutoTagsModal() {
  const autoTagsStatus = document.getElementById("tags-modal-auto-tags-status");
  if (!tagsModalProductId) {
    autoTagsStatus.textContent = "Error: No hay producto cargado";
    autoTagsStatus.style.color = "#c00";
    return;
  }
  
  const { data: variants } = await supabase
    .from("product_variants")
    .select("id")
    .eq("product_id", tagsModalProductId)
    .eq("active", true)
    .limit(1);
  
  if (!variants || variants.length === 0) {
    autoTagsStatus.textContent = "Error: El producto no tiene variantes activas";
    autoTagsStatus.style.color = "#c00";
    return;
  }
  
  const { data: images } = await supabase
    .from("variant_images")
    .select("url")
    .eq("variant_id", variants[0].id)
    .eq("is_main", true)
    .limit(1)
    .maybeSingle();
  
  if (!images || !images.url) {
    autoTagsStatus.textContent = "Error: El producto no tiene imagen principal";
    autoTagsStatus.style.color = "#c00";
    return;
  }
  
  const { data: product } = await supabase
    .from("products")
    .select("name, category, description")
    .eq("id", tagsModalProductId)
    .single();
  
  if (!product) {
    autoTagsStatus.textContent = "Error: No se pudo obtener información del producto";
    autoTagsStatus.style.color = "#c00";
    return;
  }
  
  autoTagsStatus.textContent = "Analizando con IA...";
  autoTagsStatus.style.color = "inherit";
  
  try {
    const { data, error } = await supabase.functions.invoke("auto_tags", {
      body: {
        image_url: images.url,
        product_name: product.name,
        category_hint: product.category,
        description: product.description || null,
      },
    });
    
    if (error) throw error;
    
    if (!data || !data.tag1 || !data.tag2) {
      throw new Error("La respuesta de la IA está incompleta");
    }
    
    // Buscar o crear tag1
    let tag1 = await loadTagsModalTags1(tagsModalProductCategory);
    let tag1Found = tag1.find(t => normalizeName(t.name) === normalizeName(data.tag1));
    if (!tag1Found) {
      tag1Found = await createTagModal(data.tag1, 1, tagsModalProductCategory, null);
    }
    if (tag1Found) {
      tagsModalSelectedTag1Id = tag1Found.id;
      await renderTagsModalTags1();
      document.getElementById("tags-modal-tag1-select").value = tag1Found.id;
      await renderTagsModalTags2();
    }
    
    // Buscar o crear tag2
    if (tagsModalSelectedTag1Id) {
      let tag2 = await loadTagsModalTags2(tagsModalSelectedTag1Id);
      let tag2Found = tag2.find(t => normalizeName(t.name) === normalizeName(data.tag2));
      if (!tag2Found) {
        tag2Found = await createTagModal(data.tag2, 2, tagsModalProductCategory, tagsModalSelectedTag1Id);
      }
      if (tag2Found) {
        tagsModalSelectedTag2Id = tag2Found.id;
        await renderTagsModalTags2();
        document.getElementById("tags-modal-tag2-select").value = tag2Found.id;
        await renderTagsModalTags3();
      }
    }
    
    autoTagsStatus.textContent = "✓ Tags sugeridos aplicados";
    autoTagsStatus.style.color = "#065f46";
  } catch (error) {
    console.error("Error en auto-tags:", error);
    autoTagsStatus.textContent = "Error: " + error.message;
    autoTagsStatus.style.color = "#c00";
  }
}

function normalizeName(str) {
  return (str || "").toLowerCase().trim().replace(/\s+/g, " ");
}

async function saveTagsModal() {
  if (!tagsModalProductId) {
    showStatus("Error: No hay producto cargado", "err");
    return;
  }
  
  if (!tagsModalSelectedTag1Id || !tagsModalSelectedTag2Id) {
    showStatus("Error: Tags1 y Tags2 son obligatorios", "err");
    return;
  }
  
  const saveBtn = document.getElementById("tags-modal-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Guardando...";
  
  try {
    const { data: existingTags } = await supabase
      .from("product_tags")
      .select("product_id")
      .eq("product_id", tagsModalProductId)
      .maybeSingle();
    
    const tagPayload = {
      product_id: tagsModalProductId,
      tag1_id: tagsModalSelectedTag1Id,
      tag2_id: tagsModalSelectedTag2Id,
      tag3_ids: tagsModalSelectedTag3Ids.length > 0 ? tagsModalSelectedTag3Ids : null
    };
    
    if (existingTags) {
      const { error } = await supabase
        .from("product_tags")
        .update(tagPayload)
        .eq("product_id", tagsModalProductId);
      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("product_tags")
        .insert([tagPayload]);
      if (error) throw error;
    }
    
    showStatus("✓ Tags guardados correctamente", "ok");
    
    // Cerrar modal
    document.getElementById("tags-modal").classList.remove("active");
    
    // Refrescar después de un momento
    setTimeout(() => {
      loadVariants();
    }, 1000);
    
  } catch (error) {
    console.error("Error guardando tags:", error);
    showStatus(`Error: ${error.message}`, "err");
    saveBtn.disabled = false;
    saveBtn.textContent = "Guardar";
  }
}

// Función para cargar imágenes desde URLs de Cloudinary (reutilizada de products.js)
async function loadImagesFromUrls(variantId, urlsText, refreshAfter = true) {
  if (!variantId) {
    showStatus("No se pudo obtener el ID de la variante", "err");
    return false;
  }
  
  if (!urlsText || !urlsText.trim()) {
    return false;
  }

  // Parsear URLs (separadas por comas o saltos de línea)
  const urls = urlsText
    .split(/[,\n]/)
    .map(url => url.trim())
    .filter(url => url.length > 0 && (url.startsWith("http://") || url.startsWith("https://")));

  if (urls.length === 0) {
    showStatus("No se encontraron URLs válidas", "err");
    return false;
  }

  // Validar cantidad máxima (10 imágenes)
  const maxImages = 10;
  if (urls.length > maxImages) {
    showStatus(`Máximo ${maxImages} imágenes permitidas. Se cargarán las primeras ${maxImages}.`, "info");
    urls.splice(maxImages);
  }

  showStatus(`Procesando ${urls.length} URL(s)...`, "info");

  const imagesPayload = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    
    try {
      // Normalizar URL (usar https)
      const secure_url = url.replace(/^http:/, "https:");
      
      // Extraer public_id de la URL de Cloudinary
      // Formato: https://res.cloudinary.com/{cloud_name}/image/upload/{transformations}/{public_id}.{format}
      // Ejemplos:
      // - https://res.cloudinary.com/dnuedzuzm/image/upload/v1234567890/productos/calzado/ZAP343-NEG-1.jpg
      // - https://res.cloudinary.com/dnuedzuzm/image/upload/f_auto,q_auto/productos/calzado/ZAP343-NEG-1.jpg
      let public_id = null;
      
      // Intentar extraer public_id después de /upload/
      const uploadMatch = secure_url.match(/\/image\/upload\/[^\/]+\/(.+)$/i);
      if (uploadMatch) {
        // Remover transformaciones y obtener el path completo
        const pathAfterUpload = uploadMatch[1];
        // Remover parámetros de query si existen
        const pathWithoutQuery = pathAfterUpload.split('?')[0];
        // Remover extensión
        public_id = pathWithoutQuery.replace(/\.(jpg|jpeg|png|webp|gif)$/i, '');
      }
      
      // Si no se pudo extraer, intentar método alternativo
      if (!public_id) {
        const altMatch = secure_url.match(/\/upload\/(?:v\d+\/|f_[^\/]+\/|q_[^\/]+\/|c_[^\/]+\/|w_\d+\/)*([^\/]+(?:\/[^\/]+)*)\.(jpg|jpeg|png|webp|gif)/i);
        if (altMatch) {
          public_id = altMatch[1];
        }
      }
      
      // Si aún no se pudo extraer, usar null (se usará secure_url directamente)
      if (!public_id) {
        console.warn(`⚠️ No se pudo extraer public_id de la URL: ${url}. Se usará la URL directamente.`);
      }

      imagesPayload.push({
        variant_id: variantId,
        public_id: public_id, // Puede ser null
        secure_url: secure_url,
        url: secure_url, // Asegurar que url siempre tenga un valor
        position: i + 1,
        is_main: i === 0,
      });

      successCount++;
      console.log(`✅ URL ${i + 1}/${urls.length} procesada:`, secure_url);

    } catch (err) {
      console.error(`Error procesando URL ${url}:`, err);
      errorCount++;
    }
  }

  // Guardar imágenes en variant_images
  if (imagesPayload.length > 0) {
    const { error: insertError } = await supabase
      .from("variant_images")
      .insert(imagesPayload);

    if (insertError) {
      console.error("❌ Error guardando URLs en DB:", insertError);
      showStatus(`⚠️ Error guardando URLs: ${insertError.message}`, "err");
    } else {
      console.log(`✅ ${imagesPayload.length} URL(s) guardada(s) en variant_images`);
      showStatus(`✅ ${successCount} URL(s) cargada(s) correctamente`, "ok");
      
      // Solo refrescar si se solicita (no refrescar cuando se llama desde saveProductImages)
      if (refreshAfter) {
        // Verificar tags después de guardar
        await checkAndPromptTags(variantId);
        
        // Refrescar la lista después de un momento
        setTimeout(() => {
          loadVariants();
        }, 1000);
      }
    }
  }

  if (errorCount > 0) {
    showStatus(`${successCount > 0 ? "✅ " : ""}⚠️ ${errorCount} error(es) al procesar URLs`, errorCount === urls.length ? "err" : "info");
  }

  return successCount > 0;
}

// Función para mostrar mensajes de estado
function showStatus(message, type = "info") {
  statusMessage.textContent = message;
  statusMessage.className = `message ${type}`;
  statusMessage.style.display = "block";
  
  if (type === "ok") {
    setTimeout(() => {
      if (statusMessage.textContent === message) {
        statusMessage.style.display = "none";
      }
    }, 3000);
  }
}

// Función para obtener el estado del badge
function getStatusBadge(status, isActive) {
  const statusText = status || "draft";
  const activeText = isActive ? "Activa" : "Inactiva";
  const activeClass = isActive ? "status-active" : "status-inactive";
  
  let statusClass = "status-draft";
  if (statusText === "active") statusClass = "status-active";
  else if (statusText === "pending_stock") statusClass = "status-pending";
  else if (statusText === "archived") statusClass = "status-archived";
  
  return {
    productStatus: `<span class="status-badge ${statusClass}">${statusText}</span>`,
    variantStatus: `<span class="status-badge ${activeClass}">${activeText}</span>`
  };
}

// Función para cargar variantes sin imágenes
async function loadVariants(productIdToUpdate = null) {
  try {
    if (!productIdToUpdate) {
      productsCardsContainer.innerHTML = `
        <div style="text-align:center;padding:40px;color:#9ca3af">
          <div style="font-size:16px;margin-bottom:8px">⏳</div>
          Cargando variantes sin imágenes...
        </div>
      `;
    }

    // Obtener todas las variantes con información del producto
    const { data: allVariants, error: variantsError } = await supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        active,
        products!inner (
          id,
          name,
          handle,
          status,
          category
        )
      `);

    if (variantsError) {
      throw variantsError;
    }

    // Obtener todas las imágenes (solo variant_id para verificar existencia)
    const { data: allImages, error: imagesError } = await supabase
      .from("variant_images")
      .select("variant_id");

    if (imagesError) {
      console.warn("⚠️ Error obteniendo imágenes (continuando de todas formas):", imagesError);
    }

    // Crear Set de variant_ids que tienen imágenes
    const variantsWithImages = new Set((allImages || []).map(img => img.variant_id));

    // Filtrar variantes sin imágenes
    let variantsWithoutImages = (allVariants || []).filter(v => {
      if (variantsWithImages.has(v.id)) return false;
      
      const productStatus = v.products?.status;
      if (!showActive) {
        return productStatus === 'draft' || productStatus === 'pending_stock';
      } else {
        return productStatus !== 'archived';
      }
    });

    currentVariants = variantsWithoutImages;
    countDisplay.textContent = `${variantsWithoutImages.length} variante(s) sin imágenes`;

    if (variantsWithoutImages.length === 0) {
      if (!productIdToUpdate) {
        productsCardsContainer.innerHTML = `
          <div style="text-align:center;padding:20px;color:#999">
            ✅ No hay variantes sin imágenes${showActive ? "" : " (mostrando solo draft/pending_stock)"}
            <br/><small style="color:#666;margin-top:8px;display:block">
              Tip: Activa "Mostrar también variantes/productos activos" para ver más productos
            </small>
          </div>
        `;
      }
      return;
    }

    // Agrupar variantes por producto
    groupedVariants.clear();
    variantsWithoutImages.forEach(variant => {
      const productId = variant.products.id;
      if (!groupedVariants.has(productId)) {
        groupedVariants.set(productId, {
          product: variant.products,
          variants: []
        });
      }
      groupedVariants.get(productId).variants.push(variant);
    });

    // Renderizar tarjetas
    if (productIdToUpdate) {
      // Actualizar solo la tarjeta específica
      updateProductCard(productIdToUpdate);
    } else {
      // Renderizar todas las tarjetas
      renderProductCards();
    }

  } catch (error) {
    console.error("❌ Error cargando variantes:", error);
    showStatus(`Error cargando variantes: ${error.message}`, "err");
    if (!productIdToUpdate) {
      productsCardsContainer.innerHTML = `
        <div style="text-align:center;padding:20px;color:#c00">
          Error cargando variantes: ${error.message}
        </div>
      `;
    }
  }
}

// Función para renderizar tarjetas de productos
function renderProductCards() {
  productsCardsContainer.innerHTML = "";

  if (groupedVariants.size === 0) {
    productsCardsContainer.innerHTML = `
      <div style="text-align:center;padding:20px;color:#999">
        ✅ No hay variantes sin imágenes
      </div>
    `;
    return;
  }

  groupedVariants.forEach((group, productId) => {
    const card = createProductCard(productId, group.product, group.variants);
    productsCardsContainer.appendChild(card);
  });
}

// Función para crear una tarjeta de producto
function createProductCard(productId, product, variants) {
  const card = document.createElement("div");
  card.className = "product-card";
  card.dataset.productId = productId;

  const badges = getStatusBadge(product?.status, true);
  const pendingCount = getPendingImagesCount(productId);

  card.innerHTML = `
    <div class="product-card-header">
      <div class="product-card-title">
        <h3>${product?.name || "(sin nombre)"}</h3>
        <small>${product?.handle || ""}</small>
      </div>
      <div class="product-card-meta">
        ${badges.productStatus}
        <span class="product-card-count">${variants.length} variante(s) sin imagen</span>
      </div>
    </div>
    <div class="variants-list" id="variants-list-${productId}">
      ${variants.map(v => createVariantItemHTML(v, product)).join("")}
    </div>
    <div class="pending-images-section" id="pending-images-${productId}">
      <div class="pending-images-header">
        <h4>📷 Imágenes pendientes de guardar</h4>
      </div>
      <div class="pending-images-list" id="pending-images-list-${productId}"></div>
    </div>
    <button class="save-product-btn" id="save-btn-${productId}" data-product-id="${productId}">
      💾 Guardar imágenes de este producto
    </button>
  `;

  // Agregar event listeners a los botones de cada variante
  variants.forEach(variant => {
    const variantItem = card.querySelector(`[data-variant-id="${variant.id}"]`);
    if (!variantItem) return;

    // Botón de subir archivos
    const fileInput = variantItem.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.addEventListener("change", async (e) => {
        const files = e.target.files;
        if (files.length === 0) return;

        const variantId = fileInput.dataset.variantId;
        const category = fileInput.dataset.category;
        const skuBase = fileInput.dataset.sku;
        const color = fileInput.dataset.color;

        showImagePreviewModal(variantId, files, category, skuBase, color, productId);
        e.target.value = "";
      });
    }

    // Botón de cargar URLs
    const urlBtn = variantItem.querySelector('button[data-variant-id]');
    if (urlBtn) {
      urlBtn.addEventListener("click", () => {
        const variantId = urlBtn.dataset.variantId;
        showUrlModal(variantId, productId);
      });
    }
  });

  // Botón de guardar
  const saveBtn = card.querySelector(`#save-btn-${productId}`);
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      await saveProductImages(productId);
    });
  }

  // Actualizar estado de imágenes pendientes
  updatePendingImagesDisplay(productId);

  return card;
}

// Función para crear HTML de un item de variante
function createVariantItemHTML(variant, product) {
  const badges = getStatusBadge(product?.status, variant.active);
  return `
    <div class="variant-item" data-variant-id="${variant.id}">
      <div class="variant-info">
        <code class="variant-sku">${variant.sku || "-"}</code>
        <span class="variant-color">${variant.color || "-"}</span>
        ${badges.variantStatus}
      </div>
      <div class="variant-actions">
        <label class="btn" style="cursor:pointer">
          📤 Subir imágenes
          <input type="file" multiple accept="image/jpeg,image/jpg,image/png,image/webp" 
                 data-variant-id="${variant.id}" 
                 data-category="${product?.category || ""}"
                 data-sku="${variant.sku || ""}"
                 data-color="${variant.color || ""}"
                 style="display:none" />
        </label>
        <button class="btn" data-variant-id="${variant.id}">
          🔗 Cargar URL
        </button>
      </div>
    </div>
  `;
}

// Función para actualizar una tarjeta específica
function updateProductCard(productId) {
  const card = document.querySelector(`[data-product-id="${productId}"]`);
  if (!card) return;

  const group = groupedVariants.get(productId);
  if (!group) {
    // Si el producto ya no tiene variantes sin imagen, eliminar la tarjeta
    card.remove();
    return;
  }

  // Actualizar el contador
  const countEl = card.querySelector(".product-card-count");
  if (countEl) {
    countEl.textContent = `${group.variants.length} variante(s) sin imagen`;
  }

  // Actualizar lista de variantes
  const variantsList = card.querySelector(`#variants-list-${productId}`);
  if (variantsList) {
    variantsList.innerHTML = group.variants.map(v => createVariantItemHTML(v, group.product)).join("");

    // Re-agregar event listeners
    group.variants.forEach(variant => {
      const variantItem = variantsList.querySelector(`[data-variant-id="${variant.id}"]`);
      if (!variantItem) return;

      const fileInput = variantItem.querySelector('input[type="file"]');
      if (fileInput) {
        fileInput.addEventListener("change", async (e) => {
          const files = e.target.files;
          if (files.length === 0) return;

          const variantId = fileInput.dataset.variantId;
          const category = fileInput.dataset.category;
          const skuBase = fileInput.dataset.sku;
          const color = fileInput.dataset.color;

          showImagePreviewModal(variantId, files, category, skuBase, color, productId);
          e.target.value = "";
        });
      }

      const urlBtn = variantItem.querySelector('button[data-variant-id]');
      if (urlBtn) {
        urlBtn.addEventListener("click", () => {
          const variantId = urlBtn.dataset.variantId;
          showUrlModal(variantId, productId);
        });
      }
    });
  }

  // Actualizar display de imágenes pendientes
  updatePendingImagesDisplay(productId);

  // Re-agregar event listeners después de actualizar
  const saveBtn = card.querySelector(`#save-btn-${productId}`);
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      await saveProductImages(productId);
    });
  }
}

// Event listeners
refreshBtn.addEventListener("click", () => {
  loadVariants();
});

showActiveCheckbox.addEventListener("change", (e) => {
  showActive = e.target.checked;
  loadVariants();
});

// Cargar variantes al iniciar
loadVariants();

