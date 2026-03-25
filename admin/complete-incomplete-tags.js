// admin/complete-incomplete-tags.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

// Estado
let currentProductId = null;
let currentProductCategory = null;
let selectedTag1Id = null;
let selectedTag2Id = null;
let selectedTag3Ids = [];

// Elementos del DOM
const productInfo = document.getElementById("product-info");
const productName = document.getElementById("product-name");
const productCategory = document.getElementById("product-category");
const productHandle = document.getElementById("product-handle");
const tagsSection = document.getElementById("tags-section");
const loadingState = document.getElementById("loading-state");
const tag1Select = document.getElementById("tag1-select");
const tag2Select = document.getElementById("tag2-select");
const tag3Select = document.getElementById("tag3-select");
const tag1New = document.getElementById("tag1-new");
const tag2New = document.getElementById("tag2-new");
const tag3New = document.getElementById("tag3-new");
const tag1Create = document.getElementById("tag1-create");
const tag2Create = document.getElementById("tag2-create");
const tag3Create = document.getElementById("tag3-create");
const tag3Chips = document.getElementById("tag3-chips");
const autoTagsBtn = document.getElementById("auto-tags-btn");
const autoTagsStatus = document.getElementById("auto-tags-status");
const saveBtn = document.getElementById("save-btn");
const cancelBtn = document.getElementById("cancel-btn");
const statusMessage = document.getElementById("status-message");

// Obtener productId de la URL
const urlParams = new URLSearchParams(window.location.search);
const productId = urlParams.get("id");

// Función auxiliar para normalizar nombres
function normalizeName(str) {
  return (str || "").toLowerCase().trim().replace(/\s+/g, " ");
}

// Obtener categoría del producto
function getProductCategory() {
  return currentProductCategory || "";
}

// Cargar producto
async function loadProduct() {
  if (!productId) {
    showStatus("Error: No se proporcionó ID de producto", "error");
    loadingState.innerHTML = `
      <div class="empty-state-icon">❌</div>
      <p>Error: No se proporcionó ID de producto</p>
      <a href="./incomplete-products.html">Volver a Productos Incompletos</a>
    `;
    return;
  }

  try {
    const { data: product, error } = await supabase
      .from("products")
      .select("id, name, category, handle, description")
      .eq("id", productId)
      .single();

    if (error) {
      throw error;
    }

    if (!product) {
      throw new Error("Producto no encontrado");
    }

    currentProductId = product.id;
    currentProductCategory = product.category;

    // Mostrar información del producto
    productName.textContent = product.name || "(sin nombre)";
    productCategory.textContent = `Categoría: ${product.category || "N/A"}`;
    productHandle.textContent = `Handle: ${product.handle || "N/A"}`;
    productInfo.style.display = "block";

    // Cargar tags existentes
    await loadProductTags(product.id);

    // Cargar tags disponibles
    await renderTags1();

    // Mostrar sección de tags
    tagsSection.style.display = "block";
    loadingState.style.display = "none";

  } catch (error) {
    console.error("Error cargando producto:", error);
    showStatus(`Error: ${error.message}`, "error");
    loadingState.innerHTML = `
      <div class="empty-state-icon">❌</div>
      <p>Error cargando producto: ${error.message}</p>
      <a href="./incomplete-products.html">Volver a Productos Incompletos</a>
    `;
  }
}

