// admin/fyl-products.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { checkPermission } from "./permissions-helper.js";

await requireAuth();

// Verificar permisos de stock
let canViewStock = false;
let canEditStock = false;

async function checkStockPermissions() {
  canViewStock = await checkPermission('stock', 'view');
  canEditStock = await checkPermission('stock', 'edit');
  
  if (!canViewStock) {
    alert("No tienes permiso para ver el stock.");
    window.location.href = "./index.html";
    return;
  }
}

await checkStockPermissions();

// Elementos del DOM
const productsContainer = document.getElementById("products-container");
const searchInput = document.getElementById("search-input");
const resultsCount = document.getElementById("results-count");
const reloadBtn = document.getElementById("reload-btn");
const errorContainer = document.getElementById("error-container");
const noResults = document.getElementById("no-results");

// Modal
const editModal = document.getElementById("edit-modal");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const modalSaveBtn = document.getElementById("modal-save-btn");
const modalProductName = document.getElementById("modal-product-name");
const modalVariantsTbody = document.getElementById("modal-variants-tbody");

// Datos
let allProducts = []; // Array de productos con sus variantes
let filteredProducts = [];
let currentEditingProduct = null;
let warehouseIds = { general: null, ventaPublico: null };

// Cargar IDs de almacenes
async function loadWarehouseIds() {
  const { data: warehouses, error } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (error) {
    console.error("Error cargando almacenes:", error);
    showError(`Error cargando almacenes: ${error.message}`);
    return false;
  }
  
  warehouses.forEach(w => {
    if (w.code === "general") warehouseIds.general = w.id;
    if (w.code === "venta-publico") warehouseIds.ventaPublico = w.id;
  });
  
  if (!warehouseIds.general || !warehouseIds.ventaPublico) {
    showError("Error: No se encontraron los almacenes necesarios");
    return false;
  }
  
  return true;
}

// Cargar productos FYL
async function loadProducts() {
  productsContainer.innerHTML = '<div class="loading">Cargando productos...</div>';
  errorContainer.innerHTML = "";
  noResults.style.display = "none";
  
  // Cargar almacenes primero
  const warehousesLoaded = await loadWarehouseIds();
  if (!warehousesLoaded) {
    productsContainer.innerHTML = "";
    return;
  }
  
  try {
    // Obtener proveedor FYL
    const { data: supplier, error: supplierError } = await supabase
      .from("suppliers")
      .select("id, name")
      .eq("name", "FYL")
      .single();
    
    if (supplierError || !supplier) {
      showError("No se encontró el proveedor FYL. Asegúrate de que existe en la base de datos.");
      productsContainer.innerHTML = "";
      return;
    }
    
    // Obtener productos del proveedor FYL
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, name, handle, category, status")
      .eq("supplier_id", supplier.id)
      .neq("status", "archived")
      .order("name", { ascending: true });
    
    if (productsError) {
      showError(`Error cargando productos: ${productsError.message}`);
      productsContainer.innerHTML = "";
      return;
    }
    
    if (!products || products.length === 0) {
      productsContainer.innerHTML = "";
      noResults.style.display = "block";
      updateResultsCount(0);
      return;
    }
    
    // Obtener todas las variantes de estos productos
    const productIds = products.map(p => p.id);
    const { data: variants, error: variantsError } = await supabase
      .from("product_variants")
      .select("id, product_id, color, size, sku, price, active")
      .in("product_id", productIds)
      .order("color", { ascending: true })
      .order("size", { ascending: true });
    
    if (variantsError) {
      showError(`Error cargando variantes: ${variantsError.message}`);
      productsContainer.innerHTML = "";
      return;
    }
    
    // Obtener imágenes de variantes
    const variantIds = (variants || []).map(v => v.id);
    let images = [];
    if (variantIds.length > 0) {
      const { data: imagesData, error: imagesError } = await supabase
        .from("variant_images")
        .select("variant_id, url, position")
        .in("variant_id", variantIds)
        .order("position", { ascending: true });
      
      if (imagesError) {
        console.error("Error cargando imágenes:", imagesError);
      } else {
        images = imagesData || [];
      }
    }
    
    // Crear mapa de imágenes por producto (primera imagen de la primera variante)
    const productImages = new Map();
    products.forEach(product => {
      const productVariants = variants.filter(v => v.product_id === product.id);
      if (productVariants.length > 0) {
        const firstVariantId = productVariants[0].id;
        const firstImage = images.find(img => img.variant_id === firstVariantId && img.position === 1);
        if (firstImage) {
          productImages.set(product.id, firstImage.url);
        }
      }
    });
    
    // Obtener stocks de todas las variantes
    let stocks = [];
    if (variantIds.length > 0) {
      const { data: stocksData, error: stocksError } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", [warehouseIds.general, warehouseIds.ventaPublico]);
      
      if (stocksError) {
        console.error("Error cargando stocks:", stocksError);
      } else {
        stocks = stocksData || [];
      }
    }
    
    // Crear mapa de stocks
    const stockMap = new Map();
    stocks.forEach(s => {
      const key = `${s.variant_id}_${s.warehouse_id}`;
      stockMap.set(key, s.stock_qty || 0);
    });
    
    // Agrupar variantes por producto y agregar stocks
    allProducts = products.map(product => {
      const productVariants = (variants || [])
        .filter(v => v.product_id === product.id)
        .map(variant => {
          const stockGeneralKey = `${variant.id}_${warehouseIds.general}`;
          const stockVentaPublicoKey = `${variant.id}_${warehouseIds.ventaPublico}`;
          const stock_general = stockMap.get(stockGeneralKey) || 0;
          const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
          const stock_total = stock_general + stock_venta_publico;
          
          return {
            ...variant,
            stock_general,
            stock_venta_publico,
            stock_total
          };
        });
      
      return {
        ...product,
        variants: productVariants,
        image_url: productImages.get(product.id) || null
      };
    });
    
    // Filtrar productos sin variantes
    allProducts = allProducts.filter(p => p.variants.length > 0);
    
    filteredProducts = [...allProducts];
    renderProducts();
    
  } catch (error) {
    console.error("Error en loadProducts:", error);
    showError(`Error: ${error.message}`);
    productsContainer.innerHTML = "";
  }
}

