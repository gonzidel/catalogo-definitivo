// admin/incomplete-products.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";

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

// Cargar productos incompletos (productos nuevos con status pending_stock y stock 0)
async function loadIncompleteProducts() {
  const { data: products, error } = await supabase
    .from("products")
    .select("id, handle, name, category, description, supplier_id, suppliers(name)")
    .eq("status", "pending_stock")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Error cargando productos:", error);
    showMessage(`Error cargando productos: ${error.message}`, "err");
    return [];
  }

  console.log(`📦 Productos con status pending_stock encontrados: ${(products || []).length}`);

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
      // Obtener variantes (sin size, ya que los talles están en variant_sizes)
      const { data: variants } = await supabase
        .from("product_variants")
        .select("id, sku, color, price")
        .eq("product_id", product.id)
        .order("color");

      if (!variants || variants.length === 0) {
        console.log(`⚠️ Producto ${product.name} (${product.id}) no tiene variantes - totalStock = 0`);
        return {
          ...product,
          variants: [],
          totalStock: 0,
        };
      }

      console.log(`🔍 Producto ${product.name} (${product.id}): ${variants.length} variante(s)`);

      // Obtener talles desde variant_sizes para todas las variantes
      const variantIds = variants.map(v => v.id);
      const { data: sizesData, error: sizesError } = await supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty, sku")
        .in("variant_id", variantIds)
        .order("size");

      if (sizesError) {
        console.error("Error cargando talles:", sizesError);
      }

      // Agrupar talles por variant_id
      const sizesByVariant = new Map();
      if (sizesData && sizesData.length > 0) {
        sizesData.forEach(sizeRow => {
          if (!sizeRow.variant_id) return;
          if (!sizesByVariant.has(sizeRow.variant_id)) {
            sizesByVariant.set(sizeRow.variant_id, []);
          }
          // Normalizar el tamaño usando la función centralizada
          const normalizedSize = normalizeSize(sizeRow.size) || String(sizeRow.size || "").trim();
          if (normalizedSize) {
            sizesByVariant.get(sizeRow.variant_id).push({
              size: normalizedSize,
              stock_qty: sizeRow.stock_qty || 0,
              sku: sizeRow.sku || null,
            });
          }
        });
      }

      // Obtener stock por talle y warehouse desde variant_size_warehouse_stock
      const { data: sizeWarehouseStocks, error: sizeWarehouseError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

      if (sizeWarehouseError) {
        console.error("Error cargando stock por talle y warehouse:", sizeWarehouseError);
      }

      // Crear mapa de stock por variante, talle y warehouse
      // key: `${variantId}_${normalizedSize}_${warehouseId}`
      // IMPORTANTE: Normalizar el tamaño para asegurar consistencia en las comparaciones
      const sizeWarehouseStockMap = new Map();
      if (sizeWarehouseStocks && sizeWarehouseStocks.length > 0) {
        sizeWarehouseStocks.forEach(sws => {
          const normalizedSize = normalizeSize(sws.size) || String(sws.size || "").trim();
          if (normalizedSize) {
            const key = `${sws.variant_id}_${normalizedSize}_${sws.warehouse_id}`;
            sizeWarehouseStockMap.set(key, sws.stock_qty || 0);
          }
        });
      }

      // Obtener stocks por almacén para variantes sin talles (stock total por variante)
      const { data: stocks, error: stocksError } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", variantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

      if (stocksError) {
        console.error("Error cargando stocks:", stocksError);
      }

      // Crear mapa de stocks por variante y almacén (para variantes sin talles)
      const stockMap = new Map();
      (stocks || []).forEach(s => {
        const key = `${s.variant_id}_${s.warehouse_id}`;
        stockMap.set(key, s.stock_qty || 0);
      });

      // Combinar datos: agregar talles y stocks a cada variante
      const variantsWithStock = variants.map(v => {
        // Obtener talles para esta variante
        const sizes = sizesByVariant.get(v.id) || [];

        if (sizes && sizes.length > 0) {
          // Para cada talle, obtener stock desde variant_size_warehouse_stock
          // IMPORTANTE: Normalizar el tamaño para asegurar consistencia en las comparaciones
          const sizesWithStock = sizes.map(sizeRow => {
            const normalizedSize = normalizeSize(sizeRow.size) || String(sizeRow.size || "").trim();
            const generalKey = `${v.id}_${normalizedSize}_${generalWarehouseId}`;
            const ventaPublicoKey = `${v.id}_${normalizedSize}_${ventaPublicoWarehouseId}`;
            const stock_general = sizeWarehouseStockMap.get(generalKey) || 0;
            const stock_venta_publico = sizeWarehouseStockMap.get(ventaPublicoKey) || 0;
            
            return {
              ...sizeRow,
              stock_general,
              stock_venta_publico,
              stock_total: stock_general + stock_venta_publico
            };
          });

          return {
            ...v,
            sizes: sizesWithStock, // Array de talles con stock individual por warehouse
          };
        } else {
          // Si no tiene talles, usar stock total de la variante desde variant_warehouse_stock
          const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
          const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
          const stock_general = stockMap.get(stockGeneralKey) || 0;
          const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
          const stock_total = stock_general + stock_venta_publico;

          return {
            ...v,
            sizes: [], // Sin talles
            stock_general,
            stock_venta_publico,
            stock_total
          };
        }
      });

      // Calcular stock total del producto (suma de todos los stock_total de los talles individuales)
      const totalStock = variantsWithStock.reduce((sum, v) => {
        if (v.sizes && v.sizes.length > 0) {
          // Si hay talles, sumar el stock total de cada talle (stock_general + stock_venta_publico)
          const sizesStock = v.sizes.reduce((sizeSum, s) => sizeSum + (s.stock_total || 0), 0);
          return sum + sizesStock;
        } else {
          // Si no hay talles, usar el stock total de la variante
          return sum + (v.stock_total || 0);
        }
      }, 0);

      console.log(`  📊 Producto ${product.name}: totalStock = ${totalStock} (variantes: ${variantsWithStock.length})`);

      return {
        ...product,
        supplier_name: product.suppliers?.name || null,
        variants: variantsWithStock,
        totalStock,
      };
    })
  );

  // Filtrar solo productos con stock total = 0 (productos nuevos sin stock contabilizado)
  const productsWithZeroStock = productsWithVariants.filter(p => {
    const hasZeroStock = p.totalStock === 0;
    if (!hasZeroStock) {
      console.log(`  ⏭️ Producto ${p.name} tiene stock ${p.totalStock}, no se incluye en incompletos`);
    }
    return hasZeroStock;
  });

  console.log(`✅ Productos incompletos (stock = 0): ${productsWithZeroStock.length} de ${productsWithVariants.length}`);

  return productsWithZeroStock;
}

