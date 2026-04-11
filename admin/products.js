// admin/products.js
import { supabase } from "../scripts/supabase-client.js";

console.log("🔧 products.js cargado");

// Verificación simple de autenticación sin bloquear
let __currentUser = null;
async function checkAuth() {
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

// Verificar autenticación sin bloquear
checkAuth();

const form = document.getElementById("product-form");
let isSaving = false;
const statusEl = document.getElementById("save-status");
const variantsTable = document.querySelector("#variants-table tbody");
const addVariantBtn = document.getElementById("add-variant");
let canViewCostFields = false;

console.log("🔍 Elementos encontrados:", {
  form: !!form,
  statusEl: !!statusEl,
  variantsTable: !!variantsTable,
  addVariantBtn: !!addVariantBtn,
  supabase: !!supabase,
});

function applyCostVisibilityToRow(row) {
  if (!row) return;
  const costInput = row.querySelector(".v-cost");
  const costCell = costInput?.closest("td");
  if (costCell) {
    costCell.style.display = canViewCostFields ? "" : "none";
  }
}

function applyCostFieldVisibility() {
  document.querySelectorAll("[data-cost-sensitive]").forEach((el) => {
    el.style.display = canViewCostFields ? "" : "none";
  });

  variantsTable?.querySelectorAll("tr").forEach((row) => {
    applyCostVisibilityToRow(row);
  });
}

async function initRoleBasedCostVisibility() {
  try {
    const { isSuperAdmin } = await import("./permissions-helper.js");
    canViewCostFields = await isSuperAdmin();
  } catch (error) {
    console.warn("No se pudo resolver rol para visibilidad de costos:", error);
    canViewCostFields = false;
  }

  applyCostFieldVisibility();
}

// Search / load controls
const pSearch = document.getElementById("p-search");
const pSearchBtn = document.getElementById("p-search-btn");
const pResults = document.getElementById("p-results");
const pLoad = document.getElementById("p-load");
const pNew = document.getElementById("p-new");
const productsDatalist = document.getElementById("products-datalist");
const pDelete = document.getElementById("p-delete");

// Autocompletar para buscador de productos
let lastProductSuggestions = [];
function productLabel(p) {
  const name = p.name || "(sin nombre)";
  const handle = p.handle || "";
  const cat = p.category ? ` (${p.category})` : "";
  return `${name} — ${handle}${cat}`.trim();
}
function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

let currentProductId = null;
let originalVariantIds = new Set();

// Helpers: slug & SKU base
let COLORS = [];
let TAGS = [];
// Cache de proveedores: Map<supplierId, supplierCode>
let SUPPLIERS_CACHE = new Map();

// Funciones para gestionar talles recurrentes (localStorage) - Por categoría
function getSizesStorageKey(category) {
  const cat = category || "Calzado"; // Default a Calzado si no hay categoría
  return `product_recurrent_sizes_${cat}`;
}

function getSavedSizes(category = null) {
  try {
    const categoryEl = document.getElementById("category");
    const cat = category || categoryEl?.value || "Calzado";
    const storageKey = getSizesStorageKey(cat);
    const saved = localStorage.getItem(storageKey);
    return saved ? JSON.parse(saved) : [];
  } catch (e) {
    console.warn("Error cargando talles guardados:", e);
    return [];
  }
}

function saveSizesSet(sizesStr, name = null, category = null) {
  if (!sizesStr || !sizesStr.trim()) {
    alert("No hay talles para guardar");
    return false;
  }
  
  const sizes = sizesStr.split(",").map(s => s.trim()).filter(Boolean);
  if (sizes.length === 0) {
    alert("No hay talles válidos para guardar");
    return false;
  }
  
  const categoryEl = document.getElementById("category");
  const cat = category || categoryEl?.value || "Calzado";
  const storageKey = getSizesStorageKey(cat);
  const saved = getSavedSizes(cat);
  // Mantener el orden original, NO ordenar alfabéticamente
  const sizesKey = sizes.join(",");
  
  // Verificar si ya existe (comparar sin ordenar)
  const exists = saved.find(s => {
    // Comparar arrays sin importar el orden
    const savedSizes = s.sizesArray || s.sizes.split(",").map(s => s.trim()).filter(Boolean);
    if (savedSizes.length !== sizes.length) return false;
    // Verificar que contengan los mismos elementos
    const savedSet = new Set(savedSizes);
    return sizes.every(size => savedSet.has(size));
  });
  if (exists) {
    if (confirm(`Los talles "${sizesKey}" ya están guardados para ${cat}. ¿Querés actualizar el nombre?`)) {
      const newName = name || prompt("Nombre para estos talles:", exists.name || sizesKey);
      if (newName) {
        exists.name = newName.trim();
        exists.updatedAt = new Date().toISOString();
      } else {
        return false;
      }
    } else {
      return false;
    }
  } else {
    // Solicitar nombre si no se proporcionó
    if (!name) {
      const newName = prompt("Nombre para estos talles:", sizesKey);
      if (!newName) return false;
      name = newName.trim();
    }
    
    saved.push({
      name: name,
      sizes: sizesKey,
      sizesArray: sizes,
      category: cat,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  
  try {
    localStorage.setItem(storageKey, JSON.stringify(saved));
    return true;
  } catch (e) {
    console.error("Error guardando talles:", e);
    alert("Error al guardar los talles");
    return false;
  }
}

function deleteSizesSet(sizesKey, category = null) {
  const categoryEl = document.getElementById("category");
  const cat = category || categoryEl?.value || "Calzado";
  const storageKey = getSizesStorageKey(cat);
  const saved = getSavedSizes(cat);
  const filtered = saved.filter(s => s.sizes !== sizesKey);
  try {
    localStorage.setItem(storageKey, JSON.stringify(filtered));
    return true;
  } catch (e) {
    console.error("Error eliminando talles:", e);
    return false;
  }
}

function refreshSizesPresets(selectEl, category = null) {
  if (!selectEl) return;
  
  const categoryEl = document.getElementById("category");
  const cat = category || categoryEl?.value || "Calzado";
  const saved = getSavedSizes(cat);
  const currentValue = selectEl.value;
  
  selectEl.innerHTML = '<option value="">Talles guardados...</option>';
  
  saved.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item.sizes;
    opt.textContent = `${item.name} (${item.sizesArray.join(", ")})`;
    opt.dataset.sizesArray = JSON.stringify(item.sizesArray);
    selectEl.appendChild(opt);
  });
  
  // Agregar opción para eliminar (si hay items guardados)
  if (saved.length > 0) {
    const hr = document.createElement("option");
    hr.disabled = true;
    hr.textContent = "──────────";
    selectEl.appendChild(hr);
    
    saved.forEach(item => {
      const opt = document.createElement("option");
      opt.value = `DELETE:${item.sizes}`;
      opt.textContent = `🗑️ Eliminar: ${item.name}`;
      selectEl.appendChild(opt);
    });
  }
  
  // Restaurar selección si existe
  if (currentValue && [...selectEl.options].some(o => o.value === currentValue)) {
    selectEl.value = currentValue;
  }
}

const colorMap = {
  negro: "NEG",
  suela: "SUE",
  suelaa: "SUE",
  blanco: "BLA",
  beige: "BEI",
  marron: "MAR",
  marrón: "MAR",
  rojo: "ROJ",
  azul: "AZU",
  azulmarino: "AZM",
  marino: "MAR",
  verde: "VER",
  gris: "GRI",
  lila: "LIL",
  rosa: "ROS",
  dorado: "DOR",
  plateado: "PLA",
  nude: "NUD",
};

function slugify(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function colorCode(color) {
  if (!color) return "CLR";
  const found = COLORS.find(
    (c) => c.name?.toLowerCase() === color.toString().toLowerCase()
  );
  if (found?.code) return found.code.toUpperCase();
  const k = color.toString().toLowerCase().replace(/\s+/g, "");
  if (colorMap[k]) return colorMap[k];
  return (
    k
      .replace(/[^a-z]/g, "")
      .slice(0, 3)
      .toUpperCase() || "CLR"
  );
}

// Obtener código del proveedor (con cache)
async function getSupplierCode(supplierId) {
  if (!supplierId) return null;
  
  // Verificar cache primero
  if (SUPPLIERS_CACHE.has(supplierId)) {
    return SUPPLIERS_CACHE.get(supplierId);
  }
  
  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("code")
      .eq("id", supplierId)
      .single();
    
    if (error || !data) {
      console.warn("No se pudo obtener código del proveedor:", error?.message);
      return null;
    }
    
    const code = data.code || null;
    // Guardar en cache
    if (code) {
      SUPPLIERS_CACHE.set(supplierId, code);
    }
    return code;
  } catch (e) {
    console.warn("Error obteniendo código del proveedor:", e);
    return null;
  }
}

function makeSkuBase(handle, color, supplierCode = null) {
  const h = (handle || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const colorPart = colorCode(color);
  
  // Si hay código de proveedor, agregarlo al inicio
  if (supplierCode) {
    const prov = (supplierCode || "").toUpperCase().trim();
    if (prov) {
      return `${prov}-${h}-${colorPart}`;
    }
  }
  
  // Formato sin proveedor (comportamiento original)
  return `${h}-${colorPart}`;
}

// ----- Precio ARS helpers -----
function digitsOnly(str) {
  return (str || "").toString().replace(/\D+/g, "");
}

function parseARS(str) {
  const d = digitsOnly(str);
  return d ? parseInt(d, 10) : 0;
}

function formatARS(value) {
  const n = Math.round(Number(value) || 0);
  const s = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$${s}`;
}

/**
 * Helpers para imágenes: generan URL optimizada desde public_id si existe, sino usan url
 */
const CLOUDINARY_CLOUD_NAME = "dnuedzuzm"; // Cloud name de Cloudinary

/**
 * Genera URL optimizada de Cloudinary desde public_id
 * @param {string} public_id - public_id de Cloudinary (sin extensión)
 * @param {number} width - Ancho deseado en px
 * @param {string} secure_url - URL segura opcional para detectar formato
 * @returns {string} URL optimizada
 */
function cloudinaryOptimizedFromPublicId(public_id, width, secure_url = null) {
  if (!public_id) return "";
  // Detectar formato desde secure_url si está disponible, sino usar f_auto
  // Cloudinary puede determinar el formato automáticamente con f_auto
  // Si secure_url tiene extensión, podemos extraerla como hint, pero f_auto funciona bien
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/f_auto,q_auto,c_scale,w_${width}/${public_id}`;
}

/**
 * Obtiene URL de thumbnail (200px) desde objeto imagen
 * @param {Object} img - Objeto con public_id y/o url/secure_url
 * @returns {string} URL optimizada
 */
function getImgThumb(img) {
  if (!img) return "";
  
  // Si tiene public_id válido, usarlo para generar URL optimizada
  if (img.public_id && img.public_id.trim()) {
    try {
      return cloudinaryOptimizedFromPublicId(img.public_id, 200, img.secure_url);
    } catch (e) {
      console.warn("Error generando URL optimizada desde public_id:", e);
      // Continuar con fallback
    }
  }
  
  // Fallback a url/secure_url - aplicar transformación si es URL de Cloudinary
  const url = img.url || img.secure_url || "";
  if (!url) return "";
  
  // Si es URL de Cloudinary, aplicar transformación de forma segura
  if (url.includes("res.cloudinary.com") && url.includes("/image/upload/")) {
    // Verificar si ya tiene transformaciones para evitar duplicarlas
    if (url.includes("/upload/f_") || url.includes("/upload/v")) {
      // Ya tiene transformaciones, solo ajustar el ancho si es necesario
      if (!url.includes("w_200") && !url.includes("w_")) {
        return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_200/`);
      }
      // Si ya tiene w_ pero no es 200, reemplazarlo
      return url.replace(/w_\d+/, "w_200");
    } else {
      // No tiene transformaciones, agregarlas
      return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_200/`);
    }
  }
  
  // Si no es Cloudinary, devolver URL tal cual
  return url;
}

/**
 * Obtiene URL de imagen completa (800px) desde objeto imagen
 * @param {Object} img - Objeto con public_id y/o url/secure_url
 * @returns {string} URL optimizada
 */
function getImgFull(img) {
  if (!img) return "";
  
  // Si tiene public_id válido, usarlo para generar URL optimizada
  if (img.public_id && img.public_id.trim()) {
    try {
      return cloudinaryOptimizedFromPublicId(img.public_id, 800, img.secure_url);
    } catch (e) {
      console.warn("Error generando URL optimizada desde public_id:", e);
      // Continuar con fallback
    }
  }
  
  // Fallback a url/secure_url - aplicar transformación si es URL de Cloudinary
  const url = img.url || img.secure_url || "";
  if (!url) return "";
  
  // Si es URL de Cloudinary, aplicar transformación de forma segura
  if (url.includes("res.cloudinary.com") && url.includes("/image/upload/")) {
    // Verificar si ya tiene transformaciones para evitar duplicarlas
    if (url.includes("/upload/f_") || url.includes("/upload/v")) {
      // Ya tiene transformaciones, solo ajustar el ancho si es necesario
      if (!url.includes("w_800") && !url.includes("w_")) {
        return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_800/`);
      }
      // Si ya tiene w_ pero no es 800, reemplazarlo
      return url.replace(/w_\d+/, "w_800");
    } else {
      // No tiene transformaciones, agregarlas
      return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_800/`);
    }
  }
  
  // Si no es Cloudinary, devolver URL tal cual
  return url;
}

// ========== FUNCIONES PARA GESTIÓN DE IMÁGENES (ORDEN + PRINCIPAL) ==========

/**
 * Reordena las imágenes de una variante y actualiza position e is_main
 * @param {string} variant_id - ID de la variante
 * @param {Array<string>} orderedImageIds - Array de image IDs en el orden final deseado
 * @returns {Promise<boolean>} - true si se actualizó correctamente
 */
async function reorderVariantImages(variant_id, orderedImageIds) {
  if (!variant_id || !Array.isArray(orderedImageIds) || orderedImageIds.length === 0) {
    console.warn("⚠️ reorderVariantImages: parámetros inválidos");
    return false;
  }

  try {
    // VALIDACIÓN: Verificar que todos los image_ids pertenecen a este variant_id
    const { data: existingImages, error: fetchError } = await supabase
      .from("variant_images")
      .select("id, variant_id")
      .in("id", orderedImageIds);

    if (fetchError) {
      console.error("❌ Error validando imágenes:", fetchError);
      return false;
    }

    if (!existingImages || existingImages.length !== orderedImageIds.length) {
      console.error(`❌ Validación fallida: se esperaban ${orderedImageIds.length} imágenes, se encontraron ${existingImages?.length || 0}`);
      return false;
    }

    // Verificar que todas pertenecen al variant_id correcto
    const invalidImages = existingImages.filter(img => img.variant_id !== variant_id);
    if (invalidImages.length > 0) {
      console.error(`❌ Validación fallida: ${invalidImages.length} imagen(es) no pertenecen a variant_id ${variant_id}:`, invalidImages);
      return false;
    }

    // Preparar updates: position = index + 1, is_main = (index === 0)
    const updates = orderedImageIds.map((imageId, index) => ({
      id: imageId,
      position: index + 1,
      is_main: index === 0,
    }));

    // Actualizar en batch (actualiza position e is_main)
    const promises = updates.map(update => {
      const { id, ...rest } = update;
      return supabase
        .from("variant_images")
        .update(rest)
        .eq("id", id)
        .eq("variant_id", variant_id); // Doble validación: también en la query
    });

    const results = await Promise.all(promises);
    const errors = results.filter(r => r.error);

    if (errors.length > 0) {
      console.error("❌ Error reordenando imágenes:", errors);
      return false;
    }

    console.log(`✅ Imágenes reordenadas para variante ${variant_id}: ${orderedImageIds.length} imágenes`);
    return true;
  } catch (error) {
    console.error("❌ Error en reorderVariantImages:", error);
    return false;
  }
}

/**
 * Carga y renderiza las imágenes de una variante en su fila
 * @param {HTMLTableRowElement} row - Fila de la variante
 * @param {string} variant_id - ID de la variante
 */
async function loadVariantImages(row, variant_id) {
  if (!row || !variant_id) {
    console.warn("⚠️ loadVariantImages: parámetros inválidos", { row: !!row, variant_id });
    return;
  }

  const imagesList = row.querySelector(".variant-images-list");
  if (!imagesList) {
    console.warn("⚠️ loadVariantImages: no se encontró .variant-images-list en la fila");
    return;
  }

  try {
    console.log(`🔧 Cargando imágenes para variante ${variant_id}...`);
    const { data: images, error } = await supabase
      .from("variant_images")
      .select("id, public_id, secure_url, url, position, is_main")
      .eq("variant_id", variant_id)
      .order("position", { ascending: true });

    if (error) {
      console.error("❌ Error cargando imágenes:", error);
      return;
    }

    console.log(`✅ Imágenes cargadas: ${images?.length || 0}`, images);
    renderVariantImages(row, images || []);
  } catch (error) {
    console.error("❌ Error en loadVariantImages:", error);
  }
}

/**
 * Renderiza las imágenes de una variante en la UI
 * @param {HTMLTableRowElement} row - Fila de la variante
 * @param {Array<Object>} images - Array de objetos imagen con id, public_id, url, position, is_main
 */
function renderVariantImages(row, images) {
  const imagesList = row.querySelector(".variant-images-list");
  if (!imagesList) {
    console.warn("⚠️ renderVariantImages: no se encontró .variant-images-list en la fila");
    return;
  }

  imagesList.innerHTML = "";

  if (!images || images.length === 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.textContent = "Sin imágenes";
    emptyMsg.style.color = "#999";
    emptyMsg.style.fontSize = "10px";
    emptyMsg.style.fontStyle = "italic";
    imagesList.appendChild(emptyMsg);
    console.log("ℹ️ No hay imágenes para renderizar");
    return;
  }

  console.log(`🔧 Renderizando ${images.length} imagen(es)...`);

  images.forEach((img, index) => {
    const imageItem = document.createElement("div");
    imageItem.className = "variant-image-item";
    imageItem.dataset.imageId = img.id;
    imageItem.style.cssText = `
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border: 2px solid ${img.is_main ? "#3a6df0" : "#ddd"};
      border-radius: 4px;
      background: ${img.is_main ? "#f0f4ff" : "#fff"};
    `;

    // Thumbnail - añadir ?v= para evitar caché cuando se reemplaza imagen (mismo path Cloudinary)
    const thumb = document.createElement("img");
    let thumbUrl = getImgThumb(img);
    thumbUrl = thumbUrl ? (thumbUrl + (thumbUrl.includes("?") ? "&" : "?") + "v=" + (img.id || "")) : "";
    thumb.src = thumbUrl;
    thumb.alt = `Imagen ${index + 1}`;
    thumb.style.cssText = `
      width: 40px;
      height: 40px;
      object-fit: cover;
      border-radius: 3px;
      flex-shrink: 0;
    `;
    thumb.onerror = () => {
      console.error(`❌ Error cargando imagen ${img.id}:`, thumbUrl);
      thumb.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect fill='%23ddd' width='40' height='40'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999' font-size='10'%3EError%3C/text%3E%3C/svg%3E";
    };
    thumb.onload = () => {
      console.log(`✅ Imagen ${img.id} cargada correctamente:`, thumbUrl);
    };

    // Badge "Principal"
    const badge = document.createElement("span");
    if (img.is_main) {
      badge.textContent = "Principal";
      badge.style.cssText = `
        font-size: 9px;
        font-weight: bold;
        color: #3a6df0;
        background: #fff;
        padding: 2px 4px;
        border-radius: 3px;
        white-space: nowrap;
      `;
    }

    // Controles: Mover arriba / Mover abajo / Eliminar
    const controls = document.createElement("div");
    controls.style.cssText = `
      display: flex;
      gap: 2px;
      margin-left: auto;
    `;

    // Botón subir
    const btnUp = document.createElement("button");
    btnUp.type = "button";
    btnUp.innerHTML = "▲";
    btnUp.title = "Mover arriba";
    btnUp.disabled = index === 0;
    btnUp.style.cssText = `
      padding: 2px 4px;
      font-size: 10px;
      border: 1px solid #ddd;
      background: ${index === 0 ? "#f5f5f5" : "#fff"};
      cursor: ${index === 0 ? "not-allowed" : "pointer"};
      border-radius: 3px;
    `;
    btnUp.addEventListener("click", async () => {
      if (index > 0) {
        const newOrder = [...images];
        [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
        const orderedIds = newOrder.map(i => i.id);
        const variantId = row.dataset.variantId;
        if (variantId && await reorderVariantImages(variantId, orderedIds)) {
          await loadVariantImages(row, variantId);
        }
      }
    });

    // Botón bajar
    const btnDown = document.createElement("button");
    btnDown.type = "button";
    btnDown.innerHTML = "▼";
    btnDown.title = "Mover abajo";
    btnDown.disabled = index === images.length - 1;
    btnDown.style.cssText = `
      padding: 2px 4px;
      font-size: 10px;
      border: 1px solid #ddd;
      background: ${index === images.length - 1 ? "#f5f5f5" : "#fff"};
      cursor: ${index === images.length - 1 ? "not-allowed" : "pointer"};
      border-radius: 3px;
    `;
    btnDown.addEventListener("click", async () => {
      if (index < images.length - 1) {
        const newOrder = [...images];
        [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
        const orderedIds = newOrder.map(i => i.id);
        const variantId = row.dataset.variantId;
        if (variantId && await reorderVariantImages(variantId, orderedIds)) {
          await loadVariantImages(row, variantId);
        }
      }
    });

    // Botón eliminar
    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.innerHTML = "✕";
    btnDelete.title = "Eliminar imagen";
    btnDelete.style.cssText = `
      padding: 2px 4px;
      font-size: 10px;
      border: 1px solid #dc3545;
      background: #fff;
      color: #dc3545;
      cursor: pointer;
      border-radius: 3px;
    `;
    btnDelete.addEventListener("click", async () => {
      if (confirm("¿Eliminar esta imagen?")) {
        const variantId = row.dataset.variantId;
        if (await deleteVariantImage(img.id)) {
          if (variantId) {
            await loadVariantImages(row, variantId);
          }
        }
      }
    });

    controls.appendChild(btnUp);
    controls.appendChild(btnDown);
    controls.appendChild(btnDelete);

    imageItem.appendChild(thumb);
    if (img.is_main) {
      imageItem.appendChild(badge);
    }
    imageItem.appendChild(controls);

    imagesList.appendChild(imageItem);
  });
}

/**
 * Elimina una imagen de una variante y recalcula posiciones e is_main
 * @param {string} image_id - ID de la imagen a eliminar
 * @returns {Promise<boolean>} - true si se eliminó correctamente
 */
async function deleteVariantImage(image_id) {
  if (!image_id) {
    console.warn("⚠️ deleteVariantImage: image_id requerido");
    return false;
  }

  try {
    // 1. Obtener datos de la imagen antes de eliminar
    const { data: imageData, error: fetchError } = await supabase
      .from("variant_images")
      .select("id, variant_id, position, is_main")
      .eq("id", image_id)
      .single();

    if (fetchError || !imageData) {
      console.error("❌ Error obteniendo imagen:", fetchError);
      return false;
    }

    const { variant_id, position: deletedPosition, is_main: wasMain } = imageData;

    // 2. Eliminar la imagen
    const { error: deleteError } = await supabase
      .from("variant_images")
      .delete()
      .eq("id", image_id);

    if (deleteError) {
      console.error("❌ Error eliminando imagen:", deleteError);
      return false;
    }

    // 3. Siempre recalcular posiciones 1..N y setear principal al primero (reduce edge cases)
    const { data: remainingImages, error: fetchRemainingError } = await supabase
      .from("variant_images")
      .select("id, position")
      .eq("variant_id", variant_id)
      .order("position", { ascending: true });

    if (fetchRemainingError) {
      console.error("❌ Error obteniendo imágenes restantes:", fetchRemainingError);
      return false;
    }

    if (remainingImages && remainingImages.length > 0) {
      // Recalcular posiciones (1..N) y setear is_main = true para position = 1
      const updates = remainingImages.map((img, index) => ({
        id: img.id,
        position: index + 1,
        is_main: index === 0, // La primera es la principal
      }));

      const updatePromises = updates.map(update => {
        const { id, ...rest } = update;
        return supabase
          .from("variant_images")
          .update(rest)
          .eq("id", id);
      });

      const updateResults = await Promise.all(updatePromises);
      const updateErrors = updateResults.filter(r => r.error);

      if (updateErrors.length > 0) {
        console.error("❌ Error actualizando posiciones después de eliminar:", updateErrors);
        return false;
      }

      console.log(`✅ Posiciones recalculadas después de eliminar imagen. Nueva principal: ${updates[0]?.id}`);
    }

    console.log(`✅ Imagen ${image_id} eliminada correctamente`);
    return true;
  } catch (error) {
    console.error("❌ Error en deleteVariantImage:", error);
    return false;
  }
}

function attachPriceFormatter(input) {
  // Formateo inicial
  input.value = formatARS(parseARS(input.value));
  input.addEventListener("focus", () => {
    input.value = digitsOnly(input.value);
  });
  input.addEventListener("blur", () => {
    input.value = formatARS(parseARS(input.value));
  });
  input.addEventListener("input", () => {
    const raw = digitsOnly(input.value);
    input.value = raw;
  });
}

// ----- Funciones de cálculo de precio recomendado -----
function roundToNearest100(value) {
  const num = Number(value) || 0;
  if (num <= 0) return 0;
  // Redondear hacia arriba al próximo múltiplo de 100
  return Math.ceil(num / 100) * 100;
}

function calculateRecommendedPrice(cost, percentage, logisticAmount) {
  const costNum = Number(cost) || 0;
  const percentageNum = Number(percentage) || 0;
  const logisticNum = Number(parseARS(logisticAmount)) || 0;
  
  if (costNum <= 0) return 0;
  
  // Fórmula: costo + (costo * porcentaje/100) + monto_logistico
  const calculated = costNum + (costNum * percentageNum / 100) + logisticNum;
  
  // Redondear hacia arriba al múltiplo de 100 más cercano
  return roundToNearest100(calculated);
}

// ========== FUNCIÓN PARA ASEGURAR VARIANT_ID (SOLO COLOR) ==========

/**
 * Asegura que la fila de variante tenga un variant_id válido.
 * Crea variante SOLO por COLOR (sin size).
 * Si no existe producto, crea uno draft.
 * 
 * @param {HTMLTableRowElement} row - Fila de la tabla de variantes
 * @returns {Promise<string|null>} - variant_id o null si falló
 */
async function ensureVariantId(row) {
  // 1. Verificar autenticación
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) {
    const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
    if (rowStatusEl) {
      rowStatusEl.textContent = "Debes estar autenticado para guardar variantes";
      rowStatusEl.style.color = "#c00";
    }
    return null;
  }

  // 2. Si ya tiene variant_id, verificar que existe en DB y retornarlo
  const existingVariantId = row.dataset.variantId;
  if (existingVariantId) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("id")
      .eq("id", existingVariantId)
      .single();
    
    if (!error && data) {
      return existingVariantId;
    }
    // Si no existe, limpiar y continuar
    delete row.dataset.variantId;
  }

  // 3. Validar campo mínimo: COLOR
  const color = row.querySelector(".v-color")?.value?.trim();
  if (!color) {
    const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
    if (rowStatusEl) {
      rowStatusEl.textContent = "El color es obligatorio para guardar la variante";
      rowStatusEl.style.color = "#c00";
    }
    return null;
  }

  // 4. Asegurar que existe product_id (crear producto draft si hace falta)
  let prodId = currentProductId;
  
  if (!prodId) {
    // Validar campos mínimos del producto
    const category = document.getElementById("category")?.value;
    let name = document.getElementById("name")?.value?.trim();
    if (!name) {
      const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
      if (rowStatusEl) {
        rowStatusEl.textContent = "El nombre del producto es obligatorio";
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }
    
    // Convertir nombre a mayúsculas
    name = name.toUpperCase();
    
    // Normalizar handle (lowercase + slug)
    const handleRaw = document.getElementById("handle")?.value?.trim() || slugify(name);
    const handle = handleRaw.toLowerCase().trim();
    
    if (!handle) {
      const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
      if (rowStatusEl) {
        rowStatusEl.textContent = "El handle no puede estar vacío";
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }

    if (!category) {
      const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
      if (rowStatusEl) {
        rowStatusEl.textContent = "La categoría es obligatoria";
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }

    // Validar unicidad de handle (case-insensitive)
    const { data: dupHandle, error: dupErr } = await supabase
      .from("products")
      .select("id, handle")
      .ilike("handle", handle) // Case-insensitive
      .neq("status", "archived")
      .limit(1);
    
    if (dupErr) {
      console.error("Error validando handle:", dupErr);
      const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
      if (rowStatusEl) {
        rowStatusEl.textContent = `Error validando handle: ${dupErr.message}`;
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }
    
    if (dupHandle && dupHandle.length && dupHandle[0].id !== currentProductId) {
      const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
      if (rowStatusEl) {
        rowStatusEl.textContent = `El handle '${handle}' ya existe (case-insensitive). Cambialo o ajusta el nombre.`;
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }

    // Crear producto draft
    const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
    if (rowStatusEl) {
      rowStatusEl.textContent = "Creando producto...";
      rowStatusEl.style.color = "inherit";
    }
    
    const supplierValue = document.getElementById("supplier")?.value || null;
    const pricePercentageValue = parseFloat(document.getElementById("price-percentage")?.value || "30");
    const logisticAmountValue = parseARS(document.getElementById("logistic-amount")?.value || "500");
    
    // Obtener user_id actual para marcar created_by (si existe la columna)
    const { data: session } = await supabase.auth.getSession();
    const userId = session?.session?.user?.id || null;
    
    // Calcular estado inicial: si no tiene stock ni imágenes, será pending_stock
    // (se actualizará automáticamente cuando se guarden variantes y talles)
    const initialStatus = "pending_stock";
    
    const payloadProduct = {
      category,
      handle,
      name: name.trim().toUpperCase(),
      description: document.getElementById("description")?.value?.trim() || "",
      status: initialStatus,
      supplier_id: supplierValue || null,
      price_percentage: pricePercentageValue || 30,
      logistic_amount: logisticAmountValue || 500,
      updated_at: new Date().toISOString(),
    };

    const { data: prod, error: prodErr } = await supabase
      .from("products")
      .insert([payloadProduct])
      .select("id")
      .single();
    
    if (prodErr) {
      console.error("❌ Error al crear producto:", prodErr);
      if (rowStatusEl) {
        rowStatusEl.textContent = `Error al crear producto: ${prodErr.message}`;
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }
    
    prodId = prod.id;
    currentProductId = prodId;
    console.log(`✅ Producto creado con ID: ${prodId}, estado inicial: ${initialStatus}`);
  }

  // 5. Crear variante SOLO con COLOR (sin size)
  const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
  if (rowStatusEl) {
    rowStatusEl.textContent = "Guardando variante...";
    rowStatusEl.style.color = "inherit";
  }

  const skuBase = row.querySelector(".v-skuBase")?.value?.trim() || "";
  const price = parseARS(row.querySelector(".v-price")?.value || "0");
  const active = row.querySelector(".v-active")?.checked ?? true;

  // Si no hay sku_base, generarlo
  let finalSkuBase = skuBase;
  if (!finalSkuBase) {
    const handle = document.getElementById("handle")?.value || "";
    const supplierId = document.getElementById("supplier")?.value || "";
    const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
    finalSkuBase = makeSkuBase(handle, color, supplierCode);
  }

  // Payload de variante: SOLO COLOR, SIN SIZE
  const variantPayload = {
    product_id: prodId,
    color,
    sku: finalSkuBase, // SKU base, no incluye size
    price: price || 0,
    active,
  };

  const { data: variant, error: variantErr } = await supabase
    .from("product_variants")
    .insert([variantPayload])
    .select("id")
    .single();

  if (variantErr) {
    console.error("❌ Error al crear variante:", variantErr);
    
    // Manejar error de SKU duplicado
    if (variantErr.code === "23505" || variantErr.message?.includes("duplicate key") || variantErr.message?.includes("product_variants_sku_key")) {
      console.log("🔧 SKU duplicado detectado, verificando si hay variante archivada...");
      
      // Buscar variante con ese SKU
      const { data: existingVariant } = await supabase
        .from("product_variants")
        .select("id, product_id")
        .eq("sku", finalSkuBase)
        .limit(1)
        .single();
      
      // Verificar si el producto asociado está archivado
      let isArchived = false;
      if (existingVariant) {
        const { data: product } = await supabase
          .from("products")
          .select("status")
          .eq("id", existingVariant.product_id)
          .single();
        isArchived = product?.status === "archived";
      }
      
      if (existingVariant && isArchived) {
        console.log("🔧 Encontrada variante archivada con ese SKU, actualizando SKU de la variante archivada...");
        // Actualizar el SKU de la variante archivada para liberar el SKU
        const archivedSku = `${finalSkuBase}__arch_${Date.now()}`;
        const { error: updateErr } = await supabase
          .from("product_variants")
          .update({ sku: archivedSku })
          .eq("id", existingVariant.id);
        
        if (updateErr) {
          console.error("❌ Error actualizando SKU archivado:", updateErr);
          if (rowStatusEl) {
            rowStatusEl.textContent = `Error: No se pudo liberar el SKU duplicado. Intenta con un SKU diferente.`;
            rowStatusEl.style.color = "#c00";
          }
          return null;
        }
        
        console.log("✅ SKU archivado actualizado, reintentando crear variante...");
        // Reintentar crear la variante
        const { data: retryVariant, error: retryErr } = await supabase
          .from("product_variants")
          .insert([variantPayload])
          .select("id")
          .single();
        
        if (retryErr) {
          console.error("❌ Error al crear variante después de liberar SKU:", retryErr);
          if (rowStatusEl) {
            rowStatusEl.textContent = `Error al crear variante: ${retryErr.message}`;
            rowStatusEl.style.color = "#c00";
          }
          return null;
        }
        
        const variantId = retryVariant.id;
        row.dataset.variantId = variantId;
        updateVariantStatus(row, "saved");
        
        if (rowStatusEl) {
          rowStatusEl.textContent = "Variante guardada";
          rowStatusEl.style.color = "#090";
          setTimeout(() => {
            if (rowStatusEl.textContent === "Variante guardada") {
              rowStatusEl.textContent = "";
            }
          }, 2000);
        }
        
        return variantId;
      } else {
        // SKU duplicado pero no es de un producto archivado
        if (rowStatusEl) {
          rowStatusEl.textContent = `Error: El SKU "${finalSkuBase}" ya existe. Cambia el SKU base o el color.`;
          rowStatusEl.style.color = "#c00";
        }
        return null;
      }
    } else {
      // Otro tipo de error
      if (rowStatusEl) {
        rowStatusEl.textContent = `Error al crear variante: ${variantErr.message}`;
        rowStatusEl.style.color = "#c00";
      }
      return null;
    }
  }

  const variantId = variant.id;
  row.dataset.variantId = variantId;
  updateVariantStatus(row, "saved");
  
  console.log("✅ Variante creada (solo color) con ID:", variantId);
  if (rowStatusEl) {
    rowStatusEl.textContent = "Variante guardada";
    rowStatusEl.style.color = "#090";
    setTimeout(() => {
      if (rowStatusEl.textContent === "Variante guardada") {
        rowStatusEl.textContent = "";
      }
    }, 2000);
  }

  return variantId;
}

/**
 * Verifica si hay talles definidos en una fila
 * @param {HTMLTableRowElement} row - Fila de la tabla
 * @returns {boolean} - true si hay al menos un talle definido
 */
function hasSizesDefined(row) {
  // Solo verificar modo multi-talle (modo simple eliminado)
  const sizeInputs = row.querySelectorAll(".sizes-list .size-stock");
  if (sizeInputs.length > 0) {
    // Verificar que al menos uno tenga un size definido (data-size)
    const hasValidSizes = Array.from(sizeInputs).some(inp => {
      const size = inp.dataset.size?.trim();
      return size && size.length > 0;
    });
    if (hasValidSizes) {
      console.log(`🔧 hasSizesDefined: Encontrados ${sizeInputs.length} talles en modo multi-talle`);
      return true;
    }
  }
  
  console.log("⚠️ hasSizesDefined: No se encontraron talles definidos. Usa el campo de talles y el botón 'Generar' para definir talles.");
  return false;
}

/**
 * Verifica si el producto tiene stock en todas sus variantes
 * @param {Array<HTMLTableRowElement>} rows - Filas de variantes
 * @returns {Promise<boolean>} - true si todas las variantes tienen stock > 0
 */
let generalWarehouseIdCache = undefined;

async function getGeneralWarehouseIdForProducts() {
  if (generalWarehouseIdCache !== undefined) return generalWarehouseIdCache;
  const { data, error } = await supabase
    .from("warehouses")
    .select("id")
    .eq("code", "general")
    .maybeSingle();
  if (error) {
    console.warn("⚠️ No se pudo obtener el depósito general:", error.message || error);
    generalWarehouseIdCache = null;
    return null;
  }
  generalWarehouseIdCache = data?.id || null;
  return generalWarehouseIdCache;
}

async function getGeneralStockByVariantIds(variantIds) {
  const normalizedVariantIds = [...new Set((variantIds || []).filter(Boolean))];
  const stockByVariant = new Map();
  normalizedVariantIds.forEach((id) => stockByVariant.set(id, 0));
  if (normalizedVariantIds.length === 0) return stockByVariant;

  const generalWarehouseId = await getGeneralWarehouseIdForProducts();
  if (!generalWarehouseId) return stockByVariant;

  const { data, error } = await supabase
    .from("variant_size_warehouse_stock")
    .select("variant_id, stock_qty")
    .in("variant_id", normalizedVariantIds)
    .eq("warehouse_id", generalWarehouseId);
  if (error) {
    console.warn("⚠️ Error obteniendo stock general por variante:", error);
    return stockByVariant;
  }

  (data || []).forEach((row) => {
    const current = stockByVariant.get(row.variant_id) || 0;
    stockByVariant.set(row.variant_id, current + (row.stock_qty || 0));
  });

  return stockByVariant;
}

async function checkProductHasStock(rows) {
  if (rows.length === 0) return false;
  const variantIds = [...new Set(rows.map((row) => row.dataset.variantId).filter(Boolean))];
  const stockByVariant = await getGeneralStockByVariantIds(variantIds);
  
  for (const row of rows) {
    const variantId = row.dataset.variantId;
    if (!variantId) {
      // Si no hay variantId, verificar stock en la UI
      const sizeInputs = row.querySelectorAll(".sizes-list .size-stock");
      if (sizeInputs.length > 0) {
        let hasStockInRow = false;
        sizeInputs.forEach(inp => {
          const stock = parseInt(inp.value || "0", 10);
          if (stock > 0) {
            hasStockInRow = true;
          }
        });
        if (!hasStockInRow) {
          return false;
        }
      }
    } else {
      const totalStock = stockByVariant.get(variantId) || 0;
      if (totalStock <= 0) return false;
    }
  }
  
  return true;
}

/**
 * Calcula el estado del producto basado en stock e imágenes de sus variantes
 * @param {string} productId - ID del producto
 * @returns {Promise<string>} - Estado del producto: 'pending_stock', 'draft', o 'active'
 */
async function calculateProductStatus(productId) {
  if (!productId) {
    console.warn("⚠️ calculateProductStatus: productId requerido");
    return "draft";
  }

  console.log(`🔧 Calculando estado para producto ${productId}...`);

  // 1. Obtener todas las variantes del producto
  const { data: variants, error: variantsError } = await supabase
    .from("product_variants")
    .select("id")
    .eq("product_id", productId)
    .eq("active", true);

  if (variantsError) {
    console.error("❌ Error obteniendo variantes:", variantsError);
    return "draft";
  }

  if (!variants || variants.length === 0) {
    console.log(`ℹ️ Producto ${productId} sin variantes activas, estado: pending_stock`);
    return "pending_stock";
  }

  const variantIds = variants.map(v => v.id);
  console.log(`🔧 Producto tiene ${variantIds.length} variantes:`, variantIds);

  // 2. Verificar stock por variante usando depósito general por talle (VSW canónico en products)
  const stockByVariant = await getGeneralStockByVariantIds(variantIds);

  // Verificar si alguna variante tiene stock > 0
  const hasAnyStock = Array.from(stockByVariant.values()).some(stock => stock > 0);
  console.log(`🔧 Stock por variante:`, Array.from(stockByVariant.entries()).map(([vid, stock]) => ({ variant_id: vid, stock })));
  console.log(`🔧 ¿Alguna variante tiene stock? ${hasAnyStock}`);

  // Si ninguna variante tiene stock, estado es pending_stock
  if (!hasAnyStock) {
    console.log(`✅ Estado calculado: pending_stock (ninguna variante tiene stock)`);
    return "pending_stock";
  }

  // 3. Verificar imágenes para variantes que tienen stock
  const variantsWithStock = Array.from(stockByVariant.entries())
    .filter(([vid, stock]) => stock > 0)
    .map(([vid]) => vid);

  console.log(`🔧 Variantes con stock: ${variantsWithStock.length}`, variantsWithStock);

  const { data: imagesData, error: imagesError } = await supabase
    .from("variant_images")
    .select("variant_id")
    .in("variant_id", variantsWithStock);

  if (imagesError) {
    console.error("❌ Error obteniendo imágenes:", imagesError);
    return "draft";
  }

  // Verificar si alguna variante con stock tiene imágenes
  const variantsWithImages = new Set((imagesData || []).map(img => img.variant_id));
  const hasAnyImages = variantsWithStock.some(vid => variantsWithImages.has(vid));
  
  console.log(`🔧 Variantes con imágenes:`, Array.from(variantsWithImages));
  console.log(`🔧 ¿Alguna variante con stock tiene imágenes? ${hasAnyImages}`);

  // Si tiene stock pero no imágenes, estado es draft
  if (!hasAnyImages) {
    console.log(`✅ Estado calculado: draft (tiene stock pero sin imágenes)`);
    return "draft";
  }

  // 4. Verificar tags (Tags1 y Tags2 requeridos, Tags3 opcional)
  const { data: productTags, error: tagsError } = await supabase
    .from("product_tags")
    .select("tag1_id, tag2_id")
    .eq("product_id", productId)
    .maybeSingle();

  if (tagsError) {
    console.error("❌ Error obteniendo tags:", tagsError);
    // Si hay error, asumir que faltan tags
    console.log(`✅ Estado calculado: missing_tags (error obteniendo tags)`);
    return "missing_tags";
  }

  // Verificar si tiene Tags1 y Tags2
  const hasTags1 = productTags && productTags.tag1_id !== null;
  const hasTags2 = productTags && productTags.tag2_id !== null;
  const hasCompleteTags = hasTags1 && hasTags2;

  console.log(`🔧 Tags del producto:`, { tag1_id: productTags?.tag1_id, tag2_id: productTags?.tag2_id });
  console.log(`🔧 ¿Tiene Tags1 y Tags2? ${hasCompleteTags}`);

  // Si tiene stock e imágenes pero falta Tags1 o Tags2, estado es missing_tags
  if (!hasCompleteTags) {
    console.log(`✅ Estado calculado: missing_tags (tiene stock e imágenes pero falta Tags1 o Tags2)`);
    return "missing_tags";
  }

  // Si tiene stock, imágenes y tags completos, estado es active
  console.log(`✅ Estado calculado: active (tiene stock, imágenes y tags completos)`);
  return "active";
}

/**
 * Verifica si el producto tiene imágenes en todas sus variantes
 * @param {Array<HTMLTableRowElement>} rows - Filas de variantes
 * @returns {Promise<boolean>} - true si todas las variantes tienen al menos una imagen
 */
async function checkProductHasImages(rows) {
  if (rows.length === 0) return false;
  
  for (const row of rows) {
    const variantId = row.dataset.variantId;
    if (!variantId) {
      // Si no hay variantId, verificar en la UI
      const imagesContainer = row.querySelector(".variant-images");
      if (!imagesContainer || imagesContainer.querySelectorAll("img").length === 0) {
        return false;
      }
    } else {
      // Verificar imágenes en la base de datos
      const { data: images, error } = await supabase
        .from("variant_images")
        .select("id")
        .eq("variant_id", variantId)
        .limit(1);
      
      if (error) {
        console.warn("Error verificando imágenes:", error);
        continue;
      }
      
      if (!images || images.length === 0) {
        return false;
      }
    }
  }
  
  return true;
}

/**
 * Guarda los talles y el stock editable (depósito general por talle) de una variante.
 * @param {string} variantId - ID de la variante
 * @param {HTMLTableRowElement} row - Fila de la tabla
 * @returns {Promise<boolean>} - true si se guardó correctamente
 */
async function saveVariantSizes(variantId, row) {
  // Validar que row sea el elemento correcto
  if (!row || !row.dataset) {
    console.error("❌ saveVariantSizes: row inválido o sin dataset");
    return false;
  }
  
  // Verificar que el variantId coincida con el de la fila
  const rowVariantId = row.dataset.variantId;
  if (rowVariantId && rowVariantId !== variantId) {
    console.error(`❌ saveVariantSizes: variantId (${variantId}) no coincide con row.dataset.variantId (${rowVariantId})`);
    return false;
  }
  
  const skuBase = row.querySelector(".v-skuBase")?.value?.trim() || "";
  
  // Obtener talles desde el modo multi-talle (sizes-list) - ELIMINADO MODO SIMPLE
  // IMPORTANTE: Usar row.querySelectorAll para asegurar que solo se seleccionen inputs de esta fila
  const sizesListContainer = row.querySelector(".sizes-list");
  if (!sizesListContainer) {
    console.warn(`⚠️ No se encontró .sizes-list en la fila para variante ${variantId}`);
    return false;
  }
  
  const sizeInputs = sizesListContainer.querySelectorAll(".size-stock");
  const sizes = [];
  
  if (sizeInputs.length === 0) {
    console.warn(`⚠️ No se encontraron talles en modo multi-talle para variante ${variantId}. Define talles usando el campo de talles y el botón "Generar".`);
    return false;
  }
  
  // Modo multi-talle (único modo permitido)
  console.log(`🔧 [VARIANTE ${variantId}] Encontrados ${sizeInputs.length} inputs de talles en modo multi-talle`);
  console.log(`🔧 [VARIANTE ${variantId}] Verificando que todos los inputs pertenezcan a esta fila...`);
  
  // Verificar que todos los inputs pertenezcan a esta fila
  sizeInputs.forEach((inp, index) => {
    const inputParent = inp.closest('tr');
    if (inputParent !== row) {
      console.error(`❌ [VARIANTE ${variantId}] Input ${index} NO pertenece a la fila correcta!`, {
        input: inp,
        expectedRow: row,
        actualParent: inputParent
      });
      return; // Saltar este input
    }
  });
  
  sizeInputs.forEach((inp, index) => {
    const size = inp.dataset.size?.trim();
    if (!size) {
      console.warn(`⚠️ Input de talle ${index} sin atributo data-size válido. Elemento:`, inp, `data-size="${inp.dataset.size}"`);
      return; // Si no hay size, saltar
    }
    
    // Permitir stock 0: tratar vacío, null, undefined como 0
    let stockValue = inp.value;
    if (stockValue === "" || stockValue === null || stockValue === undefined) {
      stockValue = "0";
    }
    const stock_qty = parseInt(stockValue, 10);
    
    console.log(`🔧 [VARIANTE ${variantId}] Procesando input ${index}: size="${size}", value="${inp.value}", stock_qty=${stock_qty}, skuBase="${skuBase}"`);
    
    // Validar que stock_qty sea un número válido (incluyendo 0)
    if (!isNaN(stock_qty) && stock_qty >= 0) {
      const sizeObj = {
        size: String(size).trim(),
        stock_qty: Number(stock_qty),
        sku: skuBase ? `${skuBase}-${size}` : null,
      };
      sizes.push(sizeObj);
      console.log(`✅ [VARIANTE ${variantId}] Talle agregado al array:`, JSON.stringify(sizeObj));
    } else {
      console.warn(`⚠️ [VARIANTE ${variantId}] Talle ${size} con stock inválido: ${stockValue} (parseado como ${stock_qty})`);
    }
  });
  
  console.log(`🔧 [VARIANTE ${variantId}] Total de talles a guardar: ${sizes.length}`, sizes);
  console.log(`🔧 [VARIANTE ${variantId}] Resumen de stock por talle:`, sizes.map(s => `${s.size}: ${s.stock_qty}`).join(', '));
  
  // Verificar que los objetos de sizes tengan las propiedades correctas
  sizes.forEach((s, index) => {
    if (!s.size) {
      console.error(`❌ Talle en índice ${index} sin propiedad 'size':`, s);
    }
    if (s.stock_qty === undefined || s.stock_qty === null) {
      console.warn(`⚠️ Talle en índice ${index} sin stock_qty válido:`, s);
    }
  });

  if (sizes.length === 0) {
    // No hay talles para guardar - esto ahora es un error
    console.warn("⚠️ saveVariantSizes: No hay talles para guardar");
    return false;
  }

  // Preparar payload para RPC que persiste stock canónico en depósito general por talle.
  const payload = sizes.map((s, index) => {
    const payloadItem = {
      variant_id: variantId,
      size: String(s.size || "").trim(),
      stock_qty: s.stock_qty || 0,
      sku: s.sku || null,
    };
    
    if (!payloadItem.size) {
      console.error(`❌ [VARIANTE ${variantId}] Payload item ${index} sin size válido:`, s, payloadItem);
    }
    
    // Validar que el variant_id sea correcto
    if (payloadItem.variant_id !== variantId) {
      console.error(`❌ [VARIANTE ${variantId}] Payload item ${index} tiene variant_id incorrecto:`, payloadItem);
    }
    
    return payloadItem;
  }).filter(p => p.size); // Filtrar items sin size válido
  
  console.log(`🔧 [VARIANTE ${variantId}] Payload para guardar talles (${payload.length} items válidos):`, payload);
  console.log(`🔧 [VARIANTE ${variantId}] Verificando que todos los items tengan variant_id=${variantId}...`);
  payload.forEach((p, idx) => {
    if (p.variant_id !== variantId) {
      console.error(`❌ [VARIANTE ${variantId}] Item ${idx} tiene variant_id incorrecto:`, p);
    }
  });
  
  if (payload.length === 0) {
    console.error("❌ No hay items válidos en el payload después de filtrar");
    return false;
  }

  console.log(`🔧 [VARIANTE ${variantId}] Guardando ${payload.length} talles (RPC atómico):`, payload);

  const invalidSizes = payload.filter(
    (p) => !p.size || isNaN(p.stock_qty) || p.stock_qty < 0 || p.variant_id !== variantId
  );
  if (invalidSizes.length > 0) {
    console.error(`❌ [VARIANTE ${variantId}] Hay talles inválidos en el payload:`, invalidSizes);
    return false;
  }

  const pItems = payload.map((p) => ({
    size: p.size,
    stock_qty: p.stock_qty,
    sku: p.sku,
  }));

  const errMsgTransactional =
    "No se pudo guardar el stock de los talles. No se aplicaron cambios completos. Reintentá o revisá en Stock.";

  const { data: rpcData, error: rpcErr } = await supabase.rpc(
    "rpc_save_product_variant_initial_stock",
    { p_variant_id: variantId, p_items: pItems }
  );

  if (rpcErr) {
    console.error(`❌ [VARIANTE ${variantId}] RPC stock inicial:`, rpcErr);
    if (statusEl) {
      statusEl.textContent = errMsgTransactional;
      statusEl.style.color = "#c00";
    }
    return false;
  }

  if (!rpcData || rpcData.ok !== true) {
    console.error(`❌ [VARIANTE ${variantId}] RPC stock inicial respuesta inválida:`, rpcData);
    if (statusEl) {
      statusEl.textContent = errMsgTransactional;
      statusEl.style.color = "#c00";
    }
    return false;
  }

  console.log(
    `✅ [VARIANTE ${variantId}] Stock general guardado (RPC): warehouse_id=${rpcData.warehouse_id}, total_qty=${rpcData.total_qty}`
  );

  const upsertedData = Array.isArray(rpcData.variant_sizes)
    ? rpcData.variant_sizes
    : [];

  for (const record of upsertedData) {
    if (!record.qr_code) {
      try {
        const { data: qrCodeData, error: qrCodeError } = await supabase.rpc(
          "assign_qr_code_to_variant_size",
          { p_variant_size_id: record.id }
        );

        if (qrCodeError) {
          console.warn(
            `⚠️ [VARIANTE ${variantId}] Error asignando código QR a variant_size ${record.id}:`,
            qrCodeError
          );
        } else {
          console.log(
            `✅ [VARIANTE ${variantId}] Código QR asignado: ${qrCodeData} para talle ${record.size}`
          );
        }
      } catch (error) {
        console.warn(`⚠️ [VARIANTE ${variantId}] Excepción al asignar código QR:`, error);
      }
    }
  }

  if (upsertedData.length > 0) {
    const wrongVariants = upsertedData.filter((d) => d.variant_id !== variantId);
    if (wrongVariants.length > 0) {
      console.error(
        `❌ [VARIANTE ${variantId}] ERROR: variant_sizes devueltos con variant_id incorrecto:`,
        wrongVariants
      );
    }
  }

  return true;
}

/**
 * Actualiza el indicador de estado de la variante en la UI
 */
function updateVariantStatus(row, status) {
  const statusEl = row.querySelector(".variant-status");
  if (statusEl) {
    if (status === "saved") {
      statusEl.textContent = "✓ Guardada";
      statusEl.style.color = "#090";
      statusEl.className = "variant-status saved";
      statusEl.style.background = "#d4edda";
      statusEl.style.color = "#155724";
    } else {
      statusEl.textContent = "No guardada";
      statusEl.style.color = "#856404";
      statusEl.className = "variant-status unsaved";
      statusEl.style.background = "#fff3cd";
    }
  }

  // HABILITAR botones de imágenes cuando variant_id existe (ya no requiere status "saved")
  const uploadBtn = row.querySelector(".upload-images-btn");
  const loadUrlBtn = row.querySelector(".load-url-images-btn");
  const variantId = row.dataset.variantId;
  
  if (uploadBtn) {
    // Habilitar el botón si hay variantId (se guarda automáticamente al seleccionar color)
    uploadBtn.disabled = !variantId;
    if (!variantId) {
      uploadBtn.title = "Primero selecciona un color para crear la variante";
    } else {
      uploadBtn.title = "Subir imágenes";
    }
  }
  
  if (loadUrlBtn) {
    // Habilitar el botón si hay variantId
    loadUrlBtn.disabled = !variantId;
    if (!variantId) {
      loadUrlBtn.title = "Primero selecciona un color para crear la variante";
    } else {
      loadUrlBtn.title = "Cargar URLs de Cloudinary";
    }
  }
}

/**
 * Sube imágenes a Cloudinary usando Edge Function
 * @param {HTMLTableRowElement} row - Fila de la tabla de variantes
 * @param {FileList} files - Archivos a subir
 * @returns {Promise<boolean>} - true si se subieron correctamente
 */
async function uploadImagesToCloudinary(row, files) {
  // 0. Verificar autenticación y permisos ANTES de subir
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) {
    alert("Debes estar autenticado para subir imágenes. Por favor, inicia sesión.");
    return false;
  }

  // Verificar que el usuario puede editar productos (super_admin o colaborador con permiso)
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert("No se pudo verificar tu identidad. Por favor, recarga la página e inicia sesión nuevamente.");
      return false;
    }

    const { data: canEdit, error: permError } = await supabase
      .rpc("has_permission", {
        check_user_id: user.id,
        permission_key: "products",
        action: "edit"
      });

    if (permError) {
      console.error("Error verificando permisos:", permError);
      alert("Error verificando permisos de administrador. Por favor, contacta al administrador del sistema.");
      return false;
    }

    if (!canEdit) {
      alert("No tienes permisos para subir imágenes. Necesitas permiso de edición de productos.");
      return false;
    }
  } catch (err) {
    console.error("Error verificando permisos:", err);
    alert("Error verificando permisos. Por favor, recarga la página e intenta nuevamente.");
    return false;
  }

  // 1. Asegurar variant_id ANTES de subir
  const variantId = await ensureVariantId(row);
  if (!variantId) {
    alert("No se pudo guardar la variante. Verifica que el color esté completo.");
    return false;
  }

  const rowStatusEl = row.querySelector(".row-status-message") || statusEl;
  const category = document.getElementById("category")?.value || "";
  const skuBase = row.querySelector(".v-skuBase")?.value?.trim() || "";
  const color = row.querySelector(".v-color")?.value?.trim() || "";

  if (!category || !skuBase || !color) {
    if (rowStatusEl) {
      rowStatusEl.textContent = "Completa categoría, SKU base y color antes de subir imágenes";
      rowStatusEl.style.color = "#c00";
    }
    return false;
  }

  const fileArray = Array.from(files);
  if (fileArray.length === 0) {
    return false;
  }

  // Validar cantidad máxima (10 imágenes)
  const maxImages = 10;
  if (fileArray.length > maxImages) {
    alert(`Máximo ${maxImages} imágenes permitidas`);
    return false;
  }

  if (rowStatusEl) {
    rowStatusEl.textContent = `Subiendo ${fileArray.length} imagen(es)...`;
    rowStatusEl.style.color = "inherit";
  }

  const uploadedImages = [];
  let successCount = 0;
  let errorCount = 0;

  for (let i = 0; i < fileArray.length; i++) {
    const file = fileArray[i];
    
    // Validar tipo de archivo
    if (!file.type.match(/^image\/(jpeg|jpg|png|webp)$/)) {
      console.error(`Archivo ${file.name} no es una imagen válida`);
      errorCount++;
      continue;
    }

    // Validar tamaño (10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      console.error(`Archivo ${file.name} excede 10MB`);
      errorCount++;
      continue;
    }

    try {
      // Asegurar que la sesión esté activa y el token sea válido
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !session) {
        console.error("Error de sesión:", sessionError);
        if (rowStatusEl) {
          rowStatusEl.textContent = "Tu sesión expiró. Por favor, recarga la página e inicia sesión nuevamente.";
          rowStatusEl.style.color = "#c00";
        }
        errorCount++;
        continue;
      }

      // Refrescar el token si está cerca de expirar (menos de 5 minutos)
      const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
      const now = Date.now();
      const timeUntilExpiry = expiresAt - now;
      const fiveMinutes = 5 * 60 * 1000;
      
      if (timeUntilExpiry < fiveMinutes && timeUntilExpiry > 0) {
        console.log("🔄 Refrescando token de autenticación...");
        const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) {
          console.warn("⚠️ No se pudo refrescar el token:", refreshError);
        } else if (refreshData?.session) {
          console.log("✅ Token refrescado exitosamente");
        }
      }

      // Convertir archivo a base64
      const base64 = await fileToBase64(file);

      // Verificar que tenemos un cliente de Supabase válido
      if (!supabase) {
        console.error("❌ Cliente de Supabase no disponible");
        if (rowStatusEl) {
          rowStatusEl.textContent = "Error: Cliente de Supabase no disponible. Recarga la página.";
          rowStatusEl.style.color = "#c00";
        }
        errorCount++;
        continue;
      }

      // Log de diagnóstico (solo en desarrollo)
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        console.log("🔍 Diagnóstico antes de subir:", {
          tieneSesion: !!session,
          usuarioEmail: session?.user?.email,
          tokenExpiraEn: session?.expires_at ? new Date(session.expires_at * 1000).toISOString() : 'N/A',
          variantId,
          category,
          skuBase,
          color
        });
      }

      // Llamar Edge Function con reintentos (mitiga "Failed to send a request" intermitente)
      let data, error;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = await supabase.functions.invoke("upload-image", {
          body: {
            variant_id: variantId,
            file: base64,
            category: category,
            sku_base: skuBase,
            color: color,
            position: i + 1,
          },
        });
        data = result.data;
        error = result.error;
        const isConnectionError = error?.message?.includes("Failed to send") || error?.message?.includes("fetch");
        if (!error || !isConnectionError || attempt === maxRetries) break;
        console.warn(`⚠️ Intento ${attempt}/${maxRetries} falló (${error?.message}). Reintentando en ${attempt * 1000}ms...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }

      if (error) {
        // Manejo mejorado de errores con más detalles
        let errorMessage = `Error subiendo ${file.name}: `;
        let errorDetails = error;
        
        // Intentar extraer más información del error
        if (error.context) {
          console.error("Contexto del error:", error.context);
        }
        if (error.message) {
          console.error("Mensaje del error:", error.message);
        }
        
        if (error.status === 403 || error.message?.includes("403") || error.message?.includes("Forbidden")) {
          errorMessage += "No tienes permisos para subir imágenes. ";
          errorMessage += "Verifica que tengas permiso de edición de productos. ";
          errorMessage += "Si el problema persiste, recarga la página e inicia sesión nuevamente.";
        } else if (error.status === 401 || error.message?.includes("401") || error.message?.includes("No autorizado") || error.message?.includes("No autenticado")) {
          errorMessage += "Tu sesión expiró o no estás autenticado. ";
          errorMessage += "Por favor, recarga la página e inicia sesión nuevamente.";
        } else if (error.message?.includes("Failed to send") || error.message?.includes("Edge Function")) {
          errorMessage += "No se pudo conectar con el servidor de subida. ";
          errorMessage += "Verifica tu conexión a internet, intenta de nuevo o contacta al administrador si persiste.";
        } else if (error.message) {
          errorMessage += error.message;
        } else {
          errorMessage += "Error desconocido. Revisa la consola para más detalles.";
        }
        
        console.error("❌ Error completo:", {
          error,
          status: error.status,
          message: error.message,
          context: error.context,
          file: file.name
        });
        
        if (rowStatusEl) {
          rowStatusEl.textContent = errorMessage;
          rowStatusEl.style.color = "#c00";
        }
        errorCount++;
        continue;
      }

      if (!data) {
        console.error(`Error subiendo ${file.name}: respuesta vacía del servidor`);
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
      console.log(`✅ Imagen ${i + 1}/${fileArray.length} subida:`, data.public_id);

    } catch (err) {
      console.error(`Error procesando ${file.name}:`, err);
      errorCount++;
    }
  }

  // Guardar imágenes en variant_images después del upload
  if (uploadedImages.length > 0) {
    // Verificar si ya existe una imagen principal para esta variante
    const { data: existingImages } = await supabase
      .from("variant_images")
      .select("id, is_main")
      .eq("variant_id", variantId);
    
    // Si hay 1 imagen existente y subimos 1 nueva → reemplazar (eliminar la existente primero)
    const isReplacing = existingImages?.length === 1 && uploadedImages.length === 1;
    if (isReplacing) {
      await supabase
        .from("variant_images")
        .delete()
        .eq("id", existingImages[0].id);
    }
    
    // Tras reemplazar no hay principal; si agregamos, la primera es principal solo si no había
    const hasMainImage = isReplacing ? false : (existingImages?.some(img => img.is_main === true) || false);
    
    // Determinar is_main: la primera imagen (position 1) es la principal SOLO si no hay una principal existente
    const imagesPayload = uploadedImages.map(img => ({
      variant_id: variantId,
      public_id: img.public_id,
      secure_url: img.secure_url,
      url: img.secure_url, // url = secure_url para compatibilidad
      position: img.position,
      is_main: !hasMainImage && img.position === 1, // Solo marcar como principal si no hay una existente
    }));

    const { error: insertError } = await supabase
      .from("variant_images")
      .insert(imagesPayload);

    if (insertError) {
      console.error("❌ Error guardando imágenes en DB:", insertError);
      if (rowStatusEl) {
        rowStatusEl.textContent = `⚠️ Imágenes subidas pero error guardando en DB: ${insertError.message}`;
        rowStatusEl.style.color = "#c00";
      }
    } else {
      console.log(`✅ ${imagesPayload.length} imagen(es) guardada(s) en variant_images`);
      // Refrescar la UI de imágenes
      await loadVariantImages(row, variantId);
      
      // Verificar si el producto tiene stock y ahora tiene imágenes → activar automáticamente
      if (currentProductId) {
        const allRows = Array.from(variantsTable.querySelectorAll("tr"));
        const hasStock = await checkProductHasStock(allRows);
        const hasImages = await checkProductHasImages(allRows);
        
        if (hasStock && hasImages) {
          // Verificar estado actual del producto
          const { data: product } = await supabase
            .from("products")
            .select("status")
            .eq("id", currentProductId)
            .single();
          
          if (product && product.status !== "active") {
            // Activar producto automáticamente
            const { error: updateErr } = await supabase
              .from("products")
              .update({ status: "active" })
              .eq("id", currentProductId);
            
            if (!updateErr) {
              console.log("✅ Producto activado automáticamente (tiene stock e imágenes)");
              // Actualizar el select de estado en la UI
              const statusSelect = document.getElementById("status");
              if (statusSelect) {
                statusSelect.value = "active";
              }
              statusEl.textContent = "✅ Producto activado automáticamente (tiene stock e imágenes)";
              statusEl.style.color = "#090";
              setTimeout(() => {
                if (statusEl.textContent.includes("activado automáticamente")) {
                  statusEl.textContent = "";
                }
              }, 3000);
            }
          }
        }
      }
    }
  }

  // Mostrar resultado
  if (rowStatusEl) {
    if (successCount > 0) {
      rowStatusEl.textContent = `✅ ${successCount} imagen(es) subida(s) y guardada(s) correctamente`;
      rowStatusEl.style.color = "#090";
    }
    if (errorCount > 0) {
      rowStatusEl.textContent = `${rowStatusEl.textContent || ""} ⚠️ ${errorCount} error(es)`;
      rowStatusEl.style.color = "#c00";
    }
    setTimeout(() => {
      if (rowStatusEl.textContent.includes("subida")) {
        rowStatusEl.textContent = "";
      }
    }, 3000);
  }

  return successCount > 0;
}

/**
 * Muestra el modal para cargar URLs de imágenes
 * @param {HTMLTableRowElement} row - Fila de la tabla de variantes
 */
function showUrlModalForRow(row) {
  const variantId = row.dataset.variantId;
  if (!variantId) {
    alert("Primero debes seleccionar un color para crear la variante");
    return;
  }

  const modal = document.getElementById("url-modal");
  const urlsContainer = document.getElementById("url-inputs-container");
  const addUrlBtn = document.getElementById("add-url-btn");
  const modalClose = document.getElementById("url-modal-close");
  const modalCancel = document.getElementById("url-modal-cancel");
  const modalSubmit = document.getElementById("url-modal-submit");
  
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
  const processUrls = async () => {
    const urls = urlInputs
      .map(item => item.input.value.trim())
      .filter(url => url.length > 0 && (url.startsWith("http://") || url.startsWith("https://")));
    
    if (urls.length === 0) {
      alert("Por favor ingresá al menos una URL válida");
      return;
    }
    
    if (urls.length < MIN_URLS) {
      alert(`Se requiere al menos ${MIN_URLS} URL${MIN_URLS > 1 ? 's' : ''}`);
      return;
    }
    
    if (urls.length > MAX_URLS) {
      alert(`Máximo ${MAX_URLS} URLs permitidas`);
      return;
    }
    
    closeModal();
    await loadImagesFromUrls(row, urls);
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

/**
 * Carga imágenes desde URLs de Cloudinary directamente
 * @param {HTMLTableRowElement} row - Fila de la tabla de variantes
 * @param {Array<string>} urls - Array de URLs (opcional, si no se proporciona se abre el modal)
 * @returns {Promise<boolean>} - true si se cargaron correctamente
 */
async function loadImagesFromUrls(row, urls = null) {
  const variantId = row.dataset.variantId;
  if (!variantId) {
    alert("Primero debes seleccionar un color para crear la variante");
    return false;
  }

  // Si no se proporcionan URLs, abrir el modal
  if (!urls || urls.length === 0) {
    showUrlModalForRow(row);
    return false;
  }

  const rowStatusEl = row.querySelector(".row-status-message");

  if (rowStatusEl) {
    rowStatusEl.textContent = `Procesando ${urls.length} URL(s)...`;
    rowStatusEl.style.color = "inherit";
  }

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
        is_main: i === 0, // La primera es la principal
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
    // Verificar si ya existe una imagen principal para esta variante
    const { data: existingImages } = await supabase
      .from("variant_images")
      .select("id, is_main")
      .eq("variant_id", variantId);
    
    const hasMainImage = existingImages?.some(img => img.is_main === true) || false;
    
    // Ajustar is_main: solo la primera imagen puede ser principal si no hay una existente
    imagesPayload.forEach((img, index) => {
      img.is_main = !hasMainImage && index === 0;
    });
    
    const { error: insertError } = await supabase
      .from("variant_images")
      .insert(imagesPayload);

    if (insertError) {
      console.error("❌ Error guardando URLs en DB:", insertError);
      if (rowStatusEl) {
        rowStatusEl.textContent = `⚠️ Error guardando URLs: ${insertError.message}`;
        rowStatusEl.style.color = "#c00";
      }
    } else {
      console.log(`✅ ${imagesPayload.length} URL(s) guardada(s) en variant_images`);
      // Refrescar la UI de imágenes
      await loadVariantImages(row, variantId);
      
      // Verificar si el producto tiene stock y ahora tiene imágenes → activar automáticamente
      if (currentProductId) {
        const allRows = Array.from(variantsTable.querySelectorAll("tr"));
        const hasStock = await checkProductHasStock(allRows);
        const hasImages = await checkProductHasImages(allRows);
        
        if (hasStock && hasImages) {
          // Verificar estado actual del producto
          const { data: product } = await supabase
            .from("products")
            .select("status")
            .eq("id", currentProductId)
            .single();
          
          if (product && product.status !== "active") {
            // Activar producto automáticamente
            const { error: updateErr } = await supabase
              .from("products")
              .update({ status: "active" })
              .eq("id", currentProductId);
            
            if (!updateErr) {
              console.log("✅ Producto activado automáticamente (tiene stock e imágenes)");
              // Actualizar el select de estado en la UI
              const statusSelect = document.getElementById("status");
              if (statusSelect) {
                statusSelect.value = "active";
              }
              statusEl.textContent = "✅ Producto activado automáticamente (tiene stock e imágenes)";
              statusEl.style.color = "#090";
              setTimeout(() => {
                if (statusEl.textContent.includes("activado automáticamente")) {
                  statusEl.textContent = "";
                }
              }, 3000);
            }
          }
        }
      }
      
      if (rowStatusEl) {
        rowStatusEl.textContent = `✅ ${successCount} URL(s) cargada(s) correctamente`;
        rowStatusEl.style.color = "#090";
        setTimeout(() => {
          if (rowStatusEl.textContent.includes("cargada")) {
            rowStatusEl.textContent = "";
          }
        }, 3000);
      }
    }
  }

  if (errorCount > 0 && rowStatusEl) {
    rowStatusEl.textContent = `${rowStatusEl.textContent || ""} ⚠️ ${errorCount} error(es)`;
    rowStatusEl.style.color = "#c00";
  }

  return successCount > 0;
}

/**
 * Convierte un File a base64 string
 */
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
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Auto-handle from name unless user edits handle
const nameEl = document.getElementById("name");
const handleEl = document.getElementById("handle");
let handleDirty = false;
handleEl?.addEventListener("input", () => (handleDirty = true));
nameEl?.addEventListener("input", async () => {
  // Convertir a mayúsculas mientras escribe
  const cursorPos = nameEl.selectionStart;
  const currentValue = nameEl.value;
  const upperValue = currentValue.toUpperCase();
  if (currentValue !== upperValue) {
    nameEl.value = upperValue;
    // Restaurar posición del cursor
    nameEl.setSelectionRange(cursorPos, cursorPos);
  }
  
  if (!handleDirty) {
    handleEl.value = slugify(nameEl.value);
    // Update SKU bases in existing rows when handle changes automatically
    const supplierEl = document.getElementById("supplier");
    const supplierId = supplierEl?.value || "";
    const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
    
    variantsTable.querySelectorAll("tr").forEach((tr) => {
      const color = tr.querySelector(".v-color")?.value || "";
      const skuBaseEl = tr.querySelector(".v-skuBase");
      if (skuBaseEl && !skuBaseEl.dataset.dirty) {
        skuBaseEl.value = makeSkuBase(handleEl.value, color, supplierCode);
      }
    });
  }
});

// Obtener siguiente número progresivo para productos de categoría Ropa
async function getNextRopaNumber() {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("name")
      .eq("category", "Ropa")
      .not("name", "is", null);
    
    if (error) {
      console.warn("Error obteniendo productos de Ropa:", error);
      return 1; // Por defecto, empezar en 1
    }
    
    // Buscar el número más alto en nombres que empiecen con "R" seguido de dígitos
    let maxNumber = 0;
    products.forEach(prod => {
      const name = (prod.name || "").trim().toUpperCase();
      // Buscar patrones como R1, R2, R123, etc.
      const match = name.match(/^R(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    });
    
    return maxNumber + 1;
  } catch (error) {
    console.warn("Error en getNextRopaNumber:", error);
    return 1;
  }
}

// Agregar "R" automáticamente cuando el usuario sale del campo nombre si la categoría es Ropa
// Y asegurar que esté en mayúsculas
nameEl?.addEventListener("blur", () => {
  // Convertir a mayúsculas al salir del campo
  const currentValue = nameEl.value.trim();
  if (currentValue) {
    nameEl.value = currentValue.toUpperCase();
  }
  
  const categoryEl = document.getElementById("category");
  if (categoryEl?.value === "Ropa") {
    const currentName = nameEl.value.trim();
    // Solo agregar si hay texto y no comienza con "R" seguido de dígitos
    if (currentName && !/^R\d/.test(currentName)) {
      // Si el nombre no empieza con R seguido de número, agregar R al inicio
      nameEl.value = "R" + currentName;
      // Actualizar handle si no fue editado manualmente
      if (!handleDirty) {
        handleEl.value = slugify(nameEl.value);
      }
    }
  }
});

function refreshColorDatalist() {
  const datalist = document.getElementById("colors-datalist");
  if (!datalist) return;
  datalist.innerHTML = (COLORS || [])
    .map((c) => `<option value="${c.name}">${c.code || ""}</option>`)
    .join("");
}

async function loadColors() {
  try {
    const { data, error } = await supabase
      .from("colors")
      .select("name, code, hex_color, display_number")
      .order("name");
    if (error) {
      console.warn("No se pudieron cargar colores:", error.message);
      return;
    }
    if (Array.isArray(data)) {
      // Eliminar duplicados normalizando nombres (case-insensitive, trim)
      const colorMap = new Map();
      data.forEach((c) => {
        const normalizedName = (c.name || "").trim().toLowerCase();
        if (normalizedName && !colorMap.has(normalizedName)) {
          colorMap.set(normalizedName, c);
        }
      });
      COLORS = Array.from(colorMap.values()).sort((a, b) => 
        (a.name || "").localeCompare(b.name || "")
      );
      refreshColorDatalist();
    }
  } catch (e) {
    console.warn("Error cargando colores", e);
  }
}

function refreshTagsDatalist() {
  const dl = document.getElementById("tags-datalist");
  if (!dl) return;
  dl.innerHTML = (TAGS || [])
    .map((t) => `<option value="${t.name}"></option>`)
    .join("");
}

async function loadTags() {
  try {
    const { data, error } = await supabase
      .from("tags")
      .select("id, name")
      .order("name");
    if (!error && Array.isArray(data)) {
      TAGS = data;
      refreshTagsDatalist();
    }
  } catch (e) {
    console.warn("Error cargando tags", e);
  }
}

async function loadSuppliers() {
  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("id, name, code")
      .order("name");
    if (error) {
      console.warn("No se pudieron cargar proveedores:", error.message);
      return;
    }
    if (Array.isArray(data)) {
      // Poblar cache de proveedores
      SUPPLIERS_CACHE.clear();
      data.forEach(s => {
        if (s.id && s.code) {
          SUPPLIERS_CACHE.set(s.id, s.code);
        }
      });
      
      const supplierSelect = document.getElementById("supplier");
      if (supplierSelect) {
        const currentValue = supplierSelect.value; // Guardar selección actual
        const base = '<option value="">Sin proveedor</option>';
        supplierSelect.innerHTML = base + data.map(s => 
          `<option value="${s.id}">${s.name}</option>`
        ).join("");
        // Restaurar selección si existe
        if (currentValue && [...supplierSelect.options].some(o => o.value === currentValue)) {
          supplierSelect.value = currentValue;
        }
        // Actualizar visibilidad del botón de editar
        updateEditButtonVisibility();
      }
    }
  } catch (e) {
    console.warn("Error cargando proveedores", e);
  }
}

// Crear nuevo proveedor
async function createNewSupplier() {
  const nameInput = document.getElementById("new-supplier-name");
  const codeInput = document.getElementById("new-supplier-code");
  const name = (nameInput?.value || "").trim();
  let code = (codeInput?.value || "").trim();
  
  if (!name) {
    alert("El nombre del proveedor es obligatorio");
    nameInput?.focus();
    return null;
  }
  
  // Generar código automáticamente si no se proporciona
  if (!code) {
    // Crear código a partir del nombre (primeras 3 letras en mayúsculas)
    code = name
      .substring(0, 3)
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    
    // Si el código queda vacío, usar las primeras letras
    if (!code) {
      code = name
        .split(" ")
        .map(word => word.charAt(0))
        .join("")
        .substring(0, 3)
        .toUpperCase() || "PRV";
    }
    
    // Verificar que el código no exista ya
    const { data: existing } = await supabase
      .from("suppliers")
      .select("code")
      .eq("code", code)
      .maybeSingle();
    
    if (existing) {
      // Si existe, agregar número
      let counter = 1;
      let newCode = code + counter;
      while (true) {
        const { data: check } = await supabase
          .from("suppliers")
          .select("code")
          .eq("code", newCode)
          .maybeSingle();
        if (!check) break;
        counter++;
        newCode = code + counter;
      }
      code = newCode;
    }
  }
  
  try {
    const supplierData = {
      name: name,
      code: code
    };
    
    const { data, error } = await supabase
      .from("suppliers")
      .insert([supplierData])
      .select("id, name, code")
      .single();
    
    if (error) {
      console.error("Error creando proveedor:", error);
      if (error.code === "23505") { // Violación de unicidad
        alert("Ya existe un proveedor con ese código. Por favor, ingresa un código diferente.");
      } else {
        alert(`Error al crear proveedor: ${error.message}`);
      }
      return null;
    }
    
    // Limpiar formulario
    if (nameInput) nameInput.value = "";
    if (codeInput) codeInput.value = "";
    
    // Ocultar formulario
    const form = document.getElementById("new-supplier-form");
    if (form) form.style.display = "none";
    
    // Recargar lista de proveedores (esto también actualiza el cache)
    await loadSuppliers();
    
    // Seleccionar el proveedor recién creado
    const supplierSelect = document.getElementById("supplier");
    if (supplierSelect && data) {
      supplierSelect.value = data.id;
      // Recalcular SKU bases con el nuevo proveedor
      await recalculateAllSkuBases();
    }
    
    return data;
  } catch (e) {
    console.error("Error creando proveedor:", e);
    alert(`Error al crear proveedor: ${e.message}`);
    return null;
  }
}

function addVariantRow(prefill = {}) {
  // Si no hay prefill de costo/precio, obtenerlos de la primera variante existente
  const firstRow = variantsTable.querySelector("tr");
  if (firstRow) {
    const firstCostEl = firstRow.querySelector(".v-cost");
    const firstPriceEl = firstRow.querySelector(".v-price");
    // Siempre copiar costo y precio de la primera variante si no están especificados
    if (firstCostEl && !prefill.cost) {
      prefill.cost = firstCostEl.value || "";
    }
    if (firstPriceEl && !prefill.price) {
      prefill.price = firstPriceEl.value || "0";
    }
  }
  
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>
      <div style="position:relative;">
        <div style="display:flex;gap:4px;align-items:center;">
          <input class="v-color" placeholder="Negro" value="${
            prefill.color ?? ""
          }" style="flex:1;padding:4px;font-size:11px;background-color:#fff;" title="Escribe un color o haz clic en el botón para seleccionar" list="colors-datalist" autocomplete="on"/>
          <button type="button" class="color-menu-btn" title="Colores" style="padding:4px 6px;font-size:11px;cursor:pointer">▼</button>
        </div>
        <div class="color-menu" style="display:none;position:absolute;top:calc(100% + 2px);left:0;width:100%;min-width:280px;background:#fff;border:1px solid #ccc;border-radius:4px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1000;font-size:11px;max-height:350px;overflow-y:auto">
        <div class="color-list"></div>
        <hr style="margin:4px 0"/>
        <div style="display:flex;gap:3px;align-items:center;">
          <input class="new-color-name" placeholder="Nuevo color" style="flex:1;padding:3px;font-size:11px" autocomplete="off"/>
          <input class="new-color-code" placeholder="COD" style="width:50px;padding:3px;font-size:11px" autocomplete="off"/>
          <input type="color" class="new-color-hex" value="#000000" style="width:28px;height:24px;padding:1px;border:1px solid #ddd;border-radius:3px;cursor:pointer" title="Color hex"/>
          <input type="number" class="new-color-number" placeholder="#" min="1" max="9" style="width:35px;padding:3px;font-size:11px" title="Número 1-9 para mostrar en círculo" autocomplete="off"/>
          <button type="button" class="add-color" style="padding:3px 6px;font-size:11px">Agregar</button>
        </div>
        <small style="color:#666;font-size:10px;display:block;margin-top:2px">Si dejás COD vacío, se autogenera. El número (1-9) es opcional y se mostrará en el círculo de color.</small>
      </div>
    </td>
    <td>
      <span class="variant-status unsaved" style="font-size:11px;padding:4px 8px;border-radius:4px;background:#fff3cd;color:#856404;display:inline-block;">
        No guardada
      </span>
      <div class="row-status-message" style="font-size:10px;color:#666;margin-top:2px;"></div>
    </td>
    <td>
      <button type="button" class="upload-images-btn btn" disabled style="padding:4px 8px;font-size:11px;width:100%;margin-bottom:4px;">
        Subir imágenes
      </button>
      <button type="button" class="load-url-images-btn btn" disabled style="padding:4px 8px;font-size:11px;width:100%;">
        Cargar URL
      </button>
    </td>
    <td>
      <div class="sizes-editor">
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
          <select class="sizes-presets" style="flex:0 0 auto;min-width:100px;padding:4px;font-size:11px">
            <option value="">Talles guardados...</option>
          </select>
          <input class="v-sizes" placeholder="35,36,37" style="flex:1;min-width:120px;padding:4px;font-size:11px" autocomplete="off" />
          <button type="button" class="sizes-generate" style="padding:4px 8px;font-size:11px;white-space:nowrap">Generar</button>
          <button type="button" class="sizes-save" style="padding:4px 8px;font-size:11px;white-space:nowrap" title="Guardar estos talles">💾</button>
        </div>
        <div class="sizes-list" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;"></div>
        <small style="color:#666;font-size:10px;line-height:1.2;display:block;margin-top:2px">Tip: ingresá talles separados por coma y tocá Generar. El stock de estos talles corresponde al depósito general y se guardará al guardar el producto.</small>
      </div>
    </td>
    <td><input class="v-skuBase" placeholder="ZAP343-NEG" value="${
      prefill.skuBase ?? ""
    }" style="padding:4px;font-size:11px" autocomplete="off"/></td>
    <td data-cost-sensitive="cost-col-cell"><input class="v-cost" type="text" inputmode="numeric" value="${
      prefill.cost ?? ""
    }" placeholder="0" style="padding:4px;font-size:11px" autocomplete="off"/></td>
    <td><input class="v-price" type="text" inputmode="numeric" value="${
      prefill.price ?? 0
    }" style="padding:4px;font-size:11px" autocomplete="off"/></td>
    <td style="text-align:center;"><input class="v-active" type="checkbox" ${
      prefill.active === false ? "" : "checked"
    }/></td>
    <td>
      <div class="variant-images-container" style="min-width:200px;">
        <div class="variant-images-list" style="display:flex;flex-direction:column;gap:4px;min-height:50px;">
          <!-- Las imágenes se cargan dinámicamente aquí -->
        </div>
        <!-- Mantener textarea oculto para compatibilidad legacy (si es necesario) -->
        <textarea class="v-images" rows="2" placeholder="https://...\nhttps://..." style="display:none;">${(
      prefill.images || []
    ).join("\n")}</textarea>
      </div>
    </td>
    <td><button type="button" class="rm" style="padding:4px 8px;font-size:12px;min-width:auto">✕</button></td>
    <input class="v-sku" type="hidden" value="${prefill.sku ?? ""}" />
  `;
  if (prefill.id) tr.dataset.variantId = prefill.id;
  tr.querySelector(".rm").addEventListener("click", () => tr.remove());
  
  // Cargar talles guardados en el dropdown
  const sizesPresetsSelect = tr.querySelector(".sizes-presets");
  const categoryEl = document.getElementById("category");
  const category = categoryEl?.value || "Calzado";
  refreshSizesPresets(sizesPresetsSelect, category);
  
  // Handler para seleccionar talles guardados
  if (sizesPresetsSelect) {
    sizesPresetsSelect.addEventListener("change", (e) => {
      const value = e.target.value;
      if (!value) return;
      
      const categoryEl = document.getElementById("category");
      const category = categoryEl?.value || "Calzado";
      
      if (value.startsWith("DELETE:")) {
        // Eliminar conjunto de talles
        const sizesKey = value.replace("DELETE:", "");
        const saved = getSavedSizes(category);
        const item = saved.find(s => s.sizes === sizesKey);
        if (item && confirm(`¿Eliminar los talles guardados "${item.name}"?`)) {
          deleteSizesSet(sizesKey, category);
          refreshSizesPresets(sizesPresetsSelect, category);
          // Recargar en todas las filas
          variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel, category));
          e.target.value = "";
        } else {
          e.target.value = "";
        }
        return;
      }
      
      // Cargar talles seleccionados
      const saved = getSavedSizes(category);
      const item = saved.find(s => s.sizes === value);
      if (item && item.sizesArray) {
        const sizesInput = tr.querySelector(".v-sizes");
        if (sizesInput) {
          sizesInput.value = item.sizesArray.join(", ");
          generate();
        }
        e.target.value = ""; // Resetear selección
      }
    });
  }
  
  // Handler para guardar talles
  const saveSizesBtn = tr.querySelector(".sizes-save");
  if (saveSizesBtn) {
    saveSizesBtn.addEventListener("click", () => {
      const sizesInput = tr.querySelector(".v-sizes");
      const sizesStr = sizesInput?.value?.trim() || "";
      
      if (!sizesStr) {
        alert("Primero ingresá los talles que querés guardar");
        sizesInput?.focus();
        return;
      }
      
      const categoryEl = document.getElementById("category");
      const category = categoryEl?.value || "Calzado";
      
      if (saveSizesSet(sizesStr, null, category)) {
        // Recargar dropdowns en todas las filas
        variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel, category));
        statusEl.textContent = "Talles guardados correctamente";
        statusEl.style.color = "#090";
        setTimeout(() => {
          statusEl.textContent = "";
        }, 2000);
      }
    });
  }
  
  // sizes generate handler
  const generate = () => {
    const sizesStr = tr.querySelector(".v-sizes").value.trim();
    const list = tr.querySelector(".sizes-list");
    if (!sizesStr) {
      list.innerHTML = "";
      return;
    }
    
    // Preservar valores de stock existentes antes de regenerar
    const existingStocks = new Map();
    list.querySelectorAll(".size-stock").forEach((inp) => {
      const size = inp.dataset.size?.trim();
      const stock = inp.value || "0";
      if (size) {
        existingStocks.set(size, stock);
      }
    });
    
    const sizes = sizesStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    
    if (sizes.length === 0) {
      list.innerHTML = "";
      return;
    }
    
    // Limpiar y regenerar
    list.innerHTML = "";
    sizes.forEach((s) => {
      // Usar stock existente si existe, sino 0
      const stockToUse = existingStocks.get(s) || "0";
      
      const box = document.createElement("div");
      box.style =
        "display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;border:1px solid #ddd;border-radius:4px;min-width:50px;position:relative;";
      box.innerHTML = `
        <button type="button" class="remove-size-btn" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;padding:0;border:1px solid #ccc;border-radius:50%;background:#fff;color:#c33;cursor:pointer;font-size:10px;line-height:1;display:flex;align-items:center;justify-content:center;z-index:1;" title="Eliminar talle">✕</button>
        <strong style="font-size:11px">${s}</strong>
        <input type="number" class="size-stock" data-size="${s}" min="0" value="${stockToUse}" style="width:50px;padding:3px;font-size:11px" placeholder="0" autocomplete="off"/>
      `;
      
      // Agregar handler para guardar automáticamente cuando cambia el stock (si ya existe la variante)
      const stockInput = box.querySelector(".size-stock");
      if (stockInput) {
        let saveTimeout;
        stockInput.addEventListener("input", () => {
          // Debounce: guardar después de 500ms de inactividad
          clearTimeout(saveTimeout);
          saveTimeout = setTimeout(async () => {
            const variantId = tr.dataset.variantId;
            if (variantId) {
              console.log(`🔧 Stock cambiado para talle ${s}, guardando automáticamente...`);
              const saved = await saveVariantSizes(variantId, tr);
              if (saved) {
                updateVariantStatus(tr, "saved");
              }
            }
          }, 500);
        });
      }
      
      // Agregar handler para eliminar talle
      const removeBtn = box.querySelector(".remove-size-btn");
      if (removeBtn) {
        removeBtn.addEventListener("click", () => {
          box.remove();
          // Actualizar el input de talles
          const currentSizes = Array.from(list.querySelectorAll(".size-stock"))
            .map(inp => inp.dataset.size)
            .filter(Boolean);
          const sizesInput = tr.querySelector(".v-sizes");
          if (sizesInput) {
            sizesInput.value = currentSizes.join(", ");
          }
        });
      }
      
      list.appendChild(box);
    });
    console.log(`🔧 Talles generados: ${sizes.length} talles (${sizes.join(", ")}) - Todos con stock permitido (incluyendo 0)`);
    
    // Si ya hay una variante guardada (tiene variantId), guardar automáticamente los talles
    const variantId = tr.dataset.variantId;
    if (variantId && sizes.length > 0) {
      console.log(`🔧 Variante ${variantId} ya existe, guardando talles automáticamente...`);
      // Llamar a saveVariantSizes después de un pequeño delay para asegurar que el DOM esté actualizado
      setTimeout(async () => {
        const saved = await saveVariantSizes(variantId, tr);
        if (saved) {
          updateVariantStatus(tr, "saved");
          const rowStatusEl = tr.querySelector(".row-status-message");
          if (rowStatusEl) {
            rowStatusEl.textContent = "✅ Talles guardados automáticamente";
            rowStatusEl.style.color = "#090";
            setTimeout(() => {
              if (rowStatusEl.textContent === "✅ Talles guardados automáticamente") {
                rowStatusEl.textContent = "";
              }
            }, 2000);
          }
        }
      }, 100);
    }
  };
  tr.querySelector(".sizes-generate").addEventListener("click", generate);
  tr.querySelector(".v-sizes").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      generate();
    }
  });
  // Auto SKU base when color changes (unless manually edited)
  const skuBaseEl = tr.querySelector(".v-skuBase");
  skuBaseEl?.addEventListener("input", () => (skuBaseEl.dataset.dirty = "1"));
  const colorEl = tr.querySelector(".v-color");
  const supplierEl = document.getElementById("supplier");
  const maybeFillSkuBase = async () => {
    if (!skuBaseEl) return;
    if (!skuBaseEl.dataset.dirty || skuBaseEl.value.trim() === "") {
      const handle = handleEl?.value || "";
      const color = colorEl?.value || "";
      const supplierId = supplierEl?.value || "";
      
      // Obtener código del proveedor si existe
      const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
      
      skuBaseEl.value = makeSkuBase(handle, color, supplierCode);
    }
  };
  colorEl?.addEventListener("input", maybeFillSkuBase);
  // Initial fill
  maybeFillSkuBase();

  // Color menu logic
  const menuBtn = tr.querySelector(".color-menu-btn");
  const menu = tr.querySelector(".color-menu");
  const list = tr.querySelector(".color-list");
  const rebuildList = () => {
    list.innerHTML = "";
    COLORS.forEach((c) => {
      const item = document.createElement("div");
      item.style = "display:flex;gap:3px;align-items:center;padding:2px 0;";
      
      // Color picker
      const colorPicker = document.createElement("input");
      colorPicker.type = "color";
      colorPicker.value = c.hex_color || "#000000";
      colorPicker.style = "width:24px;height:20px;padding:1px;border:1px solid #ddd;border-radius:3px;cursor:pointer;flex-shrink:0";
      colorPicker.title = "Editar color hex";
      
      // Botón de selección
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c.name + (c.code ? ` (${c.code})` : "");
      b.style = "flex:1;text-align:left;padding:3px 5px;margin:0;border:1px solid #ddd;border-radius:3px;background:#fff;cursor:pointer;font-size:11px";
      b.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        colorEl.value = c.name;
        maybeFillSkuBase();
        menu.style.display = "none";
        // Guardar variante automáticamente al seleccionar color
        await autoSaveVariant();
      });
      
      // Botón para editar nombre y código
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "✏️";
      editBtn.style = "padding:2px 4px;border:1px solid #ddd;border-radius:3px;background:#fff;cursor:pointer;font-size:10px;flex-shrink:0";
      editBtn.title = "Editar color";
      editBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const newName = prompt(`Editar nombre del color "${c.name}":`, c.name);
        if (newName === null) return; // Usuario canceló
        
        const trimmedName = newName.trim();
        if (!trimmedName) {
          alert("El nombre del color no puede estar vacío");
          return;
        }
        
        // Si el nombre cambió, verificar que no exista otro color con ese nombre
        if (trimmedName.toLowerCase() !== c.name.toLowerCase()) {
          const existingColor = COLORS.find(col => 
            col.name.toLowerCase() === trimmedName.toLowerCase() && col.name !== c.name
          );
          if (existingColor) {
            alert(`Ya existe un color con el nombre "${trimmedName}". Por favor, elige otro nombre.`);
            return;
          }
        }
        
        const newCode = prompt(`Editar código del color "${c.name}" (actual: ${c.code || 'ninguno'}):`, c.code || "");
        if (newCode === null) return; // Usuario canceló
        
        const newDisplayNumber = prompt(`Editar número de visualización (1-9) del color "${c.name}" (actual: ${c.display_number || 'ninguno'}, dejar vacío para eliminar):`, c.display_number || "");
        if (newDisplayNumber === null) return; // Usuario canceló
        
        try {
          const updateData = {};
          
          // Solo actualizar nombre si cambió
          if (trimmedName.toLowerCase() !== c.name.toLowerCase()) {
            updateData.name = trimmedName;
          }
          
          // Actualizar código si se proporcionó
          if (newCode.trim()) {
            // Verificar que el código no esté en uso por otro color
            const existingCode = COLORS.find(col => 
              col.code && col.code.toUpperCase() === newCode.trim().toUpperCase() && col.name !== c.name
            );
            if (existingCode) {
              alert(`El código "${newCode.trim().toUpperCase()}" ya está en uso por el color "${existingCode.name}".`);
              return;
            }
            updateData.code = newCode.trim().toUpperCase();
          }
          
          // Actualizar display_number
          if (newDisplayNumber.trim() === "") {
            // Si está vacío, eliminar el número (null)
            updateData.display_number = null;
          } else {
            const num = parseInt(newDisplayNumber.trim(), 10);
            if (isNaN(num) || num < 1 || num > 9) {
              alert("El número debe estar entre 1 y 9");
              return;
            }
            updateData.display_number = num;
          }
          
          // Solo actualizar si hay cambios
          if (Object.keys(updateData).length === 0) {
            return; // No hay cambios
          }
          
          const { data, error } = await supabase
            .from("colors")
            .update(updateData)
            .eq("name", c.name)
            .select("name, code, hex_color, display_number")
            .single();
            
          if (error) {
            console.error("Error actualizando color:", error);
            if (error.code === '23505') { // Unique violation
              alert(`Error: Ya existe un color con ese nombre o código. Por favor, elige otro.`);
            } else {
              alert(`Error al actualizar color: ${error.message}`);
            }
          } else {
            // Recargar colores desde la BD para obtener los datos actualizados
            await loadColors();
            rebuildList();
            // Si el color seleccionado era el editado, actualizar el input
            if (colorEl.value === c.name) {
              colorEl.value = trimmedName;
            }
            console.log(`✅ Color actualizado: ${c.name} -> ${trimmedName}`);
          }
        } catch (err) {
          console.error("Error actualizando color:", err);
          alert(`Error al actualizar color: ${err.message}`);
        }
      });
      
      // Guardar hex_color cuando cambia el color picker
      colorPicker.addEventListener("change", async (e) => {
        const newHex = e.target.value.toUpperCase();
        if (newHex !== (c.hex_color || "").toUpperCase()) {
          try {
            const { error } = await supabase
              .from("colors")
              .update({ hex_color: newHex })
              .eq("name", c.name);
            if (error) {
              console.error("Error actualizando color:", error);
              alert(`Error al actualizar color: ${error.message}`);
              e.target.value = c.hex_color || "#000000";
            } else {
              c.hex_color = newHex;
              console.log(`✅ Color ${c.name} actualizado a ${newHex}`);
            }
          } catch (err) {
            console.error("Error actualizando color:", err);
            alert(`Error al actualizar color: ${err.message}`);
            e.target.value = c.hex_color || "#000000";
          }
        }
      });
      
      item.appendChild(colorPicker);
      item.appendChild(b);
      item.appendChild(editBtn);
      list.appendChild(item);
    });
    if (!COLORS.length) {
      const empty = document.createElement("div");
      empty.textContent = "Sin colores cargados";
      empty.style.color = "#666";
      list.appendChild(empty);
    }
  };
  rebuildList();
  
  // Función para abrir/cerrar el menú
  const toggleMenu = () => {
    if (!menu) {
      console.warn("⚠️ No se encontró el elemento del menú");
      return;
    }
    
    rebuildList();
    const isVisible = menu.style.display === "block";
    
    if (isVisible) {
      menu.style.display = "none";
    } else {
      menu.style.display = "block";
    }
  };
  
  // Abrir menú al hacer clic en el botón
  if (menuBtn) {
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("🔵 Botón de menú clickeado, abriendo menú...");
      toggleMenu();
    });
  } else {
    console.warn("⚠️ No se encontró el botón del menú de colores");
  }
  
  // Cerrar menú al hacer clic fuera (usar setTimeout para evitar cierre inmediato)
  const handleOutsideClick = (e) => {
    if (menu && menu.style.display === "block") {
      const clickedInsideMenu = menu.contains(e.target);
      const clickedOnButton = e.target === menuBtn || menuBtn?.contains(e.target);
      const clickedOnInput = e.target === colorEl;
      
      if (!clickedInsideMenu && !clickedOnButton && !clickedOnInput) {
        menu.style.display = "none";
      }
    }
  };
  
  // Usar setTimeout para que el listener se agregue después de que se procese el click del botón
  setTimeout(() => {
    document.addEventListener("click", handleOutsideClick, true);
  }, 0);
  
  tr.querySelector(".add-color")?.addEventListener("click", async () => {
    const name = tr.querySelector(".new-color-name").value.trim();
    let code = tr.querySelector(".new-color-code").value.trim().toUpperCase();
    const hexColorInput = tr.querySelector(".new-color-hex");
    let hexColor = hexColorInput?.value?.trim().toUpperCase() || "";
    const displayNumberInput = tr.querySelector(".new-color-number");
    const displayNumberValue = displayNumberInput?.value?.trim();
    let displayNumber = null;
    
    if (!name) return;
    if (!code) code = colorCode(name);
    
    // Validar formato hex
    if (hexColor && !/^#[0-9A-F]{6}$/i.test(hexColor)) {
      alert("El color hex debe tener el formato #RRGGBB (ej: #FF0000)");
      return;
    }
    
    // Si no hay hex_color, usar el valor del color picker o un valor por defecto
    if (!hexColor) {
      hexColor = hexColorInput?.value || "#000000";
    }
    
    // Validar y procesar display_number (1-9)
    if (displayNumberValue) {
      const num = parseInt(displayNumberValue, 10);
      if (num >= 1 && num <= 9) {
        displayNumber = num;
      } else {
        alert("El número debe estar entre 1 y 9");
        return;
      }
    }
    
    try {
      const insertData = { name, code, hex_color: hexColor };
      if (displayNumber !== null) {
        insertData.display_number = displayNumber;
      }
      
      const { data, error } = await supabase
        .from("colors")
        .insert([insertData])
        .select("name, code, hex_color, display_number")
        .single();
      if (error) {
        statusEl.textContent = `No se pudo guardar el color: ${error.message}`;
        statusEl.style.color = "#c00";
        return;
      }
      if (data) {
        COLORS.push(data);
        refreshColorDatalist();
        colorEl.value = data.name;
        maybeFillSkuBase();
        rebuildList();
        // Limpiar campos
        tr.querySelector(".new-color-name").value = "";
        tr.querySelector(".new-color-code").value = "";
        if (hexColorInput) hexColorInput.value = "#000000";
        if (displayNumberInput) displayNumberInput.value = "";
        // Guardar variante automáticamente después de crear el color
        await autoSaveVariant();
      }
    } catch (e) {
      statusEl.textContent = `Error al guardar color`;
      statusEl.style.color = "#c00";
    }
  });

  // Cost formatter
  const costEl = tr.querySelector(".v-cost");
  if (costEl) attachPriceFormatter(costEl);
  
  // Price formatter
  const priceEl = tr.querySelector(".v-price");
  if (priceEl) attachPriceFormatter(priceEl);
  
  // Función para recalcular precio recomendado
  const recalculatePrice = () => {
    const cost = parseARS(costEl?.value || "0");
    const percentage = parseFloat(document.getElementById("price-percentage")?.value || "30");
    const logisticAmount = document.getElementById("logistic-amount")?.value || "500";
    
    if (cost > 0 && priceEl) {
      const recommended = calculateRecommendedPrice(cost, percentage, logisticAmount);
      // Solo actualizar si el precio actual está vacío o coincide con un valor calculado anterior
      // Esto permite que el usuario edite manualmente el precio
      const currentPrice = parseARS(priceEl.value || "0");
      if (currentPrice === 0 || currentPrice === recommended || priceEl.dataset.autoCalculated === "true") {
        priceEl.value = formatARS(recommended);
        priceEl.dataset.autoCalculated = "true";
        // Retornar el precio calculado para sincronizarlo
        return formatARS(recommended);
      }
    }
    return priceEl?.value || "";
  };
  
  // Función para sincronizar costo y precio con todas las variantes
  const syncCostAndPrice = (sourceCostEl, sourcePriceEl, syncPrice = true) => {
    const costValue = sourceCostEl?.value || "";
    const priceValue = sourcePriceEl?.value || "";
    
    // Sincronizar con todas las demás variantes
    variantsTable.querySelectorAll("tr").forEach((otherRow) => {
      if (otherRow === tr) return; // No sincronizar consigo mismo
      
      const otherCostEl = otherRow.querySelector(".v-cost");
      const otherPriceEl = otherRow.querySelector(".v-price");
      
      // Sincronizar costo
      if (otherCostEl && costValue) {
        otherCostEl.value = costValue;
      }
      
      // Sincronizar precio siempre que se especifique
      if (syncPrice && otherPriceEl && priceValue) {
        otherPriceEl.value = priceValue;
        // Copiar el estado de autoCalculated
        if (sourcePriceEl?.dataset.autoCalculated !== undefined) {
          otherPriceEl.dataset.autoCalculated = sourcePriceEl.dataset.autoCalculated;
        }
      }
    });
  };
  
  // Event listeners para recalcular precio
  costEl?.addEventListener("input", () => {
    const calculatedPrice = recalculatePrice();
    // Sincronizar costo y precio recalculado con todas las variantes
    if (calculatedPrice) {
      syncCostAndPrice(costEl, priceEl, true);
    } else {
      syncCostAndPrice(costEl, priceEl, false);
    }
  });
  costEl?.addEventListener("blur", () => {
    const calculatedPrice = recalculatePrice();
    // Sincronizar costo y precio recalculado con todas las variantes
    if (calculatedPrice) {
      syncCostAndPrice(costEl, priceEl, true);
    } else {
      syncCostAndPrice(costEl, priceEl, false);
    }
  });
  
  // Marcar precio como editado manualmente cuando el usuario lo modifica
  priceEl?.addEventListener("input", () => {
    // Si el usuario está editando, desmarcar como auto-calculado
    // pero solo si realmente está cambiando el valor
    const currentValue = parseARS(priceEl.value || "0");
    const cost = parseARS(costEl?.value || "0");
    if (cost > 0) {
      const percentage = parseFloat(document.getElementById("price-percentage")?.value || "30");
      const logisticAmount = document.getElementById("logistic-amount")?.value || "500";
      const expected = calculateRecommendedPrice(cost, percentage, logisticAmount);
      // Si el valor actual no coincide con el esperado, es una edición manual
      if (currentValue !== expected && currentValue > 0) {
        priceEl.dataset.autoCalculated = "false";
        // Sincronizar precio con todas las variantes cuando se edita manualmente
        syncCostAndPrice(costEl, priceEl);
      }
    } else if (currentValue > 0) {
      // Si no hay costo pero hay precio, también sincronizar
      syncCostAndPrice(costEl, priceEl);
    }
  });
  
  // También sincronizar al salir del campo precio
  priceEl?.addEventListener("blur", () => {
    const currentValue = parseARS(priceEl.value || "0");
    if (currentValue > 0) {
      syncCostAndPrice(costEl, priceEl);
    }
  });
  
  // Las imágenes se cargan después de agregar la fila (ver loadProductById o uploadImagesToCloudinary)

  // Guardar variante automáticamente cuando se selecciona/escribe un color
  // Función para guardar variante automáticamente (SOLO si hay talles definidos)
  const autoSaveVariant = async () => {
    const color = colorEl?.value?.trim();
    if (!color) return;
    
    // Verificar estado del producto
    const productStatus = document.getElementById("status")?.value || "";
    const isPendingStock = productStatus === "pending_stock";
    
    // Verificar que haya talles definidos antes de guardar
    if (!hasSizesDefined(tr)) {
      // No guardar si no hay talles (excepto si es pending_stock, pero aún así necesitamos talles)
      const rowStatusEl = tr.querySelector(".row-status-message");
      if (rowStatusEl) {
        rowStatusEl.textContent = "⚠️ Define al menos un talle para guardar la variante";
        rowStatusEl.style.color = "#fa0";
        setTimeout(() => {
          if (rowStatusEl.textContent === "⚠️ Define al menos un talle para guardar la variante") {
            rowStatusEl.textContent = "";
          }
        }, 3000);
      }
      return;
    }
    
    const rowStatusEl = tr.querySelector(".row-status-message");
    const variantId = await ensureVariantId(tr);
    if (variantId) {
      // Guardar talles ahora que sabemos que existen (pueden tener stock 0, especialmente si es pending_stock)
      const sizesSaved = await saveVariantSizes(variantId, tr);
      if (sizesSaved) {
        updateVariantStatus(tr, "saved");
        if (rowStatusEl) {
          const message = isPendingStock 
            ? "✅ Variante y talles guardados (stock 0 permitido en modo 'completar stock')"
            : "✅ Variante y talles guardados";
          rowStatusEl.textContent = message;
          rowStatusEl.style.color = "#090";
          setTimeout(() => {
            if (rowStatusEl.textContent.includes("✅ Variante y talles guardados")) {
              rowStatusEl.textContent = "";
            }
          }, 2000);
        }
      } else {
        if (rowStatusEl) {
          rowStatusEl.textContent = "⚠️ Error guardando talles";
          rowStatusEl.style.color = "#c00";
        }
      }
    }
  };
  
  // Guardar automáticamente cuando se sale del input de color (blur)
  colorEl?.addEventListener("blur", autoSaveVariant);

  // Botón Subir imágenes
  const uploadBtn = tr.querySelector(".upload-images-btn");
  if (uploadBtn) {
    // Crear input file oculto
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/jpeg,image/jpg,image/png,image/webp";
    fileInput.multiple = true;
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    uploadBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", async (e) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        await uploadImagesToCloudinary(tr, files);
        fileInput.value = ""; // Reset para permitir subir el mismo archivo de nuevo
      }
    });
  }

  // Botón Cargar URL de Cloudinary
  const loadUrlBtn = tr.querySelector(".load-url-images-btn");
  if (loadUrlBtn) {
    loadUrlBtn.addEventListener("click", () => {
      showUrlModalForRow(tr);
    });
  }
  
  // Actualizar estado del botón de cargar URL
  const variantIdForUrl = tr.dataset.variantId;
  if (loadUrlBtn) {
    loadUrlBtn.disabled = !variantIdForUrl;
    if (!variantIdForUrl) {
      loadUrlBtn.title = "Primero selecciona un color para crear la variante";
    } else {
      loadUrlBtn.title = "Cargar URLs de Cloudinary";
    }
  }

  // Inicializar estado
  if (prefill.id) {
    updateVariantStatus(tr, "saved");
  } else {
    updateVariantStatus(tr, "unsaved");
  }

  // Procesar prefill.sizes si existe (cargar talles desde variant_sizes)
  if (prefill.sizes && Array.isArray(prefill.sizes) && prefill.sizes.length > 0) {
    console.log("🔧 Procesando prefill.sizes:", prefill.sizes);
    const sizesList = tr.querySelector(".sizes-list");
    const sizesInput = tr.querySelector(".v-sizes");
    
    if (!sizesList) {
      console.error("❌ No se encontró .sizes-list en la fila");
      return tr;
    }
    
    if (!sizesInput) {
      console.error("❌ No se encontró .v-sizes en la fila");
      return tr;
    }
    
    // Construir string de talles para el input - manejar objetos y strings
    const sizesStr = prefill.sizes
      .map(s => {
        if (typeof s === 'object' && s !== null) {
          return s.size || s;
        }
        return s;
      })
      .filter(Boolean)
      .join(", ");
    
    console.log(`🔧 Talle string generado: "${sizesStr}"`);
    
    if (sizesInput) {
      sizesInput.value = sizesStr;
    }
    
    // Renderizar los talles con sus valores de stock
    sizesList.innerHTML = "";
    prefill.sizes.forEach((sizeData, index) => {
      // Manejar tanto objetos {size, stock_qty} como strings simples
      let size, stock_qty;
      
      if (typeof sizeData === 'object' && sizeData !== null) {
        size = sizeData.size || sizeData;
        stock_qty = sizeData.stock_qty ?? 0;
      } else {
        size = sizeData;
        stock_qty = 0;
      }
      
      size = String(size || "").trim();
      
      if (!size) {
        console.warn(`⚠️ Talle inválido en índice ${index}:`, sizeData);
        return;
      }
      
      console.log(`🔧 Creando input para talle ${index + 1}: ${size} con stock ${stock_qty}`);
      
      if (size) {
        const box = document.createElement("div");
        box.style =
          "display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;border:1px solid #ddd;border-radius:4px;min-width:50px;position:relative;";
        box.innerHTML = `
          <button type="button" class="remove-size-btn" style="position:absolute;top:-4px;right:-4px;width:18px;height:18px;padding:0;border:1px solid #ccc;border-radius:50%;background:#fff;color:#c33;cursor:pointer;font-size:10px;line-height:1;display:flex;align-items:center;justify-content:center;z-index:1;" title="Eliminar talle">✕</button>
          <strong style="font-size:11px">${size}</strong>
          <input type="number" class="size-stock" data-size="${size}" min="0" value="${stock_qty || '0'}" style="width:50px;padding:3px;font-size:11px" placeholder="0" autocomplete="off"/>
        `;
        
        // Agregar handler para eliminar talle
        const removeBtn = box.querySelector(".remove-size-btn");
        if (removeBtn) {
          removeBtn.addEventListener("click", () => {
            box.remove();
            // Actualizar el input de talles
            const currentSizes = Array.from(sizesList.querySelectorAll(".size-stock"))
              .map(inp => inp.dataset.size)
              .filter(Boolean);
            if (sizesInput) {
              sizesInput.value = currentSizes.join(", ");
            }
          });
        }
        
        sizesList.appendChild(box);
      }
    });
    console.log("🔧 Talles cargados desde prefill:", prefill.sizes);
  }

  variantsTable.appendChild(tr);
  applyCostVisibilityToRow(tr);
  return tr; // Retornar la fila para poder llamar loadVariantImages después
}