// Cargar tags del producto
async function loadProductTags(productId) {
  try {
    const { data: productTags, error } = await supabase
      .from("product_tags")
      .select("tag1_id, tag2_id, tag3_ids")
      .eq("product_id", productId)
      .maybeSingle();
    
    if (error) {
      console.warn("Error cargando tags del producto:", error);
      selectedTag1Id = null;
      selectedTag2Id = null;
      selectedTag3Ids = [];
      return;
    }
    
    selectedTag1Id = productTags?.tag1_id || null;
    selectedTag2Id = productTags?.tag2_id || null;
    selectedTag3Ids = productTags?.tag3_ids || [];
    
    // Renderizar tags
    await renderTags1();
    await renderTags2();
    await renderTags3();
  } catch (error) {
    console.error("Error cargando tags:", error);
  }
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

// Crear nuevo tag
async function createTag(name, level, category, parentId) {
  const { data, error } = await supabase
    .from("tags")
    .insert([{ name, level, category, parent_id: parentId }])
    .select("id, name")
    .single();
  if (error) {
    console.error("Error creando tag:", error);
    return null;
  }
  return data;
}

// Renderizar tags1
async function renderTags1() {
  const category = getProductCategory();
  const tags1 = await loadTags1(category);
  
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
  tag2Select.disabled = false;
  if (selectedTag2Id) {
    tag2Select.value = selectedTag2Id;
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
  } else {
    tag2New.style.display = "block";
    tag2Create.style.display = "block";
  }
}

// Renderizar tags3
async function renderTags3() {
  if (!selectedTag1Id) {
    tag3Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag3Select.disabled = true;
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
    renderTag3Chips();
    return;
  }
  const tags3 = await loadTags3(selectedTag1Id);
  tag3Select.innerHTML = "";
  tags3.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    opt.selected = selectedTag3Ids.includes(tag.id);
    tag3Select.appendChild(opt);
  });
  tag3Select.disabled = false;
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
  Promise.all(selectedTag3Ids.map(id => 
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
          selectedTag3Ids = selectedTag3Ids.filter((_, i) => i !== idx);
          renderTags3();
        });
        chip.appendChild(x);
        tag3Chips.appendChild(chip);
      }
    });
  });
}

// Guardar tags y activar producto
async function saveAndActivate() {
  if (!currentProductId) {
    showStatus("Error: No hay producto cargado", "error");
    return;
  }
  
  // Validar Tags1 y Tags2
  if (!selectedTag1Id || !selectedTag2Id) {
    showStatus("Error: Tags1 y Tags2 son obligatorios", "error");
    return;
  }
  
  saveBtn.disabled = true;
  showStatus("Guardando...", "info");
  
  try {
    // Guardar tags jerárquicos
    const { data: existingTags, error: checkError } = await supabase
      .from("product_tags")
      .select("product_id")
      .eq("product_id", currentProductId)
      .maybeSingle();
    
    const tagPayload = {
      product_id: currentProductId,
      tag1_id: selectedTag1Id,
      tag2_id: selectedTag2Id,
      tag3_ids: selectedTag3Ids.length > 0 ? selectedTag3Ids : null
    };
    
    if (existingTags) {
      // Actualizar
      const { error: updateError } = await supabase
        .from("product_tags")
        .update(tagPayload)
        .eq("product_id", currentProductId);
      
      if (updateError) throw updateError;
    } else {
      // Insertar
      const { error: insertError } = await supabase
        .from("product_tags")
        .insert([tagPayload]);
      
      if (insertError) throw insertError;
    }
    
    // Cambiar status a "active" (el trigger SQL actualizará automáticamente según stock e imágenes)
    // Pero como ya tiene stock (viene de incomplete-products), solo necesita verificar imágenes
    // El trigger se encargará de actualizar el estado correctamente
    
    showStatus("✓ Tags guardados correctamente. El estado del producto se actualizará automáticamente.", "success");
    
    // Redirigir después de 2 segundos
    setTimeout(() => {
      window.location.href = "./incomplete-products.html";
    }, 2000);
    
  } catch (error) {
    console.error("Error guardando tags:", error);
    showStatus(`Error: ${error.message}`, "error");
    saveBtn.disabled = false;
  }
}

// Función auxiliar para mostrar mensajes
function showStatus(message, type = "info") {
  statusMessage.textContent = message;
  statusMessage.className = `status-message ${type}`;
  statusMessage.style.display = "block";
}

