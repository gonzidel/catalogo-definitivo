// admin/move-stock.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

const searchInput = document.getElementById("search-input");
const resultsContainer = document.getElementById("results-container");
const messageContainer = document.getElementById("message-container");
const suggestionsDropdown = document.getElementById("suggestions-dropdown");
const suggestionsList = document.getElementById("suggestions-list");
const productsDatalist = document.getElementById("products-datalist");

let searchTimeout = null;
let suggestionsTimeout = null;
let currentMode = "to_public"; // "to_public" o "to_general"

// Buscar productos
async function searchProducts(term) {
  if (!term || term.trim().length < 2) {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Ingresa al menos 2 caracteres para buscar</p>
      </div>
    `;
    return;
  }

  resultsContainer.innerHTML = '<div class="loading">Buscando productos...</div>';

  try {
    const searchTerm = term.trim().toLowerCase();
    
    let productIds = [];
    let products = [];
    
    // Primero intentar buscar productos por nombre
    if (searchTerm) {
      const { data: productsByName, error: productsError } = await supabase
        .from("products")
        .select("id, name, category, status")
        .eq("status", "active")
        .ilike("name", `%${searchTerm}%`)
        .limit(100);
      
      if (productsError) throw productsError;
      
      if (productsByName && productsByName.length > 0) {
        products = productsByName;
        productIds = products.map(p => p.id);
      }
    }
    
    // Buscar variantes que coincidan con el término (SKU, color, size)
    let variantsQuery = supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        size,
        active,
        product_id,
        products!inner(id, name, category, status)
      `)
      .eq("active", true)
      .eq("products.status", "active");
    
    if (searchTerm) {
      // Si ya tenemos productos por nombre, buscar variantes de esos productos
      if (productIds.length > 0) {
        variantsQuery = variantsQuery
          .in("product_id", productIds)
          .or(`sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%,size.ilike.%${searchTerm}%`);
      } else {
        // Si no hay productos por nombre, buscar variantes directamente por SKU, color o size
        variantsQuery = variantsQuery.or(
          `sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%,size.ilike.%${searchTerm}%`
        );
      }
    } else {
      // Sin término de búsqueda, obtener todas las variantes activas
      if (productIds.length > 0) {
        variantsQuery = variantsQuery.in("product_id", productIds);
      }
    }
    
    const { data: variants, error: variantsError } = await variantsQuery.limit(500);
    
    if (variantsError) throw variantsError;
    
    if (!variants || variants.length === 0) {
      resultsContainer.innerHTML = `
        <div class="no-results">
          <p>No se encontraron variantes que coincidan con "${term}"</p>
        </div>
      `;
      return;
    }
    
    // Si no encontramos productos por nombre pero sí variantes, obtener los productos de las variantes
    if (products.length === 0) {
      const uniqueProductIds = [...new Set(variants.map(v => v.product_id))];
      const { data: productsFromVariants, error: productsError2 } = await supabase
        .from("products")
        .select("id, name, category, status")
        .in("id", uniqueProductIds)
        .eq("status", "active");
      
      if (productsError2) throw productsError2;
      products = productsFromVariants || [];
    }
    
    // Combinar productos con sus variantes
    const productsMap = new Map();
    
    // Primero agregar productos conocidos
    products.forEach(p => {
      productsMap.set(p.id, {
        id: p.id,
        name: p.name,
        category: p.category,
        variants: []
      });
    });
    
    // Agregar productos desde variantes si no están en el mapa
    variants.forEach(v => {
      if (v.products && !productsMap.has(v.products.id)) {
        productsMap.set(v.products.id, {
          id: v.products.id,
          name: v.products.name,
          category: v.products.category,
          variants: []
        });
      }
    });
    
    // Agregar variantes a sus productos
    variants.forEach(v => {
      const productId = v.product_id || (v.products && v.products.id);
      const product = productsMap.get(productId);
      
      if (product) {
        product.variants.push({
          id: v.id,
          sku: v.sku,
          color: v.color,
          size: v.size,
          active: v.active,
          products: {
            id: product.id,
            name: product.name,
            category: product.category,
            status: "active"
          }
        });
      }
    });
    
    // Filtrar productos que no tienen variantes
    const productsWithVariants = Array.from(productsMap.values())
      .filter(p => p.variants.length > 0);
    
    if (productsWithVariants.length === 0) {
      resultsContainer.innerHTML = `
        <div class="no-results">
          <p>No se encontraron productos con variantes que coincidan con "${term}"</p>
        </div>
      `;
      return;
    }

    // Cargar stock para cada variante
    const productsToShow = productsWithVariants;
    
    for (const product of productsToShow) {
      for (const variant of product.variants) {
        const stockData = await getVariantStock(variant.id);
        variant.stockData = stockData;
      }
    }

    renderResults(productsToShow);
  } catch (error) {
    console.error("Error buscando productos:", error);
    showMessage("Error al buscar productos: " + error.message, "error");
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Error al buscar productos. Por favor, intenta nuevamente.</p>
      </div>
    `;
  }
}

// Obtener stock por almacén para una variante
async function getVariantStock(variantId) {
  try {
    const { data, error } = await supabase
      .rpc("get_variant_stock_by_warehouse", { p_variant_id: variantId });

    if (error) throw error;

    const stockMap = {};
    const total = { stock: 0 };

    if (data) {
      for (const row of data) {
        stockMap[row.warehouse_code] = {
          name: row.warehouse_name,
          stock: row.stock_qty
        };
        total.stock += row.stock_qty;
      }
    }

    return {
      general: stockMap["general"] || { name: "Almacén General", stock: 0 },
      ventaPublico: stockMap["venta-publico"] || { name: "Venta al Público", stock: 0 },
      total: total.stock
    };
  } catch (error) {
    console.error("Error obteniendo stock:", error);
    return {
      general: { name: "Almacén General", stock: 0 },
      ventaPublico: { name: "Venta al Público", stock: 0 },
      total: 0
    };
  }
}

// Renderizar resultados
function renderResults(products) {
  if (products.length === 0) {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>No se encontraron productos</p>
      </div>
    `;
    return;
  }

  let html = "";

  for (const product of products) {
    html += `
      <div class="product-item">
        <div class="product-header">
          <div>
            <div class="product-name">${escapeHtml(product.name)}</div>
            <div class="product-category">${escapeHtml(product.category || "")}</div>
          </div>
        </div>
        <div class="variants-list">
    `;

    for (const variant of product.variants) {
      const stockData = variant.stockData || {
        general: { stock: 0 },
        ventaPublico: { stock: 0 },
        total: 0
      };

      // Determinar qué stock mostrar según el modo
      const sourceStock = currentMode === "to_public" 
        ? stockData.general.stock 
        : stockData.ventaPublico.stock;
      const sourceLabel = currentMode === "to_public" 
        ? "Stock General" 
        : "Stock Venta Público";
      const destinationLabel = currentMode === "to_public" 
        ? "Venta Público" 
        : "General";
      const buttonText = currentMode === "to_public" 
        ? "Mover a Venta Público" 
        : "Devolver a General";

      html += `
        <div class="variant-item" data-variant-id="${variant.id}">
          <div class="variant-info">
            <div class="variant-details">
              <span class="variant-detail"><strong>SKU:</strong> ${escapeHtml(variant.sku || "")}</span>
              <span class="variant-detail"><strong>Color:</strong> ${escapeHtml(variant.color || "")}</span>
              <span class="variant-detail"><strong>Talle:</strong> ${escapeHtml(variant.size || "")}</span>
            </div>
          </div>
          <div class="stock-info">
            <div class="stock-label">${sourceLabel}</div>
            <div class="stock-value">${sourceStock}</div>
          </div>
          <div class="move-controls">
            <div class="quantity-controls">
              <button 
                class="quantity-btn decrease" 
                data-variant-id="${variant.id}"
                data-action="decrease"
                ${sourceStock === 0 ? "disabled" : ""}
                type="button"
              >
                −
              </button>
              <input 
                type="number" 
                class="quantity-input" 
                min="0" 
                max="${sourceStock}"
                value="0"
                placeholder="0"
                data-variant-id="${variant.id}"
                ${sourceStock === 0 ? "disabled" : ""}
              />
              <button 
                class="quantity-btn increase" 
                data-variant-id="${variant.id}"
                data-action="increase"
                ${sourceStock === 0 ? "disabled" : ""}
                type="button"
              >
                +
              </button>
            </div>
            <button 
              class="move-btn" 
              data-variant-id="${variant.id}"
              ${sourceStock === 0 ? "disabled" : ""}
            >
              ${buttonText}
            </button>
          </div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  resultsContainer.innerHTML = html;

  // Mostrar/ocultar header con botón "Mover todo"
  const resultsHeader = document.getElementById("results-header");
  if (products && products.length > 0) {
    if (resultsHeader) {
      resultsHeader.style.display = "block";
    }
  } else {
    if (resultsHeader) {
      resultsHeader.style.display = "none";
    }
  }

  // Agregar event listeners a los botones individuales
  document.querySelectorAll(".move-btn").forEach(btn => {
    btn.addEventListener("click", handleMoveStock);
  });
  
  // Agregar event listeners a los botones + y -
  document.querySelectorAll(".quantity-btn").forEach(btn => {
    btn.addEventListener("click", handleQuantityChange);
  });
}

// Manejar cambios de cantidad con botones + y -
function handleQuantityChange(event) {
  const btn = event.target;
  const variantId = btn.getAttribute("data-variant-id");
  const action = btn.getAttribute("data-action");
  const quantityInput = document.querySelector(
    `.quantity-input[data-variant-id="${variantId}"]`
  );
  
  if (!quantityInput || quantityInput.disabled) return;
  
  const currentValue = parseInt(quantityInput.value, 10) || 0;
  const maxValue = parseInt(quantityInput.max, 10);
  const minValue = parseInt(quantityInput.min, 10) || 0;
  
  let newValue = currentValue;
  
  if (action === "increase") {
    newValue = Math.min(currentValue + 1, maxValue);
  } else if (action === "decrease") {
    newValue = Math.max(currentValue - 1, minValue);
  }
  
  quantityInput.value = newValue;
  
  // Disparar evento input para que otros listeners sepan del cambio
  quantityInput.dispatchEvent(new Event("input", { bubbles: true }));
}

// Manejar movimiento de stock
async function handleMoveStock(event) {
  const btn = event.target;
  const variantId = btn.getAttribute("data-variant-id");
  const quantityInput = document.querySelector(
    `.quantity-input[data-variant-id="${variantId}"]`
  );
  
  if (!quantityInput) {
    showMessage("Error: No se encontró el input de cantidad", "error");
    return;
  }

  const quantity = parseInt(quantityInput.value, 10);

  if (!quantity || quantity <= 0 || isNaN(quantity)) {
    showMessage("Por favor, ingresa una cantidad válida mayor a 0", "error");
    return;
  }

  const maxStock = parseInt(quantityInput.max, 10);
  if (quantity > maxStock) {
    showMessage(`No puedes mover más de ${maxStock} unidades (stock disponible)`, "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Moviendo...";

  try {
    // Determinar almacenes según el modo
    const fromWarehouse = currentMode === "to_public" ? "general" : "venta-publico";
    const toWarehouse = currentMode === "to_public" ? "venta-publico" : "general";
    const actionText = currentMode === "to_public" ? "movieron a Venta al Público" : "devolvieron a General";
    
    const { data, error } = await supabase.rpc("rpc_move_stock", {
      p_variant_id: variantId,
      p_from_warehouse_code: fromWarehouse,
      p_to_warehouse_code: toWarehouse,
      p_quantity: quantity,
      p_notes: currentMode === "to_public" 
        ? `Movido desde panel de admin` 
        : `Devuelto a General desde panel de admin`
    });

    if (error) throw error;

    showMessage(
      `✅ Se ${actionText} ${quantity} unidades exitosamente`,
      "success"
    );

    // Actualizar stock en la UI
    const variantItem = btn.closest(".variant-item");
    const stockValueEl = variantItem.querySelector(".stock-value");
    const newStock = data.from_stock_after;
    
    stockValueEl.textContent = newStock;
    quantityInput.max = newStock;
    quantityInput.value = "0";
    
    if (newStock === 0) {
      quantityInput.disabled = true;
      btn.disabled = true;
    }

    // Actualizar datos en memoria
    const variant = Array.from(document.querySelectorAll(".variant-item"))
      .find(el => el.getAttribute("data-variant-id") === variantId);
    
    if (variant) {
      // Recargar stock actualizado
      const updatedStock = await getVariantStock(variantId);
      // Actualizar en el objeto de datos si existe
    }

  } catch (error) {
    console.error("Error moviendo stock:", error);
    showMessage("Error al mover stock: " + (error.message || "Error desconocido"), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Mover a Venta Público";
  }
}

// Mostrar mensaje
function showMessage(text, type = "info") {
  messageContainer.innerHTML = `
    <div class="message ${type}">
      ${escapeHtml(text)}
    </div>
  `;

  // Auto-ocultar después de 5 segundos
  setTimeout(() => {
    messageContainer.innerHTML = "";
  }, 5000);
}

// Escapar HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Buscar sugerencias para autocompletado
async function loadSuggestions(term) {
  if (!term || term.trim().length < 2) {
    suggestionsDropdown.style.display = "none";
    return;
  }

  try {
    const searchTerm = term.trim().toLowerCase();
    
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category")
      .eq("status", "active")
      .ilike("name", `%${searchTerm}%`)
      .limit(10);

    if (error) throw error;

    if (!products || products.length === 0) {
      suggestionsDropdown.style.display = "none";
      return;
    }

    // Actualizar datalist
    productsDatalist.innerHTML = "";
    products.forEach(p => {
      const option = document.createElement("option");
      option.value = p.name;
      productsDatalist.appendChild(option);
    });

    // Mostrar sugerencias en dropdown
    suggestionsList.innerHTML = products.map(p => `
      <div class="suggestion-item" data-product-name="${escapeHtml(p.name)}">
        <div class="suggestion-name">${escapeHtml(p.name)}</div>
        <div class="suggestion-details">${escapeHtml(p.category || "")}</div>
      </div>
    `).join("");

    // Agregar event listeners a las sugerencias
    suggestionsList.querySelectorAll(".suggestion-item").forEach(item => {
      item.addEventListener("click", () => {
        const productName = item.getAttribute("data-product-name");
        searchInput.value = productName;
        suggestionsDropdown.style.display = "none";
        searchProducts(productName);
      });
    });

    suggestionsDropdown.style.display = "block";
  } catch (error) {
    console.error("Error cargando sugerencias:", error);
    suggestionsDropdown.style.display = "none";
  }
}

// Event listener para búsqueda y autocompletado
searchInput.addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  clearTimeout(suggestionsTimeout);
  const term = e.target.value.trim();
  
  // Mostrar sugerencias mientras escribe
  suggestionsTimeout = setTimeout(() => {
    loadSuggestions(term);
  }, 200);
  
  // Búsqueda completa después de un delay más largo
  if (term.length >= 2) {
    searchTimeout = setTimeout(() => {
      searchProducts(term);
    }, 500);
  } else {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Ingresa al menos 2 caracteres para buscar</p>
      </div>
    `;
  }
});