addVariantBtn.addEventListener("click", () => {
  console.log("🚀 Botón Agregar variante presionado");
  addVariantRow();
});

// Función para asegurar que siempre haya al menos una variante
function ensureDefaultVariant() {
  const existingRows = variantsTable.querySelectorAll("tr");
  console.log("🔍 Verificando variantes existentes:", existingRows.length);
  if (existingRows.length === 0) {
    console.log("📝 Agregando variante por defecto");
    addVariantRow();
  } else {
    console.log("✅ Ya hay variantes existentes");
  }
}

// Función para recalcular todos los precios recomendados
function recalculateAllRecommendedPrices() {
  const percentage = parseFloat(document.getElementById("price-percentage")?.value || "30");
  const logisticAmount = document.getElementById("logistic-amount")?.value || "500";
  
  const rows = variantsTable.querySelectorAll("tr");
  rows.forEach((row) => {
    const costEl = row.querySelector(".v-cost");
    const priceEl = row.querySelector(".v-price");
    
    if (costEl && priceEl) {
      const cost = parseARS(costEl.value || "0");
      if (cost > 0) {
        const recommended = calculateRecommendedPrice(cost, percentage, logisticAmount);
        // Solo actualizar si el precio fue calculado automáticamente
        if (priceEl.dataset.autoCalculated === "true") {
          priceEl.value = formatARS(recommended);
        }
      }
    }
  });
}