// Renderizar productos
function renderProducts(products, containerId) {
  const container = document.getElementById(containerId);
  
  if (!products || products.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay productos incompletos en esta categoría</div>';
    return;
  }

  container.innerHTML = products.map((product, index) => {
    // Obtener colores faltantes (todos tienen stock 0)
    const colors = product.variants.map(v => v.color || 'Sin color').filter(Boolean);
    const colorsBadge = colors.length > 0 ? colors.join(', ') : 'Sin colores';

    // Generar HTML de variantes (solo cuando esté expandido)
    let previousColor = null;
    const variantsHtml = product.variants.map((v, variantIndex) => {
      const currentColor = v.color || 'Sin color';
      const isNewColor = previousColor !== null && previousColor !== currentColor;
      previousColor = currentColor;
      
      // Si hay talles individuales, mostrarlos
      if (v.sizes && v.sizes.length > 0) {
        const sizesHtml = v.sizes.map((sizeRow, sizeIndex) => {
          const stockGeneralValue = sizeRow.stock_general || 0;
          const stockVentaPublicoValue = sizeRow.stock_venta_publico || 0;
          const stockTotal = stockGeneralValue + stockVentaPublicoValue;
          const isFirstSizeOfNewColor = isNewColor && sizeIndex === 0;
          
          return `
            ${isFirstSizeOfNewColor ? '<div class="color-separator"></div>' : ''}
            <div class="variant-size-item ${isFirstSizeOfNewColor ? 'new-color-group' : ''}">
              <div class="variant-stock-row">
                <div class="variant-info-left">
                  <strong class="variant-color">${v.color || 'Sin color'}</strong>
                  <span class="variant-size">${sizeRow.size || 'N/A'}</span>
                </div>
                <div class="stock-input-group">
                  <label class="stock-label">General</label>
                  <input type="number" min="0" 
                         data-variant-id="${v.id}" 
                         data-size-id="${sizeRow.size}"
                         data-field="stock_general"
                         class="stock-input main-stock-input" 
                         placeholder="0" />
                </div>
                <div class="stock-input-group">
                  <label class="stock-label">Local</label>
                  <input type="number" min="0" 
                         data-variant-id="${v.id}" 
                         data-size-id="${sizeRow.size}"
                         data-field="stock_venta_publico"
                         class="stock-input main-stock-input" 
                         placeholder="0" />
                </div>
              </div>
            </div>
          `;
        }).join('');
        return sizesHtml;
      } else {
        // Si no hay talles, mostrar solo la variante de color
        const stockGeneralValue = v.stock_general || 0;
        const stockVentaPublicoValue = v.stock_venta_publico || 0;
        const stockTotal = stockGeneralValue + stockVentaPublicoValue;
        
        return `
          ${isNewColor ? '<div class="color-separator"></div>' : ''}
          <div class="variant-size-item ${isNewColor ? 'new-color-group' : ''}">
            <div class="variant-stock-row">
              <div class="variant-info-left">
                <strong class="variant-color">${v.color || 'Sin color'}</strong>
                <span class="variant-size">Sin talles</span>
              </div>
              <div class="stock-input-group">
                <label class="stock-label">General</label>
                <input type="number" min="0" 
                       data-variant-id="${v.id}" 
                       data-field="stock_general"
                       class="stock-input main-stock-input" 
                       placeholder="0" />
              </div>
              <div class="stock-input-group">
                <label class="stock-label">Local</label>
                <input type="number" min="0" 
                       data-variant-id="${v.id}" 
                       data-field="stock_venta_publico"
                       class="stock-input main-stock-input" 
                       placeholder="0" />
              </div>
            </div>
          </div>
        `;
      }
    }).join('');

    const productId = product.id;
    const accordionId = `product-${productId}-${index}`;

    return `
      <div class="product-accordion" data-product-id="${productId}">
        <button class="accordion-header" type="button" aria-expanded="false" aria-controls="${accordionId}">
          <div class="accordion-header-content">
            <div class="accordion-title-section">
              <h3 class="accordion-title">${product.name}</h3>
              ${product.supplier_name ? `<span class="accordion-supplier">${product.supplier_name}</span>` : ''}
            </div>
            <div class="accordion-colors-badge">
              <span class="colors-text">${colorsBadge}</span>
            </div>
          </div>
          <span class="accordion-icon">▼</span>
        </button>
        <div class="accordion-content" id="${accordionId}" style="display: none;">
          <div class="variants-list">
            ${variantsHtml}
          </div>
          <div class="accordion-actions">
            <button class="btn-complete" onclick="saveStockAndRedirect('${productId}')">
              <span>✓</span>
              <span>Completar Stock</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Configurar event listeners para acordeón y actualizar stock total
  setupAccordionListeners(container);
  setupMainStockInputListeners(container);
}

// Configurar event listeners para acordeón
function setupAccordionListeners(container) {
  const accordionHeaders = container.querySelectorAll(".accordion-header");
  accordionHeaders.forEach(header => {
    header.addEventListener("click", () => {
      const isExpanded = header.getAttribute("aria-expanded") === "true";
      const contentId = header.getAttribute("aria-controls");
      const content = document.getElementById(contentId);
      const icon = header.querySelector(".accordion-icon");

      if (isExpanded) {
        header.setAttribute("aria-expanded", "false");
        content.style.display = "none";
        icon.textContent = "▼";
        header.classList.remove("expanded");
      } else {
        header.setAttribute("aria-expanded", "true");
        content.style.display = "block";
        icon.textContent = "▲";
        header.classList.add("expanded");
      }
    });
  });
}

// Configurar event listeners para inputs de stock en la vista principal
function setupMainStockInputListeners(container) {
  const stockInputs = container.querySelectorAll(".main-stock-input");
  stockInputs.forEach(input => {
    input.addEventListener("input", (e) => {
      const variantId = e.target.dataset.variantId;
      const sizeId = e.target.dataset.sizeId;
      const variantSizeItem = e.target.closest(".variant-size-item");
      if (!variantSizeItem) return;

      // Obtener valores actuales
      const stockGeneralInput = variantSizeItem.querySelector(`input[data-field="stock_general"]`);
      const stockVentaPublicoInput = variantSizeItem.querySelector(`input[data-field="stock_venta_publico"]`);
      
      // El cálculo del total ya no es necesario ya que no se muestra
    });
  });
}

// Guardar stock
window.saveStockAndRedirect = async function(productId) {
  const product = incompleteProducts.find(p => p.id === productId);
  if (!product) return;

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

  // Obtener stocks desde la vista principal
  const productAccordion = document.querySelector(`.product-accordion[data-product-id="${productId}"]`);
  if (!productAccordion) {
    showMessage("Error: No se encontró el producto", "err");
    return;
  }

  const stockInputs = productAccordion.querySelectorAll(".main-stock-input");
  
  // Agrupar por variantId y size (cada talle tiene su propio stock)
  const sizeStockMap = new Map(); // key: `${variantId}_${size}`
  const variantTotals = new Map(); // key: variantId -> { stock_general: 0, stock_venta_publico: 0 }
  
  Array.from(stockInputs).forEach(input => {
    const variantId = input.dataset.variantId;
    const sizeId = input.dataset.sizeId; // El size del talle
    const field = input.dataset.field;
    const value = parseInt(input.value, 10) || 0;
    
    if (!variantId) return;
    
    // Si hay sizeId, agrupar por variantId y size
    if (sizeId) {
      const key = `${variantId}_${sizeId}`;
      if (!sizeStockMap.has(key)) {
        sizeStockMap.set(key, {
          variantId,
          size: sizeId,
          stock_general: 0,
          stock_venta_publico: 0,
        });
      }
      const stockData = sizeStockMap.get(key);
      stockData[field] = value;
    } else {
      // Si no hay sizeId, es una variante sin talles (caso especial)
      if (!variantTotals.has(variantId)) {
        variantTotals.set(variantId, {
          stock_general: 0,
          stock_venta_publico: 0,
        });
      }
      const stockData = variantTotals.get(variantId);
      stockData[field] = value;
    }
  });

  // Guardar stocks si hay actualizaciones
  try {
    // 1. Guardar stock por talle en variant_sizes (solo si hay talles)
    if (sizeStockMap.size > 0) {
      const sizeWarehouseUpdates = [];
      
      sizeStockMap.forEach((stockData, key) => {
        const sizeNormalized = String(stockData.size || "").trim();
        
        sizeWarehouseUpdates.push({
          variant_id: stockData.variantId,
          size: sizeNormalized,
          warehouse_id: generalWarehouseId,
          stock_qty: stockData.stock_general || 0,
        });
        
        sizeWarehouseUpdates.push({
          variant_id: stockData.variantId,
          size: sizeNormalized,
          warehouse_id: ventaPublicoWarehouseId,
          stock_qty: stockData.stock_venta_publico || 0,
        });
      });

      // variant_sizes se actualiza automáticamente via trigger 84
      // al escribir en variant_size_warehouse_stock.

      // Upsert en variant_size_warehouse_stock (stock por talle y warehouse)
      if (sizeWarehouseUpdates.length > 0) {
        const { error: sizeWarehouseError } = await supabase
          .from("variant_size_warehouse_stock")
          .upsert(sizeWarehouseUpdates, {
            onConflict: "variant_id,size,warehouse_id",
          });

        if (sizeWarehouseError) {
          console.error("Error actualizando variant_size_warehouse_stock:", sizeWarehouseError);
          throw new Error(`Error actualizando stock por talle y almacén: ${sizeWarehouseError.message}`);
        }
      }

      // variant_warehouse_stock se actualiza automáticamente via trigger 145
      // al escribir en variant_size_warehouse_stock.
    }

    // 4. Si hay variantes sin talles, guardar directamente en variant_warehouse_stock
    if (variantTotals.size > 0) {
      const warehouseUpdates = [];
      variantTotals.forEach((stockData, variantId) => {
        warehouseUpdates.push({
          variant_id: variantId,
          warehouse_id: generalWarehouseId,
          stock_qty: stockData.stock_general || 0,
        });
        warehouseUpdates.push({
          variant_id: variantId,
          warehouse_id: ventaPublicoWarehouseId,
          stock_qty: stockData.stock_venta_publico || 0,
        });
      });

      if (warehouseUpdates.length > 0) {
        const { error: warehouseError } = await supabase
          .from("variant_warehouse_stock")
          .upsert(warehouseUpdates, {
            onConflict: "variant_id,warehouse_id",
          });

        if (warehouseError) {
          console.error("Error actualizando variant_warehouse_stock (sin talles):", warehouseError);
          throw new Error(`Error actualizando stock: ${warehouseError.message}`);
        }
      }
    }
  } catch (error) {
    showMessage(`Error guardando stock: ${error.message}`, "err");
    return;
  }

  // Verificar si el producto tiene imágenes antes de activarlo
  const variantIds = product.variants.map(v => v.id);
  if (variantIds.length > 0) {
    const { data: images, error: imagesError } = await supabase
      .from("variant_images")
      .select("id")
      .in("variant_id", variantIds)
      .limit(1);

    if (!imagesError && images && images.length > 0) {
      // El producto tiene imágenes, activarlo
      const { error: statusError } = await supabase
        .from("products")
        .update({ status: "active" })
        .eq("id", productId);

      if (statusError) {
        console.error("Error actualizando status del producto:", statusError);
        showMessage("Stock guardado, pero no se pudo activar el producto", "err");
      } else {
        showMessage("Stock guardado y producto activado", "ok");
      }
    } else {
      // No tiene imágenes, dejar el status como está
      showMessage("Stock guardado correctamente (falta cargar imágenes para activar)", "ok");
    }
  } else {
    showMessage("Stock guardado correctamente", "ok");
  }
  
  // Recargar productos para que el producto con stock desaparezca de la lista
  await refreshProducts();
};

// Funciones del modal eliminadas

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
  console.log("🔄 Refrescando productos incompletos...");
  incompleteProducts = await loadIncompleteProducts();
  
  console.log(`📋 Total productos incompletos: ${incompleteProducts.length}`);
  
  const shoes = incompleteProducts.filter(p => p.category === "Calzado");
  const clothing = incompleteProducts.filter(p => p.category === "Ropa");
  
  console.log(`👟 Calzado: ${shoes.length}, 👕 Ropa: ${clothing.length}`);
  
  renderProducts(shoes, "shoes-container");
  renderProducts(clothing, "clothing-container");
}


// Cargar productos al iniciar
let incompleteProducts = [];
refreshProducts();