// Ocultar sugerencias al hacer clic fuera
document.addEventListener("click", (e) => {
  if (!searchInput.contains(e.target) && !suggestionsDropdown.contains(e.target)) {
    suggestionsDropdown.style.display = "none";
  }
});

// Manejar movimiento de todas las variantes
async function handleMoveAll() {
  console.log("🔄 handleMoveAll llamado");
  const moveAllBtn = document.getElementById("move-all-btn");
  const moveAllStatus = document.getElementById("move-all-status");
  
  if (!moveAllBtn) {
    console.error("❌ Botón move-all-btn no encontrado");
    return;
  }
  
  // Obtener todas las variantes visibles con cantidad > 0
  const variantItems = document.querySelectorAll(".variant-item");
  const movesToProcess = [];
  
  for (const item of variantItems) {
    const variantId = item.getAttribute("data-variant-id");
    const quantityInput = item.querySelector(`.quantity-input[data-variant-id="${variantId}"]`);
    
    if (!quantityInput || quantityInput.disabled) continue;
    
    const quantity = parseInt(quantityInput.value, 10);
    if (!quantity || quantity <= 0 || isNaN(quantity)) continue;
    
    const maxStock = parseInt(quantityInput.max, 10);
    if (quantity > maxStock) {
      showMessage(`No puedes mover más de ${maxStock} unidades para una variante`, "error");
      return;
    }
    
    movesToProcess.push({ variantId, quantity, quantityInput, item });
  }
  
  if (movesToProcess.length === 0) {
    showMessage("No hay variantes con cantidades válidas para mover", "error");
    return;
  }
  
  moveAllBtn.disabled = true;
  moveAllBtn.textContent = "Moviendo...";
  moveAllStatus.textContent = `Procesando ${movesToProcess.length} movimiento(s)...`;
  
  let successCount = 0;
  let errorCount = 0;
  
  try {
    // Procesar movimientos en paralelo (con límite de concurrencia)
    const batchSize = 5;
    for (let i = 0; i < movesToProcess.length; i += batchSize) {
      const batch = movesToProcess.slice(i, i + batchSize);
      
      // Determinar almacenes según el modo
      const fromWarehouse = currentMode === "to_public" ? "general" : "venta-publico";
      const toWarehouse = currentMode === "to_public" ? "venta-publico" : "general";
      
      const results = await Promise.allSettled(
        batch.map(async ({ variantId, quantity }) => {
          const { data, error } = await supabase.rpc("rpc_move_stock", {
            p_variant_id: variantId,
            p_from_warehouse_code: fromWarehouse,
            p_to_warehouse_code: toWarehouse,
            p_quantity: quantity,
            p_notes: currentMode === "to_public" 
              ? `Movido desde panel de admin (mover todo)` 
              : `Devuelto a General desde panel de admin (mover todo)`
          });
          
          if (error) throw error;
          return { variantId, quantity, data };
        })
      );
      
      // Actualizar UI para cada movimiento exitoso
      results.forEach((result, index) => {
        const { variantId, quantity, quantityInput, item } = batch[index];
        
        if (result.status === "fulfilled") {
          successCount++;
          const stockValueEl = item.querySelector(".stock-value");
          const newStock = result.value.data.from_stock_after;
          
          stockValueEl.textContent = newStock;
          quantityInput.max = newStock;
          quantityInput.value = "0";
          
          if (newStock === 0) {
            quantityInput.disabled = true;
            item.querySelector(".move-btn").disabled = true;
          }
        } else {
          errorCount++;
          console.error(`Error moviendo variante ${variantId}:`, result.reason);
        }
      });
      
      moveAllStatus.textContent = `Procesando... ${Math.min(i + batchSize, movesToProcess.length)}/${movesToProcess.length}`;
    }
    
    if (successCount > 0) {
      showMessage(
        `✅ Se movieron ${successCount} variante(s) exitosamente${errorCount > 0 ? ` (${errorCount} error(es))` : ""}`,
        successCount === movesToProcess.length ? "success" : "error"
      );
    } else {
      showMessage("Error: No se pudo mover ninguna variante", "error");
    }
    
  } catch (error) {
    console.error("Error en movimiento masivo:", error);
    showMessage("Error al mover stock: " + (error.message || "Error desconocido"), "error");
  } finally {
    moveAllBtn.disabled = false;
    updateMoveAllButtonText();
    moveAllStatus.textContent = "";
  }
}

