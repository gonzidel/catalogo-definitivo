// admin/incomplete-products.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

let currentProduct = null;
let selectedTag1Id = null;
let selectedTag2Id = null;
let selectedTag3Ids = [];

// Obtener categoría del producto
function getProductCategory(product) {
  const category = product?.category || "";
  if (category === "Calzado") return "Calzado";
  if (category === "Ropa") return "Ropa";
  if (category === "Lenceria" || category === "Marroquineria") return "Otros";
  return category || "Calzado";
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

// Cargar productos incompletos
async function loadIncompleteProducts() {
  const { data: products, error } = await supabase
    .from("products")
    .select("id, handle, name, category, description")
    .eq("status", "incomplete")
    .order("created_at", { ascending: false });

  if (error) {
    showMessage(`Error cargando productos: ${error.message}`, "err");
    return [];
  }

  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);

  if (warehousesError) {
    showMessage(`Error cargando almacenes: ${warehousesError.message}`, "err");
    return [];
  }

  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");

  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    showMessage("Error: No se encontraron los almacenes necesarios", "err");
    return [];
  }

  // Cargar variantes para cada producto
  const productsWithVariants = await Promise.all(
    (products || []).map(async (product) => {
      const { data: variants } = await supabase
        .from("product_variants")
        .select("id, sku, color, size, price")
        .eq("product_id", product.id)
        .order("color, size");

      if (!variants || variants.length === 0) {
        return {
          ...product,
          variants: [],
        };
      }

      // Obtener stocks por almacén para estas variantes
      const variantIds = variants.map(v => v.id);
      const { data: stocks, error: stocksError } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

      if (stocksError) {
        console.error("Error cargando stocks:", stocksError);
      }

      // Crear mapa de stocks por variante y almacén
      const stockMap = new Map();
      (stocks || []).forEach(s => {
        const key = `${s.variant_id}_${s.warehouse_id}`;
        stockMap.set(key, s.stock_qty || 0);
      });

      // Combinar datos: agregar stocks a cada variante
      const variantsWithStock = variants.map(v => {
        const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
        const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
        const stock_general = stockMap.get(stockGeneralKey) || 0;
        const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
        const stock_total = stock_general + stock_venta_publico;

        return {
          ...v,
          stock_general,
          stock_venta_publico,
          stock_total
        };
      });

      return {
        ...product,
        variants: variantsWithStock,
      };
    })
  );

  return productsWithVariants;
}

// Renderizar productos
function renderProducts(products, containerId) {
  const container = document.getElementById(containerId);
  
  if (!products || products.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay productos incompletos en esta categoría</div>';
    return;
  }

  container.innerHTML = products.map(product => {
    const variantsHtml = product.variants.map(v => `
      <div class="variant-item">
        <div class="variant-info">
          <strong>${v.color || 'Sin color'}</strong> - Talle: ${v.size || 'N/A'} | 
          SKU: <code>${v.sku}</code> | Precio: $${v.price || 0}
        </div>
        <div class="variant-stock">
          <div class="stock-column">
            <span class="stock-label">Stock Total:</span>
            <span class="stock-total-value" data-variant-id="${v.id}">${v.stock_total || 0}</span>
          </div>
          <div class="stock-column">
            <span class="stock-label">Stock General:</span>
            <input type="number" min="0" value="${v.stock_general || 0}" 
                   data-variant-id="${v.id}" 
                   data-field="stock_general"
                   data-sku="${v.sku}" 
                   class="stock-input main-stock-input" />
          </div>
          <div class="stock-column">
            <span class="stock-label">Stock Venta al Público:</span>
            <input type="number" min="0" value="${v.stock_venta_publico || 0}" 
                   data-variant-id="${v.id}" 
                   data-field="stock_venta_publico"
                   data-sku="${v.sku}" 
                   class="stock-input main-stock-input" />
          </div>
        </div>
      </div>
    `).join('');

    return `
      <div class="product-card" data-product-id="${product.id}">
        <div class="product-header">
          <div class="product-info">
            <h3>${product.name}</h3>
            <p><strong>Handle:</strong> ${product.handle}</p>
            <p><strong>Categoría:</strong> ${product.category}</p>
            <p><strong>Variantes:</strong> ${product.variants.length}</p>
            <p><strong>Tags:</strong> Completar en el modal</p>
          </div>
          <button class="btn-complete" onclick="openCompleteModal('${product.id}')">
            <span>✏️</span>
            <span>Completar</span>
          </button>
        </div>
        <div class="variants-list">
          ${variantsHtml}
        </div>
      </div>
    `;
  }).join('');

  // Configurar event listeners para actualizar stock total en la vista principal
  setupMainStockInputListeners(container);
}