// Renderizar productos
function renderProducts() {
  if (filteredProducts.length === 0) {
    productsContainer.innerHTML = "";
    noResults.style.display = "block";
    updateResultsCount(0);
    return;
  }
  
  noResults.style.display = "none";
  updateResultsCount(filteredProducts.length);
  
  const isMobile = window.innerWidth <= 768;
  
  productsContainer.innerHTML = filteredProducts.map(product => {
    const totalStock = product.variants.reduce((sum, v) => sum + v.stock_total, 0);
    const activeVariants = product.variants.filter(v => v.active).length;
    const hasLowStock = product.variants.some(v => v.stock_total <= 3);
    
    // Calcular precio promedio o rango de precios
    const prices = product.variants.map(v => v.price || 0).filter(p => p > 0);
    let priceDisplay = "";
    if (prices.length > 0) {
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      if (minPrice === maxPrice) {
        priceDisplay = formatPrice(minPrice);
      } else {
        priceDisplay = `${formatPrice(minPrice)} - ${formatPrice(maxPrice)}`;
      }
    }
    
    if (isMobile) {
      // Layout móvil: agrupar por color
      const variantsByColor = {};
      product.variants.forEach(variant => {
        const color = variant.color || "Sin color";
        if (!variantsByColor[color]) {
          variantsByColor[color] = [];
        }
        variantsByColor[color].push(variant);
      });
      
      const colorsHtml = Object.entries(variantsByColor).map(([color, variants]) => {
        const colorTotalGeneral = variants.reduce((sum, v) => sum + v.stock_general, 0);
        const colorTotalVenta = variants.reduce((sum, v) => sum + v.stock_venta_publico, 0);
        const colorTotal = colorTotalGeneral + colorTotalVenta;
        const colorId = `color-${product.id}-${color.replace(/\s+/g, '-')}`;
        const allActive = variants.every(v => v.active);
        
        const sizesHtml = variants.map(variant => {
          return `
            <div class="mobile-size-item" data-variant-id="${variant.id}">
              <div class="mobile-size-name">Talle ${variant.size || "N/A"}</div>
              <div class="mobile-size-stocks">
                <div class="mobile-stock-item">
                  <span class="mobile-stock-label">General:</span>
                  <input 
                    type="number" 
                    min="0" 
                    value="${variant.stock_general}" 
                    class="mobile-stock-input mobile-stock-general"
                    data-variant-id="${variant.id}"
                    ${!canEditStock ? 'disabled' : ''}
                  />
                </div>
                <div class="mobile-stock-item">
                  <span class="mobile-stock-label">Venta Público:</span>
                  <input 
                    type="number" 
                    min="0" 
                    value="${variant.stock_venta_publico}" 
                    class="mobile-stock-input mobile-stock-venta"
                    data-variant-id="${variant.id}"
                    ${!canEditStock ? 'disabled' : ''}
                  />
                </div>
                <div class="mobile-stock-item mobile-stock-total">
                  <span class="mobile-stock-label">Total:</span>
                  <span class="mobile-stock-total-value" data-variant-id="${variant.id}">${variant.stock_total}</span>
                </div>
              </div>
              <div class="mobile-size-status">
                <input 
                  type="checkbox" 
                  ${variant.active ? 'checked' : ''}
                  class="mobile-status-checkbox"
                  data-variant-id="${variant.id}"
                  ${!canEditStock ? 'disabled' : ''}
                />
                <span class="status-badge ${variant.active ? 'status-active' : 'status-inactive'} mobile-status-badge" data-variant-id="${variant.id}">
                  ${variant.active ? 'Activo' : 'Inactivo'}
                </span>
              </div>
            </div>
          `;
        }).join("");
        
        return `
          <div class="mobile-color-group">
            <div class="mobile-color-header" data-color-id="${colorId}">
              <div class="mobile-color-info">
                <div class="mobile-color-name">${escapeHtml(color)}</div>
                <div class="mobile-color-summary">
                  ${variants.length} talle${variants.length !== 1 ? 's' : ''} • 
                  General: ${colorTotalGeneral} • 
                  Venta: ${colorTotalVenta} • 
                  Total: <strong>${colorTotal}</strong>
                </div>
              </div>
              <div class="mobile-color-stats">
                <span class="status-badge ${allActive ? 'status-active' : 'status-inactive'}">
                  ${allActive ? 'Activo' : 'Inactivo'}
                </span>
                <span class="mobile-expand-icon">▼</span>
              </div>
            </div>
            <div class="mobile-color-details" id="${colorId}" style="display: none;">
              ${sizesHtml}
            </div>
          </div>
        `;
      }).join("");
      
      return `
        <div class="product-card mobile-product-card" data-product-id="${product.id}">
          <div class="product-card-header">
            <div class="product-card-header-top">
              ${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" class="product-card-image" onerror="this.style.display='none'">` : ''}
              <div class="product-card-header-text">
                <div class="product-card-title">${escapeHtml(product.name)}</div>
                <div class="product-card-meta">
                  ${product.category || "Sin categoría"} • ${product.variants.length} variante${product.variants.length !== 1 ? 's' : ''} 
                  • ${activeVariants} activa${activeVariants !== 1 ? 's' : ''} • Stock total: ${totalStock}
                </div>
                ${priceDisplay ? `<div class="product-card-price">Precio: ${priceDisplay}</div>` : ''}
              </div>
            </div>
          </div>
          <div class="product-card-body mobile-product-body">
            ${colorsHtml}
          </div>
        </div>
      `;
    } else {
      // Layout desktop: tabla completa
      const variantsHtml = product.variants.map(variant => {
        const lowStockClass = variant.stock_total <= 3 ? "low-stock" : "";
        const variantPrice = variant.price ? formatPrice(variant.price) : "N/A";
        return `
          <div class="variant-item ${lowStockClass}">
            <div class="variant-info">
              <div class="variant-color-size">${variant.color || "Sin color"} - ${variant.size || "Sin talle"}</div>
              <div class="variant-sku">SKU: ${variant.sku || "N/A"}</div>
            </div>
            <div class="variant-price">${variantPrice}</div>
            <div class="stock-info">
              <div class="stock-label">General</div>
              <div class="stock-value">${variant.stock_general}</div>
            </div>
            <div class="stock-info">
              <div class="stock-label">Venta Público</div>
              <div class="stock-value">${variant.stock_venta_publico}</div>
            </div>
            <div class="stock-info">
              <div class="stock-label">Total</div>
              <div class="stock-value stock-total">${variant.stock_total}</div>
            </div>
            <div class="variant-status">
              <span class="status-badge ${variant.active ? 'status-active' : 'status-inactive'}">
                ${variant.active ? 'Activo' : 'Inactivo'}
              </span>
            </div>
          </div>
        `;
      }).join("");
      
      return `
        <div class="product-card" data-product-id="${product.id}">
          <div class="product-card-header">
            <div class="product-card-header-top">
              ${product.image_url ? `<img src="${escapeHtml(product.image_url)}" alt="${escapeHtml(product.name)}" class="product-card-image" onerror="this.style.display='none'">` : ''}
              <div class="product-card-header-text">
                <div class="product-card-title">${escapeHtml(product.name)}</div>
                <div class="product-card-meta">
                  ${product.category || "Sin categoría"} • ${product.variants.length} variante${product.variants.length !== 1 ? 's' : ''} 
                  • ${activeVariants} activa${activeVariants !== 1 ? 's' : ''} • Stock total: ${totalStock}
                </div>
                ${priceDisplay ? `<div class="product-card-price">Precio: ${priceDisplay}</div>` : ''}
              </div>
            </div>
          </div>
          <div class="product-card-body">
            <div class="variants-header">
              <div class="variant-header-col variant-header-info">Variante</div>
              <div class="variant-header-col variant-header-price">Precio</div>
              <div class="variant-header-col variant-header-stock">General</div>
              <div class="variant-header-col variant-header-stock">Venta Público</div>
              <div class="variant-header-col variant-header-stock">Total</div>
              <div class="variant-header-col variant-header-status">Estado</div>
            </div>
            <div class="variants-list">
              ${variantsHtml}
            </div>
          </div>
        </div>
      `;
    }
  }).join("");
  
  // Agregar event listeners
  if (isMobile) {
    // Event listeners para expandir/colapsar colores en móvil
    productsContainer.querySelectorAll(".mobile-color-header").forEach(header => {
      header.addEventListener("click", (e) => {
        e.stopPropagation();
        const colorId = header.getAttribute("data-color-id");
        const details = document.getElementById(colorId);
        const icon = header.querySelector(".mobile-expand-icon");
        if (details) {
          const isExpanded = details.style.display !== "none";
          details.style.display = isExpanded ? "none" : "block";
          icon.textContent = isExpanded ? "▼" : "▲";
        }
      });
    });
    
    // Event listeners para editar stock en móvil
    productsContainer.querySelectorAll(".mobile-stock-input").forEach(input => {
      input.addEventListener("input", (e) => {
        const variantId = input.getAttribute("data-variant-id");
        const generalInput = productsContainer.querySelector(
          `.mobile-stock-general[data-variant-id="${variantId}"]`
        );
        const ventaInput = productsContainer.querySelector(
          `.mobile-stock-venta[data-variant-id="${variantId}"]`
        );
        const totalEl = productsContainer.querySelector(
          `.mobile-stock-total-value[data-variant-id="${variantId}"]`
        );
        
        if (generalInput && ventaInput && totalEl) {
          const total = parseInt(generalInput.value || 0) + parseInt(ventaInput.value || 0);
          totalEl.textContent = total;
        }
      });
      
      input.addEventListener("blur", async (e) => {
        if (!canEditStock) return;
        await saveMobileStockChange(input);
      });
    });
    
    // Event listeners para cambiar estado activo en móvil
    productsContainer.querySelectorAll(".mobile-status-checkbox").forEach(checkbox => {
      checkbox.addEventListener("change", async (e) => {
        if (!canEditStock) return;
        await saveMobileStatusChange(checkbox);
      });
    });
  } else {
    // Event listeners para abrir modal en desktop
    productsContainer.querySelectorAll(".product-card").forEach(card => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".variant-item")) return;
        
        const productId = card.getAttribute("data-product-id");
        const product = filteredProducts.find(p => p.id === productId);
        if (product && canEditStock) {
          openEditModal(product);
        }
      });
    });
  }
}

// Abrir modal de edición
function openEditModal(product) {
  currentEditingProduct = product;
  modalProductName.textContent = product.name;
  modalVariantsTbody.innerHTML = "";
  
  product.variants.forEach(variant => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td data-label="Color">${escapeHtml(variant.color || "Sin color")}</td>
      <td data-label="Talle">${escapeHtml(variant.size || "Sin talle")}</td>
      <td data-label="SKU">${escapeHtml(variant.sku || "N/A")}</td>
      <td class="cell-center" data-label="Precio">
        <input 
          type="number" 
          min="0" 
          step="0.01"
          value="${variant.price || 0}" 
          data-variant-id="${variant.id}"
          data-field="price"
          ${!canEditStock ? 'disabled' : ''}
          style="width: 100px;"
        />
      </td>
      <td class="cell-center" data-label="Stock General">
        <input 
          type="number" 
          min="0" 
          value="${variant.stock_general}" 
          data-variant-id="${variant.id}"
          data-field="stock_general"
          ${!canEditStock ? 'disabled' : ''}
        />
      </td>
      <td class="cell-center" data-label="Stock Venta Público">
        <input 
          type="number" 
          min="0" 
          value="${variant.stock_venta_publico}" 
          data-variant-id="${variant.id}"
          data-field="stock_venta_publico"
          ${!canEditStock ? 'disabled' : ''}
        />
      </td>
      <td class="cell-center" data-label="Total">
        <strong id="total-${variant.id}">${variant.stock_total}</strong>
      </td>
      <td class="cell-center" data-label="Activo">
        <input 
          type="checkbox" 
          ${variant.active ? 'checked' : ''}
          data-variant-id="${variant.id}"
          data-field="active"
          ${!canEditStock ? 'disabled' : ''}
        />
      </td>
    `;
    modalVariantsTbody.appendChild(row);
  });
  
  // Agregar event listeners para recalcular totales
  modalVariantsTbody.querySelectorAll("input[type='number']").forEach(input => {
    input.addEventListener("input", () => {
      const variantId = input.getAttribute("data-variant-id");
      const stockGeneralInput = modalVariantsTbody.querySelector(
        `input[data-variant-id="${variantId}"][data-field="stock_general"]`
      );
      const stockVentaInput = modalVariantsTbody.querySelector(
        `input[data-variant-id="${variantId}"][data-field="stock_venta_publico"]`
      );
      const totalEl = document.getElementById(`total-${variantId}`);
      
      if (stockGeneralInput && stockVentaInput && totalEl) {
        const total = parseInt(stockGeneralInput.value || 0) + parseInt(stockVentaInput.value || 0);
        totalEl.textContent = total;
      }
    });
  });
  
  editModal.classList.add("show");
}