// Auto-tags con IA
autoTagsBtn?.addEventListener("click", async () => {
  if (!currentProductId) {
    autoTagsStatus.textContent = "Error: No hay producto cargado";
    autoTagsStatus.style.color = "#c00";
    return;
  }
  
  // Obtener imagen principal del producto
  const { data: variants } = await supabase
    .from("product_variants")
    .select("id")
    .eq("product_id", currentProductId)
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
    .eq("position", 1)
    .eq("is_main", true)
    .limit(1)
    .maybeSingle();
  
  if (!images || !images.url) {
    autoTagsStatus.textContent = "Error: El producto no tiene imagen principal";
    autoTagsStatus.style.color = "#c00";
    return;
  }
  
  // Obtener datos del producto
  const { data: product } = await supabase
    .from("products")
    .select("name, category, description")
    .eq("id", currentProductId)
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
    
    // Buscar tags en la base de datos
    const category = getProductCategory();
    
    // Buscar Tags1
    const { data: tags1 } = await supabase
      .from("tags")
      .select("id, name")
      .eq("category", category)
      .eq("level", 1)
      .ilike("name", data.tag1);
    
    if (tags1 && tags1.length > 0) {
      selectedTag1Id = tags1[0].id;
      await renderTags1();
      
      // Buscar Tags2
      const { data: tags2 } = await supabase
        .from("tags")
        .select("id, name")
        .eq("parent_id", selectedTag1Id)
        .eq("level", 2)
        .ilike("name", data.tag2);
      
      if (tags2 && tags2.length > 0) {
        selectedTag2Id = tags2[0].id;
        await renderTags2();
      }
    }
    
    autoTagsStatus.textContent = "✓ Tags detectados. Revisá y guardá si están correctos.";
    autoTagsStatus.style.color = "#090";
    
  } catch (error) {
    console.error("Error en auto-tags:", error);
    autoTagsStatus.textContent = `Error: ${error.message}`;
    autoTagsStatus.style.color = "#c00";
  }
});

// Event listeners
tag1Select?.addEventListener("change", async (e) => {
  selectedTag1Id = e.target.value || null;
  selectedTag2Id = null;
  selectedTag3Ids = [];
  await renderTags2();
  await renderTags3();
});

tag2Select?.addEventListener("change", async (e) => {
  selectedTag2Id = e.target.value || null;
  selectedTag3Ids = [];
  await renderTags3();
});

tag3Select?.addEventListener("change", (e) => {
  const selected = Array.from(e.target.selectedOptions).map(opt => opt.value);
  selectedTag3Ids = selected.filter(id => id);
  renderTag3Chips();
});

// Crear Tags1
tag1Create?.addEventListener("click", async () => {
  const name = tag1New.value.trim();
  if (!name) return;
  
  const category = getProductCategory();
  const newTag = await createTag(name, 1, category, null);
  if (newTag) {
    selectedTag1Id = newTag.id;
    tag1New.value = "";
    await renderTags1();
  }
});

// Crear Tags2
tag2Create?.addEventListener("click", async () => {
  const name = tag2New.value.trim();
  if (!name || !selectedTag1Id) return;
  
  const category = getProductCategory();
  const newTag = await createTag(name, 2, category, selectedTag1Id);
  if (newTag) {
    selectedTag2Id = newTag.id;
    tag2New.value = "";
    await renderTags2();
  }
});

// Crear Tags3
tag3Create?.addEventListener("click", async () => {
  const name = tag3New.value.trim();
  if (!name || !selectedTag2Id || selectedTag3Ids.length >= 2) return;
  
  const category = getProductCategory();
  const newTag = await createTag(name, 3, category, selectedTag2Id);
  if (newTag) {
    selectedTag3Ids.push(newTag.id);
    tag3New.value = "";
    await renderTags3();
  }
});

// Guardar
saveBtn?.addEventListener("click", saveAndActivate);

// Cancelar
cancelBtn?.addEventListener("click", () => {
  window.location.href = "./incomplete-products.html";
});

// Cargar producto al iniciar
loadProduct();