// Configurar event listeners para inputs de stock en la vista principal
function setupMainStockInputListeners(container) {
  const stockInputs = container.querySelectorAll(".main-stock-input");
  stockInputs.forEach(input => {
    input.addEventListener("input", (e) => {
      const variantId = e.target.dataset.variantId;
      const field = e.target.dataset.field;
      const variantItem = e.target.closest(".variant-item");
      if (!variantItem) return;

      // Obtener valores actuales
      const stockGeneralInput = variantItem.querySelector(`input[data-field="stock_general"]`);
      const stockVentaPublicoInput = variantItem.querySelector(`input[data-field="stock_venta_publico"]`);
      
      const stockGeneral = parseInt(stockGeneralInput?.value || "0", 10);
      const stockVentaPublico = parseInt(stockVentaPublicoInput?.value || "0", 10);
      const stockTotal = stockGeneral + stockVentaPublico;

      // Actualizar el valor del stock total
      const stockTotalValue = variantItem.querySelector(`.stock-total-value[data-variant-id="${variantId}"]`);
      if (stockTotalValue) {
        stockTotalValue.textContent = stockTotal;
      }
    });
  });
}

// Abrir modal para completar producto
window.openCompleteModal = async function(productId) {
  const product = incompleteProducts.find(p => p.id === productId);
  if (!product) return;

  currentProduct = product;
  const modal = document.getElementById("complete-modal");
  const modalBody = document.getElementById("modal-body");
  const modalName = document.getElementById("modal-product-name");

  modalName.textContent = `Completar: ${product.name}`;

  // Cargar tags jerárquicos del producto
  const category = getProductCategory(product);
  let tag1Id = null, tag2Id = null, tag3Ids = [];
  try {
    const { data: pt } = await supabase
      .from("product_tags")
      .select("tag1_id, tag2_id, tag3_ids")
      .eq("product_id", product.id)
      .single();
    if (pt) {
      tag1Id = pt.tag1_id;
      tag2Id = pt.tag2_id;
      tag3Ids = pt.tag3_ids || [];
    }
  } catch (e) {
    console.warn("Error cargando tags jerárquicos:", e);
  }

  selectedTag1Id = tag1Id;
  selectedTag2Id = tag2Id;
  selectedTag3Ids = tag3Ids;

  const tags1 = await loadTags1(category);
  const tags2 = selectedTag1Id ? await loadTags2(selectedTag1Id) : [];
  const tags3 = selectedTag1Id ? await loadTags3(selectedTag1Id) : [];

  // Renderizar tags jerárquicos
  const tagsHtml = `
    <div class="tags-section">
      <label>Tags Jerárquicos</label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:8px;">
        <div>
          <label style="font-size:13px;color:#666;margin-bottom:4px;display:block;">Tags1 (Nivel 1)</label>
          <select id="modal-tag1-select" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;">
            <option value="">-- Seleccionar Tags1 --</option>
            ${tags1.map(t => `<option value="${t.id}" ${t.id === selectedTag1Id ? 'selected' : ''}>${t.name}</option>`).join('')}
          </select>
          <input type="text" id="modal-tag1-new" placeholder="O crear nuevo..." style="width:100%;margin-top:4px;padding:8px;border:1px solid #ddd;border-radius:8px;display:none;" />
          <button type="button" id="modal-tag1-create" class="btn" style="margin-top:4px;display:none;width:100%;padding:8px;">Crear Tags1</button>
        </div>
        <div>
          <label style="font-size:13px;color:#666;margin-bottom:4px;display:block;">Tags2 (Nivel 2)</label>
          <select id="modal-tag2-select" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;" ${!selectedTag1Id ? 'disabled' : ''}>
            <option value="">${selectedTag1Id ? '-- Seleccionar Tags2 --' : '-- Primero selecciona Tags1 --'}</option>
            ${tags2.map(t => `<option value="${t.id}" ${t.id === selectedTag2Id ? 'selected' : ''}>${t.name}</option>`).join('')}
          </select>
          <input type="text" id="modal-tag2-new" placeholder="O crear nuevo..." style="width:100%;margin-top:4px;padding:8px;border:1px solid #ddd;border-radius:8px;display:none;" />
          <button type="button" id="modal-tag2-create" class="btn" style="margin-top:4px;display:none;width:100%;padding:8px;">Crear Tags2</button>
        </div>
        <div>
          <label style="font-size:13px;color:#666;margin-bottom:4px;display:block;">Tags3 (Nivel 3) - Máx 2</label>
          <select id="modal-tag3-select" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:8px;" ${!selectedTag1Id ? 'disabled' : ''} multiple>
            ${tags3.map(t => `<option value="${t.id}" ${selectedTag3Ids.includes(t.id) ? 'selected' : ''}>${t.name}</option>`).join('')}
          </select>
          <input type="text" id="modal-tag3-new" placeholder="O crear nuevo..." style="width:100%;margin-top:4px;padding:8px;border:1px solid #ddd;border-radius:8px;display:none;" />
          <button type="button" id="modal-tag3-create" class="btn" style="margin-top:4px;display:none;width:100%;padding:8px;">Crear Tags3</button>
          <div id="modal-tag3-chips" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;"></div>
        </div>
      </div>
      <small style="color: #6c757d; margin-top: 8px; display: block;">
        Seleccioná Tags1, luego Tags2, y finalmente hasta 2 Tags3. Los Tags3 se pueden compartir entre diferentes Tags2 del mismo Tags1. Podés crear nuevos tags si no existen.
      </small>
    </div>
  `;

  // Renderizar variantes con stock
  const variantsHtml = product.variants.map(v => `
    <div class="variant-item">
      <div class="variant-info">
        <strong>${v.color || 'Sin color'}</strong> - Talle: ${v.size || 'N/A'} | 
        SKU: <code>${v.sku}</code> | Precio: $${v.price || 0}
      </div>
      <div class="variant-stock">
        <div class="stock-column">
          <span class="stock-label">Stock Total:</span>
          <span class="stock-total-value">${v.stock_total || 0}</span>
        </div>
        <div class="stock-column">
          <span class="stock-label">Stock General:</span>
          <input type="number" min="0" value="${v.stock_general || 0}" 
                 data-variant-id="${v.id}" 
                 data-field="stock_general"
                 class="stock-input modal-stock-input" />
        </div>
        <div class="stock-column">
          <span class="stock-label">Stock Venta al Público:</span>
          <input type="number" min="0" value="${v.stock_venta_publico || 0}" 
                 data-variant-id="${v.id}" 
                 data-field="stock_venta_publico"
                 class="stock-input modal-stock-input" />
        </div>
      </div>
    </div>
  `).join('');

  modalBody.innerHTML = `
    ${tagsHtml}
    <div class="variants-section">
      <h4>Stock por Variante</h4>
      <div class="variants-list">
        ${variantsHtml}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancelar</button>
      <button class="btn-save" onclick="saveAndActivate()">
        <span>💾</span>
        <span>Guardar y Activar</span>
      </button>
    </div>
  `;

  // Event listeners para tags jerárquicos
  setupTagListeners(category);

  // Renderizar chips de tags3
  renderModalTag3Chips();

  // Event listeners para actualizar stock total en tiempo real
  setupStockInputListeners();

  modal.classList.add("active");
};