// Cerrar modal
function closeEditModal() {
  editModal.classList.remove("show");
  currentEditingProduct = null;
}

// Guardar cambios del modal
async function saveModalChanges() {
  if (!canEditStock) {
    alert("No tienes permiso para editar el stock.");
    return;
  }
  
  if (!currentEditingProduct) return;
  
  modalSaveBtn.disabled = true;
  modalSaveBtn.textContent = "Guardando...";
  
  try {
    const updates = [];
    const variantUpdates = [];
    
    // Recopilar todos los cambios
    modalVariantsTbody.querySelectorAll("tr").forEach(row => {
      const variantId = row.querySelector("input[data-field='stock_general']")?.getAttribute("data-variant-id");
      if (!variantId) return;
      
      const price = parseFloat(row.querySelector("input[data-field='price']")?.value || 0);
      const stockGeneral = parseInt(row.querySelector("input[data-field='stock_general']")?.value || 0);
      const stockVentaPublico = parseInt(row.querySelector("input[data-field='stock_venta_publico']")?.value || 0);
      const active = row.querySelector("input[data-field='active']")?.checked || false;
      
      const originalVariant = currentEditingProduct.variants.find(v => v.id === variantId);
      if (!originalVariant) return;
      
      // Actualizar precio
      if (price !== (originalVariant.price || 0)) {
        variantUpdates.push(
          supabase
            .from("product_variants")
            .update({ price })
            .eq("id", variantId)
        );
      }
      
      // Actualizar stock general
      if (stockGeneral !== originalVariant.stock_general) {
        updates.push(
          supabase
            .from("variant_warehouse_stock")
            .upsert(
              { 
                variant_id: variantId, 
                warehouse_id: warehouseIds.general, 
                stock_qty: stockGeneral 
              },
              { onConflict: "variant_id,warehouse_id" }
            )
        );
      }
      
      // Actualizar stock venta público
      if (stockVentaPublico !== originalVariant.stock_venta_publico) {
        updates.push(
          supabase
            .from("variant_warehouse_stock")
            .upsert(
              { 
                variant_id: variantId, 
                warehouse_id: warehouseIds.ventaPublico, 
                stock_qty: stockVentaPublico 
              },
              { onConflict: "variant_id,warehouse_id" }
            )
        );
      }
      
      // Actualizar estado activo
      if (active !== originalVariant.active) {
        variantUpdates.push(
          supabase
            .from("product_variants")
            .update({ active })
            .eq("id", variantId)
        );
      }
    });
    
    // Ejecutar todas las actualizaciones
    const allUpdates = [...updates, ...variantUpdates];
    if (allUpdates.length === 0) {
      closeEditModal();
      modalSaveBtn.disabled = false;
      modalSaveBtn.textContent = "Guardar Cambios";
      return;
    }
    
    const results = await Promise.all(allUpdates);
    const errors = results.filter(r => r.error).map(r => r.error);
    
    if (errors.length > 0) {
      showError(`Error al guardar: ${errors.map(e => e.message).join(", ")}`);
      modalSaveBtn.disabled = false;
      modalSaveBtn.textContent = "Guardar Cambios";
      return;
    }
    
    // Recargar productos
    await loadProducts();
    closeEditModal();
    
  } catch (error) {
    console.error("Error guardando cambios:", error);
    showError(`Error: ${error.message}`);
    modalSaveBtn.disabled = false;
    modalSaveBtn.textContent = "Guardar Cambios";
  }
}