// Declarar editSupplierBtn y supplierSelect antes de loadSuppliers
// (necesarios para updateEditButtonVisibility que se llama dentro de loadSuppliers)
const editSupplierBtn = document.getElementById("edit-supplier-btn");
const supplierSelect = document.getElementById("supplier");

// arranque con una fila
await initRoleBasedCostVisibility();
await loadColors();
await loadTags();
await loadSuppliers();

// Event listeners para campos globales de cálculo de precio
const pricePercentageEl = document.getElementById("price-percentage");
const logisticAmountEl = document.getElementById("logistic-amount");

if (pricePercentageEl) {
  pricePercentageEl.addEventListener("input", () => {
    recalculateAllRecommendedPrices();
    // Guardar el porcentaje para la categoría actual
    const categoryEl = document.getElementById("category");
    const category = categoryEl?.value || "Calzado";
    const percentage = parseFloat(pricePercentageEl.value) || 0;
    if (percentage > 0) {
      savePercentage(category, percentage);
    }
  });
  pricePercentageEl.addEventListener("change", () => {
    recalculateAllRecommendedPrices();
    // Guardar el porcentaje para la categoría actual
    const categoryEl = document.getElementById("category");
    const category = categoryEl?.value || "Calzado";
    const percentage = parseFloat(pricePercentageEl.value) || 0;
    if (percentage > 0) {
      savePercentage(category, percentage);
    }
  });
}

