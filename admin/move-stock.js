// admin/move-stock.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";

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
      // Si el término parece ser un código corto (solo números o alfanumérico corto),
      // buscar coincidencias exactas o que empiecen con el término seguido de un separador
      const isShortCode = /^[a-z0-9]{1,5}$/i.test(searchTerm);
      
      let productsQuery = supabase
        .from("products")
        .select("id, name, category, status")
        .in("status", ["active", "pending_stock", "draft"]);
      
      if (isShortCode) {
        // Para códigos cortos, buscar coincidencias exactas primero
        const { data: exactMatch, error: exactError } = await supabase
          .from("products")
          .select("id, name, category, status")
          .in("status", ["active", "pending_stock", "draft"])
          .ilike("name", searchTerm)
          .limit(100);
        
        if (exactError) throw exactError;
        
        if (exactMatch && exactMatch.length > 0) {
          products = exactMatch;
          productIds = products.map(p => p.id);
        } else {
          // Si no hay coincidencia exacta, buscar que el código esté al inicio o al final
          // pero separado por un guion, espacio, o al inicio/fin del nombre
          // Esto evita que "55" coincida con "MU55" o "Z55"
          const { data: prefixMatch, error: prefixError } = await supabase
            .from("products")
            .select("id, name, category, status")
            .in("status", ["active", "pending_stock", "draft"])
            .or(`name.ilike.${searchTerm},name.ilike.${searchTerm}-%,name.ilike.${searchTerm} %,name.ilike.%-${searchTerm},name.ilike.% ${searchTerm}`)
            .limit(100);
          
          if (prefixError) throw prefixError;
          
          if (prefixMatch && prefixMatch.length > 0) {
            // Filtrar resultados para asegurar que el término esté separado correctamente
            const filtered = prefixMatch.filter(p => {
              const name = p.name.toLowerCase();
              // Coincidencia exacta
              if (name === searchTerm) return true;
              // Empieza con el término seguido de separador
              if (name.startsWith(searchTerm + "-") || name.startsWith(searchTerm + " ")) return true;
              // Termina con el término precedido de separador
              if (name.endsWith("-" + searchTerm) || name.endsWith(" " + searchTerm)) return true;
              return false;
            });
            
            if (filtered.length > 0) {
              products = filtered;
              productIds = products.map(p => p.id);
            }
          }
        }
      } else {
        // Para términos más largos, usar búsqueda parcial normal
        const { data: productsByName, error: productsError } = await productsQuery
          .ilike("name", `%${searchTerm}%`)
          .limit(100);
        
        if (productsError) throw productsError;
        
        if (productsByName && productsByName.length > 0) {
          products = productsByName;
          productIds = products.map(p => p.id);
        }
      }
    }
    
    // Buscar variantes que coincidan con el término (SKU, color)
    // Nota: size ya no está en product_variants, se busca en variant_sizes después
    let variantsQuery = supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        active,
        product_id,
        products!inner(id, name, category, status)
      `)
      .eq("active", true)
      .in("products.status", ["active", "pending_stock", "draft"]);
    
    if (searchTerm) {
      // Si ya tenemos productos por nombre, buscar variantes de esos productos
      if (productIds.length > 0) {
        variantsQuery = variantsQuery
          .in("product_id", productIds)
          .or(`sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`);
      } else {
        // Si no hay productos por nombre, buscar variantes directamente por SKU o color
        variantsQuery = variantsQuery.or(
          `sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`
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
    
    // Obtener talles desde variant_sizes para las variantes encontradas
    const variantIds = variants.map(v => v.id);
    const { data: variantSizes, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("variant_id, size")
      .in("variant_id", variantIds)
      .order("variant_id, size");
    
    if (sizesError) {
      console.warn("Error obteniendo talles desde variant_sizes:", sizesError);
    }
    
    // Agrupar talles por variant_id
    const sizesByVariant = new Map();
    if (variantSizes) {
      variantSizes.forEach(vs => {
        if (!sizesByVariant.has(vs.variant_id)) {
          sizesByVariant.set(vs.variant_id, []);
        }
        sizesByVariant.get(vs.variant_id).push(vs.size);
      });
    }
    
    // Si el término de búsqueda parece ser un talle, filtrar variantes que tengan ese talle
    let filteredVariants = variants;
    if (searchTerm && variantSizes) {
      const searchTermLower = searchTerm.toLowerCase().trim();
      // Verificar si alguna variante tiene un talle que coincida
      const matchingVariantIds = new Set();
      variantSizes.forEach(vs => {
        if (String(vs.size || "").toLowerCase().includes(searchTermLower)) {
          matchingVariantIds.add(vs.variant_id);
        }
      });
      
      if (matchingVariantIds.size > 0) {
        filteredVariants = variants.filter(v => matchingVariantIds.has(v.id));
      }
    }
    
    if (filteredVariants.length === 0) {
      resultsContainer.innerHTML = `
        <div class="no-results">
          <p>No se encontraron variantes que coincidan con "${term}"</p>
        </div>
      `;
      return;
    }
    
    // Agregar talles a cada variante
    filteredVariants.forEach(v => {
      v.sizes = sizesByVariant.get(v.id) || [];
    });
    
    // Si no encontramos productos por nombre pero sí variantes, obtener los productos de las variantes
    if (products.length === 0) {
      const uniqueProductIds = [...new Set(variants.map(v => v.product_id))];
      const { data: productsFromVariants, error: productsError2 } = await supabase
        .from("products")
        .select("id, name, category, status")
        .in("id", uniqueProductIds)
        .in("status", ["active", "pending_stock", "draft"]);
      
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
    filteredVariants.forEach(v => {
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
    filteredVariants.forEach(v => {
      const productId = v.product_id || (v.products && v.products.id);
      const product = productsMap.get(productId);
      
      if (product) {
        product.variants.push({
          id: v.id,
          sku: v.sku,
          color: v.color,
          sizes: v.sizes || [],
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

// Obtener stock por almacén para una variante (por talle individual)
async function getVariantStock(variantId) {
  try {
    // 1. Obtener talles desde variant_sizes para esta variante (con stock_qty como fallback)
    const { data: sizesData, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("size, stock_qty")
      .eq("variant_id", variantId)
      .order("size");

    if (sizesError) throw sizesError;

    // Crear mapa de talles con su stock_qty de fallback
    const sizesMap = new Map();
    (sizesData || []).forEach(s => {
      const normalizedSize = normalizeSize(s.size);
      if (normalizedSize) {
        sizesMap.set(normalizedSize, {
          size: normalizedSize,
          stockQty: s.stock_qty || 0
        });
      }
    });

    // 2. Obtener stock por talle desde variant_size_warehouse_stock (usar left join para traer todos)
    // Primero obtener IDs de warehouses
    const { data: warehouses, error: warehousesError } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);

    if (warehousesError) throw warehousesError;

    const warehouseMap = new Map();
    warehouses?.forEach(w => {
      warehouseMap.set(w.code, w.id);
    });

    const generalWarehouseId = warehouseMap.get("general");
    const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");

    if (!generalWarehouseId || !ventaPublicoWarehouseId) {
      console.error("Almacenes no encontrados");
      return { sizes: [] };
    }

    // Obtener stock desde variant_size_warehouse_stock
    const { data: stockData, error: stockError } = await supabase
      .from("variant_size_warehouse_stock")
      .select("size, warehouse_id, stock_qty")
      .eq("variant_id", variantId)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

    if (stockError) throw stockError;

    // 3. Organizar stock por talle y warehouse
    const stockBySize = new Map();
    
    // Inicializar todos los talles desde variant_sizes
    sizesMap.forEach((sizeInfo, normalizedSize) => {
      stockBySize.set(normalizedSize, {
        size: normalizedSize,
        general: 0,
        ventaPublico: 0
      });
    });

    // Poblar con datos reales de variant_size_warehouse_stock
    if (stockData) {
      stockData.forEach(row => {
        const normalizedSize = normalizeSize(row.size);
        if (!normalizedSize) return;

        if (!stockBySize.has(normalizedSize)) {
          stockBySize.set(normalizedSize, {
            size: normalizedSize,
            general: 0,
            ventaPublico: 0
          });
        }

        const sizeStock = stockBySize.get(normalizedSize);
        const stockQty = row.stock_qty || 0;

        if (String(row.warehouse_id) === String(generalWarehouseId)) {
          sizeStock.general = stockQty;
        } else if (String(row.warehouse_id) === String(ventaPublicoWarehouseId)) {
          sizeStock.ventaPublico = stockQty;
        }
      });
    }

    // 4. Aplicar fallback: si no hay stock en warehouses pero hay stock_qty en variant_sizes, usar ese para general
    sizesMap.forEach((sizeInfo, normalizedSize) => {
      const sizeStock = stockBySize.get(normalizedSize);
      if (sizeStock && sizeStock.general === 0 && sizeStock.ventaPublico === 0 && sizeInfo.stockQty > 0) {
        sizeStock.general = sizeInfo.stockQty;
      }
    });

    // 5. Retornar estructura con talles
    return {
      sizes: Array.from(stockBySize.values())
    };
  } catch (error) {
    console.error("Error obteniendo stock:", error);
    return {
      sizes: []
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
      const stockData = variant.stockData || { sizes: [] };
      const sizes = stockData.sizes || [];

      const sizesDisplay = variant.sizes && variant.sizes.length > 0 
        ? variant.sizes.join(", ") 
        : "Sin talles";

      // Información de la variante (cabecera)
      html += `
        <div class="variant-item" data-variant-id="${variant.id}">
          <div class="variant-info">
            <div class="variant-details">
              <span class="variant-detail"><strong>SKU:</strong> ${escapeHtml(variant.sku || "")}</span>
              <span class="variant-detail"><strong>Color:</strong> ${escapeHtml(variant.color || "")}</span>
              <span class="variant-detail"><strong>Talles:</strong> ${escapeHtml(sizesDisplay)}</span>
            </div>
          </div>
          <div class="sizes-list" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e5e5;">
      `;

      // Mostrar cada talle con sus controles individuales
      const sourceLabel = currentMode === "to_public" 
        ? "Stock General" 
        : "Stock Venta Público";
      const destinationLabel = currentMode === "to_public" 
        ? "Venta Público" 
        : "General";
      const buttonText = currentMode === "to_public" 
        ? "Mover a Venta Público" 
        : "Devolver a General";

      if (sizes.length === 0) {
        html += `
          <div style="padding: 8px; color: #999; font-size: 14px;">
            No hay talles con stock para mover
          </div>
        `;
      } else {
        sizes.forEach(sizeStock => {
          const normalizedSize = normalizeSize(sizeStock.size);
          const sourceStock = currentMode === "to_public" 
            ? sizeStock.general 
            : sizeStock.ventaPublico;

          html += `
            <div class="size-item" style="display: flex; align-items: center; gap: 12px; padding: 8px; background: #f9f9f9; border-radius: 6px; margin-bottom: 8px; flex-wrap: wrap;">
              <div style="min-width: 80px; font-weight: 600; color: #333;">
                Talle ${normalizedSize}
              </div>
              <div style="min-width: 120px; text-align: center;">
                <div style="font-size: 12px; color: #666; margin-bottom: 2px;">${sourceLabel}</div>
                <div class="stock-value" style="font-size: 16px; font-weight: 600; color: #155724;">${sourceStock}</div>
              </div>
              <div class="move-controls" style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <div class="quantity-controls" style="display: flex; align-items: center; gap: 0; border: 1px solid #ddd; border-radius: 6px; overflow: hidden;">
                  <button 
                    class="quantity-btn decrease" 
                    data-variant-id="${variant.id}"
                    data-size="${normalizedSize}"
                    data-action="decrease"
                    ${sourceStock === 0 ? "disabled" : ""}
                    type="button"
                    style="width: 32px; height: 32px; padding: 0; border: none; background: #f0f0f0; color: #333; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center;"
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
                    data-size="${normalizedSize}"
                    ${sourceStock === 0 ? "disabled" : ""}
                    style="width: 50px; padding: 6px 4px; border: none; border-left: 1px solid #ddd; border-right: 1px solid #ddd; text-align: center; font-size: 14px;"
                  />
                  <button 
                    class="quantity-btn increase" 
                    data-variant-id="${variant.id}"
                    data-size="${normalizedSize}"
                    data-action="increase"
                    ${sourceStock === 0 ? "disabled" : ""}
                    type="button"
                    style="width: 32px; height: 32px; padding: 0; border: none; background: #f0f0f0; color: #333; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center;"
                  >
                    +
                  </button>
                </div>
                <button 
                  class="move-btn" 
                  data-variant-id="${variant.id}"
                  data-size="${normalizedSize}"
                  ${sourceStock === 0 ? "disabled" : ""}
                  style="padding: 6px 12px; background: #CD844D; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 13px;"
                >
                  ${buttonText}
                </button>
              </div>
            </div>
          `;
        });
      }

      html += `
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
  const size = btn.getAttribute("data-size");
  const action = btn.getAttribute("data-action");
  
  // Buscar input específico por variant_id y size
  const quantityInput = document.querySelector(
    `.quantity-input[data-variant-id="${variantId}"][data-size="${size}"]`
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
  const size = btn.getAttribute("data-size");
  
  if (!variantId || !size) {
    showMessage("Error: No se encontró información del talle", "error");
    return;
  }

  // Buscar input específico por variant_id y size
  const quantityInput = document.querySelector(
    `.quantity-input[data-variant-id="${variantId}"][data-size="${size}"]`
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
    
    const normalizedSize = normalizeSize(size);
    
    const { data, error } = await supabase.rpc("rpc_move_size_stock", {
      p_variant_id: variantId,
      p_size: normalizedSize,
      p_from_warehouse_code: fromWarehouse,
      p_to_warehouse_code: toWarehouse,
      p_quantity: quantity,
      p_notes: currentMode === "to_public" 
        ? `Movido desde panel de admin` 
        : `Devuelto a General desde panel de admin`
    });

    if (error) throw error;

    showMessage(
      `✅ Se ${actionText} ${quantity} unidades del talle ${normalizedSize} exitosamente`,
      "success"
    );

    // Actualizar stock en la UI para este talle específico
    const sizeItem = btn.closest(".size-item");
    const stockValueEl = sizeItem.querySelector(".stock-value");
    const newStock = data.from_stock_after;
    
    if (stockValueEl) {
      stockValueEl.textContent = newStock;
    }
    quantityInput.max = newStock;
    quantityInput.value = "0";
    
    // Actualizar estado de botones y inputs
    if (newStock === 0) {
      quantityInput.disabled = true;
      btn.disabled = true;
      const decreaseBtn = sizeItem.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      const increaseBtn = sizeItem.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      if (decreaseBtn) decreaseBtn.disabled = true;
      if (increaseBtn) increaseBtn.disabled = true;
    } else {
      quantityInput.disabled = false;
      btn.disabled = false;
      const decreaseBtn = sizeItem.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      const increaseBtn = sizeItem.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      if (decreaseBtn) decreaseBtn.disabled = false;
      if (increaseBtn) increaseBtn.disabled = false;
    }

  } catch (error) {
    console.error("Error moviendo stock:", error);
    showMessage("Error al mover stock: " + (error.message || "Error desconocido"), "error");
  } finally {
    btn.disabled = false;
    const buttonText = currentMode === "to_public" 
      ? "Mover a Venta Público" 
      : "Devolver a General";
    btn.textContent = buttonText;
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
      .in("status", ["active", "pending_stock", "draft"])
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

// Manejar movimiento de todas las variantes (por talle individual)
async function handleMoveAll() {
  console.log("🔄 handleMoveAll llamado");
  const moveAllBtn = document.getElementById("move-all-btn");
  const moveAllStatus = document.getElementById("move-all-status");
  
  if (!moveAllBtn) {
    console.error("❌ Botón move-all-btn no encontrado");
    return;
  }
  
  // Obtener todas las combinaciones variant_id + size con cantidad > 0
  const sizeItems = document.querySelectorAll(".size-item");
  const movesToProcess = [];
  
  for (const item of sizeItems) {
    const variantItem = item.closest(".variant-item");
    if (!variantItem) continue;
    
    const variantId = variantItem.getAttribute("data-variant-id");
    const size = item.querySelector(".quantity-input")?.getAttribute("data-size");
    
    if (!variantId || !size) continue;
    
    const quantityInput = item.querySelector(`.quantity-input[data-variant-id="${variantId}"][data-size="${size}"]`);
    
    if (!quantityInput || quantityInput.disabled) continue;
    
    const quantity = parseInt(quantityInput.value, 10);
    if (!quantity || quantity <= 0 || isNaN(quantity)) continue;
    
    const maxStock = parseInt(quantityInput.max, 10);
    if (quantity > maxStock) {
      showMessage(`No puedes mover más de ${maxStock} unidades para el talle ${size}`, "error");
      return;
    }
    
    movesToProcess.push({ variantId, size, quantity, quantityInput, item });
  }
  
  if (movesToProcess.length === 0) {
    showMessage("No hay talles con cantidades válidas para mover", "error");
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
        batch.map(async ({ variantId, size, quantity }) => {
          const normalizedSize = normalizeSize(size);
          const { data, error } = await supabase.rpc("rpc_move_size_stock", {
            p_variant_id: variantId,
            p_size: normalizedSize,
            p_from_warehouse_code: fromWarehouse,
            p_to_warehouse_code: toWarehouse,
            p_quantity: quantity,
            p_notes: currentMode === "to_public" 
              ? `Movido desde panel de admin (mover todo)` 
              : `Devuelto a General desde panel de admin (mover todo)`
          });
          
          if (error) throw error;
          return { variantId, size: normalizedSize, quantity, data };
        })
      );
      
      // Actualizar UI para cada movimiento exitoso
      results.forEach((result, index) => {
        const { variantId, size, quantity, quantityInput, item } = batch[index];
        
        if (result.status === "fulfilled") {
          successCount++;
          const normalizedSize = normalizeSize(size);
          const stockValueEl = item.querySelector(".stock-value");
          const newStock = result.value.data.from_stock_after;
          
          if (stockValueEl) {
            stockValueEl.textContent = newStock;
          }
          quantityInput.max = newStock;
          quantityInput.value = "0";
          
          // Actualizar estado de botones y inputs
          if (newStock === 0) {
            quantityInput.disabled = true;
            const moveBtn = item.querySelector(`.move-btn[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const decreaseBtn = item.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const increaseBtn = item.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            if (moveBtn) moveBtn.disabled = true;
            if (decreaseBtn) decreaseBtn.disabled = true;
            if (increaseBtn) increaseBtn.disabled = true;
          } else {
            quantityInput.disabled = false;
            const moveBtn = item.querySelector(`.move-btn[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const decreaseBtn = item.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const increaseBtn = item.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            if (moveBtn) moveBtn.disabled = false;
            if (decreaseBtn) decreaseBtn.disabled = false;
            if (increaseBtn) increaseBtn.disabled = false;
          }
        } else {
          errorCount++;
          console.error(`Error moviendo variante ${variantId}, talle ${size}:`, result.reason);
        }
      });
      
      moveAllStatus.textContent = `Procesando... ${Math.min(i + batchSize, movesToProcess.length)}/${movesToProcess.length}`;
    }
    
    if (successCount > 0) {
      showMessage(
        `✅ Se movieron ${successCount} talle(s) exitosamente${errorCount > 0 ? ` (${errorCount} error(es))` : ""}`,
        successCount === movesToProcess.length ? "success" : "error"
      );
    } else {
      showMessage("Error: No se pudo mover ningún talle", "error");
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