// Búsqueda
function filterProducts(searchTerm) {
  if (!searchTerm || searchTerm.trim() === "") {
    filteredProducts = [...allProducts];
  } else {
    const term = searchTerm.toLowerCase().trim();
    filteredProducts = allProducts.filter(product => {
      return product.name.toLowerCase().includes(term) ||
             product.handle?.toLowerCase().includes(term) ||
             product.variants.some(v => 
               v.color?.toLowerCase().includes(term) ||
               v.size?.toLowerCase().includes(term) ||
               v.sku?.toLowerCase().includes(term)
             );
    });
  }
  renderProducts();
}

// Guardar cambio de stock en móvil
async function saveMobileStockChange(input) {
  const variantId = input.getAttribute("data-variant-id");
  const isGeneral = input.classList.contains("mobile-stock-general");
  const stockValue = parseInt(input.value || 0);
  
  const warehouseId = isGeneral ? warehouseIds.general : warehouseIds.ventaPublico;
  
  const { error } = await supabase
    .from("variant_warehouse_stock")
    .upsert(
      { 
        variant_id: variantId, 
        warehouse_id: warehouseId, 
        stock_qty: stockValue 
      },
      { onConflict: "variant_id,warehouse_id" }
    );
  
  if (error) {
    console.error("Error guardando stock:", error);
    alert(`Error al guardar: ${error.message}`);
    // Recargar para restaurar valores
    loadProducts();
  }
}

