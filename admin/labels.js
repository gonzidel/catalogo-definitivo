// admin/labels.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { SUPABASE_URL, QZ_SIGN_SECRET } from "../scripts/config.js";

await requireAuth();

// Referencias DOM
const searchInput = document.getElementById("label-product-search");
const resultsContainer = document.getElementById("label-product-results");
const detailContainer = document.getElementById("label-product-detail");

// Estado
let currentProduct = null;

// ============================================================================
// Utilidades
// ============================================================================

function debounce(fn, wait = 300) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), wait);
  };
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ============================================================================
// Búsqueda de productos
// ============================================================================

async function searchProductsForLabels(term, category = "Ropa") {
  if (!term || term.trim().length < 2) {
    return [];
  }

  try {
    const searchTerm = term.trim().toLowerCase();
    // Normalizar categoría: capitalizar primera letra (Ropa, Calzado, etc.)
    const normalizedCategory = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
    
    console.log("🔍 Búsqueda labels:", { term, category, normalizedCategory });

    let productIds = [];
    let products = [];

    // Buscar productos por nombre, handle o código (filtrar por categoría, sin filtrar por status)
    if (searchTerm) {
      const { data: productsByName, error: productsError } = await supabase
        .from("products")
        .select("id, name, category, status, handle")
        .eq("category", normalizedCategory)
        .or(`name.ilike.%${searchTerm}%,handle.ilike.%${searchTerm}%`)
        .limit(100);

      if (productsError) {
        console.error("❌ Error buscando productos por nombre:", productsError);
        throw productsError;
      }
      
      console.log(`📦 Productos encontrados por nombre/handle: ${productsByName?.length || 0}`, productsByName);

      if (productsByName && productsByName.length > 0) {
        products = productsByName;
        productIds = products.map(p => p.id);
      }
    }

    // Buscar variantes que coincidan con el término (SKU, color)
    // Nota: size ya no se usa en product_variants, se busca en variant_sizes
    // Sin filtrar por active para mostrar todas las variantes
    let variantsQuery = supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        active,
        product_id,
        products!inner(id, name, category, status, handle)
      `);

    if (searchTerm) {
      // Extraer código base del término de búsqueda (si es algo como "R1751-BLA", usar "R1751")
      const baseCode = searchTerm.split('-')[0];
      const searchPattern = baseCode.length >= 2 ? baseCode : searchTerm;
      
      // Buscar por SKU completo, código base (que empiece con el término), o color
      const skuSearchPattern = searchPattern !== searchTerm 
        ? `sku.ilike.%${searchTerm}%,sku.ilike.${searchPattern}%,color.ilike.%${searchTerm}%`
        : `sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`;
      
      if (productIds.length > 0) {
        variantsQuery = variantsQuery
          .in("product_id", productIds)
          .or(skuSearchPattern);
      } else {
        variantsQuery = variantsQuery.or(skuSearchPattern);
      }
    } else {
      if (productIds.length > 0) {
        variantsQuery = variantsQuery.in("product_id", productIds);
      }
    }

    // También buscar en variant_sizes por SKU de talle
    // Buscar por SKU completo o por código base (parte antes del guión, ej: "R1751" en "R1751-BLA-L")
    let sizeSkuMatches = [];
    if (searchTerm) {
      // Extraer código base del término de búsqueda (si es algo como "R1751-BLA-L", usar "R1751")
      const baseCode = searchTerm.split('-')[0];
      const searchPattern = baseCode.length >= 2 ? baseCode : searchTerm;
      
      // Usar consultas separadas en lugar de .or() para evitar errores 400
      // Sin filtrar por active para mostrar todas las variantes
      // Buscar por SKU completo o por código base (que empiece con el término)
      const [skuMatches, sizeMatches, baseCodeMatches] = await Promise.all([
        supabase
          .from("variant_sizes")
          .select("variant_id, sku, size, product_variants!inner(id, product_id, color, active, products!inner(id, name, category, status, handle))")
          .ilike("sku", `%${searchTerm}%`),
        supabase
          .from("variant_sizes")
          .select("variant_id, sku, size, product_variants!inner(id, product_id, color, active, products!inner(id, name, category, status, handle))")
          .ilike("size", `%${searchTerm}%`),
        // Buscar por código base (SKUs que empiecen con el código base)
        searchPattern.length >= 2 ? supabase
          .from("variant_sizes")
          .select("variant_id, sku, size, product_variants!inner(id, product_id, color, active, products!inner(id, name, category, status, handle))")
          .ilike("sku", `${searchPattern}%`) : Promise.resolve({ data: null, error: null })
      ]);

      // Combinar resultados y eliminar duplicados
      const allSizeMatches = [];
      const seenIds = new Set();
      
      [skuMatches.data, sizeMatches.data, baseCodeMatches.data].forEach(matches => {
        if (matches) {
          matches.forEach(sm => {
            if (!seenIds.has(sm.variant_id)) {
              seenIds.add(sm.variant_id);
              allSizeMatches.push(sm);
            }
          });
        }
      });

      // Filtrar solo los que son de la categoría correcta (sin filtrar por status)
      sizeSkuMatches = allSizeMatches
        .filter(sm => 
          sm.product_variants && 
          sm.product_variants.products && 
          sm.product_variants.products.category === normalizedCategory
        )
        .map(sm => ({
          id: sm.product_variants.id,
          sku: sm.product_variants.sku,
          color: sm.product_variants.color,
          active: sm.product_variants.active,
          product_id: sm.product_variants.product_id,
          products: sm.product_variants.products
        }));
    }

    const { data: variants, error: variantsError } = await variantsQuery.limit(500);

    if (variantsError) {
      console.error("❌ Error buscando variantes:", variantsError);
      throw variantsError;
    }
    
    console.log(`🎨 Variantes encontradas (antes de filtrar por categoría): ${variants?.length || 0}`);
    
    // Filtrar variantes de la categoría correcta (sin filtrar por status)
    const activeVariants = (variants || []).filter(v => {
      const matches = v.products && v.products.category === normalizedCategory;
      if (!matches && v.products) {
        console.log(`⚠️ Variante descartada - categoría: "${v.products.category}" (esperada: "${normalizedCategory}")`);
      }
      return matches;
    });
    
    console.log(`✅ Variantes después de filtrar por categoría "${normalizedCategory}": ${activeVariants.length}`);

    // Combinar variantes encontradas directamente con las encontradas por SKU de talle
    const allVariants = [...activeVariants];
    if (sizeSkuMatches.length > 0) {
      // Evitar duplicados
      const variantIds = new Set(allVariants.map(v => v.id));
      sizeSkuMatches.forEach(v => {
        if (!variantIds.has(v.id)) {
          allVariants.push(v);
          variantIds.add(v.id);
        }
      });
    }

    if (allVariants.length === 0) {
      return [];
    }

    // Si no encontramos productos por nombre pero sí variantes, obtener los productos
    if (products.length === 0 && allVariants.length > 0) {
      const uniqueProductIds = [...new Set(allVariants.map(v => v.product_id))];
      if (uniqueProductIds.length > 0) {
        const { data: productsFromVariants, error: productsError2 } = await supabase
          .from("products")
          .select("id, name, category, status, handle")
          .in("id", uniqueProductIds)
          .eq("category", normalizedCategory);

        if (productsError2) throw productsError2;
        products = productsFromVariants || [];
      }
    }

    // Combinar productos con sus variantes
    const productsMap = new Map();

    products.forEach(p => {
      productsMap.set(p.id, {
        id: p.id,
        name: p.name,
        category: p.category,
        handle: p.handle,
        variants: []
      });
    });

    // Agregar productos desde todas las variantes encontradas
    allVariants.forEach(v => {
      // Agregar producto al mapa si no existe
      const productId = v.product_id || (v.products && v.products.id);
      if (v.products && !productsMap.has(productId)) {
        productsMap.set(productId, {
          id: v.products.id,
          name: v.products.name,
          category: v.products.category,
          handle: v.products.handle,
          variants: []
        });
      }
    });

    // Agregar variantes a sus productos correspondientes
    allVariants.forEach(v => {
      const productId = v.product_id || (v.products && v.products.id);
      const product = productsMap.get(productId);

      if (product) {
        product.variants.push({
          id: v.id,
          sku: v.sku,
          color: v.color,
          active: v.active
        });
      }
    });

    // Filtrar productos que no tienen variantes
    return Array.from(productsMap.values())
      .filter(p => p.variants.length > 0);
  } catch (error) {
    console.error("Error buscando productos:", error);
    return [];
  }
}

async function enrichVariantsWithStock(variants) {
  if (!variants || variants.length === 0) {
    return [];
  }

  const variantIds = variants.map(v => v.id);

  // Obtener talles desde variant_sizes para todas las variantes
  const { data: sizesData, error: sizesError } = await supabase
    .from("variant_sizes")
    .select("variant_id, size, stock_qty, sku, qr_code")
    .in("variant_id", variantIds)
    .order("size");

  if (sizesError) {
    console.error("Error obteniendo talles desde variant_sizes:", sizesError);
  }

  // Agrupar talles por variant_id
  const sizesByVariant = new Map();
  if (sizesData && sizesData.length > 0) {
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
          qr_code: sizeRow.qr_code || null,
        });
      }
    });
  }

  // Obtener IDs de almacenes para stock detallado
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);

  let generalWarehouseId = null;
  let ventaPublicoWarehouseId = null;
  if (!warehousesError && warehouses) {
    warehouses.forEach(w => {
      if (w.code === "general") generalWarehouseId = w.id;
      if (w.code === "venta-publico") ventaPublicoWarehouseId = w.id;
    });
  }

  // Obtener stock por talle y almacén si hay almacenes disponibles
  let sizeWarehouseStockMap = new Map();
  if (generalWarehouseId && ventaPublicoWarehouseId) {
    const { data: sizeWarehouseStocks, error: sizeWarehouseError } = await supabase
      .from("variant_size_warehouse_stock")
      .select("variant_id, size, warehouse_id, stock_qty")
      .in("variant_id", variantIds)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

    if (!sizeWarehouseError && sizeWarehouseStocks) {
      sizeWarehouseStocks.forEach(sws => {
        // Normalizar el size para asegurar consistencia con las claves de búsqueda
        const sizeNormalized = String(sws.size || "").trim();
        const key = `${sws.variant_id}_${sizeNormalized}_${sws.warehouse_id}`;
        sizeWarehouseStockMap.set(key, sws.stock_qty || 0);
      });
    }
  }

  // Enriquecer variantes con sus talles
  const enriched = [];
  for (const variant of variants) {
    const sizes = sizesByVariant.get(variant.id) || [];
    
    // Si no hay talles en variant_sizes, agregar placeholder para asegurar que se muestre
    if (sizes.length === 0) {
      if (variant.size) {
        // Fallback: usar el size de la variante (comportamiento legacy)
        sizes.push({
          size: variant.size,
          stock_qty: 0,
          sku: variant.sku || null,
          qr_code: null
        });
      } else {
        // Si no hay size legacy, agregar placeholder "Sin talle" para que se muestre
        sizes.push({
          size: "Sin talle",
          stock_qty: 0,
          sku: variant.sku || null,
          qr_code: null
        });
      }
    }

    // Enriquecer cada talle con stock por almacén
    const enrichedSizes = sizes.map(sizeData => {
      // Normalizar el size para asegurar consistencia con las claves del map
      const sizeNormalized = String(sizeData.size || "").trim();
      
      const stockDeposito = generalWarehouseId 
        ? (sizeWarehouseStockMap.get(`${variant.id}_${sizeNormalized}_${generalWarehouseId}`) || 0)
        : 0;
      const stockLocal = ventaPublicoWarehouseId
        ? (sizeWarehouseStockMap.get(`${variant.id}_${sizeNormalized}_${ventaPublicoWarehouseId}`) || 0)
        : 0;
      
      let finalStockDeposito = stockDeposito;
      let finalStockLocal = stockLocal;

      // Stock Total = suma de depósito + local
      const stockTotal = finalStockDeposito + finalStockLocal;

      return {
        ...sizeData,
        stock_qty: stockTotal > 0 ? stockTotal : (sizeData.stock_qty || 0), // Stock total = depósito + local
        stock_deposito: finalStockDeposito,
        stock_local: finalStockLocal,
      };
    });

    enriched.push({
      ...variant,
      sizes: enrichedSizes,
      // Mantener stock total para compatibilidad (suma de todos los talles)
      stock: enrichedSizes.reduce((sum, s) => sum + (s.stock_qty || 0), 0)
    });
  }

  return enriched;
}

// ============================================================================
// Renderizado de resultados
// ============================================================================

function renderSearchResults(products) {
  if (products.length === 0) {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>No se encontraron productos</p>
      </div>
    `;
    return;
  }

  const html = products.map(product => {
    const firstSku = product.variants[0]?.sku || "";
    return `
      <div class="product-result-item" data-product-id="${product.id}">
        <div class="product-name">${escapeHtml(product.name)}</div>
        <div class="product-sku">${escapeHtml(firstSku)}</div>
      </div>
    `;
  }).join("");

  resultsContainer.innerHTML = html;

  // Agregar event listeners
  document.querySelectorAll(".product-result-item").forEach(item => {
    item.addEventListener("click", async () => {
      const productId = item.dataset.productId;
      const product = products.find(p => p.id === productId);
      if (product) {
        await showLabelProductDetail(product);
      }
    });
  });
}