if (logisticAmountEl) {
  // Aplicar formateador de precio al monto logístico
  attachPriceFormatter(logisticAmountEl);
  logisticAmountEl.addEventListener("input", recalculateAllRecommendedPrices);
  logisticAmountEl.addEventListener("blur", recalculateAllRecommendedPrices);
}

// Función para actualizar código de proveedor existente
async function updateSupplierCode(supplierId, newCode) {
  if (!supplierId || !newCode) {
    alert("El código del proveedor es obligatorio");
    return null;
  }
  
  const code = (newCode || "").trim().toUpperCase();
  if (!code) {
    alert("El código del proveedor no puede estar vacío");
    return null;
  }
  
  try {
    // Verificar que el código no exista en otro proveedor
    const { data: existing } = await supabase
      .from("suppliers")
      .select("id, code")
      .eq("code", code)
      .neq("id", supplierId)
      .maybeSingle();
    
    if (existing) {
      alert("Ya existe otro proveedor con ese código. Por favor, usa un código diferente.");
      return null;
    }
    
    // Actualizar el código del proveedor
    const { data, error } = await supabase
      .from("suppliers")
      .update({ code: code })
      .eq("id", supplierId)
      .select("id, name, code")
      .single();
    
    if (error) {
      console.error("Error actualizando proveedor:", error);
      if (error.code === "23505") { // Violación de unicidad
        alert("Ya existe un proveedor con ese código. Por favor, ingresa un código diferente.");
      } else {
        alert(`Error al actualizar proveedor: ${error.message}`);
      }
      return null;
    }
    
    // Actualizar cache
    if (data && data.id && data.code) {
      SUPPLIERS_CACHE.set(data.id, data.code);
    }
    
    // Recargar lista de proveedores
    await loadSuppliers();
    
    // Recalcular SKU bases con el nuevo código
    await recalculateAllSkuBases();
    
    return data;
  } catch (e) {
    console.error("Error actualizando proveedor:", e);
    alert(`Error al actualizar proveedor: ${e.message}`);
    return null;
  }
}