// Guardar cambio de estado en móvil
async function saveMobileStatusChange(checkbox) {
  const variantId = checkbox.getAttribute("data-variant-id");
  const active = checkbox.checked;
  
  const { error } = await supabase
    .from("product_variants")
    .update({ active })
    .eq("id", variantId);
  
  if (error) {
    console.error("Error guardando estado:", error);
    alert(`Error al guardar: ${error.message}`);
    checkbox.checked = !active; // Revertir
  } else {
    // Actualizar badge visual
    const badge = productsContainer.querySelector(
      `.mobile-status-badge[data-variant-id="${variantId}"]`
    );
    if (badge) {
      badge.textContent = active ? 'Activo' : 'Inactivo';
      badge.className = `status-badge ${active ? 'status-active' : 'status-inactive'} mobile-status-badge`;
      badge.setAttribute("data-variant-id", variantId);
    }
  }
}

// Re-renderizar al cambiar tamaño de ventana
let resizeTimeout;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    renderProducts();
  }, 250);
});

// Utilidades
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function formatPrice(price) {
  if (!price || price === 0) return "$0";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(price);
}

function showError(message) {
  errorContainer.innerHTML = `<div class="error-message">${escapeHtml(message)}</div>`;
}

function updateResultsCount(count) {
  resultsCount.textContent = `${count} producto${count !== 1 ? 's' : ''} encontrado${count !== 1 ? 's' : ''}`;
}

// Event listeners
searchInput.addEventListener("input", (e) => {
  filterProducts(e.target.value);
});

reloadBtn.addEventListener("click", () => {
  loadProducts();
});

modalCloseBtn.addEventListener("click", closeEditModal);
modalCancelBtn.addEventListener("click", closeEditModal);

modalSaveBtn.addEventListener("click", saveModalChanges);

// Cerrar modal al hacer click fuera
editModal.addEventListener("click", (e) => {
  if (e.target === editModal) {
    closeEditModal();
  }
});

// Cargar productos al iniciar
loadProducts();

