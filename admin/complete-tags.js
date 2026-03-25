// admin/complete-tags.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

// Estado
let currentProductId = null;
let currentProductCategory = null;
let selectedTag1Id = null;
let selectedTag2Id = null;
let selectedTag3Ids = [];
let selectedDetailsIds = [];
let selectedHighlightsIds = [];

// Elementos del DOM
const productsContainer = document.getElementById("products-container");
const tagsSection = document.getElementById("tags-section");
const selectedProductName = document.getElementById("selected-product-name");
const selectedProductCategory = document.getElementById("selected-product-category");
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
const detailsSearch = document.getElementById("details-search");
const detailsList = document.getElementById("details-list");
const highlightsContainer = document.getElementById("highlights-container");
const saveTagsBtn = document.getElementById("save-tags-btn");
const tagsStatus = document.getElementById("tags-status");

// Función auxiliar para normalizar nombres
function normalizeName(str) {
  return (str || "").toLowerCase().trim().replace(/\s+/g, " ");
}

// Obtener categoría del producto
function getProductCategory() {
  return currentProductCategory || "";
}

// Cargar productos sin tags (status = 'missing_tags')
async function loadProductsWithoutTags() {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, handle, name, category, description")
      .eq("status", "missing_tags")
      .order("created_at", { ascending: false });

    if (error) {
      showStatus(`Error cargando productos: ${error.message}`, "error");
      return;
    }

    if (!products || products.length === 0) {
      productsContainer.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">✅</div>
          <p>No hay productos sin tags</p>
        </div>
      `;
      return;
    }

    renderProducts(products);
  } catch (error) {
    console.error("Error cargando productos:", error);
    showStatus(`Error: ${error.message}`, "error");
  }
}

// Renderizar lista de productos
function renderProducts(products) {
  productsContainer.innerHTML = "";
  
  products.forEach(product => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.dataset.productId = product.id;
    card.innerHTML = `
      <h3>${product.name || "(sin nombre)"}</h3>
      <p><strong>Categoría:</strong> ${product.category || "N/A"}</p>
      <p><strong>Handle:</strong> ${product.handle || "N/A"}</p>
    `;
    
    card.addEventListener("click", () => selectProduct(product));
    productsContainer.appendChild(card);
  });
}

// Seleccionar producto
async function selectProduct(product) {
  // Remover selección anterior
  document.querySelectorAll(".product-card").forEach(card => {
    card.classList.remove("selected");
  });
  
  // Marcar como seleccionado
  const card = document.querySelector(`[data-product-id="${product.id}"]`);
  if (card) {
    card.classList.add("selected");
  }
  
  currentProductId = product.id;
  currentProductCategory = product.category;
  
  // Mostrar información del producto
  selectedProductName.textContent = product.name || "(sin nombre)";
  selectedProductCategory.textContent = `Categoría: ${product.category || "N/A"}`;
  
  // Mostrar sección de tags
  tagsSection.classList.add("active");
  
  // Cargar tags existentes del producto
  await loadProductTags(product.id);
  
  // Cargar tags disponibles según categoría
  await renderTags1();
  
  // Cargar detalles y destacados
  await loadProductDetails(product.id);
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
    selectedHighlightsIds = productTags?.tag3_ids || [];
    
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
  
  // Deduplicar por nombre (case-insensitive)
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

// Cargar detalles del producto
async function loadProductDetails(productId) {
  if (!productId) {
    selectedDetailsIds = [];
    selectedHighlightsIds = [];
    renderDetailsList();
    renderHighlights();
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
    
    // Cargar highlights desde product_tags
    const { data: productTags } = await supabase
      .from("product_tags")
      .select("tag3_ids")
      .eq("product_id", productId)
      .maybeSingle();
    
    selectedHighlightsIds = productTags?.tag3_ids || [];
    
    renderDetailsList();
    renderHighlights();
  } catch (error) {
    console.error("Error cargando details:", error);
  }
}

// Renderizar lista de detalles
async function renderDetailsList() {
  if (!selectedTag1Id || !selectedTag2Id) {
    detailsList.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;padding:8px;">
        Selecciona Tags1 y Tags2 para ver detalles disponibles
      </div>
    `;
    return;
  }
  
  const tags3 = await loadTags3(selectedTag1Id);
  const searchTerm = detailsSearch.value.toLowerCase();
  const filteredTags3 = tags3.filter(tag => 
    tag.name.toLowerCase().includes(searchTerm)
  );
  
  detailsList.innerHTML = "";
  
  filteredTags3.forEach(tag => {
    const item = document.createElement("div");
    item.className = "detail-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = tag.id;
    checkbox.checked = selectedDetailsIds.includes(tag.id);
    checkbox.addEventListener("change", (e) => {
      if (e.target.checked) {
        if (!selectedDetailsIds.includes(tag.id)) {
          selectedDetailsIds.push(tag.id);
        }
      } else {
        selectedDetailsIds = selectedDetailsIds.filter(id => id !== tag.id);
        // Remover de highlights si estaba
        selectedHighlightsIds = selectedHighlightsIds.filter(id => id !== tag.id);
        renderHighlights();
      }
      renderDetailsList();
    });
    
    const label = document.createElement("label");
    label.textContent = tag.name;
    label.style.cursor = "pointer";
    label.style.margin = 0;
    label.style.flex = 1;
    
    item.appendChild(checkbox);
    item.appendChild(label);
    detailsList.appendChild(item);
  });
}