// Configurar event listeners para inputs de stock en el modal
function setupStockInputListeners() {
  const stockInputs = document.querySelectorAll(".modal-stock-input");
  stockInputs.forEach(input => {
    input.addEventListener("input", (e) => {
      const variantId = e.target.dataset.variantId;
      const field = e.target.dataset.field;
      const variantItem = e.target.closest(".variant-item");
      if (!variantItem) return;

      // Obtener valores actuales
      const stockGeneralInput = variantItem.querySelector(`input[data-field="stock_general"]`);
      const stockVentaPublicoInput = variantItem.querySelector(`input[data-field="stock_venta_publico"]`);
      
      const stockGeneral = parseInt(stockGeneralInput?.value || "0", 10);
      const stockVentaPublico = parseInt(stockVentaPublicoInput?.value || "0", 10);
      const stockTotal = stockGeneral + stockVentaPublico;

      // Actualizar el valor del stock total
      const stockTotalValue = variantItem.querySelector(".stock-total-value");
      if (stockTotalValue) {
        stockTotalValue.textContent = stockTotal;
      }
    });
  });
}

// Configurar event listeners para tags jerárquicos en el modal
async function setupTagListeners(category) {
  const tag1Select = document.getElementById("modal-tag1-select");
  const tag1New = document.getElementById("modal-tag1-new");
  const tag1Create = document.getElementById("modal-tag1-create");
  const tag2Select = document.getElementById("modal-tag2-select");
  const tag2New = document.getElementById("modal-tag2-new");
  const tag2Create = document.getElementById("modal-tag2-create");
  const tag3Select = document.getElementById("modal-tag3-select");
  const tag3New = document.getElementById("modal-tag3-new");
  const tag3Create = document.getElementById("modal-tag3-create");

  tag1Select?.addEventListener("change", async (e) => {
    selectedTag1Id = e.target.value || null;
    selectedTag2Id = null;
    selectedTag3Ids = []; // Limpiar tags3 al cambiar tags1
    const tags2 = selectedTag1Id ? await loadTags2(selectedTag1Id) : [];
    tag2Select.innerHTML = '<option value="">-- Seleccionar Tags2 --</option>';
    tags2.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      tag2Select.appendChild(opt);
    });
    tag2Select.disabled = !selectedTag1Id;
    // Mostrar inputs de tags2 si hay tags1 pero no tags2 seleccionado
    if (selectedTag1Id && !selectedTag2Id) {
      tag2New.style.display = "block";
      tag2Create.style.display = "block";
    } else {
      tag2New.style.display = "none";
      tag2Create.style.display = "none";
    }
    // Cargar tags3 de todos los tags2 del tags1
    const tags3 = selectedTag1Id ? await loadTags3(selectedTag1Id) : [];
    tag3Select.innerHTML = "";
    tags3.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = selectedTag3Ids.includes(t.id);
      tag3Select.appendChild(opt);
    });
    tag3Select.disabled = !selectedTag1Id;
    // Mostrar inputs de tags3 solo si hay tags2 seleccionado y menos de 2 tags3
    if (selectedTag2Id && selectedTag3Ids.length < 2) {
      tag3New.style.display = "block";
      tag3Create.style.display = "block";
    } else {
      tag3New.style.display = "none";
      tag3Create.style.display = "none";
    }
    renderModalTag3Chips();
  });

  tag1Create?.addEventListener("click", async () => {
    const name = tag1New.value.trim();
    if (!name) return;
    const tag = await createTag(name, 1, category, null);
    if (tag) {
      selectedTag1Id = tag.id;
      tag1New.value = "";
      tag1New.style.display = "none";
      tag1Create.style.display = "none";
      const opt = document.createElement("option");
      opt.value = tag.id;
      opt.textContent = tag.name;
      opt.selected = true;
      tag1Select.appendChild(opt);
      tag1Select.value = tag.id;
      tag1Select.dispatchEvent(new Event("change"));
    }
  });

  tag2Select?.addEventListener("change", async (e) => {
    selectedTag2Id = e.target.value || null;
    // No limpiar tags3 al cambiar tags2, ya que pueden compartirse
    // Recargar tags3 para asegurar que estén actualizados
    const tags3 = selectedTag1Id ? await loadTags3(selectedTag1Id) : [];
    tag3Select.innerHTML = "";
    tags3.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.name;
      opt.selected = selectedTag3Ids.includes(t.id);
      tag3Select.appendChild(opt);
    });
    tag3Select.disabled = !selectedTag1Id;
    // Mostrar/ocultar inputs de tags2
    tag2New.style.display = selectedTag2Id ? "none" : "block";
    tag2Create.style.display = selectedTag2Id ? "none" : "block";
    // Mostrar/ocultar inputs de tags3 según si hay tags2 seleccionado y menos de 2 tags3
    if (selectedTag2Id && selectedTag3Ids.length < 2) {
      tag3New.style.display = "block";
      tag3Create.style.display = "block";
    } else {
      tag3New.style.display = "none";
      tag3Create.style.display = "none";
    }
    renderModalTag3Chips();
  });

  tag2Create?.addEventListener("click", async () => {
    const name = tag2New.value.trim();
    if (!name || !selectedTag1Id) return;
    const tag = await createTag(name, 2, category, selectedTag1Id);
    if (tag) {
      selectedTag2Id = tag.id;
      tag2New.value = "";
      tag2New.style.display = "none";
      tag2Create.style.display = "none";
      const opt = document.createElement("option");
      opt.value = tag.id;
      opt.textContent = tag.name;
      opt.selected = true;
      tag2Select.appendChild(opt);
      tag2Select.value = tag.id;
      tag2Select.dispatchEvent(new Event("change"));
    }
  });

  tag3Select?.addEventListener("change", async (e) => {
    const selected = Array.from(e.target.selectedOptions).map(opt => opt.value).filter(Boolean);
    if (selected.length > 2) {
      alert("Solo podés seleccionar hasta 2 Tags3");
      e.target.value = selectedTag3Ids[0] || "";
      return;
    }
    selectedTag3Ids = selected;
    renderModalTag3Chips();
    tag3New.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
    tag3Create.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
  });

  tag3Create?.addEventListener("click", async () => {
    const name = tag3New.value.trim();
    if (!name || !selectedTag2Id || selectedTag3Ids.length >= 2) return;
    const tag = await createTag(name, 3, category, selectedTag2Id);
    if (tag) {
      selectedTag3Ids.push(tag.id);
      tag3New.value = "";
      tag3New.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
      tag3Create.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
      const opt = document.createElement("option");
      opt.value = tag.id;
      opt.textContent = tag.name;
      opt.selected = true;
      tag3Select.appendChild(opt);
      renderModalTag3Chips();
    }
  });
}