// Actualizar texto del botón según el modo
function updateMoveAllButtonText() {
  const moveAllBtn = document.getElementById("move-all-btn");
  if (moveAllBtn) {
    moveAllBtn.textContent = currentMode === "to_public" 
      ? "📦 Mover Todo a Venta Público" 
      : "↩️ Devolver Todo a General";
  }
}

// Toggle entre modos
function toggleMode() {
  currentMode = currentMode === "to_public" ? "to_general" : "to_public";
  
  const modeToggle = document.getElementById("mode-toggle");
  if (modeToggle) {
    modeToggle.textContent = currentMode === "to_public" 
      ? "📦 Mover a Venta Público" 
      : "↩️ Devolver a General";
  }
  
  updateMoveAllButtonText();
  
  // Si hay resultados, re-renderizarlos con el nuevo modo
  const currentSearch = searchInput.value.trim();
  if (currentSearch.length >= 2) {
    searchProducts(currentSearch);
  }
}

// Event listener para botón "Mover todo" usando event delegation
// Esto funciona incluso si el botón se crea dinámicamente
document.addEventListener("click", (e) => {
  if (e.target && (e.target.id === "move-all-btn" || e.target.closest("#move-all-btn"))) {
    e.preventDefault();
    e.stopPropagation();
    console.log("🖱️ Click detectado en botón Mover Todo");
    handleMoveAll();
  }
  
  // Toggle de modo
  if (e.target && (e.target.id === "mode-toggle" || e.target.closest("#mode-toggle"))) {
    e.preventDefault();
    e.stopPropagation();
    toggleMode();
  }
});

// Inicializar texto del botón de modo
updateMoveAllButtonText();

// Búsqueda inicial si hay texto en el input
if (searchInput.value.trim().length >= 2) {
  searchProducts(searchInput.value.trim());
}

