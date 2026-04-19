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
    
    // Obtener todas las variantes de estos productos (sin usar size que está deprecado)
    const productIds = products.map(p => p.id);
    const { data: variants, error: variantsError } = await supabase
      .from("product_variants")
      .select("id, product_id, color, sku, price, active")
      .in("product_id", productIds)
      .order("color", { ascending: true });
    
    if (variantsError) {
      showError(`Error cargando variantes: ${variantsError.message}`);
      productsContainer.innerHTML = "";
      return;
    }
    
    // Obtener talles desde variant_sizes para todas las variantes
    const variantIds = (variants || []).map(v => v.id);
    let sizesData = [];
    if (variantIds.length > 0) {
      const { data: sizes, error: sizesError } = await supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty, sku")
        .in("variant_id", variantIds)
        .order("size");
      
      if (sizesError) {
        console.error("Error cargando talles desde variant_sizes:", sizesError);
      } else {
        sizesData = sizes || [];
      }
    }
    
    // Agrupar talles por variant_id
    const sizesByVariant = new Map();
    sizesData.forEach(sizeRow => {
      if (!sizeRow.variant_id) return;
      if (!sizesByVariant.has(sizeRow.variant_id)) {
        sizesByVariant.set(sizeRow.variant_id, []);
      }
      const sizeValue = String(sizeRow.size || "").trim();
      if (sizeValue) {
        sizesByVariant.get(sizeRow.variant_id).push({
          size: sizeValue,
          stock_qty: sizeRow.stock_qty || 0,
          sku: sizeRow.sku || null,
        });
      }
    });
    
    // Obtener imágenes de variantes
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
    
    // Obtener stocks por talle y almacén desde variant_size_warehouse_stock
    let sizeWarehouseStocks = [];
    if (variantIds.length > 0) {
      const { data: sizeStocksData, error: sizeStocksError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", [warehouseIds.general, warehouseIds.ventaPublico]);
      
      if (sizeStocksError) {
        console.error("Error cargando stock por talle:", sizeStocksError);
      } else {
        sizeWarehouseStocks = sizeStocksData || [];
      }
    }
    
    // Crear mapa de stocks por variante, talle y almacén
    // key: `${variant_id}_${size}_${warehouse_id}` -> stock_qty
    const sizeWarehouseStockMap = new Map();
    sizeWarehouseStocks.forEach(sws => {
      const key = `${sws.variant_id}_${sws.size}_${sws.warehouse_id}`;
      sizeWarehouseStockMap.set(key, sws.stock_qty || 0);
    });
    
    // También obtener stocks generales de variantes (fallback para variantes sin talles)
    let stocks = [];
    if (variantIds.length > 0) {
      const { data: stocksData, error: stocksError } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", [warehouseIds.general, warehouseIds.ventaPublico]);
      
      if (stocksError) {
        console.error("Error cargando stocks generales:", stocksError);
      } else {
        stocks = stocksData || [];
      }
    }
    
    // Crear mapa de stocks generales (fallback)
    const stockMap = new Map();
    stocks.forEach(s => {
      const key = `${s.variant_id}_${s.warehouse_id}`;
      stockMap.set(key, s.stock_qty || 0);
    });
    
    // Agrupar variantes por producto y expandir con talles
    allProducts = products.map(product => {
      const productVariants = (variants || [])
        .filter(v => v.product_id === product.id);
      
      // Expandir cada variante con sus talles
      const expandedVariants = [];
      productVariants.forEach(variant => {
        const sizes = sizesByVariant.get(variant.id) || [];
        
        // Si no hay talles en variant_sizes, crear una entrada sin talle (comportamiento legacy)
        if (sizes.length === 0) {
          const stockGeneralKey = `${variant.id}_${warehouseIds.general}`;
          const stockVentaPublicoKey = `${variant.id}_${warehouseIds.ventaPublico}`;
          const stock_general = stockMap.get(stockGeneralKey) || 0;
          const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
          const stock_total = stock_general + stock_venta_publico;
          
          expandedVariants.push({
            ...variant,
            size: null, // Sin talle
            sizeSku: variant.sku, // Usar SKU de variante como fallback
            stock_general,
            stock_venta_publico,
            stock_total,
            isSizeRow: false // Indica que es una variante sin talles
          });
        } else {
          // Crear una entrada por cada talle
          sizes.forEach(sizeData => {
            const stockGeneralKey = `${variant.id}_${sizeData.size}_${warehouseIds.general}`;
            const stockVentaPublicoKey = `${variant.id}_${sizeData.size}_${warehouseIds.ventaPublico}`;
            const stock_general = sizeWarehouseStockMap.get(stockGeneralKey) || 0;
            const stock_venta_publico = sizeWarehouseStockMap.get(stockVentaPublicoKey) || 0;
            const stock_total = stock_general + stock_venta_publico;
            
            expandedVariants.push({
              ...variant,
              size: sizeData.size,
              sizeSku: sizeData.sku || variant.sku, // SKU específico del talle
              stock_general,
              stock_venta_publico,
              stock_total,
              isSizeRow: true // Indica que es un talle individual
            });
          });
        }
      });
      
      return {
        ...product,
        variants: expandedVariants,
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
          const sizeDisplay = variant.size || "Sin talle";
          const skuDisplay = variant.sizeSku || variant.sku || "N/A";
          const uniqueId = variant.size ? `${variant.id}-${variant.size}` : variant.id;
          return `
            <div class="mobile-size-item" data-variant-id="${variant.id}" data-size="${variant.size || ''}" data-unique-id="${uniqueId}">
              <div class="mobile-size-name">Talle ${sizeDisplay}</div>
              <div class="mobile-size-sku" style="font-size: 11px; color: #666; margin-bottom: 4px;">SKU: ${skuDisplay}</div>
              <div class="mobile-size-stocks">
                <div class="mobile-stock-item">
                  <span class="mobile-stock-label">General:</span>
                  <input 
                    type="number" 
                    min="0" 
                    value="${variant.stock_general}" 
                    class="mobile-stock-input mobile-stock-general"
                    data-variant-id="${variant.id}"
                    data-size="${variant.size || ''}"
                    data-unique-id="${uniqueId}"
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
                    data-size="${variant.size || ''}"
                    data-unique-id="${uniqueId}"
                    ${!canEditStock ? 'disabled' : ''}
                  />
                </div>
                <div class="mobile-stock-item mobile-stock-total">
                  <span class="mobile-stock-label">Total:</span>
                  <span class="mobile-stock-total-value" data-unique-id="${uniqueId}">${variant.stock_total}</span>
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
      // Layout desktop: agrupar por color
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
        const colorPrice = variants[0]?.price ? formatPrice(variants[0].price) : "N/A";
        
        const variantsHtml = variants.map(variant => {
          const lowStockClass = variant.stock_total <= 3 ? "low-stock" : "";
          const variantPrice = variant.price ? formatPrice(variant.price) : "N/A";
          const sizeDisplay = variant.size || "Sin talle";
          const skuDisplay = variant.sizeSku || variant.sku || "N/A";
          const uniqueId = variant.size ? `${variant.id}-${variant.size}` : variant.id;
          return `
            <div class="variant-item ${lowStockClass}" data-variant-id="${variant.id}" data-size="${variant.size || ''}" data-unique-id="${uniqueId}">
              <div class="variant-info">
                <div class="variant-color-size">${sizeDisplay}</div>
                <div class="variant-sku">SKU: ${skuDisplay}</div>
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
          <div class="color-group">
            <div class="color-group-header" data-color-id="${colorId}">
              <div class="color-group-name">
                <span class="color-group-expand-icon">▼</span>
                ${escapeHtml(color)}
              </div>
              <div class="color-group-summary">${colorPrice}</div>
              <div class="color-group-summary">${colorTotalGeneral}</div>
              <div class="color-group-summary">${colorTotalVenta}</div>
              <div class="color-group-summary"><strong>${colorTotal}</strong></div>
              <div class="variant-status">
                <span class="status-badge ${allActive ? 'status-active' : 'status-inactive'}">
                  ${allActive ? 'Activo' : 'Inactivo'}
                </span>
              </div>
            </div>
            <div class="color-group-details" id="${colorId}">
              ${variantsHtml}
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
              ${colorsHtml}
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
        const uniqueId = input.getAttribute("data-unique-id");
        const generalInput = productsContainer.querySelector(
          `.mobile-stock-general[data-unique-id="${uniqueId}"]`
        );
        const ventaInput = productsContainer.querySelector(
          `.mobile-stock-venta[data-unique-id="${uniqueId}"]`
        );
        const totalEl = productsContainer.querySelector(
          `.mobile-stock-total-value[data-unique-id="${uniqueId}"]`
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
    // Event listeners para expandir/colapsar colores en desktop
    productsContainer.querySelectorAll(".color-group-header").forEach(header => {
      header.addEventListener("click", (e) => {
        e.stopPropagation();
        const colorId = header.getAttribute("data-color-id");
        const details = document.getElementById(colorId);
        const icon = header.querySelector(".color-group-expand-icon");
        if (details) {
          const isExpanded = details.classList.contains("expanded");
          if (isExpanded) {
            details.classList.remove("expanded");
            header.classList.remove("expanded");
            icon.textContent = "▼";
          } else {
            details.classList.add("expanded");
            header.classList.add("expanded");
            icon.textContent = "▲";
          }
        }
      });
    });
    
    // Event listeners para abrir modal en desktop
    productsContainer.querySelectorAll(".product-card").forEach(card => {
      card.addEventListener("click", (e) => {
        // No abrir modal si se hace clic en un grupo de color o variante
        if (e.target.closest(".color-group-header") || 
            e.target.closest(".color-group-details") ||
            e.target.closest(".variant-item")) return;
        
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
    const sizeDisplay = variant.size || "Sin talle";
    const skuDisplay = variant.sizeSku || variant.sku || "N/A";
    const uniqueId = variant.size ? `${variant.id}-${variant.size}` : variant.id;
    row.innerHTML = `
      <td data-label="Color">${escapeHtml(variant.color || "Sin color")}</td>
      <td data-label="Talle">${escapeHtml(sizeDisplay)}</td>
      <td data-label="SKU">${escapeHtml(skuDisplay)}</td>
      <td class="cell-center" data-label="Precio">
        <input 
          type="number" 
          min="0" 
          step="0.01"
          value="${variant.price || 0}" 
          data-variant-id="${variant.id}"
          data-size="${variant.size || ''}"
          data-unique-id="${uniqueId}"
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
          data-size="${variant.size || ''}"
          data-unique-id="${uniqueId}"
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
          data-size="${variant.size || ''}"
          data-unique-id="${uniqueId}"
          data-field="stock_venta_publico"
          ${!canEditStock ? 'disabled' : ''}
        />
      </td>
      <td class="cell-center" data-label="Total">
        <strong id="total-${uniqueId}">${variant.stock_total}</strong>
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
      const uniqueId = input.getAttribute("data-unique-id");
      const stockGeneralInput = modalVariantsTbody.querySelector(
        `input[data-unique-id="${uniqueId}"][data-field="stock_general"]`
      );
      const stockVentaInput = modalVariantsTbody.querySelector(
        `input[data-unique-id="${uniqueId}"][data-field="stock_venta_publico"]`
      );
      const totalEl = document.getElementById(`total-${uniqueId}`);
      
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
    // Etapa 2: stock por talle → rpc_set_variant_size_stock_batch (164)
    //          stock sin talle → rpc_set_variant_warehouse_stock_batch (165)
    // variantUpdates sigue en Promise.all (precio/activo no son stock).
    const rpcSizeItems = [];
    const rpcNoSizeItems = [];
    const variantUpdates = [];

    // Recopilar todos los cambios
    modalVariantsTbody.querySelectorAll("tr").forEach(row => {
      const variantId = row.querySelector("input[data-field='stock_general']")?.getAttribute("data-variant-id");
      const size = row.querySelector("input[data-field='stock_general']")?.getAttribute("data-size") || null;
      const uniqueId = row.querySelector("input[data-field='stock_general']")?.getAttribute("data-unique-id");
      if (!variantId) return;

      const price = parseFloat(row.querySelector("input[data-field='price']")?.value || 0);
      const stockGeneral = parseInt(row.querySelector("input[data-field='stock_general']")?.value || 0);
      const stockVentaPublico = parseInt(row.querySelector("input[data-field='stock_venta_publico']")?.value || 0);
      const active = row.querySelector("input[data-field='active']")?.checked || false;

      const originalVariant = currentEditingProduct.variants.find(v => {
        const vUniqueId = v.size ? `${v.id}-${v.size}` : v.id;
        return vUniqueId === uniqueId;
      });
      if (!originalVariant) return;

      // Precio: solo una vez por variante (sin talle), sin cambios.
      if (price !== (originalVariant.price || 0) && !size) {
        variantUpdates.push(
          supabase.from("product_variants").update({ price }).eq("id", variantId)
        );
      }

      // Stock: acumular en el array RPC correspondiente.
      // La RPC skipea internamente si before === after, por lo que siempre mandamos
      // ambos warehouses sin necesidad del delta-check previo.
      if (size) {
        // Con talle → rpc_set_variant_size_stock_batch
        rpcSizeItems.push(
          { variant_id: variantId, size, warehouse_id: warehouseIds.general,      stock_qty: stockGeneral },
          { variant_id: variantId, size, warehouse_id: warehouseIds.ventaPublico, stock_qty: stockVentaPublico }
        );
      } else {
        // Sin talle → rpc_set_variant_warehouse_stock_batch
        rpcNoSizeItems.push(
          { variant_id: variantId, warehouse_id: warehouseIds.general,      stock_qty: stockGeneral },
          { variant_id: variantId, warehouse_id: warehouseIds.ventaPublico, stock_qty: stockVentaPublico }
        );
      }

      // Activo: solo una vez por variante, sin cambios.
      if (active !== originalVariant.active && !size) {
        variantUpdates.push(
          supabase.from("product_variants").update({ active }).eq("id", variantId)
        );
      }
    });

    // Guardia early-exit: nada cambió en ningún array.
    if (rpcSizeItems.length === 0 && rpcNoSizeItems.length === 0 && variantUpdates.length === 0) {
      closeEditModal();
      modalSaveBtn.disabled = false;
      modalSaveBtn.textContent = "Guardar Cambios";
      return;
    }

    // Ejecutar RPC con talle (si hay ítems).
    if (rpcSizeItems.length > 0) {
      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        "rpc_set_variant_size_stock_batch",
        { p_items: rpcSizeItems, p_source: "bulk_edit" }
      );
      if (rpcErr) {
        throw new Error(`Error guardando stock por talle: ${rpcErr.message}`);
      }
      if (!rpcData?.ok) {
        throw new Error("Error guardando stock por talle (respuesta inesperada del servidor).");
      }
      console.log(`✅ rpc_set_variant_size_stock_batch (modal): ${rpcData.changed_items} cambio(s), ${rpcData.skipped_unchanged} sin cambio.`);
    }

    // Ejecutar RPC sin talle (si hay ítems).
    if (rpcNoSizeItems.length > 0) {
      const { data: rpcData, error: rpcErr } = await supabase.rpc(
        "rpc_set_variant_warehouse_stock_batch",
        { p_items: rpcNoSizeItems, p_source: "bulk_edit" }
      );
      if (rpcErr) {
        throw new Error(`Error guardando stock sin talle: ${rpcErr.message}`);
      }
      if (!rpcData?.ok) {
        throw new Error("Error guardando stock sin talle (respuesta inesperada del servidor).");
      }
      console.log(`✅ rpc_set_variant_warehouse_stock_batch (modal): ${rpcData.changed_items} cambio(s), ${rpcData.skipped_unchanged} sin cambio.`);
    }

    // Ejecutar updates de precio/activo en product_variants.
    if (variantUpdates.length > 0) {
      const results = await Promise.all(variantUpdates);
      const errors = results.filter(r => r.error).map(r => r.error);
      if (errors.length > 0) {
        throw new Error(`Error actualizando variantes: ${errors.map(e => e.message).join(", ")}`);
      }
    }

    // Recargar productos y cerrar modal.
    await loadProducts();
    closeEditModal();

    // --- Código original (Etapa 1) — desactivado. Conservado como referencia.
    // Se elimina en el ciclo de limpieza post-validación de la Etapa 2.
    /*
    const updates = [];

    modalVariantsTbody.querySelectorAll("tr").forEach(row => {
      // ... (mismo loop, con upserts directos a variant_size_warehouse_stock y variant_warehouse_stock)
      if (size) {
        if (stockGeneral !== originalVariant.stock_general) {
          updates.push(supabase.from("variant_size_warehouse_stock").upsert(
            { variant_id: variantId, size, warehouse_id: warehouseIds.general, stock_qty: stockGeneral },
            { onConflict: "variant_id,size,warehouse_id" }
          ));
        }
        if (stockVentaPublico !== originalVariant.stock_venta_publico) {
          updates.push(supabase.from("variant_size_warehouse_stock").upsert(
            { variant_id: variantId, size, warehouse_id: warehouseIds.ventaPublico, stock_qty: stockVentaPublico },
            { onConflict: "variant_id,size,warehouse_id" }
          ));
        }
      } else {
        if (stockGeneral !== originalVariant.stock_general) {
          updates.push(supabase.from("variant_warehouse_stock").upsert(
            { variant_id: variantId, warehouse_id: warehouseIds.general, stock_qty: stockGeneral },
            { onConflict: "variant_id,warehouse_id" }
          ));
        }
        if (stockVentaPublico !== originalVariant.stock_venta_publico) {
          updates.push(supabase.from("variant_warehouse_stock").upsert(
            { variant_id: variantId, warehouse_id: warehouseIds.ventaPublico, stock_qty: stockVentaPublico },
            { onConflict: "variant_id,warehouse_id" }
          ));
        }
      }
    });

    const allUpdates = [...updates, ...variantUpdates];
    if (allUpdates.length === 0) { closeEditModal(); ... return; }
    const results = await Promise.all(allUpdates);
    const errors = results.filter(r => r.error).map(r => r.error);
    if (errors.length > 0) { showError(...); return; }
    await loadProducts();
    closeEditModal();
    */
    // --- fin código original ---

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
               (v.size && v.size.toLowerCase().includes(term)) ||
               (v.sizeSku && v.sizeSku.toLowerCase().includes(term)) ||
               (v.sku && v.sku.toLowerCase().includes(term))
             );
    });
  }
  renderProducts();
}

// Guardar cambio de stock en móvil
async function saveMobileStockChange(input) {
  const variantId = input.getAttribute("data-variant-id");
  const size = input.getAttribute("data-size") || null;
  const isGeneral = input.classList.contains("mobile-stock-general");
  const stockValue = parseInt(input.value || 0);

  const warehouseId = isGeneral ? warehouseIds.general : warehouseIds.ventaPublico;

  if (size) {
    // Etapa 2: con talle → rpc_set_variant_size_stock_batch (array de 1 ítem).
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "rpc_set_variant_size_stock_batch",
      {
        p_items: [{ variant_id: variantId, size, warehouse_id: warehouseId, stock_qty: stockValue }],
        p_source: "manual_edit",
      }
    );

    if (rpcError) {
      console.error("❌ rpc_set_variant_size_stock_batch (mobile) error:", rpcError);
      alert(`Error al guardar: ${rpcError.message}`);
      loadProducts();
    } else if (!rpcData?.ok) {
      console.error("❌ rpc_set_variant_size_stock_batch (mobile) ok=false:", rpcData);
      alert("Error al guardar stock (respuesta inesperada del servidor).");
      loadProducts();
    } else {
      console.log(`✅ rpc_set_variant_size_stock_batch (mobile): ${rpcData.changed_items} cambio(s).`);
    }

    // --- Código original (Etapa 1) — desactivado. Conservado como referencia.
    /*
    const { error } = await supabase
      .from("variant_size_warehouse_stock")
      .upsert(
        { variant_id: variantId, size: size, warehouse_id: warehouseId, stock_qty: stockValue },
        { onConflict: "variant_id,size,warehouse_id" }
      );
    if (error) {
      console.error("Error guardando stock por talle:", error);
      alert(`Error al guardar: ${error.message}`);
      loadProducts();
    }
    */
    // --- fin código original ---
  } else {
    // Etapa 2: sin talle → rpc_set_variant_warehouse_stock_batch (array de 1 ítem).
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "rpc_set_variant_warehouse_stock_batch",
      {
        p_items: [{ variant_id: variantId, warehouse_id: warehouseId, stock_qty: stockValue }],
        p_source: "manual_edit",
      }
    );

    if (rpcError) {
      console.error("❌ rpc_set_variant_warehouse_stock_batch (mobile) error:", rpcError);
      alert(`Error al guardar: ${rpcError.message}`);
      loadProducts();
    } else if (!rpcData?.ok) {
      console.error("❌ rpc_set_variant_warehouse_stock_batch (mobile) ok=false:", rpcData);
      alert("Error al guardar stock (respuesta inesperada del servidor).");
      loadProducts();
    } else {
      console.log(`✅ rpc_set_variant_warehouse_stock_batch (mobile): ${rpcData.changed_items} cambio(s).`);
    }

    // --- Código original (Etapa 1) — desactivado. Conservado como referencia.
    /*
    const { error } = await supabase
      .from("variant_warehouse_stock")
      .upsert(
        { variant_id: variantId, warehouse_id: warehouseId, stock_qty: stockValue },
        { onConflict: "variant_id,warehouse_id" }
      );
    if (error) {
      console.error("Error guardando stock:", error);
      alert(`Error al guardar: ${error.message}`);
      loadProducts();
    }
    */
    // --- fin código original ---
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