// Event listeners para crear nuevo proveedor
const newSupplierBtn = document.getElementById("new-supplier-btn");
const newSupplierForm = document.getElementById("new-supplier-form");
const createSupplierBtn = document.getElementById("create-supplier-btn");
const cancelSupplierBtn = document.getElementById("cancel-supplier-btn");
const newSupplierName = document.getElementById("new-supplier-name");
const newSupplierCode = document.getElementById("new-supplier-code");

// Elementos para editar proveedor
// editSupplierBtn y supplierSelect ya están declarados arriba (antes de loadSuppliers)
const editSupplierForm = document.getElementById("edit-supplier-form");
const editSupplierCodeInput = document.getElementById("edit-supplier-code");
const saveSupplierCodeBtn = document.getElementById("save-supplier-code-btn");
const cancelEditSupplierBtn = document.getElementById("cancel-edit-supplier-btn");

// Mostrar/ocultar botón de editar según si hay proveedor seleccionado
function updateEditButtonVisibility() {
  if (editSupplierBtn && supplierSelect) {
    const hasSupplier = supplierSelect.value && supplierSelect.value !== "";
    editSupplierBtn.style.display = hasSupplier ? "block" : "none";
  }
}

// Inicializar visibilidad del botón de editar
updateEditButtonVisibility();

// Event listener para mostrar/ocultar botón de editar cuando cambia la selección
if (supplierSelect) {
  supplierSelect.addEventListener("change", () => {
    updateEditButtonVisibility();
    // Ocultar formulario de edición si se cambia el proveedor
    if (editSupplierForm) {
      editSupplierForm.style.display = "none";
    }
  });
}

// Event listener para botón de editar
if (editSupplierBtn) {
  editSupplierBtn.addEventListener("click", async () => {
    const supplierId = supplierSelect?.value;
    if (!supplierId) return;
    
    // Obtener código actual del proveedor
    const currentCode = SUPPLIERS_CACHE.get(supplierId);
    
    if (editSupplierCodeInput) {
      editSupplierCodeInput.value = currentCode || "";
    }
    
    // Mostrar formulario de edición
    if (editSupplierForm) {
      editSupplierForm.style.display = editSupplierForm.style.display === "none" ? "block" : "none";
      if (editSupplierForm.style.display === "block" && editSupplierCodeInput) {
        editSupplierCodeInput.focus();
        editSupplierCodeInput.select();
      }
    }
    
    // Ocultar formulario de nuevo proveedor si está abierto
    if (newSupplierForm) {
      newSupplierForm.style.display = "none";
    }
  });
}

// Event listener para guardar código del proveedor
if (saveSupplierCodeBtn) {
  saveSupplierCodeBtn.addEventListener("click", async () => {
    const supplierId = supplierSelect?.value;
    if (!supplierId) {
      alert("No hay proveedor seleccionado");
      return;
    }
    
    const newCode = editSupplierCodeInput?.value?.trim();
    if (!newCode) {
      alert("El código no puede estar vacío");
      return;
    }
    
    const updated = await updateSupplierCode(supplierId, newCode);
    if (updated) {
      statusEl.textContent = `Código del proveedor actualizado a "${updated.code}"`;
      statusEl.style.color = "#090";
      
      // Ocultar formulario de edición
      if (editSupplierForm) {
        editSupplierForm.style.display = "none";
      }
    }
  });
}

// Event listener para cancelar edición
if (cancelEditSupplierBtn) {
  cancelEditSupplierBtn.addEventListener("click", () => {
    if (editSupplierForm) editSupplierForm.style.display = "none";
    if (editSupplierCodeInput) editSupplierCodeInput.value = "";
  });
}

// Permitir guardar con Enter en el campo de código
if (editSupplierCodeInput) {
  editSupplierCodeInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (saveSupplierCodeBtn) saveSupplierCodeBtn.click();
    }
  });
}

if (newSupplierBtn) {
  newSupplierBtn.addEventListener("click", () => {
    if (newSupplierForm) {
      newSupplierForm.style.display = newSupplierForm.style.display === "none" ? "block" : "none";
      if (newSupplierForm.style.display === "block" && newSupplierName) {
        newSupplierName.focus();
      }
    }
    // Ocultar formulario de edición si está abierto
    if (editSupplierForm) {
      editSupplierForm.style.display = "none";
    }
  });
}

if (createSupplierBtn) {
  createSupplierBtn.addEventListener("click", async () => {
    const supplier = await createNewSupplier();
    if (supplier) {
      statusEl.textContent = `Proveedor "${supplier.name}" creado y seleccionado`;
      statusEl.style.color = "#090";
    }
  });
}

if (cancelSupplierBtn) {
  cancelSupplierBtn.addEventListener("click", () => {
    if (newSupplierForm) newSupplierForm.style.display = "none";
    if (newSupplierName) newSupplierName.value = "";
    if (newSupplierCode) newSupplierCode.value = "";
  });
}

// Permitir crear proveedor presionando Enter
if (newSupplierName) {
  newSupplierName.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (createSupplierBtn) createSupplierBtn.click();
    }
  });
}

if (newSupplierCode) {
  newSupplierCode.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (createSupplierBtn) createSupplierBtn.click();
    }
  });
}

// Función para recalcular todos los SKU bases cuando cambia el proveedor
async function recalculateAllSkuBases() {
  const supplierEl = document.getElementById("supplier");
  const supplierId = supplierEl?.value || "";
  const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
  
  const rows = variantsTable.querySelectorAll("tr");
  rows.forEach((row) => {
    const color = row.querySelector(".v-color")?.value || "";
    const skuBaseEl = row.querySelector(".v-skuBase");
    const handle = handleEl?.value || "";
    
    // Solo actualizar SKU bases que no fueron editados manualmente
    if (skuBaseEl && !skuBaseEl.dataset.dirty) {
      skuBaseEl.value = makeSkuBase(handle, color, supplierCode);
    }
  });
}

// Event listener para recalcular SKU bases cuando cambia el proveedor
const supplierEl = document.getElementById("supplier");
if (supplierEl) {
  supplierEl.addEventListener("change", recalculateAllSkuBases);
}

// rellenar datalist
const datalist = document.getElementById("colors-datalist");
if (datalist && COLORS.length) {
  datalist.innerHTML = COLORS.map(
    (c) => `<option value="${c.name}">${c.code || ""}</option>`
  ).join("");
}

// Asegurar que siempre haya al menos una variante
console.log("🔧 Llamando ensureDefaultVariant()");
ensureDefaultVariant();
console.log("🔧 Después de ensureDefaultVariant()");

// ----- TAGS JERÁRQUICOS UI -----
const tag1Select = document.getElementById("tag1-select");
const tag1New = document.getElementById("tag1-new");
const tag1Create = document.getElementById("tag1-create");
const tag2Select = document.getElementById("tag2-select");
const tag2New = document.getElementById("tag2-new");
const tag2Create = document.getElementById("tag2-create");
const tag3Select = document.getElementById("tag3-select");
const tag3New = document.getElementById("tag3-new");
const tag3Create = document.getElementById("tag3-create");
const tag3Chips = document.getElementById("tag3-chips");

let selectedTag1Id = null;
let selectedTag2Id = null;
let selectedTag3Ids = [];

// Variables para Details y Highlights
let selectedDetailsIds = []; // Array de uuid de tags3 seleccionados como details
let selectedHighlightsIds = []; // Array de uuid de tags3 seleccionados como highlights (máx 2)
let availableTags3Cache = []; // Cache de tags3 disponibles según contexto actual

// Obtener categoría del producto
function getProductCategory() {
  const category = document.getElementById("category").value;
  // Mapear categorías a grupos de tags
  if (category === "Calzado") return "Calzado";
  if (category === "Ropa") return "Ropa";
  if (category === "Lenceria" || category === "Marroquineria") return "Otros";
  return category || "Calzado"; // default
}

// Cargar tags1 por categoría
async function loadTags1(category) {
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

// Cargar tags2 por parent (tag1)
async function loadTags2(tag1Id) {
  if (!tag1Id) return [];
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("parent_id", tag1Id)
    .eq("level", 2)
    .order("name");
  return error ? [] : (data || []);
}

// Cargar tags3 de todos los tags2 que pertenecen al tags1 seleccionado
async function loadTags3(tag1Id) {
  if (!tag1Id) return [];
  // Primero obtener todos los tags2 del tags1
  const { data: tags2, error: err2 } = await supabase
    .from("tags")
    .select("id")
    .eq("parent_id", tag1Id)
    .eq("level", 2);
  if (err2 || !tags2 || tags2.length === 0) return [];
  const tag2Ids = tags2.map(t => t.id);
  // Luego obtener todos los tags3 de esos tags2
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .in("parent_id", tag2Ids)
    .eq("level", 3)
    .order("name");
  return error ? [] : (data || []);
}

// Normalizar nombre para comparación (case-insensitive, sin espacios extra)
function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

// Verificar si existe un tag duplicado
async function checkDuplicateTag(name, level, category, parentId) {
  const normalizedName = normalizeName(name);
  
  // Construir query según el nivel
  let query = supabase
    .from("tags")
    .select("id, name")
    .eq("level", level)
    .eq("category", category);
  
  // Para nivel 1, parent_id debe ser null
  if (level === 1) {
    query = query.is("parent_id", null);
  } else if (level === 2 && parentId) {
    // Para nivel 2, debe tener el mismo parent_id
    query = query.eq("parent_id", parentId);
  } else if (level === 3) {
    // Para Tags3, ignorar parent_id - solo verificar name + category + level
    // No agregamos filtro de parent_id para Tags3
  } else if (parentId) {
    // Para otros niveles, mantener comportamiento original
    query = query.eq("parent_id", parentId);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.error("Error verificando duplicados:", error);
    return null;
  }
  
  // Verificar duplicados case-insensitive
  const duplicate = (data || []).find(tag => normalizeName(tag.name) === normalizedName);
  return duplicate || null;
}

// Crear nuevo tag (con validación de duplicados)
async function createTag(name, level, category, parentId) {
  if (!name || !name.trim()) {
    alert("El nombre del tag no puede estar vacío");
    return null;
  }
  
  // Verificar duplicados
  const duplicate = await checkDuplicateTag(name, level, category, parentId);
  if (duplicate) {
    alert(`Ya existe un tag "${duplicate.name}" con el mismo nombre en este nivel y categoría. No se permiten duplicados.`);
    return null;
  }
  
  const { data, error } = await supabase
    .from("tags")
    .insert([{ name: name.trim(), level, category, parent_id: parentId }])
    .select("id, name")
    .single();
    
  if (error) {
    console.error("Error creando tag:", error);
    if (error.code === "23505") { // Unique violation
      alert("Ya existe un tag con ese nombre. No se permiten duplicados.");
    } else {
      alert(`Error al crear el tag: ${error.message}`);
    }
    return null;
  }
  
  return data;
}

// Eliminar tag (con validación de uso)
async function deleteTag(tagId, tagName) {
  if (!tagId) return false;
  
  // Confirmar eliminación
  if (!confirm(`¿Estás seguro de eliminar el tag "${tagName}"?\n\nEsta acción no se puede deshacer.`)) {
    return false;
  }
  
  // Verificar si el tag tiene hijos (tags2 o tags3)
  const { data: children, error: childrenError } = await supabase
    .from("tags")
    .select("id, name, level")
    .eq("parent_id", tagId);
  
  if (childrenError) {
    console.error("Error verificando hijos:", childrenError);
    alert("Error al verificar si el tag tiene hijos");
    return false;
  }
  
  if (children && children.length > 0) {
    const childrenList = children.map(c => `${c.name} (nivel ${c.level})`).join(", ");
    alert(`No se puede eliminar el tag "${tagName}" porque tiene tags hijos:\n${childrenList}\n\nEliminá primero los tags hijos.`);
    return false;
  }
  
  // Verificar si el tag está en uso en productos (product_tags)
  const { data: productTags, error: productTagsError } = await supabase
    .from("product_tags")
    .select("product_id")
    .or(`tag1_id.eq.${tagId},tag2_id.eq.${tagId},tag3_ids.cs.{${tagId}}`);
  
  if (productTagsError) {
    console.error("Error verificando uso en productos:", productTagsError);
    alert("Error al verificar si el tag está en uso");
    return false;
  }
  
  // Verificar si el tag está en uso como detail (product_tag_details) - solo para Tags3
  let productDetails = [];
  if (tagId) {
    const { data: detailsData, error: detailsError } = await supabase
      .from("product_tag_details")
      .select("product_id")
      .eq("tag3_id", tagId);
    
    if (detailsError) {
      console.error("Error verificando uso en details:", detailsError);
      // No bloquear si hay error, solo loguear
    } else {
      productDetails = detailsData || [];
    }
  }
  
  const totalUsage = (productTags?.length || 0) + productDetails.length;
  if (totalUsage > 0) {
    const usageDetails = [];
    if (productTags && productTags.length > 0) {
      usageDetails.push(`${productTags.length} como tag jerárquico`);
    }
    if (productDetails.length > 0) {
      usageDetails.push(`${productDetails.length} como detalle`);
    }
    alert(`No se puede eliminar el tag "${tagName}" porque está siendo usado en ${totalUsage} producto(s) (${usageDetails.join(", ")}).\n\nPrimero eliminá el tag de los productos que lo usan.`);
    return false;
  }
  
  // Eliminar el tag
  const { error: deleteError } = await supabase
    .from("tags")
    .delete()
    .eq("id", tagId);
  
  if (deleteError) {
    console.error("Error eliminando tag:", deleteError);
    alert(`Error al eliminar el tag: ${deleteError.message}`);
    return false;
  }
  
  return true;
}

// Renderizar tags1
async function renderTags1() {
  const category = getProductCategory();
  const tags1 = await loadTags1(category);
  
  // Deduplicar por nombre (case-insensitive) - mantener el primero encontrado
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
  
  // Agregar opción para eliminar (si hay tags)
  if (uniqueTags.length > 0) {
    const hr = document.createElement("option");
    hr.disabled = true;
    hr.textContent = "──────────";
    tag1Select.appendChild(hr);
    
    uniqueTags.forEach(tag => {
      const opt = document.createElement("option");
      opt.value = `DELETE:${tag.id}`;
      opt.textContent = `🗑️ Eliminar: ${tag.name}`;
      opt.dataset.tagName = tag.name;
      tag1Select.appendChild(opt);
    });
  }
  
  if (selectedTag1Id) {
    tag1Select.value = selectedTag1Id;
  }
}

// Renderizar tags2
async function renderTags2() {
  if (!selectedTag1Id) {
    tag2Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag2Select.disabled = true;
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
    return;
  }
  const tags2 = await loadTags2(selectedTag1Id);
  tag2Select.innerHTML = '<option value="">-- Seleccionar Tags2 --</option>';
  tags2.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    tag2Select.appendChild(opt);
  });
  
  // Agregar opción para eliminar (si hay tags)
  if (tags2.length > 0) {
    const hr = document.createElement("option");
    hr.disabled = true;
    hr.textContent = "──────────";
    tag2Select.appendChild(hr);
    
    tags2.forEach(tag => {
      const opt = document.createElement("option");
      opt.value = `DELETE:${tag.id}`;
      opt.textContent = `🗑️ Eliminar: ${tag.name}`;
      opt.dataset.tagName = tag.name;
      tag2Select.appendChild(opt);
    });
  }
  
  tag2Select.disabled = false;
  if (selectedTag2Id) {
    tag2Select.value = selectedTag2Id;
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
  } else {
    // Mostrar inputs de creación si no hay tags2 seleccionado
    tag2New.style.display = "block";
    tag2Create.style.display = "block";
  }
}

// Renderizar tags3 (de todos los tags2 del tags1 seleccionado)
async function renderTags3() {
  if (!selectedTag1Id) {
    tag3Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag3Select.disabled = true;
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
    renderTag3Chips();
    return;
  }
  // Cargar todos los tags3 de todos los tags2 del tags1
  const tags3 = await loadTags3(selectedTag1Id);
  tag3Select.innerHTML = "";
  tags3.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    opt.selected = selectedTag3Ids.includes(tag.id);
    tag3Select.appendChild(opt);
  });
  
  // Agregar opción para eliminar (si hay tags)
  if (tags3.length > 0) {
    const hr = document.createElement("option");
    hr.disabled = true;
    hr.textContent = "──────────";
    tag3Select.appendChild(hr);
    
    tags3.forEach(tag => {
      const opt = document.createElement("option");
      opt.value = `DELETE:${tag.id}`;
      opt.textContent = `🗑️ Eliminar: ${tag.name}`;
      opt.dataset.tagName = tag.name;
      tag3Select.appendChild(opt);
    });
  }
  
  tag3Select.disabled = false;
  // Mostrar inputs de creación si hay tags2 seleccionado y menos de 2 tags3
  if (selectedTag2Id && selectedTag3Ids.length < 2) {
    tag3New.style.display = "block";
    tag3Create.style.display = "block";
  } else {
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
  }
  renderTag3Chips();
}

// Renderizar chips de tags3 seleccionados
function renderTag3Chips() {
  if (!selectedTag1Id || selectedTag3Ids.length === 0) {
    tag3Chips.innerHTML = "";
    return;
  }
  // Cargar nombres de los tags3 seleccionados
  Promise.all(selectedTag3Ids.map(id => 
    supabase.from("tags").select("name").eq("id", id).single()
  )).then(results => {
    tag3Chips.innerHTML = "";
    results.forEach((result, idx) => {
      if (result.data) {
        const chip = document.createElement("span");
        chip.textContent = result.data.name;
        chip.style = "background:#eee;border:1px solid #ddd;border-radius:16px;padding:4px 8px;display:inline-flex;gap:6px;align-items:center;";
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "✕";
        x.style = "border:none;background:transparent;cursor:pointer;color:#666;";
        x.addEventListener("click", () => {
          selectedTag3Ids = selectedTag3Ids.filter(id => id !== selectedTag3Ids[idx]);
          renderTags3();
        });
        chip.appendChild(x);
        tag3Chips.appendChild(chip);
      }
    });
  });
}

// ========== FUNCIONES DE DETAILS Y HIGHLIGHTS ==========

// Cargar details actuales del producto
async function loadProductDetails(productId) {
  if (!productId) {
    selectedDetailsIds = [];
    return;
  }
  
  try {
    const { data, error } = await supabase
      .from("product_tag_details")
      .select("tag3_id")
      .eq("product_id", productId);
    
    if (error) {
      console.warn("Error cargando details:", error);
      selectedDetailsIds = [];
      return;
    }
    
    selectedDetailsIds = (data || []).map(d => d.tag3_id);
  } catch (e) {
    console.warn("Error cargando details:", e);
    selectedDetailsIds = [];
  }
}

// Cargar highlights actuales del producto
async function loadProductHighlights(productId) {
  if (!productId) {
    selectedHighlightsIds = [];
    return;
  }
  
  try {
    const { data: pt, error: ptError } = await supabase
      .from("product_tags")
      .select("tag3_ids")
      .eq("product_id", productId)
      .maybeSingle();
    
    // Ignorar error 406 (Not Acceptable) que puede ocurrir cuando no hay resultados
    if (ptError && ptError.code !== "PGRST116") {
      console.warn("Error cargando highlights:", ptError);
    }
    
    selectedHighlightsIds = pt?.tag3_ids || [];
  } catch (e) {
    console.warn("Error cargando highlights:", e);
    selectedHighlightsIds = [];
  }
}

// Cargar Tags3 disponibles según contexto (tag2_id o tag1_id)
async function loadAvailableTags3() {
  // Obtener la categoría del producto actual
  const category = getProductCategory();
  
  // Cargar Tags3 filtrados por categoría
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("level", 3)
    .eq("category", category)
    .order("name");
  
  availableTags3Cache = error ? [] : (data || []);
  return availableTags3Cache;
}

// Validar selections (ya no filtramos por Tags1/Tags2, todos los Tags3 están disponibles)
// Solo validamos que los highlights estén en la lista de details
async function filterInvalidSelections() {
  // No necesitamos filtrar nada, todos los Tags3 están disponibles
  // Solo validamos que los highlights estén en details (esto se hace en saveDetailsAndHighlights)
}

// Renderizar lista de details con checkboxes y botón ⭐
async function renderDetailsList() {
  const container = document.getElementById("details-list");
  const searchInput = document.getElementById("details-search");
  const searchTerm = (searchInput?.value || "").toLowerCase().trim();
  
  if (!container) return;
  
  // Recargar disponibles si cambió el contexto
  await loadAvailableTags3();
  
  // Validar selections (todos los Tags3 están disponibles ahora)
  await filterInvalidSelections();
  
  // Todos los Tags3 están disponibles ahora, no hay necesidad de separar por contexto
  const availableIds = new Set(availableTags3Cache.map(t => t.id));
  
  if (availableTags3Cache.length === 0) {
    container.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;padding:8px;">
        No hay detalles (Tags3) disponibles en el sistema.
      </div>
    `;
    return;
  }
  
  // Filtrar disponibles por búsqueda
  const filtered = availableTags3Cache.filter(tag => 
    tag.name.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;padding:8px;">
        No se encontraron detalles con "${searchTerm}"
      </div>
    `;
    return;
  }
  
  let html = "";
  
  html += filtered.map(tag => {
    const isDetailChecked = selectedDetailsIds.includes(tag.id);
    const isHighlight = selectedHighlightsIds.includes(tag.id);
    const canHighlight = isDetailChecked && selectedHighlightsIds.length < 2;
    const highlightDisabled = !isDetailChecked || (!isHighlight && selectedHighlightsIds.length >= 2);
    
    return `
      <div class="detail-row" 
           data-tag3-id="${tag.id}"
           style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:4px;transition:background 0.2s;"
           onmouseover="this.style.background='#f0f0f0'" 
           onmouseout="this.style.background='transparent'">
        <input 
          type="checkbox" 
          class="toggle-detail"
          data-tag3-id="${tag.id}"
          ${isDetailChecked ? "checked" : ""}
          style="cursor:pointer;"
        />
        <span style="flex:1;font-size:12px;">${tag.name}</span>
        <button 
          type="button"
          class="toggle-highlight"
          data-tag3-id="${tag.id}"
          ${highlightDisabled ? "disabled" : ""}
          style="background:none;border:1px solid ${highlightDisabled ? '#ccc' : '#3a6df0'};color:${highlightDisabled ? '#999' : isHighlight ? '#fff' : '#3a6df0'};cursor:${highlightDisabled ? 'not-allowed' : 'pointer'};padding:4px 8px;border-radius:4px;font-size:11px;display:flex;align-items:center;gap:4px;background:${isHighlight ? '#3a6df0' : 'transparent'};"
          title="${highlightDisabled ? (isDetailChecked ? 'Máximo 2 destacados' : 'Selecciona el detalle primero') : (isHighlight ? 'Quitar destacado' : 'Destacar')}">
          ${isHighlight ? '⭐ Destacado' : '⭐'}
        </button>
      </div>
    `;
  }).join("");
  
  container.innerHTML = html;
  
  // Re-renderizar highlights después de actualizar details
  renderHighlights();
}