async function showLabelProductDetail(product) {
  currentProduct = product;

  // Obtener todas las variantes del producto (sin usar size que está deprecado)
  // Sin filtrar por active para mostrar todas las variantes
  try {
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select("id, sku, color, active")
      .eq("product_id", product.id);

    if (error) throw error;

    if (!variants || variants.length === 0) {
      detailContainer.innerHTML = `
        <div class="no-results">
          <p>Este producto no tiene variantes</p>
        </div>
      `;
      detailContainer.classList.add("show");
      return;
    }

    // Enriquecer con talles y stock desde variant_sizes
    const enrichedVariants = await enrichVariantsWithStock(variants);

    // Agrupar por color
    const variantsByColor = {};
    enrichedVariants.forEach(v => {
      const color = v.color || "Sin color";
      if (!variantsByColor[color]) {
        variantsByColor[color] = [];
      }
      variantsByColor[color].push(v);
    });

    // Obtener imagen principal si existe
    let imageUrl = null;
    if (enrichedVariants.length > 0) {
      try {
        const { data: images, error: imagesError } = await supabase
          .from("variant_images")
          .select("url")
          .eq("variant_id", enrichedVariants[0].id)
          .eq("position", 1)
          .limit(1)
          .maybeSingle();

        // Si hay error o no hay imagen, simplemente continuar sin imagen
        if (!imagesError && images && images.url) {
          imageUrl = images.url;
        }
      } catch (error) {
        // Ignorar errores al obtener imágenes (no es crítico para imprimir etiquetas)
        console.warn("⚠️ No se pudo obtener imagen de variante (no crítico):", error);
      }
    }

    // Calcular SKU base para mostrar (primer SKU de talle o SKU de variante)
    let displaySku = "";
    if (enrichedVariants.length > 0 && enrichedVariants[0].sizes && enrichedVariants[0].sizes.length > 0) {
      displaySku = enrichedVariants[0].sizes[0].sku || enrichedVariants[0].sku || "";
    } else {
      displaySku = enrichedVariants[0]?.sku || "";
    }

    // Renderizar
    let html = `
      <div class="product-detail-header">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.name)}" class="product-detail-image" />` : ""}
        <div class="product-detail-info">
          <h2 class="product-detail-title">${escapeHtml(product.name)}</h2>
          <div class="product-detail-sku">SKU: ${escapeHtml(displaySku)}</div>
        </div>
      </div>
      <div class="variants-container">
    `;

    // Renderizar cada color
    Object.keys(variantsByColor).sort().forEach((color, colorIndex) => {
      const colorVariants = variantsByColor[color];
      const variantId = `variant-${colorIndex}`;

      // Calcular stock total del color (suma de todos los talles de todas las variantes de este color)
      let colorStockTotal = 0;
      let colorStockDeposito = 0;
      let colorStockLocal = 0;
      colorVariants.forEach(v => {
        if (v.sizes && v.sizes.length > 0) {
          v.sizes.forEach(size => {
            colorStockTotal += size.stock_qty || 0;
            colorStockDeposito += size.stock_deposito || 0;
            colorStockLocal += size.stock_local || 0;
          });
        }
      });

      html += `
        <div class="variant-card">
          <div class="variant-header" data-variant-toggle="${variantId}">
            <span>${escapeHtml(color)} Stock Total: ${colorStockTotal} | Depósito: ${colorStockDeposito} | Local: ${colorStockLocal}</span>
            <span class="variant-toggle">▼</span>
          </div>
          <div class="variant-content" id="${variantId}">
      `;

      // Renderizar cada talle de cada variante de este color
      colorVariants.forEach(variant => {
        // Mostrar todas las variantes, incluso si no tienen talles (tendrán placeholder "Sin talle")
        if (!variant.sizes || variant.sizes.length === 0) {
          // Si por alguna razón no tiene sizes, agregar placeholder
          variant.sizes = [{
            size: "Sin talle",
            stock_qty: 0,
            sku: variant.sku || null,
            qr_code: null,
            stock_deposito: 0,
            stock_local: 0
          }];
        }

        // Ordenar talles
        const sortedSizes = [...variant.sizes].sort((a, b) => {
          const sizeA = parseFloat(a.size) || 0;
          const sizeB = parseFloat(b.size) || 0;
          if (sizeA !== sizeB) return sizeA - sizeB;
          return (a.size || "").localeCompare(b.size || "", "es");
        });

        sortedSizes.forEach(sizeData => {
          const rowId = `row-${variant.id}-${sizeData.size}`;
          const sizeSku = sizeData.sku || variant.sku || "";
          const qrCode = sizeData.qr_code || null;
          const stockTotal = sizeData.stock_qty || 0;
          const stockDeposito = sizeData.stock_deposito || 0;
          const stockLocal = sizeData.stock_local || 0;

          html += `
            <div class="label-size-row" 
                 id="${rowId}"
                 data-sku="${escapeHtml(sizeSku)}"
                 data-qr-code="${escapeHtml(qrCode || '')}"
                 data-name="${escapeHtml(product.name)}"
                 data-color="${escapeHtml(color)}"
                 data-size="${escapeHtml(sizeData.size)}"
                 data-stock="${stockTotal}"
                 data-stock-deposito="${stockDeposito}"
                 data-stock-local="${stockLocal}">
              <span class="label-size-name">${escapeHtml(sizeData.size)}</span>
              <span class="label-size-stock">SKU: ${escapeHtml(sizeSku)}${qrCode ? ` | QR: ${escapeHtml(qrCode)}` : ''}</span>
              <span class="label-size-stock">Stock: ${stockTotal} (Dep: ${stockDeposito} | Loc: ${stockLocal})</span>
              <input type="number" class="label-size-qty" min="1" value="" />
              <button class="btn-print-custom-qty" data-row-id="${rowId}">Imprimir cantidad</button>
            </div>
          `;
        });
      });

      html += `
          </div>
        </div>
      `;
    });

    html += `
      </div>
      <div class="global-actions">
        <button class="btn-print-all-stock">Imprimir Todo</button>
      </div>
    `;

    detailContainer.innerHTML = html;
    detailContainer.classList.add("show");

    // Agregar event listeners
    setupDetailEventListeners();
  } catch (error) {
    console.error("Error mostrando detalle del producto:", error);
    detailContainer.innerHTML = `
      <div class="no-results">
        <p>Error al cargar el producto: ${error.message}</p>
      </div>
    `;
    detailContainer.classList.add("show");
  }
}

function setupDetailEventListeners() {
  // Toggle de variantes (colores)
  document.querySelectorAll(".variant-header").forEach(header => {
    header.addEventListener("click", () => {
      const variantId = header.dataset.variantToggle;
      const content = document.getElementById(variantId);
      const toggle = header.querySelector(".variant-toggle");

      if (content.classList.contains("expanded")) {
        content.classList.remove("expanded");
        toggle.textContent = "▼";
      } else {
        content.classList.add("expanded");
        toggle.textContent = "▲";
      }
    });
  });

  // Expandir primera variante por defecto
  const firstVariant = document.querySelector(".variant-content");
  if (firstVariant) {
    firstVariant.classList.add("expanded");
    const firstToggle = document.querySelector(".variant-header .variant-toggle");
    if (firstToggle) {
      firstToggle.textContent = "▲";
    }
  }

  // Botones de impresión por talle
  document.querySelectorAll(".btn-print-custom-qty").forEach(btn => {
    btn.addEventListener("click", () => {
      const rowId = btn.dataset.rowId;
      const row = document.getElementById(rowId);
      if (!row) return;

      const sku = row.dataset.sku;
      const qrCode = row.dataset.qrCode || null;
      const name = row.dataset.name;
      const color = row.dataset.color;
      const size = row.dataset.size;
      const qtyInput = row.querySelector(".label-size-qty");
      const qty = parseInt(qtyInput.value, 10) || 0;

      if (qty <= 0) {
        alert("La cantidad debe ser mayor a 0");
        return;
      }

      // Usar qr_code si está disponible, sino usar sku como fallback
      const qrData = qrCode || sku;
      printProductLabelsZebra(sku, name, color, size, qty, qrData);
    });
  });

  // Botones globales
  document.querySelector(".btn-print-all-stock")?.addEventListener("click", () => {
    const rows = document.querySelectorAll(".label-size-row");
    const rowsToPrint = [];

    rows.forEach(row => {
      const qtyInput = row.querySelector(".label-size-qty");
      const qty = parseInt(qtyInput.value, 10) || 0;

      if (qty > 0) {
        rowsToPrint.push({
          row: row,
          qty: qty,
          color: row.dataset.color || "",
          size: row.dataset.size || ""
        });
      }
    });

    if (rowsToPrint.length === 0) {
      alert("No hay cantidades ingresadas para imprimir");
      return;
    }

    // Ordenar por color (alfabéticamente) y luego por talle (numéricamente, luego alfabéticamente)
    rowsToPrint.sort((a, b) => {
      // Primero ordenar por color
      const colorCompare = (a.color || "").localeCompare(b.color || "", "es");
      if (colorCompare !== 0) return colorCompare;

      // Si el color es igual, ordenar por talle
      const sizeA = parseFloat(a.size) || 0;
      const sizeB = parseFloat(b.size) || 0;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return (a.size || "").localeCompare(b.size || "", "es");
    });

    // Imprimir en orden
    rowsToPrint.forEach(({ row, qty }) => {
      const sku = row.dataset.sku;
      const qrCode = row.dataset.qrCode || null;
      const name = row.dataset.name;
      const color = row.dataset.color;
      const size = row.dataset.size;

      // Usar qr_code si está disponible, sino usar sku como fallback
      const qrData = qrCode || sku;
      printProductLabelsZebra(sku, name, color, size, qty, qrData);
    });
  });
}

// ============================================================================
// Setup de búsqueda
// ============================================================================

function setupLabelProductSearch() {
  const categoryFilter = document.getElementById("label-category-filter");
  
  const debouncedSearch = debounce(async (term) => {
    if (!term || term.trim().length < 2) {
      resultsContainer.innerHTML = "";
      return;
    }

    resultsContainer.innerHTML = '<div class="loading">Buscando...</div>';

    const category = categoryFilter ? categoryFilter.value : "Ropa";
    const products = await searchProductsForLabels(term, category);
    renderSearchResults(products);
  }, 300);

  searchInput.addEventListener("input", (e) => {
    const term = e.target.value.trim();
    debouncedSearch(term);
  });
  
  // Si cambia la categoría y hay un término de búsqueda, volver a buscar
  if (categoryFilter) {
    categoryFilter.addEventListener("change", () => {
      const term = searchInput.value.trim();
      if (term && term.length >= 2) {
        debouncedSearch(term);
      }
    });
  }
}

// ============================================================================
// QZ Tray - Funciones helper
// ============================================================================

// Verificar que QZ Tray esté disponible (esperar hasta que se cargue)
async function checkQZAvailable(maxWait = 10000) {
  const startTime = Date.now();
  
  while (typeof qz === 'undefined' || !qz || !qz.websocket) {
    if (Date.now() - startTime > maxWait) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return true;
}

// Función helper para configurar certificado y firma de QZ Tray
async function setupQZSignature() {
  if (typeof qz === 'undefined' || !qz || !qz.security) {
    console.warn("⚠️ QZ Tray no está disponible para configurar firma");
    return false;
  }

  // Verificar si ya está configurado para evitar configurar múltiples veces
  if (qz.security._signaturePromise) {
    console.log("ℹ️ Firma QZ ya está configurada");
    return true;
  }

  try {
    console.log("🔧 Configurando certificado y firma remota de QZ Tray...");

    // PASO 1: Precargar y configurar certificado público (ANTES de la firma)
    // Esto identifica la conexión y evita que QZ Tray la trate como "anonymous"
    console.log("📜 setCertificatePromise: cargando /qz-site.crt");
    let certText = null;
    try {
      const certResponse = await fetch("/qz-site.crt", { cache: "no-store" });
      if (!certResponse.ok) {
        throw new Error(`HTTP ${certResponse.status}: ${certResponse.statusText}`);
      }
      
      // Verificar Content-Type para detectar si se está sirviendo HTML
      const contentType = certResponse.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        throw new Error("El servidor está sirviendo HTML en lugar del certificado. Verifica que /certs/qz-site.crt esté desplegado correctamente en Firebase Hosting.");
      }
      
      certText = await certResponse.text();
      
      // Verificar que no sea HTML antes de procesar
      if (certText.trim().startsWith("<!DOCTYPE") || certText.trim().startsWith("<html")) {
        throw new Error("Se recibió HTML en lugar del certificado. El archivo /certs/qz-site.crt no está disponible o Firebase está sirviendo index.html en su lugar.");
      }
      
      console.log("✅ cert cargado, len=", certText.length, "begin=", certText.includes("BEGIN CERTIFICATE"));
    } catch (certError) {
      console.error("❌ Error cargando certificado desde /qz-site.crt:", certError);
      console.warn("⚠️ Intentando cargar certificado desde ruta alternativa...");
      
      // Intentar rutas alternativas
      const alternativePaths = [
        "/certs/qz-site.crt",
        "./qz-site.crt",
        "../qz-site.crt",
        "qz-site.crt"
      ];
      
      for (const path of alternativePaths) {
        try {
          const altResponse = await fetch(path, { cache: "no-store" });
          if (altResponse.ok) {
            certText = await altResponse.text();
            console.log(`✅ Certificado cargado desde ruta alternativa: ${path}`);
            break;
          }
        } catch (e) {
          console.warn(`⚠️ No se pudo cargar desde ${path}:`, e.message);
        }
      }
      
      if (!certText) {
        throw new Error(`No se pudo cargar el certificado desde ninguna ruta. Error original: ${certError.message}`);
      }
    }

    // Configurar setCertificatePromise con el certificado ya cargado
    qz.security.setCertificatePromise((resolve, reject) => {
      console.log("📜 setCertificatePromise: resolviendo certificado precargado");
      if (!certText || certText.trim().length === 0) {
        const error = new Error("Certificado inválido o vacío");
        console.error("❌", error.message);
        reject(error);
        return;
      }
      
      // Limpiar el certificado (eliminar Bag Attributes, etc.)
      // Buscamos solo el bloque entre BEGIN y END CERTIFICATE
      const match = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
      if (match) {
        const cleanCert = match[0].trim();
        console.log("✅ Certificado sanitizado encontrado, longitud:", cleanCert.length);
        console.log("📋 Primeros 100 caracteres:", cleanCert.substring(0, 100));
        resolve(cleanCert);
      } else {
        // Fallback: si no machea, intentar limpiar el texto y usar
        const trimmed = certText.trim();
        if (trimmed.includes("BEGIN CERTIFICATE") && trimmed.includes("END CERTIFICATE")) {
          console.warn("⚠️ No se pudo extraer bloque limpio con regex, usando texto limpio");
          resolve(trimmed);
        } else {
          const error = new Error("Certificado no tiene formato válido (no contiene BEGIN/END CERTIFICATE)");
          console.error("❌", error.message);
          console.error("📋 Contenido recibido (primeros 200 chars):", certText.substring(0, 200));
          reject(error);
        }
      }
    });

    console.log("✅ Certificado público configurado");

    // IMPORTANTE: Configurar algoritmo SHA-512 (requerido por QZ Tray 2.1+)
    // Según documentación oficial, QZ Tray 2.x espera SHA-512 por defecto
    qz.security.setSignatureAlgorithm("SHA512");
    console.log("✅ Algoritmo de firma configurado: SHA512");

    // PASO 2: Configurar firma remota (DESPUÉS del certificado)
    qz.security.setSignaturePromise(async (toSign) => {
      console.log("🔐 QZ Tray solicitó firma. Longitud:", toSign?.length || 0);

      // Validar que toSign existe
      if (!toSign || typeof toSign !== 'string') {
        const error = new Error("toSign inválido o vacío");
        console.error("❌ Error:", error.message);
        throw error;
      }

      try {
        // Obtener secreto compartido (desde config module o window fallback)
        // CAMINO 2: Fallback temporal hardcodeado para prueba rápida
        let secret = (typeof QZ_SIGN_SECRET !== 'undefined' ? QZ_SIGN_SECRET : "") ||
          (typeof window !== 'undefined' ? window.QZ_SIGN_SECRET : "") ||
          "a8cc79b81b8552702d7deccbef31c1eea7a30043b032d136a8eb4671614b5b75";

        console.log("QZ Debug: origin =", typeof location !== 'undefined' ? location.origin : "server");
        console.log("QZ Debug: secret len =", secret.length);

        console.log("📡 Enviando request de firma a Edge Function (Shared Secret)...");
        console.log("📤 toSign a enviar (len=" + toSign.length + "):", toSign.substring(0, 50) + "...");
        console.log("🌐 URL de firma:", `${SUPABASE_URL}/functions/v1/qz-sign`);
        console.log("🔑 Secret length:", secret.length);

        // IMPORTANTE: Enviar toSign como text/plain (no JSON) para evitar alteraciones
        // QZ Tray requiere que el string llegue exactamente igual, sin JSON.stringify
        let res;
        try {
          res = await fetch(`${SUPABASE_URL}/functions/v1/qz-sign`, {
            method: "POST",
            headers: {
              "Content-Type": "text/plain;charset=utf-8",
              "x-qz-secret": secret
            },
            body: toSign // Enviar directamente, sin JSON.stringify
          });
        } catch (fetchError) {
          console.error("❌ Error de red al enviar request de firma:", fetchError);
          throw new Error(`Error de red al obtener firma: ${fetchError.message}`);
        }

        console.log("📥 Respuesta recibida. Status:", res.status, res.statusText);

        if (!res.ok) {
          const errorText = await res.text();
          console.error("❌ Error HTTP:", res.status, errorText);
          console.error("📋 Headers de respuesta:", Object.fromEntries(res.headers.entries()));
          
          let errorMessage = `Error en firma: ${res.status} - ${errorText}`;
          if (res.status === 404) {
            errorMessage += "\n\n⚠️ La Edge Function 'qz-sign' no está desplegada o la URL es incorrecta.";
          } else if (res.status === 401 || res.status === 403) {
            errorMessage += "\n\n⚠️ El secreto compartido (QZ_SIGN_SECRET) es incorrecto o falta.";
          } else if (res.status >= 500) {
            errorMessage += "\n\n⚠️ Error del servidor. Verifica que la Edge Function esté funcionando correctamente.";
          }
          
          throw new Error(errorMessage);
        }

        // IMPORTANTE: Leer como texto plano y trim, NO como JSON
        const signature = (await res.text()).trim();

        if (!signature || signature.length === 0) {
          throw new Error("La firma recibida está vacía");
        }

        console.log("✅ Firma generada correctamente. Longitud:", signature.length);
        console.log("📋 Primeros 50 caracteres de la firma:", signature.substring(0, 50));
        return signature;
      } catch (error) {
        console.error("❌ Error generando firma QZ:", error);
        console.error("Stack:", error.stack);
        // Asegurar que siempre lancemos el error para que QZ Tray lo maneje
        throw error;
      }
    });

    console.log("✅ Certificado y firma remota configurados para QZ Tray");
    return true;
  } catch (error) {
    console.error("❌ Error configurando firma QZ:", error);
    console.error("Stack:", error.stack);
    return false;
  }
}

// Exponer función globalmente para que pueda ser llamada desde labels.html
if (typeof window !== 'undefined') {
  window.setupQZSignature = setupQZSignature;
}

// NO configurar firma aquí - se configurará cuando QZ esté disponible en qzConnect()
// La configuración de firma debe hacerse DESPUÉS de que QZ esté cargado

async function qzConnect() {
  console.log("🔍 Iniciando conexión con QZ Tray...");
  console.log("🌐 Origen actual:", typeof location !== 'undefined' ? location.origin : 'desconocido');
  
  // Verificar que QZ Tray esté disponible
  const isAvailable = await checkQZAvailable();
  
  if (!isAvailable) {
    const error = new Error("QZ Tray no está disponible. Verificá que:\n" +
      "1. QZ Tray esté instalado en tu sistema\n" +
      "2. QZ Tray esté corriendo (buscalo en la bandeja del sistema)\n" +
      "3. El navegador tenga permisos para acceder a QZ Tray\n" +
      "4. La página se haya cargado completamente\n" +
      "5. No haya bloqueadores de contenido activos");
    console.error("❌", error.message);
    console.error("📋 Estado de QZ:", {
      qzDefined: typeof qz !== 'undefined',
      qzExists: typeof qz !== 'undefined' && qz !== null,
      websocketExists: typeof qz !== 'undefined' && qz && typeof qz.websocket !== 'undefined'
    });
    throw error;
  }
  
  console.log("✅ QZ Tray detectado, continuando con la conexión...");

  // Asegurar que el certificado y la firma estén configurados ANTES de conectar
  // setupQZSignature ahora es async y espera a que el certificado se cargue
  const signatureConfigured = await setupQZSignature();
  if (!signatureConfigured) {
    console.warn("⚠️ No se pudo configurar la firma, QZ puede mostrar popups de seguridad");
  }

  if (!qz.websocket.isActive()) {
    try {
      console.log("🚀 conectando QZ...");
      await qz.websocket.connect();
      console.log("✅ QZ Tray conectado");
      updateQZStatus(true);
    } catch (error) {
      console.error("❌ Error conectando QZ Tray:", error);
      
      // Mejorar mensaje de error
      if (error.message && (error.message.includes("Unable to establish connection") || 
                            error.message.includes("Connection blocked"))) {
        const improvedError = new Error("No se pudo establecer conexión con QZ Tray.\n\n" +
          "Posibles causas:\n" +
          "1. QZ Tray no está corriendo (verificá la bandeja del sistema)\n" +
          "2. QZ Tray está bloqueado por firewall o antivirus\n" +
          "3. El certificado no está correctamente configurado o no se pudo cargar\n" +
          "4. QZ Tray está rechazando conexiones desde este dominio\n" +
          "5. El certificado no coincide con el que QZ Tray espera\n\n" +
          "Soluciones:\n" +
          "- Abrí QZ Tray desde el menú Inicio y verificá que aparezca en la bandeja del sistema\n" +
          "- Verificá que el certificado /certs/qz-site.crt esté disponible en el servidor\n" +
          "- Si estás en producción, asegurate de que el certificado se haya desplegado correctamente\n" +
          "- Revisá la consola del navegador para más detalles del error");
        improvedError.stack = error.stack;
        console.error("❌ Detalles del error de conexión:", {
          message: error.message,
          stack: error.stack,
          origin: typeof location !== 'undefined' ? location.origin : 'desconocido'
        });
        updateQZStatus(false);
        throw improvedError;
      }
      
      updateQZStatus(false);
      throw error;
    }
  } else {
    updateQZStatus(true);
  }
}

async function qzGetPrinterConfig() {
  try {
    // Intentar obtener la impresora Zebra GK420t específicamente
    let printerName;
    try {
      const printers = await qz.printers.find("GK420t");
      if (printers && printers.length > 0) {
        printerName = printers[0];
      } else {
        printerName = await qz.printers.getDefault();
      }
    } catch (e) {
      printerName = await qz.printers.getDefault();
    }

    console.log("✅ Impresora:", printerName);
    // Crear config con forceRaw para enviar ZPL directamente a la impresora
    const config = qz.configs.create(printerName, { forceRaw: true });
    return config;
  } catch (error) {
    console.error("❌ Error obteniendo impresora:", error);
    throw error;
  }
}

// ============================================================================
// Generación de ZPL
// ============================================================================

function cleanZplText(v) {
  if (!v) return "";
  let s = v.toString();
  s = s.replace(/[\^~\\]/g, " ");
  s = s
    .replace(/[áÁ]/g, "a")
    .replace(/[éÉ]/g, "e")
    .replace(/[íÍ]/g, "i")
    .replace(/[óÓ]/g, "o")
    .replace(/[úÚ]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N");
  return s;
}

function buildZplForSingleLabel(sku, productName, color, size, qrData) {
  function cleanZplText(v) {
    if (!v) return "";
    let s = v.toString();
    s = s.replace(/[\^~\\]/g, " ");
    s = s
      .replace(/[áÁ]/g, "a")
      .replace(/[éÉ]/g, "e")
      .replace(/[íÍ]/g, "i")
      .replace(/[óÓ]/g, "o")
      .replace(/[úÚ]/g, "u")
      .replace(/ñ/g, "n")
      .replace(/Ñ/g, "N");
    return s;
  }

  const sSku = cleanZplText(sku);
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  // Limitar longitud de textos para que no se corten
  const nameShort = sName.slice(0, 20);
  const colorShort = sColor.slice(0, 20);
  const sizeShort = sSize.slice(0, 20);

  return (
    `^XA
^PW648
^LL160
^LH0,0
^MD30
^PR2,2

^FO12,18^BQN,2,6
^FDLA,${sQr}^FS

^FO145,18^A0N,46,42^FD${nameShort}^FS
^FO145,70^A0N,32,30^FD${colorShort}^FS
^FO145,104^A0N,32,30^FD${sizeShort}^FS

^FO145,150^A0N,18,18^FDNEW-LAYOUT-2026^FS

^XZ`
  ).trim();
}

function buildZplForDoubleLabel(sku, productName, color, size, qrData) {
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  // Limitar longitud de textos para que no se corten
  const nameShort = sName.slice(0, 18);
  const colorShort = sColor.slice(0, 18);
  const sizeShort = sSize.slice(0, 28);
  
  // Dividir talle en dos líneas para evitar cortes (corte inteligente)
  const cutMax = 16;
  let cut = sizeShort.lastIndexOf(" ", cutMax);
  if (cut < 8) cut = 14; // fallback si no hay espacio adecuado
  const sizeLine1 = sizeShort.slice(0, cut).trim();
  const sizeLine2 = sizeShort.slice(cut).trim();
  
  // Construir bloque condicional para la segunda línea del talle
  const zplSizeLine2Left = sizeLine2 ? `^FO157,132^A0N,46,42^FD${sizeLine2}^FS` : "";
  const zplSizeLine2Right = sizeLine2 ? `^FO490,132^A0N,46,42^FD${sizeLine2}^FS` : "";

  return (
    `^XA^PW648^LL172^LH0,0^MD30^PR2,2
^FX --- IZQUIERDA ---
^FO24,10^BQN,2,6^FDLA,${sQr}^FS
^FO157,18^A0N,46,42^FD${nameShort}^FS
^FO157,70^A0N,38,34^FD${colorShort}^FS
^FO157,104^A0N,46,42^FD${sizeLine1}^FS
${zplSizeLine2Left}

^FX --- DERECHA ---
^FO360,10^BQN,2,6^FDLA,${sQr}^FS
^FO490,18^A0N,46,42^FD${nameShort}^FS
^FO490,70^A0N,38,34^FD${colorShort}^FS
^FO490,104^A0N,46,42^FD${sizeLine1}^FS
${zplSizeLine2Right}
^XZ`
  ).trim();
}

// ============================================================================
// Impresión de etiquetas
// ============================================================================

async function printProductLabelsZebra(sku, productName, color, size, copies, qrDataOverride) {
  copies = parseInt(copies, 10);
  if (!copies || copies < 1) {
    console.warn("Cantidad de copias inválida:", copies);
    return;
  }

  // El QR debe contener el código numérico único (qr_code) si está disponible, sino usar SKU como fallback
  const qrData = qrDataOverride || sku;

  try {
    await qzConnect();
    const cfg = await qzGetPrinterConfig();

    const jobs = [];

    const totalLabels = copies;
    const pairs = Math.floor(totalLabels / 2); // cuantas veces imprimo doble
    const remainder = totalLabels % 2;         // 0 o 1 etiquetas sueltas

    // ZPL doble (2 etiquetas por vez)
    const zplDouble = buildZplForDoubleLabel(sku, productName, color, size, qrData);
    
    console.log("PRINT_SOURCE_FILE: admin/labels.js -> printProductLabelsZebra()");
    console.log("ZPL_START (DOUBLE):", zplDouble.slice(0, 120));
    console.log("ZPL_CONTAINS_NEW_LAYOUT:", zplDouble.includes("^FO12,18^BQN,2,6") || zplDouble.includes("^MD30"));
    console.log("ZPL_CONTAINS_OLD_LAYOUT:", zplDouble.includes("^FO24,20^BQN,2,4") || zplDouble.includes("^FO20,30^BQN,2,8") || zplDouble.includes("sSku"));

    for (let i = 0; i < pairs; i++) {
      jobs.push({
        type: "raw",
        format: "command",
        data: zplDouble
      });
    }

    // ZPL simple (1 etiqueta sola, solo lado izquierdo)
    if (remainder === 1) {
      const zplSingle = buildZplForSingleLabel(sku, productName, color, size, qrData);
      console.log("ZPL_START (SINGLE):", zplSingle.slice(0, 120));
      console.log("ZPL_CONTAINS_NEW_LAYOUT:", zplSingle.includes("^FO12,18^BQN,2,6") || zplSingle.includes("^MD30"));
      console.log("ZPL_CONTAINS_OLD_LAYOUT:", zplSingle.includes("^FO24,20^BQN,2,4") || zplSingle.includes("^FO20,30^BQN,2,8") || zplSingle.includes("sSku"));
      
      jobs.push({
        type: "raw",
        format: "command",
        data: zplSingle
      });
    }

    if (jobs.length > 0) {
      console.log("JOBS_TO_PRINT:", jobs.length, "jobs");
      await qz.print(cfg, jobs);
      console.log(`✅ ${copies} etiqueta(s) enviada(s) a la impresora`);
    }
  } catch (err) {
    console.error("❌ Error imprimiendo etiquetas Zebra:", err);
    updateQZStatus(false);

    // Mensaje de error más específico
    let errorMessage = "No se pudo imprimir la etiqueta en la Zebra.";

    if (err.message && err.message.includes("QZ Tray no está disponible")) {
      errorMessage = err.message;
    } else if (err.message && err.message.includes("No se pudo establecer conexión")) {
      errorMessage = err.message;
    } else if (err.message && err.message.includes("certificate")) {
      errorMessage += "\n\nError de certificado/firma. Verifica que la Edge Function qz-sign esté desplegada y funcionando.";
    } else if (err.message && err.message.includes("Connection blocked")) {
      errorMessage += "\n\nConexión bloqueada. Verifica que QZ Tray esté instalado y ejecutándose.";
    } else if (err.message && err.message.includes("No session token")) {
      errorMessage += "\n\nDebes estar autenticado para imprimir.";
    } else {
      errorMessage += "\n\nVerifica que:\n- QZ Tray esté instalado y ejecutándose\n- La impresora esté conectada\n- Tengas sesión activa";
    }

    alert(errorMessage);
  }
}

// ============================================================================
// Indicador de estado de QZ Tray
// ============================================================================

function updateQZStatus(isConnected) {
  // Crear o actualizar indicador de estado
  let statusIndicator = document.getElementById("qz-status-indicator");
  if (!statusIndicator) {
    statusIndicator = document.createElement("div");
    statusIndicator.id = "qz-status-indicator";
    statusIndicator.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      z-index: 10000;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      transition: all 0.3s ease;
    `;
    document.body.appendChild(statusIndicator);
  }
  
  if (isConnected) {
    statusIndicator.textContent = "✓ QZ Tray Conectado";
    statusIndicator.style.background = "#10b981";
    statusIndicator.style.color = "white";
  } else {
    statusIndicator.textContent = "✗ QZ Tray Desconectado";
    statusIndicator.style.background = "#ef4444";
    statusIndicator.style.color = "white";
  }
}

// Intentar conectar QZ Tray al cargar la página
async function initQZTray() {
  try {
    console.log("🔍 Verificando disponibilidad de QZ Tray...");
    const isAvailable = await checkQZAvailable(5000);
    
    if (isAvailable) {
      console.log("✅ QZ Tray detectado, intentando conectar...");
      try {
        await qzConnect();
      } catch (error) {
        console.warn("⚠️ No se pudo conectar a QZ Tray automáticamente:", error.message);
        updateQZStatus(false);
      }
    } else {
      console.warn("⚠️ QZ Tray no está disponible. Asegurate de que esté instalado y corriendo.");
      updateQZStatus(false);
    }
  } catch (error) {
    console.error("❌ Error inicializando QZ Tray:", error);
    updateQZStatus(false);
  }
}

// ============================================================================
// Inicialización
// ============================================================================

setupLabelProductSearch();

// Inicializar QZ Tray después de que la página cargue
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(initQZTray, 1000); // Esperar un poco para que QZ se cargue desde el CDN
  });
} else {
  setTimeout(initQZTray, 1000);
}