// Renderizar chips de tags3 seleccionados en el modal
async function renderModalTag3Chips() {
  const tag3Chips = document.getElementById("modal-tag3-chips");
  if (!tag3Chips) return;
  if (!selectedTag1Id || selectedTag3Ids.length === 0) {
    tag3Chips.innerHTML = "";
    return;
  }
  const results = await Promise.all(selectedTag3Ids.map(id => 
    supabase.from("tags").select("name").eq("id", id).single()
  ));
  tag3Chips.innerHTML = "";
  results.forEach((result, idx) => {
    if (result.data) {
      const chip = document.createElement("span");
      chip.textContent = result.data.name;
      chip.style = "background:#e9ecef;border:1px solid #ddd;border-radius:20px;padding:6px 12px;display:inline-flex;gap:6px;align-items:center;font-size:14px;";
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "✕";
      x.style = "border:none;background:transparent;cursor:pointer;color:#666;";
      const tagId = selectedTag3Ids[idx];
      x.addEventListener("click", () => {
        selectedTag3Ids = selectedTag3Ids.filter(id => id !== tagId);
        const select = document.getElementById("modal-tag3-select");
        if (select) {
          Array.from(select.options).forEach(opt => {
            if (opt.value === tagId) opt.selected = false;
          });
        }
        renderModalTag3Chips();
      });
      chip.appendChild(x);
      tag3Chips.appendChild(chip);
    }
  });
}