// Renderizar highlights como chips (una sola query)
async function renderHighlights() {
  const container = document.getElementById("highlights-container");
  if (!container) return;
  
  if (selectedHighlightsIds.length === 0) {
    container.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;width:100%;padding:4px;">
        Selecciona hasta 2 detalles de los seleccionados arriba
      </div>
    `;
    return;
  }
  
  // Una sola query para todos los highlights
  const { data: highlightsData, error } = await supabase
    .from("tags")
    .select("id, name")
    .in("id", selectedHighlightsIds);
  
  if (error) {
    console.warn("Error cargando nombres de highlights:", error);
    container.innerHTML = `
      <div style="color:#c00;font-size:11px;text-align:center;width:100%;padding:4px;">
        Error cargando destacados
      </div>
    `;
    return;
  }
  
  // Crear mapa id -> name
  const highlightsMap = new Map((highlightsData || []).map(t => [t.id, t.name]));
  
  container.innerHTML = selectedHighlightsIds
    .map(id => {
      const name = highlightsMap.get(id) || `ID: ${id.substring(0, 8)}...`;
      return `
        <div class="highlight-chip" 
             style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px;background:#3a6df0;color:#fff;border-radius:16px;font-size:11px;">
          <span>⭐ ${name}</span>
          <button type="button" 
                  class="remove-highlight"
                  data-tag3-id="${id}"
                  style="background:none;border:none;color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center;"
                  title="Quitar destacado">
            ×
          </button>
        </div>
      `;
    }).join("");
}

// Handler para toggle de detail (checkbox)
function handleDetailToggle(tag3Id, isChecked) {
  if (isChecked) {
    if (!selectedDetailsIds.includes(tag3Id)) {
      selectedDetailsIds.push(tag3Id);
    }
  } else {
    selectedDetailsIds = selectedDetailsIds.filter(id => id !== tag3Id);
    // Si estaba en highlights, quitarlo también
    if (selectedHighlightsIds.includes(tag3Id)) {
      selectedHighlightsIds = selectedHighlightsIds.filter(id => id !== tag3Id);
    }
  }
  renderDetailsList(); // Re-render para actualizar botones ⭐
}

// Handler para toggle de highlight (botón ⭐)
function handleHighlightToggle(tag3Id) {
  const isCurrentlyHighlight = selectedHighlightsIds.includes(tag3Id);
  
  if (isCurrentlyHighlight) {
    // Remover highlight
    selectedHighlightsIds = selectedHighlightsIds.filter(id => id !== tag3Id);
  } else {
    // Agregar highlight (validar máx 2)
    if (selectedHighlightsIds.length >= 2) {
      alert("Solo puedes destacar máximo 2 detalles");
      return;
    }
    
    if (!selectedDetailsIds.includes(tag3Id)) {
      alert("Primero debes seleccionar este detalle");
      return;
    }
    
    selectedHighlightsIds.push(tag3Id);
  }
  
  renderDetailsList(); // Re-render para actualizar botones ⭐
  renderHighlights(); // Re-render highlights
}

// Guardar details y highlights
async function saveDetailsAndHighlights(productId) {
  const statusEl = document.getElementById("details-highlights-status");
  
  if (!productId) {
    statusEl.textContent = "Error: No hay producto cargado";
    statusEl.style.color = "#c00";
    return;
  }
  
  // Validar highlights (máx 2)
  if (selectedHighlightsIds.length > 2) {
    statusEl.textContent = "Error: Máximo 2 highlights permitidos";
    statusEl.style.color = "#c00";
    return;
  }
  
  // Validar que highlights estén en details
  const invalidHighlights = selectedHighlightsIds.filter(id => !selectedDetailsIds.includes(id));
  if (invalidHighlights.length > 0) {
    statusEl.textContent = "Error: Los highlights deben estar en la lista de details";
    statusEl.style.color = "#c00";
    return;
  }
  
  statusEl.textContent = "Guardando...";
  statusEl.style.color = "inherit";
  
  try {
    // 1. Guardar Details (sincronización exacta)
    const { data: currentDetails, error: detailsError } = await supabase
      .from("product_tag_details")
      .select("tag3_id")
      .eq("product_id", productId);
    
    if (detailsError) {
      throw new Error(`Error cargando details: ${detailsError.message}`);
    }
    
    const currentIds = new Set((currentDetails || []).map(d => d.tag3_id));
    const newIds = new Set(selectedDetailsIds);
    
    // Insertar nuevos
    const toInsert = selectedDetailsIds.filter(id => !currentIds.has(id));
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase
        .from("product_tag_details")
        .insert(toInsert.map(tag3_id => ({ product_id: productId, tag3_id })));
      
      if (insertError) {
        throw new Error(`Error insertando details: ${insertError.message}`);
      }
    }
    
    // Eliminar removidos
    const toDelete = Array.from(currentIds).filter(id => !newIds.has(id));
    if (toDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from("product_tag_details")
        .delete()
        .eq("product_id", productId)
        .in("tag3_id", toDelete);
      
      if (deleteError) {
        throw new Error(`Error eliminando details: ${deleteError.message}`);
      }
    }
    
    // 2. Guardar Highlights
    const { error: highlightsError } = await supabase
      .from("product_tags")
      .update({ 
        tag3_ids: selectedHighlightsIds.length > 0 ? selectedHighlightsIds : null 
      })
      .eq("product_id", productId);
    
    if (highlightsError) {
      throw new Error(`Error guardando highlights: ${highlightsError.message}`);
    }
    
    statusEl.textContent = "✓ Guardado correctamente";
    statusEl.style.color = "#090";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
    
  } catch (error) {
    console.error("Error guardando details/highlights:", error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.style.color = "#c00";
  }
}

// Event listeners
tag1Select?.addEventListener("change", async (e) => {
  const value = e.target.value;
  
  // Manejar eliminación
  if (value && value.startsWith("DELETE:")) {
    const tagId = value.replace("DELETE:", "");
    const tagName = e.target.options[e.target.selectedIndex]?.dataset?.tagName || "este tag";
    const deleted = await deleteTag(tagId, tagName);
    if (deleted) {
      // Si el tag eliminado estaba seleccionado, limpiar selección
      if (selectedTag1Id === tagId) {
        selectedTag1Id = null;
        selectedTag2Id = null;
        selectedTag3Ids = [];
      }
      await renderTags1();
      await renderTags2();
      await renderTags3();
      await renderDetailsList();
    }
    e.target.value = selectedTag1Id || "";
    return;
  }
  
  selectedTag1Id = value || null;
  selectedTag2Id = null;
  selectedTag3Ids = []; // Limpiar tags3 al cambiar tags1
  await renderTags2();
  await renderTags3();
  tag1New.style.display = e.target.value ? "none" : "block";
  tag1Create.style.display = e.target.value ? "none" : "block";
  
  // Actualizar UI de details (NO limpiar selectedDetailsIds - son globales)
  await renderDetailsList();
});

tag1Create?.addEventListener("click", async () => {
  const name = tag1New.value.trim();
  if (!name) return;
  const category = getProductCategory();
  const tag = await createTag(name, 1, category, null);
  if (tag) {
    selectedTag1Id = tag.id;
    tag1New.value = "";
    tag1New.style.display = "none";
    tag1Create.style.display = "none";
    await renderTags1();
  }
});

tag2Select?.addEventListener("change", async (e) => {
  const value = e.target.value;
  
  // Manejar eliminación
  if (value && value.startsWith("DELETE:")) {
    const tagId = value.replace("DELETE:", "");
    const tagName = e.target.options[e.target.selectedIndex]?.dataset?.tagName || "este tag";
    const deleted = await deleteTag(tagId, tagName);
    if (deleted) {
      // Si el tag eliminado estaba seleccionado, limpiar selección
      if (selectedTag2Id === tagId) {
        selectedTag2Id = null;
        // No limpiar tags3, pueden ser de otros tags2
      }
      await renderTags2();
      await renderTags3();
      await renderDetailsList();
    }
    e.target.value = selectedTag2Id || "";
    return;
  }
  
  selectedTag2Id = value || null;
  // No limpiar tags3 al cambiar tags2, ya que pueden compartirse
  await renderTags3();
  // Mostrar/ocultar inputs de tags2
  tag2New.style.display = e.target.value ? "none" : "block";
  tag2Create.style.display = e.target.value ? "none" : "block";
  // Mostrar/ocultar inputs de tags3 según si hay tags2 seleccionado y menos de 2 tags3
  if (selectedTag2Id && selectedTag3Ids.length < 2) {
    tag3New.style.display = "block";
    tag3Create.style.display = "block";
  } else {
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
  }
  
  // Actualizar UI de details (NO limpiar selectedDetailsIds - son globales)
  await renderDetailsList();
});

tag2Create?.addEventListener("click", async () => {
  const name = tag2New.value.trim();
  if (!name || !selectedTag1Id) return;
  const category = getProductCategory();
  const tag = await createTag(name, 2, category, selectedTag1Id);
  if (tag) {
    selectedTag2Id = tag.id;
    tag2New.value = "";
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
    await renderTags2();
  }
});

tag3Select?.addEventListener("change", async (e) => {
  const selected = Array.from(e.target.selectedOptions).map(opt => opt.value).filter(Boolean);
  
  // Verificar si hay alguna opción de eliminación seleccionada
  const deleteOption = selected.find(v => v && v.startsWith("DELETE:"));
  if (deleteOption) {
    const tagId = deleteOption.replace("DELETE:", "");
    const selectedOption = Array.from(e.target.selectedOptions).find(opt => opt.value === deleteOption);
    const tagName = selectedOption?.dataset?.tagName || "este tag";
    const deleted = await deleteTag(tagId, tagName);
    if (deleted) {
      // Si el tag eliminado estaba seleccionado, quitarlo de la selección
      selectedTag3Ids = selectedTag3Ids.filter(id => id !== tagId);
      await renderTags3();
      await renderDetailsList();
    }
    // Restaurar selección anterior
    e.target.value = "";
    selectedTag3Ids.forEach(id => {
      const option = Array.from(e.target.options).find(opt => opt.value === id);
      if (option) option.selected = true;
    });
    return;
  }
  
  if (selected.length > 2) {
    alert("Solo podés seleccionar hasta 2 Tags3");
    e.target.value = selectedTag3Ids[0] || "";
    return;
  }
  selectedTag3Ids = selected;
  renderTag3Chips();
  // Mostrar inputs solo si hay tags2 seleccionado y menos de 2 tags3
  if (selectedTag2Id && selected.length < 2) {
    tag3New.style.display = "block";
    tag3Create.style.display = "block";
  } else {
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
  }
});

tag3Create?.addEventListener("click", async () => {
  const name = tag3New.value.trim();
  if (!name || !selectedTag2Id || selectedTag3Ids.length >= 2) return;
  const category = getProductCategory();
  const tag = await createTag(name, 3, category, selectedTag2Id);
  if (tag) {
    selectedTag3Ids.push(tag.id);
    tag3New.value = "";
    tag3New.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
    tag3Create.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
    await renderTags3();
  }
});

// Función para aplicar/remover prefijo "R " según la categoría
async function updateNamePrefix() {
  const categoryEl = document.getElementById("category");
  const nameEl = document.getElementById("name");
  
  if (!categoryEl || !nameEl) return;
  
  const category = categoryEl.value;
  let currentName = nameEl.value.trim();
  
  if (category === "Ropa") {
    // Si el nombre está vacío, autocompletar con el siguiente número progresivo
    if (!currentName) {
      const nextNumber = await getNextRopaNumber();
      nameEl.value = `R${nextNumber}`;
      // Si el handle no fue editado manualmente, actualizarlo
      if (!handleDirty) {
        handleEl.value = slugify(nameEl.value);
      }
    } else {
      // Si es Ropa y el nombre no comienza con "R" seguido de dígitos, agregar R
      if (!/^R\d/.test(currentName)) {
        nameEl.value = "R" + currentName;
        // Si el handle no fue editado manualmente, actualizarlo
        if (!handleDirty) {
          handleEl.value = slugify(nameEl.value);
        }
      }
    }
  } else {
    // Si no es Ropa y el nombre comienza con "R" seguido de dígitos, quitarlo
    if (/^R\d/.test(currentName)) {
      nameEl.value = currentName.replace(/^R\d+/, "").trim();
      // Si el handle no fue editado manualmente, actualizarlo
      if (!handleDirty) {
        handleEl.value = slugify(nameEl.value);
      }
    }
  }
}

// Función para obtener el porcentaje predeterminado según la categoría
function getDefaultPercentageForCategory(category) {
  const defaults = {
    "Calzado": 30,
    "Ropa": 32,
    "Otros": 30
  };
  return defaults[category] || 30;
}

// Funciones para gestionar porcentaje de ganancia por categoría (localStorage)
function getPercentageStorageKey(category) {
  const cat = category || "Calzado";
  return `product_percentage_${cat}`;
}

function getSavedPercentage(category) {
  try {
    const cat = category || "Calzado";
    const storageKey = getPercentageStorageKey(cat);
    const saved = localStorage.getItem(storageKey);
    return saved ? parseFloat(saved) : null;
  } catch (e) {
    console.warn("Error cargando porcentaje guardado:", e);
    return null;
  }
}

function savePercentage(category, percentage) {
  try {
    const cat = category || "Calzado";
    const storageKey = getPercentageStorageKey(cat);
    localStorage.setItem(storageKey, percentage.toString());
    console.log(`✅ Porcentaje ${percentage} guardado para categoría ${cat}`);
  } catch (e) {
    console.error("Error guardando porcentaje:", e);
  }
}

// Función para actualizar el porcentaje según la categoría seleccionada
function updatePercentageByCategory(force = false) {
  const categoryEl = document.getElementById("category");
  const pricePercentageEl = document.getElementById("price-percentage");
  
  if (!categoryEl || !pricePercentageEl) return;
  
  const category = categoryEl.value || "Calzado";
  
  // Primero intentar cargar el porcentaje guardado para esta categoría
  const savedPercentage = getSavedPercentage(category);
  const defaultPercentage = getDefaultPercentageForCategory(category);
  
  // Usar el porcentaje guardado si existe, sino el default
  const percentageToUse = savedPercentage !== null ? savedPercentage : defaultPercentage;
  
  // Si force es true, siempre actualizar (útil para nuevos productos)
  // Si no, solo actualizar si el campo está vacío o tiene un valor por defecto
  const currentValue = parseFloat(pricePercentageEl.value) || 0;
  
  if (force || currentValue === 0 || currentValue === 30 || currentValue === 32) {
    pricePercentageEl.value = percentageToUse;
    // Recalcular precios recomendados si hay costos
    recalculateAllRecommendedPrices();
  } else if (savedPercentage !== null && currentValue !== savedPercentage) {
    // Si hay un porcentaje guardado y el actual es diferente, ofrecer actualizar
    // Pero no forzar, solo si el usuario quiere
  }
}

// Observar cambios en categoría para recargar tags1 y actualizar prefijo del nombre
document.getElementById("category")?.addEventListener("change", async () => {
  selectedTag1Id = null;
  selectedTag2Id = null;
  selectedTag3Ids = [];
  
  // Limpiar selecciones de details y highlights de otra categoría
  const currentCategory = getProductCategory();
  // Recargar Tags3 disponibles para la nueva categoría
  await loadAvailableTags3();
  const availableTag3Ids = new Set(availableTags3Cache.map(t => t.id));
  
  // Filtrar details y highlights para mantener solo los de la categoría actual
  selectedDetailsIds = selectedDetailsIds.filter(id => availableTag3Ids.has(id));
  selectedHighlightsIds = selectedHighlightsIds.filter(id => availableTag3Ids.has(id));
  
  await renderTags1();
  await renderTags2();
  await renderTags3();
  // Recargar lista de details con la nueva categoría
  await renderDetailsList();
  // Actualizar prefijo del nombre según la categoría
  updateNamePrefix();
  
  // Guardar el porcentaje actual antes de cambiar de categoría
  const categoryEl = document.getElementById("category");
  const oldCategory = categoryEl?.dataset?.previousCategory || "Calzado";
  const pricePercentageEl = document.getElementById("price-percentage");
  if (pricePercentageEl && oldCategory) {
    const currentPercentage = parseFloat(pricePercentageEl.value) || 0;
    if (currentPercentage > 0) {
      savePercentage(oldCategory, currentPercentage);
    }
  }
  
  // Actualizar porcentaje según la nueva categoría (cargará el guardado si existe)
  updatePercentageByCategory(true);
  
  // Guardar la categoría actual para la próxima vez
  if (categoryEl) {
    categoryEl.dataset.previousCategory = categoryEl.value || "Calzado";
  }
  
  // Actualizar dropdowns de talles guardados según la nueva categoría
  const category = categoryEl?.value || "Calzado";
  const variantsTable = document.getElementById("variants-table");
  if (variantsTable) {
    variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel, category));
  }
});

// Inicializar porcentaje guardado al cargar la página
const categoryElInit = document.getElementById("category");
if (categoryElInit) {
  categoryElInit.dataset.previousCategory = categoryElInit.value || "Calzado";
  // Cargar porcentaje guardado para la categoría inicial
  updatePercentageByCategory(true);
}

// Inicializar tags1 al cargar
renderTags1();

async function searchProducts() {
  pResults.innerHTML = "";
  const term = (pSearch.value || "").trim();
  if (!term) return;
  const { data, error } = await supabase
    .from("products")
    .select("id, name, handle, category, status")
    .or(`name.ilike.%${term}%,handle.ilike.%${term}%`)
    .neq("status", "archived")
    .limit(50)
    .order("name");
  if (error) {
    statusEl.textContent = `Error de búsqueda: ${error.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  data.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.handle} (${p.category || "-"})`;
    pResults.appendChild(opt);
  });
}

// Autocompletar: sugerencias al tipear en el buscador superior
const suggestProducts = (function () {
  let t;
  return async function () {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = (pSearch.value || "").trim();
      if (!term) {
        if (productsDatalist) productsDatalist.innerHTML = "";
        return;
      }
      const { data, error } = await supabase
        .from("products")
        .select("id, name, handle, category, status")
        .or(`name.ilike.%${term}%,handle.ilike.%${term}%`)
        .neq("status", "archived")
        .limit(20)
        .order("name");
      if (error) return;
      lastProductSuggestions = (data || []).map((p) => ({
        id: p.id,
        name: p.name || "",
        label: productLabel(p),
      }));
      if (productsDatalist) {
        productsDatalist.innerHTML = lastProductSuggestions
          .map((s) => `<option value="${s.name}"></option>`)
          .join("");
      }
    }, 250);
  };
})();

async function tryLoadFromInput() {
  const label = (pSearch.value || "").trim();
  if (!label) return;
  // buscar coincidencia exacta
  let found = lastProductSuggestions.find(
    (s) => s.name.toLowerCase() === label.toLowerCase()
  );
  if (!found) {
    found = lastProductSuggestions.find(
      (s) => s.label.toLowerCase() === label.toLowerCase()
    );
  }
  if (found) {
    await loadProductById(found.id);
    return;
  }
  // si no hay sugerencias, forzar una búsqueda y probar con la primera
  await suggestProducts();
  if (lastProductSuggestions[0])
    await loadProductById(lastProductSuggestions[0].id);
}

pSearch?.addEventListener("input", suggestProducts);
pSearch?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    tryLoadFromInput();
  }
});
pSearchBtn?.addEventListener("click", tryLoadFromInput);

async function loadProductById(id) {
  statusEl.textContent = "Cargando producto...";
  statusEl.style.color = "inherit";
  const { data: prod, error: perr } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .single();
  if (perr) {
    statusEl.textContent = `No se pudo cargar: ${perr.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  const { data: variants, error: verr } = await supabase
    .from("product_variants")
    .select("id, sku, color, price, active")
    .eq("product_id", id)
    .order("sku");
  if (verr) {
    statusEl.textContent = `Error variantes: ${verr.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  const vIds = variants.map((v) => v.id);
  
  // Cargar talles desde variant_sizes SOLO como metadatos (size/sku).
  // El stock editable en products siempre corresponde al depósito "general".
  let variantSizesMap = new Map(); // Map<variant_id, Array<{size, stock_qty, sku}>>
  let generalWarehouseId = null;
  let generalSizeStockMap = new Map(); // key: `${variant_id}::${size}` -> stock_qty
  if (vIds.length > 0) {
    const { data: generalWarehouse } = await supabase
      .from("warehouses")
      .select("id")
      .eq("code", "general")
      .maybeSingle();
    generalWarehouseId = generalWarehouse?.id || null;

    console.log(`🔧 Buscando talles (metadatos) para ${vIds.length} variantes:`, vIds);
    const { data: sizesData, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("variant_id, size, sku, id")
      .in("variant_id", vIds)
      // NO ordenar por size para mantener el orden de inserción (usar id como orden natural)
      .order("id", { ascending: true });
    
    if (sizesError) {
      console.error("❌ Error cargando talles desde variant_sizes:", sizesError);
    } else if (sizesData && sizesData.length > 0) {
      console.log(`✅ Cargando ${sizesData.length} talles (metadatos) desde variant_sizes:`, sizesData);
      sizesData.forEach(row => {
        if (!variantSizesMap.has(row.variant_id)) {
          variantSizesMap.set(row.variant_id, []);
        }
        
        // Si el campo size está vacío pero hay SKU, extraer el talle del SKU
        let size = String(row.size || "").trim();
        if (!size && row.sku) {
          // El SKU tiene formato: SKUBASE-SIZE (ej: "FYL-RTYRTYRT-NEG-36")
          // Extraer el último segmento después del último guión
          const skuParts = row.sku.split("-");
          if (skuParts.length > 0) {
            size = skuParts[skuParts.length - 1].trim();
            console.log(`🔧 Talle extraído del SKU "${row.sku}": ${size}`);
          }
        }
        
        const sizeData = {
          size: size,
          stock_qty: 0,
          sku: row.sku || null,
        };
        
        if (sizeData.size) {
          console.log(`🔧 Agregando talle a variant ${row.variant_id}:`, sizeData);
          variantSizesMap.get(row.variant_id).push(sizeData);
        } else {
          console.warn(`⚠️ Talle inválido (sin size ni SKU válido) para variant ${row.variant_id}:`, row);
        }
      });
      console.log(`✅ Mapa de talles creado con ${variantSizesMap.size} variantes:`, Array.from(variantSizesMap.entries()).map(([id, sizes]) => ({ variant_id: id, count: sizes.length, sizes })));
    } else {
      console.log(`ℹ️ No se encontraron talles en variant_sizes para las variantes (esto es normal si aún no se han definido talles):`, vIds);
    }

    // Cargar stock por talle desde la fuente canónica para products: depósito "general".
    if (generalWarehouseId) {
      const { data: sizeWarehouseRows, error: sizeWarehouseError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, stock_qty")
        .in("variant_id", vIds)
        .eq("warehouse_id", generalWarehouseId);
      if (sizeWarehouseError) {
        console.error("❌ Error cargando stock por talle desde variant_size_warehouse_stock (general):", sizeWarehouseError);
      } else {
        (sizeWarehouseRows || []).forEach((row) => {
          const sizeKey = String(row.size || "").trim();
          if (!sizeKey) return;
          generalSizeStockMap.set(`${row.variant_id}::${sizeKey}`, Number(row.stock_qty) || 0);
        });
      }
    } else {
      console.warn("⚠️ No se encontró warehouse 'general'. Los talles se cargarán con stock 0 en products.");
    }

    // Inyectar stock general sobre los talles (variant_sizes se usa solo como metadato).
    variantSizesMap.forEach((sizes, variantId) => {
      sizes.forEach((s) => {
        s.stock_qty = generalSizeStockMap.get(`${variantId}::${String(s.size || "").trim()}`) || 0;
      });
    });
  } else {
    // No mostrar warning si es un producto nuevo sin variantes aún - esto es normal
    console.log(`ℹ️ Producto sin variantes aún (esto es normal para productos nuevos o sin variantes definidas)`);
  }
  
  // Cargar stock total de la variante en depósito general (compatibilidad)
  let stockMap = new Map();
  if (vIds.length > 0) {
    if (!generalWarehouseId) {
      const { data: warehouse } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", "general")
        .maybeSingle();
      generalWarehouseId = warehouse?.id || null;
    }

    if (generalWarehouseId) {
      const { data: stockData } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, stock_qty")
        .in("variant_id", vIds)
        .eq("warehouse_id", generalWarehouseId);
      
      if (stockData) {
        stockData.forEach(row => {
          stockMap.set(row.variant_id, row.stock_qty || 0);
        });
      }
    }
  }
  
  // Agregar stock_qty a cada variante (para compatibilidad con estructura antigua)
  variants.forEach(v => {
    v.stock_qty = stockMap.get(v.id) || 0;
    // Agregar talles desde variant_sizes si existen
    const sizesForVariant = variantSizesMap.get(v.id) || [];
    v.sizes = sizesForVariant;
    console.log(`🔧 Variante ${v.id} (${v.color}): ${sizesForVariant.length} talles asignados:`, sizesForVariant);
  });
  
  let images = [];
  if (vIds.length) {
    const { data: imgRows } = await supabase
      .from("variant_images")
      .select("id, variant_id, url, secure_url, public_id, position, is_main")
      .in("variant_id", vIds)
      .order("position");
    images = imgRows || [];
  }

  // Cargar tags jerárquicos del producto
  try {
    const { data: pt, error: ptError } = await supabase
      .from("product_tags")
      .select("tag1_id, tag2_id, tag3_ids")
      .eq("product_id", id)
      .maybeSingle();
    
    // Ignorar error 406 (Not Acceptable) que puede ocurrir cuando no hay resultados
    if (ptError && ptError.code !== "PGRST116") {
      console.warn("Error cargando tags:", ptError);
    }
    if (pt) {
      selectedTag1Id = pt.tag1_id || null;
      selectedTag2Id = pt.tag2_id || null;
      selectedTag3Ids = pt.tag3_ids || [];
      await renderTags1();
      await renderTags2();
      await renderTags3();
    } else {
      selectedTag1Id = null;
      selectedTag2Id = null;
      selectedTag3Ids = [];
      await renderTags1();
      await renderTags2();
      await renderTags3();
    }
  } catch (e) {
    console.warn("Error cargando tags:", e);
    selectedTag1Id = null;
    selectedTag2Id = null;
    selectedTag3Ids = [];
    await renderTags1();
    await renderTags2();
    await renderTags3();
  }

  // Cargar details y highlights
  await loadProductDetails(id);
  await loadProductHighlights(id);
  await renderDetailsList();

  // Populate form
  const category = prod.category || "Calzado";
  document.getElementById("category").value = category;
  document.getElementById("handle").value = prod.handle || "";
  // Mostrar nombre en mayúsculas al cargar
  // Cargar nombre y corregir formato si es Ropa (eliminar espacio después de R)
  let productName = (prod.name || "").toUpperCase();
  if (prod.category === "Ropa" && productName.startsWith("R ")) {
    productName = "R" + productName.substring(2);
  }
  document.getElementById("name").value = productName;
  document.getElementById("description").value = prod.description || "";
  const validStatuses = ["active", "draft", "pending_stock", "missing_tags", "archived"];
  const statusToShow = (prod.status && validStatuses.includes(prod.status)) ? prod.status : "active";
  document.getElementById("status").value = statusToShow;
  document.getElementById("supplier").value = prod.supplier_id || "";
  updateEditButtonVisibility();
  
  // Actualizar dropdowns de talles guardados con la categoría del producto
  variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel, category));
  
  // Populate pricing fields
  const pricePercentageEl = document.getElementById("price-percentage");
  const logisticAmountEl = document.getElementById("logistic-amount");
  if (pricePercentageEl) {
    // Prioridad: porcentaje del producto > porcentaje guardado para la categoría > default
    const productPercentage = prod.price_percentage;
    if (productPercentage) {
      pricePercentageEl.value = productPercentage;
    } else {
      // Si no tiene porcentaje en el producto, usar el guardado para la categoría o el default
      const savedPercentage = getSavedPercentage(category);
      const defaultPercentage = getDefaultPercentageForCategory(category);
      pricePercentageEl.value = savedPercentage !== null ? savedPercentage : defaultPercentage;
    }
  }
  if (logisticAmountEl) {
    logisticAmountEl.value = prod.logistic_amount ? formatARS(prod.logistic_amount) : formatARS(500);
  }

  // Variants
  variantsTable.innerHTML = "";
  originalVariantIds = new Set(vIds);
  variants.forEach((v) => {
    // Pasar el costo del producto a cada variante (aunque se guarda en products, se muestra en la tabla)
    // Si tiene talles desde variant_sizes, cargarlos en la UI
    const sizesData = v.sizes || [];
    console.log(`🔧 Cargando variante ${v.id} (${v.color}) con ${sizesData.length} talles:`, sizesData);
    const row = addVariantRow({ ...v, cost: prod.cost ? formatARS(prod.cost) : "", sizes: sizesData });
    
    // Cargar imágenes desde DB después de crear la fila
    if (v.id) {
      loadVariantImages(row, v.id);
    }
  });
  
  // Actualizar dropdowns de talles guardados después de agregar todas las filas
  const currentCategory = document.getElementById("category")?.value || "Calzado";
  variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel, currentCategory));

  // Verificar si los precios cargados coinciden con el cálculo esperado y marcarlos como auto-calculados
  const percentage = prod.price_percentage || 30;
  const logisticAmount = prod.logistic_amount || 500;
  const cost = prod.cost || 0;
  
  if (cost > 0) {
    const expectedPrice = calculateRecommendedPrice(cost, percentage, logisticAmount);
    const rows = variantsTable.querySelectorAll("tr");
    rows.forEach((row) => {
      const priceEl = row.querySelector(".v-price");
      if (priceEl) {
        const currentPrice = parseARS(priceEl.value || "0");
        // Si el precio coincide con el esperado, marcarlo como auto-calculado
        if (currentPrice === expectedPrice && currentPrice > 0) {
          priceEl.dataset.autoCalculated = "true";
        } else {
          priceEl.dataset.autoCalculated = "false";
        }
      }
    });
  }

  // Asegurar que siempre haya al menos una variante
  ensureDefaultVariant();

  currentProductId = prod.id;
  statusEl.textContent = `Producto cargado: ${prod.name}`;
}

pSearchBtn.addEventListener("click", searchProducts);
pLoad.addEventListener("click", () => {
  const id = pResults.value;
  if (id) loadProductById(id);
});
pNew.addEventListener("click", async () => {
  // Guardar porcentaje actual antes de resetear
  const categoryEl = document.getElementById("category");
  const currentCategory = categoryEl?.value || "Calzado";
  if (pricePercentageEl && currentCategory) {
    const currentPercentage = parseFloat(pricePercentageEl.value) || 0;
    if (currentPercentage > 0) {
      savePercentage(currentCategory, currentPercentage);
    }
  }
  
  currentProductId = null;
  originalVariantIds = new Set();
  form.reset();
  
  // Restaurar categoría después de resetear
  if (categoryEl && currentCategory) {
    categoryEl.value = currentCategory;
    // Si la categoría es Ropa, aplicar prefijo al nombre (si está vacío o no tiene "R" seguido de dígitos)
    if (currentCategory === "Ropa") {
      const nameEl = document.getElementById("name");
      if (nameEl) {
        const currentName = nameEl.value.trim();
        // Si está vacío, autocompletar con siguiente número progresivo
        if (!currentName) {
          const nextNumber = await getNextRopaNumber();
          nameEl.value = `R${nextNumber}`;
          if (!handleDirty) {
            handleEl.value = slugify(nameEl.value);
          }
        } else if (!/^R\d/.test(currentName)) {
          // Si no empieza con R seguido de dígitos, agregar R
          nameEl.value = "R" + currentName;
          if (!handleDirty) {
            handleEl.value = slugify(nameEl.value);
          }
        }
      }
    }
  }
  
  variantsTable.innerHTML = "";
  selectedTag1Id = null;
  selectedTag2Id = null;
  selectedTag3Ids = [];
  selectedDetailsIds = [];
  selectedHighlightsIds = [];
  await renderTags1();
  await renderTags2();
  await renderTags3();
  await renderDetailsList();
  // Limpiar proveedor
  document.getElementById("supplier").value = "";
  updateEditButtonVisibility();
  // Inicializar valores por defecto de cálculo de precio
  const pricePercentageEl = document.getElementById("price-percentage");
  const logisticAmountEl = document.getElementById("logistic-amount");
  if (logisticAmountEl) logisticAmountEl.value = formatARS(500);
  // Actualizar porcentaje según la categoría restaurada (forzar actualización para nuevo producto)
  updatePercentageByCategory(true);
  ensureDefaultVariant(); // Usar la función que asegura al menos una variante
  statusEl.textContent = "Nuevo producto";
});

// Función reutilizable para guardar producto (con opción de limpiar o no)
async function saveProduct(shouldReset = true) {
  if (isSaving) return;
  isSaving = true;
  const saveBtn = form.querySelector('button[type="submit"]');
  const preSaveBtn = document.getElementById("pre-save-btn");
  if (saveBtn) saveBtn.disabled = true;
  if (preSaveBtn) preSaveBtn.disabled = true;

  // Verificar autenticación antes de guardar
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) {
    statusEl.textContent = "Debes estar autenticado para guardar";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    if (preSaveBtn) preSaveBtn.disabled = false;
    isSaving = false;
    return;
  }

  // Verificar que el usuario tenga permisos de admin
  console.log("🔧 Usuario autenticado:", __currentUser?.email);
  console.log("🔧 Verificando permisos de admin...");

  // Verificar sesión activa antes de continuar
  const { data: currentSession } = await supabase.auth.getSession();
  if (!currentSession?.session) {
    statusEl.textContent =
      "Sesión expirada. Por favor, inicia sesión nuevamente.";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  console.log("🔧 Sesión verificada:", currentSession.session.user.email);

  statusEl.textContent = "Guardando...";
  statusEl.style.color = "inherit";

  // 1) Crear o actualizar producto
  const statusValue = document.getElementById("status").value;
  const supplierValue = document.getElementById("supplier").value;
  
  // Obtener costo de la primera variante (todas comparten el mismo costo del producto)
  const firstRow = variantsTable.querySelector("tr");
  const costValue = firstRow ? parseARS(firstRow.querySelector(".v-cost")?.value || "0") : 0;
  const pricePercentageValue = parseFloat(document.getElementById("price-percentage")?.value || "30");
  const logisticAmountValue = parseARS(document.getElementById("logistic-amount")?.value || "500");
  
  // Normalizar handle (lowercase + slug)
  const handleRaw = (
    document.getElementById("handle").value ||
    slugify(document.getElementById("name").value)
  ).trim();
  const handleNormalized = handleRaw.toLowerCase().trim();
  
  // Verificar stock y fotos para aplicar reglas de activación
  const variantRows = Array.from(variantsTable.querySelectorAll("tr"));
  const hasStock = await checkProductHasStock(variantRows);
  const hasImages = await checkProductHasImages(variantRows);
  
  // Aplicar reglas de activación
  let finalStatus = statusValue || "draft";
  if (!currentProductId) {
    // Producto nuevo: aplicar reglas estrictas
    if (hasStock && hasImages) {
      finalStatus = "active";
      console.log("✅ Producto nuevo: tiene stock e imágenes → activo");
    } else if (hasImages && !hasStock) {
      finalStatus = "pending_stock";
      console.log("✅ Producto nuevo: tiene imágenes pero no stock → completar stock");
    } else if (hasStock && !hasImages) {
      finalStatus = "draft"; // Mantener como draft hasta tener fotos
      console.log("✅ Producto nuevo: tiene stock pero no imágenes → draft (se activará al cargar fotos)");
    } else {
      finalStatus = "draft";
      console.log("⚠️ Producto nuevo: sin stock ni imágenes → draft");
    }
  } else {
    // Producto existente: aplicar reglas pero respetar cambios manuales si es necesario
    // Si el usuario seleccionó "active" pero no cumple condiciones, ajustar
    if (statusValue === "active") {
      if (hasStock && hasImages) {
        finalStatus = "active";
      } else if (hasImages && !hasStock) {
        finalStatus = "pending_stock";
        console.log("⚠️ Producto existente: intentó activar sin stock → cambiado a 'completar stock'");
      } else if (hasStock && !hasImages) {
        finalStatus = "draft";
        console.log("⚠️ Producto existente: intentó activar sin imágenes → cambiado a 'draft'");
      } else {
        finalStatus = "draft";
        console.log("⚠️ Producto existente: intentó activar sin stock ni imágenes → cambiado a 'draft'");
      }
    } else {
      // Si no es "active", usar el valor seleccionado
      finalStatus = statusValue || "draft";
    }
  }
  
  const payloadProduct = {
    category: document.getElementById("category").value,
    handle: handleNormalized,
    name: document.getElementById("name").value.trim().toUpperCase(),
    description: document.getElementById("description").value.trim(),
    status: finalStatus,
    supplier_id: supplierValue || null,
    ...(canViewCostFields
      ? {
          cost: costValue > 0 ? costValue : null,
          price_percentage: pricePercentageValue || 30,
          logistic_amount: logisticAmountValue || 500,
        }
      : {}),
    created_at: new Date().toISOString(),
  };

  // Log para depuración
  console.log("🔧 Guardando producto con status:", payloadProduct.status);

  if (!payloadProduct.handle || !payloadProduct.name) {
    statusEl.textContent = "Handle y Nombre son obligatorios";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  // Validar unicidad de handle (case-insensitive)
  const { data: dupHandle } = await supabase
    .from("products")
    .select("id")
    .ilike("handle", payloadProduct.handle)
    .neq("status", "archived")
    .limit(1);
    if (dupHandle && dupHandle.length && dupHandle[0].id !== currentProductId) {
    statusEl.textContent = `El handle '${payloadProduct.handle}' ya existe. Cambialo o ajusta el nombre.`;
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    if (preSaveBtn) preSaveBtn.disabled = false;
    isSaving = false;
    return;
  }

  let prodId = currentProductId;
  if (!currentProductId) {
    console.log("🔧 Creando nuevo producto:", payloadProduct);
    const { data: prod, error: prodErr } = await supabase
      .from("products")
      .insert([payloadProduct])
      .select("id")
      .single();
    if (prodErr) {
      console.error("❌ Error al crear producto:", prodErr);
      if (prodErr.message.includes("row-level security")) {
        statusEl.textContent =
          "Error de permisos: No tienes permisos para crear productos. Contacta al administrador.";
        statusEl.style.color = "#c00";
      } else {
        statusEl.textContent = `Error al crear producto: ${prodErr.message}`;
        statusEl.style.color = "#c00";
      }
      if (saveBtn) saveBtn.disabled = false;
      if (preSaveBtn) preSaveBtn.disabled = false;
      isSaving = false;
      return;
    }
    prodId = prod.id;
    console.log("✅ Producto creado con ID:", prodId);
  } else {
    console.log("🔧 Actualizando producto existente:", currentProductId);
    const { error: upErr } = await supabase
      .from("products")
      .update(payloadProduct)
      .eq("id", currentProductId);
    if (upErr) {
      console.error("❌ Error al actualizar producto:", upErr);
      if (upErr.message.includes("row-level security")) {
        statusEl.textContent =
          "Error de permisos: No tienes permisos para actualizar productos. Contacta al administrador.";
        statusEl.style.color = "#c00";
      } else {
        statusEl.textContent = `Error al actualizar producto: ${upErr.message}`;
        statusEl.style.color = "#c00";
      }
      if (saveBtn) saveBtn.disabled = false;
      if (preSaveBtn) preSaveBtn.disabled = false;
      isSaving = false;
      return;
    }
    prodId = currentProductId;
    console.log("✅ Producto actualizado");
  }

  // 2) Variantes - NUEVO MODELO: una variante = un color, talles en variant_sizes
  const rows = Array.from(variantsTable.querySelectorAll("tr"));
  console.log("🔧 Procesando variantes (nuevo modelo):", rows.length);

  if (rows.length === 0) {
    statusEl.textContent = "Agrega al menos una variante (color)";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    if (preSaveBtn) preSaveBtn.disabled = false;
    isSaving = false;
    return;
  }
  
  // Validar que todas las variantes tengan al menos un talle definido
  const rowsWithoutSizes = rows.filter(row => {
    const color = row.querySelector(".v-color")?.value?.trim();
    return color && !hasSizesDefined(row);
  });
  
  if (rowsWithoutSizes.length > 0) {
    statusEl.textContent = `Error: ${rowsWithoutSizes.length} variante(s) sin talles definidos. Define al menos un talle para cada variante.`;
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    if (preSaveBtn) preSaveBtn.disabled = false;
    isSaving = false;
    return;
  }

  // Obtener código del proveedor para generar SKU bases si es necesario
  const supplierId = supplierValue || null;
  const supplierCode = supplierId ? (SUPPLIERS_CACHE.get(supplierId) || null) : null;
  const handle = payloadProduct.handle;

  // Iterar filas y procesar cada variante (color)
  const savedVariantIds = [];
  
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const color = row.querySelector(".v-color")?.value?.trim();
    
    if (!color) {
      console.warn(`⚠️ Fila ${i + 1} sin color, saltando...`);
      continue;
    }

    const variantId = row.dataset.variantId;
    
    // Obtener campos de la variante
    const skuBase = (
      row.querySelector(".v-skuBase")?.value?.trim() ||
      makeSkuBase(handle, color, supplierCode)
    ).trim();
    const price = parseARS(row.querySelector(".v-price")?.value || "0");
    const active = row.querySelector(".v-active")?.checked ?? true;

    console.log(`🔧 Procesando variante ${i + 1}: color="${color}", variantId=${variantId || "null"}`);

    let finalVariantId = variantId;

    if (variantId) {
      // UPDATE: variante existe, actualizar
      console.log(`🔧 Actualizando variante existente: ${variantId}`);
      
      const updatePayload = {
        color,
        sku: skuBase, // SKU base (sin size)
        price: price || 0,
        active,
      };

      const { error: updateErr } = await supabase
        .from("product_variants")
        .update(updatePayload)
        .eq("id", variantId);

      if (updateErr) {
        console.error(`❌ Error actualizando variante ${variantId}:`, updateErr);
        statusEl.textContent = `Error actualizando variante ${color}: ${updateErr.message}`;
        statusEl.style.color = "#c00";
        if (saveBtn) saveBtn.disabled = false;
        if (preSaveBtn) preSaveBtn.disabled = false;
        isSaving = false;
        return;
      }

      console.log(`✅ Variante actualizada: ${variantId}`);
      savedVariantIds.push(variantId);
      
    } else {
      // INSERT: variante no existe, crear
      console.log(`🔧 Creando nueva variante para color: ${color}`);
      
      // Usar ensureVariantId para crear variante (crea producto draft si hace falta)
      currentProductId = prodId; // Asegurar que ensureVariantId use este producto
      finalVariantId = await ensureVariantId(row);
      
      if (!finalVariantId) {
        console.error(`❌ No se pudo crear/obtener variantId para color: ${color}`);
        statusEl.textContent = `Error creando variante para color "${color}". Verifica que el color esté completo.`;
        statusEl.style.color = "#c00";
        if (saveBtn) saveBtn.disabled = false;
        if (preSaveBtn) preSaveBtn.disabled = false;
        isSaving = false;
        return;
      }

      // Si ensureVariantId creó un producto nuevo, actualizar prodId
      if (currentProductId && currentProductId !== prodId) {
        prodId = currentProductId;
        console.log(`🔧 Producto actualizado a: ${prodId}`);
      }

      console.log(`✅ Variante creada/obtenida: ${finalVariantId}`);
      savedVariantIds.push(finalVariantId);
    }

    // Guardar talles/stock en variant_sizes (siempre, tanto para insert como update)
    // IMPORTANTE: Guardar talles incluso si no hay stock (stock = 0)
    // Validar que haya talles antes de guardar
    if (!hasSizesDefined(row)) {
      console.error(`❌ Variante ${finalVariantId} sin talles definidos`);
      statusEl.textContent = `Error: La variante "${color}" no tiene talles definidos. Define al menos un talle.`;
      statusEl.style.color = "#c00";
      if (saveBtn) saveBtn.disabled = false;
      if (preSaveBtn) preSaveBtn.disabled = false;
      isSaving = false;
      return;
    }
    
    // Guardar talles (permitir stock 0, especialmente si el estado es "pending_stock")
    console.log(`🔧 Llamando a saveVariantSizes para variante ${finalVariantId} (color: ${color})`);
    const sizesSaved = await saveVariantSizes(finalVariantId, row);
    if (!sizesSaved) {
      console.error(`❌ No se pudieron guardar talles para variante ${finalVariantId}`);
      statusEl.textContent = `Error: No se pudieron guardar los talles para la variante "${color}". Verifica que los talles estén definidos correctamente.`;
      statusEl.style.color = "#c00";
      if (saveBtn) saveBtn.disabled = false;
      if (preSaveBtn) preSaveBtn.disabled = false;
      isSaving = false;
      return;
    } else {
      const productStatus = statusValue || "active";
      const isPendingStock = productStatus === "pending_stock";
      const message = isPendingStock
        ? `✅ Talles guardados para variante ${finalVariantId} (stock 0 permitido en modo 'completar stock')`
        : `✅ Talles guardados correctamente para variante ${finalVariantId} (incluyendo talles con stock 0)`;
      console.log(message);
      
      // Verificar stock canónico por talle en depósito general.
      const generalWarehouseId = await getGeneralWarehouseIdForProducts();
      let verifySizes = [];
      if (generalWarehouseId) {
        const { data: verifyRows } = await supabase
          .from("variant_size_warehouse_stock")
          .select("size, stock_qty")
          .eq("variant_id", finalVariantId)
          .eq("warehouse_id", generalWarehouseId);
        verifySizes = verifyRows || [];
      }

      if (verifySizes.length > 0) {
        console.log(`✅ Verificación: ${verifySizes.length} talles encontrados en VSW(general) para variante ${finalVariantId}:`, verifySizes);
      } else {
        console.warn(`⚠️ Verificación: No se encontraron talles en VSW(general) para variante ${finalVariantId} después de guardar`);
      }
    }
  }

  // Verificar que al menos una variante esté activa
  const activeRows = rows.filter(row => row.querySelector(".v-active")?.checked === true);
  if (activeRows.length === 0 && savedVariantIds.length > 0) {
    console.warn("⚠️ Ninguna variante está marcada como activa.");
    const confirm = window.confirm(
      "⚠️ Ninguna variante está marcada como activa. " +
      "El producto no aparecerá en el catálogo público. " +
      "¿Deseas continuar de todas formas?"
    );
    if (!confirm) {
      statusEl.textContent = "Guardado cancelado. Marca al menos una variante como activa.";
      statusEl.style.color = "#fa0";
      if (saveBtn) saveBtn.disabled = false;
      if (preSaveBtn) preSaveBtn.disabled = false;
      isSaving = false;
      return;
    }
  }

  // Eliminar variantes que ya no están en la tabla
  const keptIdsSet = new Set(savedVariantIds);
  const toDelete = Array.from(originalVariantIds).filter(
    (id) => !keptIdsSet.has(id)
  );
  
  if (toDelete.length > 0) {
    console.log(`🔧 Eliminando ${toDelete.length} variantes que ya no están en la tabla:`, toDelete);
    // Las imágenes se eliminan automáticamente por CASCADE cuando se elimina la variante
    // y los talles también (variant_sizes tiene on delete cascade)
    const { error: deleteErr } = await supabase
      .from("product_variants")
      .delete()
      .in("id", toDelete);
    
    if (deleteErr) {
      console.error("❌ Error eliminando variantes:", deleteErr);
      // No bloquear el guardado por esto, solo loguear
    } else {
      console.log(`✅ ${toDelete.length} variantes eliminadas`);
    }
  }

  // NOTA: Las imágenes NO se procesan aquí porque ya se guardan al subir
  // mediante uploadImagesToCloudinary() que guarda directamente en variant_images

  // 4) Sincronizar tags jerárquicos del producto (product_tags)
  try {
    const tagPayload = {
      product_id: prodId,
      tag1_id: selectedTag1Id || null,
      tag2_id: selectedTag2Id || null,
      tag3_ids: selectedTag3Ids.length > 0 ? selectedTag3Ids : null
    };
    
    // Verificar si ya existe un registro
    const { data: existing, error: checkError } = await supabase
      .from("product_tags")
      .select("product_id")
      .eq("product_id", prodId)
      .maybeSingle();
    
    // Ignorar error 406 (Not Acceptable) que puede ocurrir cuando no hay resultados
    if (checkError && checkError.code !== "PGRST116") {
      console.warn("Error verificando product_tags:", checkError);
    }
    
    if (existing) {
      // Actualizar
      const { error: updateErr } = await supabase
        .from("product_tags")
        .update({
          tag1_id: tagPayload.tag1_id,
          tag2_id: tagPayload.tag2_id,
          tag3_ids: tagPayload.tag3_ids
        })
        .eq("product_id", prodId);
      if (updateErr) {
        console.warn("Error actualizando tags jerárquicos:", updateErr);
      }
    } else {
      // Insertar nuevo
      const { error: insertErr } = await supabase
        .from("product_tags")
        .insert([tagPayload]);
      if (insertErr) {
        console.warn("Error insertando tags jerárquicos:", insertErr);
      }
    }
  } catch (e) {
    console.warn("No se pudieron sincronizar tags jerárquicos", e);
  }

  currentProductId = prodId;
  // Actualizar originalVariantIds con los IDs de las variantes que se acaban de guardar
  originalVariantIds = new Set(savedVariantIds);

  // Verificar que las variantes se guardaron correctamente
  console.log("🔧 Verificando variantes guardadas...");
  try {
    // Consultar solo las columnas relevantes (sin size, que está deprecated)
    const { data: verifyVariants, error: verifyErr } = await supabase
      .from("product_variants")
      .select("id, sku, color, active, price")
      .eq("product_id", prodId);

    if (verifyErr) {
      console.warn("⚠️ Error verificando variantes:", verifyErr.message);
    } else if (verifyVariants) {
      console.log("✅ Variantes verificadas en la base de datos:", verifyVariants.length);
      console.log("📋 Variantes:", verifyVariants.map(v => ({
        sku: v.sku,
        color: v.color,
        active: v.active
      })));
    }
  } catch (e) {
    console.warn("⚠️ No se pudo verificar las variantes:", e.message);
  }

  // 5) Calcular y actualizar estado del producto automáticamente
  try {
    console.log(`🔧 Calculando estado automático para producto ${prodId}...`);
    const calculatedStatus = await calculateProductStatus(prodId);
    console.log(`🔧 Estado calculado: ${calculatedStatus}`);
    
    // Actualizar estado del producto en la base de datos
    const { error: statusUpdateError } = await supabase
      .from("products")
      .update({ status: calculatedStatus })
      .eq("id", prodId);
    
    if (statusUpdateError) {
      console.warn("⚠️ Error actualizando estado del producto:", statusUpdateError);
    } else {
      console.log(`✅ Estado del producto actualizado a: ${calculatedStatus}`);
      // Actualizar el select de estado en la UI; usar solo si existe la opción para no dejar vacío
      const statusSelect = document.getElementById("status");
      if (statusSelect) {
        const validStatuses = ["active", "draft", "pending_stock", "missing_tags", "archived"];
        statusSelect.value = validStatuses.includes(calculatedStatus) ? calculatedStatus : "draft";
      }
    }
  } catch (e) {
    console.warn("⚠️ Error calculando estado del producto:", e);
  }

  statusEl.textContent = "Producto y variantes guardados";
  statusEl.style.color = "#090";
  
  // Solo resetear si shouldReset es true
  if (shouldReset) {
    // Resetear formulario para crear nuevo producto (mantener categoría)
    const categoryEl = document.getElementById("category");
    const currentCategory = categoryEl?.value || "";
    
    currentProductId = null;
    originalVariantIds = new Set();
    form.reset();
    
    // Restaurar categoría después de resetear
    if (categoryEl && currentCategory) {
      categoryEl.value = currentCategory;
    }
    
    variantsTable.innerHTML = "";
    selectedTag1Id = null;
    selectedTag2Id = null;
    selectedTag3Ids = [];
    selectedDetailsIds = [];
    selectedHighlightsIds = [];
    
    // Limpiar tags en la UI (igual que en "Nuevo producto")
    await renderTags1();
    await renderTags2();
    await renderTags3();
    await renderDetailsList();
    
    // Limpiar proveedor
    const supplierEl = document.getElementById("supplier");
    if (supplierEl) supplierEl.value = "";
    
    // Actualizar visibilidad de botones
    updateEditButtonVisibility();
    
    // Inicializar valores por defecto de cálculo de precio
    const logisticAmountEl = document.getElementById("logistic-amount");
    if (logisticAmountEl) logisticAmountEl.value = formatARS(500);
    
    // Actualizar porcentaje según la categoría restaurada
    updatePercentageByCategory(true);
    
    // Agregar variante vacía por defecto
    ensureDefaultVariant();
  } else {
    // Pre-guardado: solo actualizar el mensaje y recargar el producto para refrescar datos
    if (currentProductId) {
      // Recargar el producto para asegurar que todo esté sincronizado
      await loadProductById(currentProductId);
    }
  }
  
  if (saveBtn) saveBtn.disabled = false;
  if (preSaveBtn) preSaveBtn.disabled = false;
  isSaving = false;
  
  // Mostrar mensaje temporal
  const message = shouldReset 
    ? "Producto y variantes guardados" 
    : "✅ Producto pre-guardado. Podés continuar agregando imágenes.";
  statusEl.textContent = message;
  setTimeout(() => {
    if (statusEl.textContent === message) {
      statusEl.textContent = "";
    }
  }, 3000);
}

// Event listener para el botón de pre-guardado
const preSaveBtn = document.getElementById("pre-save-btn");
if (preSaveBtn) {
  preSaveBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    await saveProduct(false); // false = no limpiar formulario
  });
}

// Event listener para el submit del formulario (guardar normal)
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveProduct(true); // true = limpiar formulario
});

// Eliminar producto y sus variables completamente
pDelete?.addEventListener("click", async () => {
  if (!currentProductId) {
    statusEl.textContent = "Primero carga un producto para poder eliminarlo.";
    statusEl.style.color = "#c00";
    return;
  }
  const name = (document.getElementById("name").value || "").trim();
  const handle = (document.getElementById("handle").value || "").trim();
  const ok = confirm(
    `¿Eliminar completamente el producto "${name}"?\n\nEsto eliminará:\n- El producto\n- Todas sus variantes\n- Todas las imágenes de las variantes\n- Los tags asociados\n\n⚠️ Esta acción NO se puede deshacer.`
  );
  if (!ok) return;
  
  statusEl.textContent = "Eliminando producto y variables...";
  statusEl.style.color = "inherit";
  
  try {
    // 1. Obtener todas las variantes del producto
    const { data: variants, error: variantsError } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", currentProductId);
    
    if (variantsError) {
      throw new Error(`Error obteniendo variantes: ${variantsError.message}`);
    }
    
    const variantIds = variants?.map(v => v.id) || [];
    
    // 2. Eliminar imágenes de las variantes
    if (variantIds.length > 0) {
      const { error: imagesError } = await supabase
        .from("variant_images")
        .delete()
        .in("variant_id", variantIds);
      
      if (imagesError) {
        throw new Error(`Error eliminando imágenes: ${imagesError.message}`);
      }
      console.log(`✅ ${variantIds.length} variante(s) - imágenes eliminadas`);
    }
    
    // 3. Eliminar order_items relacionados (antes de eliminar variantes)
    if (variantIds.length > 0) {
      const { error: orderItemsError } = await supabase
        .from("order_items")
        .delete()
        .in("variant_id", variantIds);
      
      if (orderItemsError) {
        console.warn("⚠️ Advertencia al eliminar order_items:", orderItemsError.message);
        // No lanzamos error aquí porque puede que no haya order_items
      } else {
        console.log("✅ Order items relacionados eliminados");
      }
    }
    
    // 4. Eliminar local_order_items relacionados (si existen)
    if (variantIds.length > 0) {
      const { error: localOrderItemsError } = await supabase
        .from("local_order_items")
        .delete()
        .in("variant_id", variantIds);
      
      if (localOrderItemsError) {
        // Ignorar si la tabla no existe o no hay registros
        if (localOrderItemsError.code !== 'PGRST116' && localOrderItemsError.code !== '42P01') {
          console.warn("⚠️ Advertencia al eliminar local_order_items:", localOrderItemsError.message);
        }
      } else {
        console.log("✅ Local order items relacionados eliminados");
      }
    }
    
    // 4.5. Eliminar public_sale_items relacionados (si existen)
    if (variantIds.length > 0) {
      const { error: publicSaleItemsError } = await supabase
        .from("public_sale_items")
        .delete()
        .in("variant_id", variantIds);
      
      if (publicSaleItemsError) {
        // Ignorar si la tabla no existe o no hay registros
        if (publicSaleItemsError.code !== 'PGRST116' && publicSaleItemsError.code !== '42P01') {
          console.warn("⚠️ Advertencia al eliminar public_sale_items:", publicSaleItemsError.message);
        }
      } else {
        console.log("✅ Public sale items relacionados eliminados");
      }
    }
    
    // 5. Eliminar variantes (esto también eliminará cart_items relacionados por cascade)
    if (variantIds.length > 0) {
      const { error: variantsDeleteError } = await supabase
        .from("product_variants")
        .delete()
        .eq("product_id", currentProductId);
      
      if (variantsDeleteError) {
        throw new Error(`Error eliminando variantes: ${variantsDeleteError.message}`);
      }
      console.log(`✅ ${variantIds.length} variante(s) eliminada(s)`);
    }
    
    // 6. Eliminar tags del producto
    const { error: tagsError } = await supabase
      .from("product_tags")
      .delete()
      .eq("product_id", currentProductId);
    
    if (tagsError) {
      console.warn("⚠️ Advertencia al eliminar tags:", tagsError.message);
      // No lanzamos error aquí porque puede que no haya tags
    } else {
      console.log("✅ Tags del producto eliminados");
    }
    
    // 6.5. Eliminar product_tag_details relacionados
    const { error: tagDetailsError } = await supabase
      .from("product_tag_details")
      .delete()
      .eq("product_id", currentProductId);
    
    if (tagDetailsError) {
      // Ignorar si la tabla no existe o no hay registros
      if (tagDetailsError.code !== 'PGRST116' && tagDetailsError.code !== '42P01') {
        console.warn("⚠️ Advertencia al eliminar product_tag_details:", tagDetailsError.message);
      }
    } else {
      console.log("✅ Product tag details eliminados");
    }
    
    // 6.6. Eliminar ofertas de precio por color relacionadas
    const { error: colorOffersError } = await supabase
      .from("color_price_offers")
      .delete()
      .eq("product_id", currentProductId);
    
    if (colorOffersError) {
      // Ignorar si la tabla no existe o no hay registros
      if (colorOffersError.code !== 'PGRST116' && colorOffersError.code !== '42P01') {
        console.warn("⚠️ Advertencia al eliminar color_price_offers:", colorOffersError.message);
      }
    } else {
      console.log("✅ Color price offers eliminados");
    }
    
    // 6.7. Eliminar items de promociones relacionados
    const { error: promotionItemsError } = await supabase
      .from("promotion_items")
      .delete()
      .eq("product_id", currentProductId);
    
    if (promotionItemsError) {
      // Ignorar si la tabla no existe o no hay registros
      if (promotionItemsError.code !== 'PGRST116' && promotionItemsError.code !== '42P01') {
        console.warn("⚠️ Advertencia al eliminar promotion_items:", promotionItemsError.message);
      }
    } else {
      console.log("✅ Promotion items eliminados");
    }
    
    // 7. Finalmente, eliminar el producto
    const { error: productError } = await supabase
      .from("products")
      .delete()
      .eq("id", currentProductId);
    
    if (productError) {
      // Mostrar error detallado
      console.error("❌ Error completo al eliminar producto:", productError);
      throw new Error(`Error eliminando producto: ${productError.message} (Código: ${productError.code || 'N/A'})`);
    }
    
    // 8. Verificar que el producto fue eliminado correctamente
    const { data: productStillExists, error: checkError } = await supabase
      .from("products")
      .select("id")
      .eq("id", currentProductId)
      .maybeSingle();
    
    if (checkError && checkError.code !== 'PGRST116') {
      console.warn("⚠️ Advertencia al verificar eliminación:", checkError.message);
    }
    
    if (productStillExists) {
      throw new Error(`El producto aún existe después de intentar eliminarlo. Esto puede deberse a restricciones de RLS o permisos.`);
    }
    
    statusEl.textContent = "✅ Producto y todas sus variables eliminados correctamente.";
    statusEl.style.color = "#090";
    
    // Limpiar formulario
    currentProductId = null;
    originalVariantIds = new Set();
    form.reset();
    variantsTable.innerHTML = "";
    selectedDetailsIds = [];
    selectedHighlightsIds = [];
    await renderDetailsList();
    ensureDefaultVariant();
    
  } catch (error) {
    console.error("❌ Error eliminando producto:", error);
    console.error("❌ Detalles del error:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });
    
    // Verificar si el producto aún existe
    const { data: productExists, error: checkError } = await supabase
      .from("products")
      .select("id, name, handle")
      .eq("id", currentProductId)
      .maybeSingle();
    
    if (productExists) {
      statusEl.textContent = `❌ Error: ${error.message}\n\nEl producto "${productExists.name || productExists.handle}" aún existe. Revisa la consola para más detalles.`;
    } else {
      statusEl.textContent = `⚠️ Advertencia: ${error.message}\n\nEl producto puede haber sido eliminado parcialmente. Revisa la consola.`;
    }
    statusEl.style.color = "#c00";
  }
});

// ========== EVENT LISTENERS PARA DETAILS Y HIGHLIGHTS ==========

// Event delegation para details-list
const detailsList = document.getElementById("details-list");
detailsList?.addEventListener("change", (e) => {
  if (e.target.classList.contains("toggle-detail")) {
    const tag3Id = e.target.dataset.tag3Id;
    handleDetailToggle(tag3Id, e.target.checked);
  }
});

detailsList?.addEventListener("click", (e) => {
  if (e.target.classList.contains("toggle-highlight") || e.target.closest(".toggle-highlight")) {
    const button = e.target.classList.contains("toggle-highlight") 
      ? e.target 
      : e.target.closest(".toggle-highlight");
    if (button && !button.disabled) {
      const tag3Id = button.dataset.tag3Id;
      handleHighlightToggle(tag3Id);
    }
  }
});

// Event delegation para highlights-container (remover highlight)
const highlightsContainer = document.getElementById("highlights-container");
highlightsContainer?.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-highlight") || e.target.closest(".remove-highlight")) {
    const button = e.target.classList.contains("remove-highlight")
      ? e.target
      : e.target.closest(".remove-highlight");
    if (button) {
      const tag3Id = button.dataset.tag3Id;
      handleHighlightToggle(tag3Id);
    }
  }
});

// Búsqueda de details
const detailsSearch = document.getElementById("details-search");
detailsSearch?.addEventListener("input", () => renderDetailsList());

// Botón guardar details/highlights
const saveDetailsHighlightsBtn = document.getElementById("save-details-highlights-btn");
saveDetailsHighlightsBtn?.addEventListener("click", () => {
  if (currentProductId) {
    saveDetailsAndHighlights(currentProductId);
  } else {
    alert("Primero carga o crea un producto");
  }
});

// ========== FUNCIONES DE AUTO-TAGS CON IA ==========

// Configuración (puede moverse a un objeto de config si crece)
const AUTO_TAGS_CONFIG = {
  timeout: 60000, // 60 segundos timeout para llamada a Edge Function
  enableLogging: true, // Logging opcional para debugging
};

// Helper: Logging condicional
function logAutoTags(...args) {
  if (AUTO_TAGS_CONFIG.enableLogging) {
    console.log("[AutoTags]", ...args);
  }
}

// Helper: Fetch tags por nombres (una sola query)
async function fetchTagsByNames(names, category, level, parentId) {
  if (!names || names.length === 0) return new Map();
  
  let query = supabase
    .from("tags")
    .select("id, name, level, parent_id, category");
  
  if (category) {
    query = query.eq("category", category);
  }
  
  if (level !== null && level !== undefined) {
    query = query.eq("level", level);
  }
  
  if (parentId) {
    query = query.eq("parent_id", parentId);
  } else if (level === 1) {
    query = query.is("parent_id", null);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.warn("Error fetching tags:", error);
    return new Map();
  }
  
  // Mapear en JS usando normalizeName
  const normalizedNames = new Set(names.map(n => normalizeName(n)));
  const result = new Map();
  
  (data || []).forEach(tag => {
    const normalized = normalizeName(tag.name);
    if (normalizedNames.has(normalized)) {
      // Encontrar el nombre original que coincide
      const originalName = names.find(n => normalizeName(n) === normalized);
      if (originalName) {
        result.set(originalName, tag.id);
      }
    }
  });
  
  return result;
}

// Mapear tag1 name a ID
async function mapTag1NameToId(name, category) {
  const map = await fetchTagsByNames([name], category, 1, null);
  return map.get(name) || null;
}

// Mapear tag2 name a ID
async function mapTag2NameToId(name, tag1Id) {
  if (!tag1Id) return null;
  const map = await fetchTagsByNames([name], null, 2, tag1Id);
  return map.get(name) || null;
}

// Mapear tag3 names a IDs con validación por árbol
async function mapTag3NamesToIds(names, tag1Id, tag2Id) {
  if (!names || names.length === 0) return new Map();
  if (!tag1Id) return new Map(); // Sin tag1, no podemos validar árbol
  
  let candidateTags = [];
  
  if (tag2Id) {
    // Caso 1: Hay tag2Id -> traer tags3 hijos DIRECTOS de ese tag2
    const { data, error } = await supabase
      .from("tags")
      .select("id, name, level, parent_id")
      .eq("level", 3)
      .eq("parent_id", tag2Id);
    
    if (!error && data) {
      candidateTags = data;
    }
  } else {
    // Caso 2: No hay tag2Id pero hay tag1Id -> traer todos los tags3 del árbol del tag1
    // Primero obtener todos los tags2 del tag1
    const { data: tags2, error: err2 } = await supabase
      .from("tags")
      .select("id")
      .eq("parent_id", tag1Id)
      .eq("level", 2);
    
    if (err2 || !tags2 || tags2.length === 0) {
      return new Map();
    }
    
    const tag2Ids = tags2.map(t => t.id);
    
    // Luego obtener todos los tags3 de esos tags2
    const { data, error } = await supabase
      .from("tags")
      .select("id, name, level, parent_id")
      .eq("level", 3)
      .in("parent_id", tag2Ids);
    
    if (!error && data) {
      candidateTags = data;
    }
  }
  
  // Validar que cada tag3 pertenece al árbol correcto
  const result = new Map();
  const normalizedNames = new Set(names.map(n => normalizeName(n)));
  
  candidateTags.forEach(tag => {
    const normalized = normalizeName(tag.name);
    if (normalizedNames.has(normalized)) {
      // Verificar que el parent_id pertenece al árbol de tag1Id
      if (tag.parent_id) {
        // Si hay tag2Id, el parent debe ser exactamente tag2Id
        if (tag2Id && tag.parent_id === tag2Id) {
          const originalName = names.find(n => normalizeName(n) === normalized);
          if (originalName) {
            result.set(originalName, tag.id);
          }
        } else if (!tag2Id) {
          // Si no hay tag2Id, el parent debe ser hijo de tag1Id (ya validado por la query)
          const originalName = names.find(n => normalizeName(n) === normalized);
          if (originalName) {
            result.set(originalName, tag.id);
          }
        }
      }
    }
  });
  
  return result;
}

// Invocar Edge Function de auto-tags con timeout y mejor manejo de errores
async function invokeAutoTags(imageUrl, productName, categoryHint, description) {
  const statusEl = document.getElementById("auto-tags-status");
  
  try {
    statusEl.textContent = "Analizando con IA...";
    statusEl.style.color = "inherit";
    
    logAutoTags("Invocando Edge Function", { productName, categoryHint, hasDescription: !!description });
    
    // Crear promise con timeout
    const invokePromise = supabase.functions.invoke("auto_tags", {
      body: {
        image_url: imageUrl,
        product_name: productName,
        category_hint: categoryHint,
        description: description || null,
      },
    });
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("La solicitud a la IA tardó demasiado. Por favor, intentá nuevamente."));
      }, AUTO_TAGS_CONFIG.timeout);
    });
    
    // Race entre invoke y timeout
    const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
    
    if (error) {
      // Manejar diferentes tipos de errores
      let errorMessage = "Error invocando función de IA";
      
      if (error.message) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      } else if (error.status === 408 || error.message?.includes("timeout")) {
        errorMessage = "La solicitud tardó demasiado. Por favor, intentá nuevamente.";
      } else if (error.status === 429) {
        errorMessage = "Demasiadas solicitudes. Por favor, esperá un momento e intentá nuevamente.";
      } else if (error.status >= 500) {
        errorMessage = "Error del servidor. Por favor, intentá nuevamente más tarde.";
      }
      
      logAutoTags("Error en invokeAutoTags", error);
      throw new Error(errorMessage);
    }
    
    if (!data) {
      logAutoTags("Respuesta vacía de Edge Function");
      throw new Error("No se recibió respuesta de la IA. Por favor, intentá nuevamente.");
    }
    
    if (data.error) {
      logAutoTags("Error en respuesta de IA", data.error);
      throw new Error(data.error || "Error en respuesta de IA");
    }
    
    // Validar estructura mínima de respuesta
    if (!data.tag1 || !data.tag2) {
      logAutoTags("Respuesta incompleta de IA", data);
      throw new Error("La respuesta de la IA está incompleta. Por favor, intentá nuevamente.");
    }
    
    logAutoTags("Respuesta exitosa de IA", {
      tag1: data.tag1,
      tag2: data.tag2,
      detailsCount: data.details?.length || 0,
      highlightsCount: data.highlights?.length || 0,
    });
    
    return data;
  } catch (error) {
    logAutoTags("Error capturado en invokeAutoTags", error);
    
    // Mensajes más amigables para el usuario
    let userMessage = error.message || "Error desconocido";
    
    if (error.message?.includes("timeout") || error.message?.includes("tardó demasiado")) {
      userMessage = "La solicitud tardó demasiado. Por favor, intentá nuevamente.";
    } else if (error.message?.includes("fetch")) {
      userMessage = "Error de conexión. Verificá tu conexión a internet e intentá nuevamente.";
    }
    
    statusEl.textContent = `Error: ${userMessage}`;
    statusEl.style.color = "#c00";
    throw error;
  }
}

// Mostrar modal de resumen
function showAutoTagsSummary(aiResponse, mappedTags, warnings) {
  return new Promise((resolve) => {
    // Remover modal anterior si existe
    const existingModal = document.getElementById("auto-tags-summary-modal");
    if (existingModal) {
      existingModal.remove();
    }
    
    const modal = document.createElement("div");
    modal.id = "auto-tags-summary-modal";
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;
    
    const tag1Found = mappedTags.tag1Id !== null;
    const tag2Found = mappedTags.tag2Id !== null;
    const tag1Name = aiResponse.tag1 || "N/A";
    const tag2Name = aiResponse.tag2 || "N/A";
    
    const detailsFound = mappedTags.detailsMap || new Map();
    const highlightsFound = mappedTags.highlightsMap || new Map();
    
    const warningsHtml = warnings.length > 0
      ? `<div class="warnings" style="margin-top:12px;padding:8px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;">
          <strong style="color:#856404;">⚠️ Advertencias:</strong>
          <ul style="margin:4px 0 0 0;padding-left:20px;color:#856404;">
            ${warnings.map(w => `<li>${w}</li>`).join("")}
          </ul>
        </div>`
      : "";
    
    modal.innerHTML = `
      <div style="background:white;border-radius:8px;padding:20px;max-width:500px;max-height:80vh;overflow-y:auto;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
        <h3 style="margin:0 0 16px 0;font-size:16px;">🤖 IA detectó los siguientes tags:</h3>
        
        <div style="margin-bottom:12px;">
          <strong>Tipo:</strong> 
          <span style="color:${tag1Found ? "#090" : "#c00"};">
            ${tag1Name} ${tag1Found ? "✓" : "⚠️ (no encontrado)"}
          </span>
        </div>
        
        <div style="margin-bottom:12px;">
          <strong>Atributo:</strong> 
          <span style="color:${tag2Found ? "#090" : "#c00"};">
            ${tag2Name} ${tag2Found ? "✓" : "⚠️ (no encontrado)"}
          </span>
        </div>
        
        <div style="margin-bottom:12px;">
          <strong>Detalles:</strong>
          <ul style="margin:4px 0;padding-left:20px;">
            ${(aiResponse.details || []).map(detail => {
              const found = detailsFound.has(detail);
              return `<li style="color:${found ? "#090" : "#c00"};">
                ${detail} ${found ? "✓" : "⚠️ (no encontrado)"}
              </li>`;
            }).join("")}
            ${(aiResponse.details || []).length === 0 ? "<li style='color:#666;'>Ninguno</li>" : ""}
          </ul>
        </div>
        
        <div style="margin-bottom:12px;">
          <strong>Destacados:</strong>
          <ul style="margin:4px 0;padding-left:20px;">
            ${(aiResponse.highlights || []).map(highlight => {
              const found = highlightsFound.has(highlight);
              return `<li style="color:${found ? "#090" : "#c00"};">
                ${highlight} ${found ? "✓" : "⚠️ (no encontrado o fuera de details)"}
              </li>`;
            }).join("")}
            ${(aiResponse.highlights || []).length === 0 ? "<li style='color:#666;'>Ninguno</li>" : ""}
          </ul>
        </div>
        
        ${warningsHtml}
        
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;">
          <button id="cancel-auto-tags" class="btn" style="padding:6px 12px;font-size:12px;">Cancelar</button>
          <button id="apply-auto-tags" class="btn primary" style="padding:6px 12px;font-size:12px;">Aplicar</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners
    document.getElementById("apply-auto-tags").addEventListener("click", () => {
      modal.remove();
      resolve(true);
    });
    
    document.getElementById("cancel-auto-tags").addEventListener("click", () => {
      modal.remove();
      resolve(false);
    });
    
    // Cerrar al hacer click fuera
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.remove();
        resolve(false);
      }
    });
    
    // Cerrar con ESC
    const handleEsc = (e) => {
      if (e.key === "Escape") {
        modal.remove();
        document.removeEventListener("keydown", handleEsc);
        resolve(false);
      }
    };
    document.addEventListener("keydown", handleEsc);
  });
}