// Renderizar highlights
function renderHighlights() {
  highlightsContainer.innerHTML = "";
  
  if (selectedHighlightsIds.length === 0) {
    highlightsContainer.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;width:100%;padding:4px;">
        Selecciona hasta 2 detalles de los seleccionados arriba
      </div>
    `;
    return;
  }
  
  Promise.all(selectedHighlightsIds.map(id => 
    supabase.from("tags").select("name").eq("id", id).single()
  )).then(results => {
    results.forEach((result, idx) => {
      if (result.data) {
        const chip = document.createElement("span");
        chip.className = "highlight-chip";
        chip.textContent = result.data.name;
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "✕";
        x.addEventListener("click", () => {
          selectedHighlightsIds = selectedHighlightsIds.filter((_, i) => i !== idx);
          renderHighlights();
        });
        chip.appendChild(x);
        highlightsContainer.appendChild(chip);
      }
    });
  });
}

// Guardar tags y detalles
async function saveTagsAndDetails() {
  if (!currentProductId) {
    showStatus("Error: No hay producto seleccionado", "error");
    return;
  }
  
  // Validar Tags1 y Tags2
  if (!selectedTag1Id || !selectedTag2Id) {
    showStatus("Error: Tags1 y Tags2 son obligatorios", "error");
    return;
  }
  
  // Validar highlights (máx 2)
  if (selectedHighlightsIds.length > 2) {
    showStatus("Error: Máximo 2 highlights permitidos", "error");
    return;
  }
  
  // Validar que highlights estén en details
  const invalidHighlights = selectedHighlightsIds.filter(id => !selectedDetailsIds.includes(id));
  if (invalidHighlights.length > 0) {
    showStatus("Error: Los highlights deben estar en la lista de details", "error");
    return;
  }
  
  tagsStatus.textContent = "Guardando...";
  tagsStatus.className = "status-message info";
  
  try {
    // 1. Guardar tags jerárquicos
    const { data: existingTags, error: checkError } = await supabase
      .from("product_tags")
      .select("product_id")
      .eq("product_id", currentProductId)
      .maybeSingle();
    
    const tagPayload = {
      product_id: currentProductId,
      tag1_id: selectedTag1Id,
      tag2_id: selectedTag2Id,
      tag3_ids: selectedHighlightsIds.length > 0 ? selectedHighlightsIds : null
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
    
    // 2. Guardar details
    const { data: currentDetails, error: detailsError } = await supabase
      .from("product_tag_details")
      .select("tag3_id")
      .eq("product_id", currentProductId);
    
    if (detailsError) throw detailsError;
    
    const currentIds = new Set((currentDetails || []).map(d => d.tag3_id));
    const newIds = new Set(selectedDetailsIds);
    
    // Insertar nuevos
    const toInsert = selectedDetailsIds.filter(id => !currentIds.has(id));
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase
        .from("product_tag_details")
        .insert(toInsert.map(tag3_id => ({ product_id: currentProductId, tag3_id })));
      
      if (insertError) throw insertError;
    }
    
    // Eliminar removidos
    const toDelete = Array.from(currentIds).filter(id => !newIds.has(id));
    if (toDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from("product_tag_details")
        .delete()
        .eq("product_id", currentProductId)
        .in("tag3_id", toDelete);
      
      if (deleteError) throw deleteError;
    }
    
    tagsStatus.textContent = "✓ Tags guardados correctamente. El estado del producto se actualizará automáticamente.";
    tagsStatus.className = "status-message success";
    
    // Recargar productos (el producto debería desaparecer de la lista)
    setTimeout(() => {
      loadProductsWithoutTags();
      tagsSection.classList.remove("active");
      currentProductId = null;
    }, 2000);
    
  } catch (error) {
    console.error("Error guardando tags:", error);
    tagsStatus.textContent = `Error: ${error.message}`;
    tagsStatus.className = "status-message error";
  }
}

// Función auxiliar para mostrar mensajes
function showStatus(message, type = "info") {
  // Esta función se puede implementar si se necesita mostrar mensajes globales
  console.log(`[${type}] ${message}`);
}

// Event listeners
tag1Select?.addEventListener("change", async (e) => {
  selectedTag1Id = e.target.value || null;
  selectedTag2Id = null;
  selectedTag3Ids = [];
  await renderTags2();
  await renderTags3();
  await loadProductDetails(currentProductId);
});

tag2Select?.addEventListener("change", async (e) => {
  selectedTag2Id = e.target.value || null;
  selectedTag3Ids = [];
  await renderTags3();
  await loadProductDetails(currentProductId);
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

// Auto-tags con IA (simplificado - copiar lógica completa de products.js si es necesario)
autoTagsBtn?.addEventListener("click", async () => {
  if (!currentProductId) {
    autoTagsStatus.textContent = "Error: No hay producto seleccionado";
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
        await loadProductDetails(currentProductId);
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

// Búsqueda de detalles
detailsSearch?.addEventListener("input", () => {
  renderDetailsList();
});

// Agregar highlights desde details
detailsList?.addEventListener("change", (e) => {
  if (e.target.type === "checkbox" && e.target.checked) {
    const tag3Id = e.target.value;
    if (selectedDetailsIds.includes(tag3Id) && selectedHighlightsIds.length < 2) {
      if (!selectedHighlightsIds.includes(tag3Id)) {
        selectedHighlightsIds.push(tag3Id);
        renderHighlights();
      }
    }
  }
});

// Guardar
saveTagsBtn?.addEventListener("click", saveTagsAndDetails);

// Cargar productos al iniciar
loadProductsWithoutTags();