// Cerrar modal
window.closeModal = function() {
  const modal = document.getElementById("complete-modal");
  modal.classList.remove("active");
  currentProduct = null;
};

// Guardar y activar producto
window.saveAndActivate = async function() {
  if (!currentProduct || !currentProduct.id) {
    showMessage("❌ Error: No se pudo identificar el producto", "err");
    return;
  }

  // Validar que se haya seleccionado al menos tags1
  if (!selectedTag1Id) {
    showMessage("Seleccioná al menos un Tags1", "err");
    return;
  }

  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);

  if (warehousesError) {
    showMessage(`Error cargando almacenes: ${warehousesError.message}`, "err");
    return;
  }

  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");

  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    showMessage("Error: No se encontraron los almacenes necesarios", "err");
    return;
  }

  // Obtener stocks actualizados desde el modal
  const stockInputs = document.querySelectorAll(".modal-stock-input");
  const stockUpdates = [];
  
  // Agrupar por variantId
  const variantStockMap = new Map();
  Array.from(stockInputs).forEach(input => {
    const variantId = input.dataset.variantId;
    const field = input.dataset.field;
    const value = parseInt(input.value, 10) || 0;
    
    if (!variantId) return;
    
    if (!variantStockMap.has(variantId)) {
      variantStockMap.set(variantId, {});
    }
    const stockData = variantStockMap.get(variantId);
    stockData[field] = value;
  });

  // Convertir a array de actualizaciones
  variantStockMap.forEach((stockData, variantId) => {
    stockUpdates.push({
      variantId,
      stock_general: stockData.stock_general !== undefined ? stockData.stock_general : 0,
      stock_venta_publico: stockData.stock_venta_publico !== undefined ? stockData.stock_venta_publico : 0,
    });
  });

  if (stockUpdates.length === 0) {
    showMessage("❌ Error: No se encontraron variantes para actualizar", "err");
    return;
  }

  try {
    // 1. Actualizar stocks en variant_warehouse_stock
    for (const update of stockUpdates) {
      if (!update.variantId) {
        console.warn("Variante sin ID, saltando:", update);
        continue;
      }
      
      // Actualizar stock general
      const { error: errorGeneral } = await supabase
        .from("variant_warehouse_stock")
        .upsert(
          { variant_id: update.variantId, warehouse_id: generalWarehouseId, stock_qty: update.stock_general },
          { onConflict: "variant_id,warehouse_id" }
        );
      
      if (errorGeneral) {
        console.error("Error actualizando stock general:", errorGeneral);
        throw new Error(`Error actualizando stock general: ${errorGeneral.message}`);
      }

      // Actualizar stock venta al público
      const { error: errorVentaPublico } = await supabase
        .from("variant_warehouse_stock")
        .upsert(
          { variant_id: update.variantId, warehouse_id: ventaPublicoWarehouseId, stock_qty: update.stock_venta_publico },
          { onConflict: "variant_id,warehouse_id" }
        );
      
      if (errorVentaPublico) {
        console.error("Error actualizando stock venta al público:", errorVentaPublico);
        throw new Error(`Error actualizando stock venta al público: ${errorVentaPublico.message}`);
      }
    }

    // 2. Actualizar tags jerárquicos
    const tagPayload = {
      product_id: currentProduct.id,
      tag1_id: selectedTag1Id || null,
      tag2_id: selectedTag2Id || null,
      tag3_ids: selectedTag3Ids.length > 0 ? selectedTag3Ids : null
    };
    
    // Verificar si ya existe un registro
    const { data: existing } = await supabase
      .from("product_tags")
      .select("product_id")
      .eq("product_id", currentProduct.id)
      .single();
    
    if (existing) {
      // Actualizar
      const { error: updateErr } = await supabase
        .from("product_tags")
        .update({
          tag1_id: tagPayload.tag1_id,
          tag2_id: tagPayload.tag2_id,
          tag3_ids: tagPayload.tag3_ids
        })
        .eq("product_id", currentProduct.id);
      
      if (updateErr) {
        console.error("Error actualizando tags jerárquicos:", updateErr);
        throw new Error(`Error actualizando tags: ${updateErr.message || updateErr}`);
      }
    } else {
      // Insertar nuevo
      const { error: insertErr } = await supabase
        .from("product_tags")
        .insert([tagPayload]);
      
      if (insertErr) {
        console.error("Error insertando tags jerárquicos:", insertErr);
        throw new Error(`Error insertando tags: ${insertErr.message || insertErr}`);
      }
    }

    // 3. Cambiar status a "active"
    const { error: updateError } = await supabase
      .from("products")
      .update({ status: "active" })
      .eq("id", currentProduct.id);
    
    if (updateError) {
      console.error("Error actualizando status:", updateError);
      throw new Error(`Error actualizando status: ${updateError.message}`);
    }

    // Guardar el nombre antes de cerrar el modal (por si currentProduct se vuelve null)
    const productName = currentProduct?.name || "el producto";
    
    // Cerrar modal y limpiar
    closeModal();
    
    // Mostrar mensaje de éxito
    showMessage(`✅ Producto "${productName}" completado y activado exitosamente`, "ok");
    
    // Recargar productos
    await refreshProducts();
  } catch (error) {
    console.error("Error completo al guardar:", error);
    const errorMessage = error?.message || error?.toString() || "Error desconocido";
    showMessage(`❌ Error al guardar: ${errorMessage}`, "err");
  }
};

// Mostrar mensaje
function showMessage(text, type = "ok") {
  const container = document.getElementById("message-container");
  const message = document.createElement("div");
  message.className = `message ${type}`;
  message.textContent = text;
  container.innerHTML = "";
  container.appendChild(message);
  
  if (type === "ok") {
    setTimeout(() => {
      message.remove();
    }, 5000);
  }
}

// Refrescar productos
async function refreshProducts() {
  incompleteProducts = await loadIncompleteProducts();
  
  const shoes = incompleteProducts.filter(p => p.category === "Calzado");
  const clothing = incompleteProducts.filter(p => p.category === "Ropa");
  
  renderProducts(shoes, "shoes-container");
  renderProducts(clothing, "clothing-container");
}

// Cerrar modal con botón X
document.getElementById("close-modal")?.addEventListener("click", closeModal);

// Cerrar modal con ESC
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModal();
  }
});

// Cargar productos al iniciar
let incompleteProducts = [];
refreshProducts();