// Aplicar auto-tags a UI
async function applyAutoTagsToUI(aiResponse) {
  const statusEl = document.getElementById("auto-tags-status");
  const warnings = [];
  
  try {
    // 1. Mapear category (opcional, solo si cambió)
    const currentCategory = getProductCategory();
    if (aiResponse.category && aiResponse.category !== currentCategory) {
      // No forzamos cambio de categoría, solo warning
      warnings.push(`La categoría detectada por la IA ("${aiResponse.category}") difiere de la actual ("${currentCategory}"). Los tags se mapearán según la categoría actual.`);
    }
    
    // 2. Mapear tag1
    let tag1Id = null;
    let tag1Name = null;
    if (aiResponse.tag1) {
      tag1Id = await mapTag1NameToId(aiResponse.tag1, aiResponse.category || currentCategory);
      if (tag1Id) {
        tag1Name = aiResponse.tag1;
      } else {
        warnings.push(`Tipo "${aiResponse.tag1}" no encontrado en la categoría "${aiResponse.category || currentCategory}". Podés crearlo manualmente.`);
      }
    }
    
    // 3. Mapear tag2 (solo si tag1 existe)
    let tag2Id = null;
    let tag2Name = null;
    if (aiResponse.tag2 && tag1Id) {
      tag2Id = await mapTag2NameToId(aiResponse.tag2, tag1Id);
      if (tag2Id) {
        tag2Name = aiResponse.tag2;
      } else {
        warnings.push(`Atributo "${aiResponse.tag2}" no encontrado como hijo de "${aiResponse.tag1}". Podés crearlo manualmente.`);
      }
    } else if (aiResponse.tag2 && !tag1Id) {
      warnings.push(`Atributo "${aiResponse.tag2}" no se puede mapear porque el Tipo no fue encontrado.`);
    }
    
    // 4. Mapear details (solo si tag1 existe)
    const detailsMap = new Map();
    if (aiResponse.details && Array.isArray(aiResponse.details) && tag1Id) {
      const mapped = await mapTag3NamesToIds(aiResponse.details, tag1Id, tag2Id);
      mapped.forEach((id, name) => {
        detailsMap.set(name, id);
      });
      
      // Warnings para details no encontrados
      aiResponse.details.forEach(detail => {
        if (!detailsMap.has(detail)) {
          warnings.push(`Detalle "${detail}" no encontrado o no pertenece al árbol de "${aiResponse.tag1}". Verificá que esté en la rama correcta.`);
        }
      });
    } else if (aiResponse.details && !tag1Id) {
      warnings.push("Los detalles no se pueden mapear porque el Tipo no fue encontrado.");
    }
    
    // 5. Mapear highlights (validar subset de details + máx 2)
    const highlightsMap = new Map();
    let validHighlights = (aiResponse.highlights || []).filter(h => detailsMap.has(h));
    
    if (validHighlights.length > 2) {
      validHighlights = validHighlights.slice(0, 2);
      warnings.push("Los destacados fueron limitados a 2 (máximo permitido).");
    }
    
    if (validHighlights.length > 0 && tag1Id) {
      const mapped = await mapTag3NamesToIds(validHighlights, tag1Id, tag2Id);
      mapped.forEach((id, name) => {
        highlightsMap.set(name, id);
      });
      
      // Warnings para highlights no encontrados
      validHighlights.forEach(highlight => {
        if (!highlightsMap.has(highlight)) {
          warnings.push(`Destacado "${highlight}" no encontrado o no pertenece al árbol. Verificá que esté en los detalles seleccionados.`);
        }
      });
    }
    
    // Preparar datos para el modal
    const mappedTags = {
      tag1Id,
      tag2Id,
      detailsMap,
      highlightsMap,
    };
    
    // 6. Mostrar modal de resumen
    const shouldApply = await showAutoTagsSummary(aiResponse, mappedTags, warnings);
    
    if (!shouldApply) {
      statusEl.textContent = "Cancelado por el usuario";
      statusEl.style.color = "#666";
      return;
    }
    
    // 7. Aplicar cambios
    if (tag1Id) {
      selectedTag1Id = tag1Id;
      await renderTags1();
    }
    
    if (tag2Id) {
      selectedTag2Id = tag2Id;
      await renderTags2();
    }
    
    // Aplicar details
    selectedDetailsIds = Array.from(detailsMap.values());
    
    // Aplicar highlights
    selectedHighlightsIds = Array.from(highlightsMap.values());
    
    // Re-renderizar
    await renderDetailsList();
    
    statusEl.textContent = "✓ Tags aplicados. Revisá y guardá cuando estés listo.";
    statusEl.style.color = "#090";
    
    if (warnings.length > 0) {
      statusEl.textContent += ` (${warnings.length} advertencias)`;
    }
    
  } catch (error) {
    console.error("Error en applyAutoTagsToUI:", error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.style.color = "#c00";
  }
}

// Handler principal para auto-tags
async function handleAutoTagsClick() {
  const statusEl = document.getElementById("auto-tags-status");
  const btn = document.getElementById("auto-tags-btn");
  
  // Validación inicial
  if (!currentProductId) {
    statusEl.textContent = "Error: Primero carga o crea un producto";
    statusEl.style.color = "#c00";
    return;
  }
  
  // Deshabilitar botón durante procesamiento
  const originalBtnText = btn.textContent;
  const originalBtnDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = "⏳ Procesando...";
  
  try {
    statusEl.textContent = "Obteniendo imagen...";
    statusEl.style.color = "inherit";
    
    logAutoTags("Iniciando proceso de auto-tags", { productId: currentProductId });
    
    // 1. Obtener variant activo
    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", currentProductId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    
    if (variantError) {
      logAutoTags("Error obteniendo variant", variantError);
      throw new Error("Error al buscar variante del producto");
    }
    
    if (!variant) {
      throw new Error("No se encontró una variante activa. Asegurate de que el producto tenga al menos una variante activa.");
    }
    
    statusEl.textContent = "Buscando imagen principal...";
    
    // 2. Obtener imagen principal usando is_main = true (nuevo sistema)
    const { data: image, error: imageError } = await supabase
      .from("variant_images")
      .select("id, public_id, secure_url, url, is_main, position")
      .eq("variant_id", variant.id)
      .eq("is_main", true)
      .maybeSingle();
    
    if (imageError) {
      logAutoTags("Error obteniendo imagen", imageError);
      throw new Error("Error al buscar imagen del producto");
    }
    
    // Si no hay imagen con is_main, intentar con position = 1 como fallback
    let mainImage = image;
    if (!mainImage) {
      const { data: fallbackImage } = await supabase
        .from("variant_images")
        .select("id, public_id, secure_url, url, is_main, position")
        .eq("variant_id", variant.id)
        .eq("position", 1)
        .maybeSingle();
      mainImage = fallbackImage;
    }
    
    if (!mainImage) {
      throw new Error("No se encontró imagen principal. Asegurate de que la variante tenga al menos una imagen subida.");
    }
    
    // 3. Generar URL optimizada usando el nuevo sistema
    // Usar getImgFull() para obtener la URL optimizada (prioriza public_id si existe)
    const imageUrl = getImgFull(mainImage);
    
    if (!imageUrl) {
      throw new Error("No se pudo obtener la URL de la imagen. Asegurate de que la imagen esté correctamente configurada.");
    }
    
    logAutoTags("Imagen principal encontrada", {
      hasPublicId: !!mainImage.public_id,
      isMain: mainImage.is_main,
      position: mainImage.position,
    });
    
    // 4. Obtener contexto del form
    const productNameEl = document.getElementById("name");
    const categoryEl = document.getElementById("category");
    const descriptionEl = document.getElementById("description");
    
    const productName = productNameEl?.value?.trim() || "";
    const category = categoryEl?.value || getProductCategory();
    const description = descriptionEl?.value?.trim() || null;
    
    if (!productName) {
      throw new Error("El nombre del producto es requerido. Completá el campo 'Nombre' antes de usar auto-tags.");
    }
    
    // 5. Invocar IA con la URL optimizada
    const aiResponse = await invokeAutoTags(imageUrl, productName, category, description);
    
    // 5. Aplicar resultados
    await applyAutoTagsToUI(aiResponse);
    
  } catch (error) {
    logAutoTags("Error en handleAutoTagsClick", error);
    
    // Mensajes más amigables
    let userMessage = error.message || "Error desconocido";
    
    if (error.message?.includes("timeout") || error.message?.includes("tardó demasiado")) {
      userMessage = "La solicitud tardó demasiado. Por favor, intentá nuevamente.";
    } else if (error.message?.includes("fetch") || error.message?.includes("conexión")) {
      userMessage = "Error de conexión. Verificá tu conexión a internet e intentá nuevamente.";
    }
    
    statusEl.textContent = `Error: ${userMessage}`;
    statusEl.style.color = "#c00";
  } finally {
    // Restaurar botón
    btn.disabled = originalBtnDisabled;
    btn.textContent = originalBtnText;
  }
}

// Event listener para botón auto-tags
const autoTagsBtn = document.getElementById("auto-tags-btn");
autoTagsBtn?.addEventListener("click", handleAutoTagsClick);
