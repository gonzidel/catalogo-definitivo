// admin/labels.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

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

async function searchProductsForLabels(term) {
  if (!term || term.trim().length < 2) {
    return [];
  }

  try {
    const searchTerm = term.trim().toLowerCase();
    
    let productIds = [];
    let products = [];
    
    // Buscar productos por nombre
    if (searchTerm) {
      const { data: productsByName, error: productsError } = await supabase
        .from("products")
        .select("id, name, category, status, handle")
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
        products!inner(id, name, category, status, handle)
      `)
      .eq("active", true)
      .eq("products.status", "active");
    
    if (searchTerm) {
      if (productIds.length > 0) {
        variantsQuery = variantsQuery
          .in("product_id", productIds)
          .or(`sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%,size.ilike.%${searchTerm}%`);
      } else {
        variantsQuery = variantsQuery.or(
          `sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%,size.ilike.%${searchTerm}%`
        );
      }
    } else {
      if (productIds.length > 0) {
        variantsQuery = variantsQuery.in("product_id", productIds);
      }
    }
    
    const { data: variants, error: variantsError } = await variantsQuery.limit(500);
    
    if (variantsError) throw variantsError;
    
    if (!variants || variants.length === 0) {
      return [];
    }
    
    // Si no encontramos productos por nombre pero sí variantes, obtener los productos
    if (products.length === 0) {
      const uniqueProductIds = [...new Set(variants.map(v => v.product_id))];
      const { data: productsFromVariants, error: productsError2 } = await supabase
        .from("products")
        .select("id, name, category, status, handle")
        .in("id", uniqueProductIds)
        .eq("status", "active");
      
      if (productsError2) throw productsError2;
      products = productsFromVariants || [];
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
    
    variants.forEach(v => {
      if (v.products && !productsMap.has(v.products.id)) {
        productsMap.set(v.products.id, {
          id: v.products.id,
          name: v.products.name,
          category: v.products.category,
          handle: v.products.handle,
          variants: []
        });
      }
    });
    
    variants.forEach(v => {
      const productId = v.product_id || (v.products && v.products.id);
      const product = productsMap.get(productId);
      
      if (product) {
        product.variants.push({
          id: v.id,
          sku: v.sku,
          color: v.color,
          size: v.size,
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
  const enriched = [];
  
  for (const variant of variants) {
    try {
      const { data, error } = await supabase
        .rpc("get_variant_stock_by_warehouse", { p_variant_id: variant.id });

      if (error) throw error;

      let totalStock = 0;
      if (data) {
        for (const row of data) {
          totalStock += row.stock_qty || 0;
        }
      }

      enriched.push({
        ...variant,
        stock: totalStock
      });
    } catch (error) {
      console.error(`Error obteniendo stock para variante ${variant.id}:`, error);
      enriched.push({
        ...variant,
        stock: 0
      });
    }
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
  
  // Obtener todas las variantes del producto con stock
  try {
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select("id, sku, color, size, active")
      .eq("product_id", product.id)
      .eq("active", true);

    if (error) throw error;

    if (!variants || variants.length === 0) {
      detailContainer.innerHTML = `
        <div class="no-results">
          <p>Este producto no tiene variantes activas</p>
        </div>
      `;
      detailContainer.classList.add("show");
      return;
    }

    // Enriquecer con stock
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

    // Ordenar talles dentro de cada color
    Object.keys(variantsByColor).forEach(color => {
      variantsByColor[color].sort((a, b) => {
        const sizeA = parseFloat(a.size) || 0;
        const sizeB = parseFloat(b.size) || 0;
        if (sizeA !== sizeB) return sizeA - sizeB;
        return (a.size || "").localeCompare(b.size || "", "es");
      });
    });

    // Obtener imagen principal si existe
    let imageUrl = null;
    if (enrichedVariants.length > 0) {
      const { data: images } = await supabase
        .from("variant_images")
        .select("url")
        .eq("variant_id", enrichedVariants[0].id)
        .eq("position", 1)
        .limit(1)
        .single();
      
      if (images) {
        imageUrl = images.url;
      }
    }

    // Renderizar
    let html = `
      <div class="product-detail-header">
        ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(product.name)}" class="product-detail-image" />` : ""}
        <div class="product-detail-info">
          <h2 class="product-detail-title">${escapeHtml(product.name)}</h2>
          <div class="product-detail-sku">SKU: ${escapeHtml(enrichedVariants[0]?.sku || "")}</div>
        </div>
      </div>
      <div class="variants-container">
    `;

    // Renderizar cada color
    Object.keys(variantsByColor).sort().forEach((color, colorIndex) => {
      const colorVariants = variantsByColor[color];
      const variantId = `variant-${colorIndex}`;
      
      html += `
        <div class="variant-card">
          <div class="variant-header" data-variant-toggle="${variantId}">
            <span>${escapeHtml(color)}</span>
            <span class="variant-toggle">▼</span>
          </div>
          <div class="variant-content" id="${variantId}">
      `;

      // Renderizar cada talle
      colorVariants.forEach(variant => {
        const rowId = `row-${variant.id}`;
        html += `
          <div class="label-size-row" 
               id="${rowId}"
               data-sku="${escapeHtml(variant.sku)}"
               data-name="${escapeHtml(product.name)}"
               data-color="${escapeHtml(color)}"
               data-size="${escapeHtml(variant.size || "")}"
               data-stock="${variant.stock}">
            <span class="label-size-name">${escapeHtml(variant.size || "")}</span>
            <span class="label-size-stock">Stock: ${variant.stock}</span>
            <input type="number" class="label-size-qty" min="1" value="${variant.stock}" />
            <label style="display: flex; align-items: center;">
              <input type="checkbox" class="label-size-selected" />
              Seleccionar
            </label>
            <button class="btn-print-stock-total" data-row-id="${rowId}">Imprimir stock total</button>
            <button class="btn-print-custom-qty" data-row-id="${rowId}">Imprimir cantidad</button>
          </div>
        `;
      });

      html += `
          </div>
        </div>
      `;
    });

    html += `
      </div>
      <div class="global-actions">
        <button class="btn-print-all-stock">Imprimir stock total de todo</button>
        <button class="btn-print-selected">Imprimir todo lo seleccionado</button>
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
  document.querySelectorAll(".btn-print-stock-total").forEach(btn => {
    btn.addEventListener("click", () => {
      const rowId = btn.dataset.rowId;
      const row = document.getElementById(rowId);
      if (!row) return;

      const sku = row.dataset.sku;
      const name = row.dataset.name;
      const color = row.dataset.color;
      const size = row.dataset.size;
      const stock = parseInt(row.dataset.stock, 10) || 0;

      if (stock <= 0) {
        alert("No hay stock disponible para este talle");
        return;
      }

      printProductLabelsZebra(sku, name, color, size, stock);
    });
  });

  document.querySelectorAll(".btn-print-custom-qty").forEach(btn => {
    btn.addEventListener("click", () => {
      const rowId = btn.dataset.rowId;
      const row = document.getElementById(rowId);
      if (!row) return;

      const sku = row.dataset.sku;
      const name = row.dataset.name;
      const color = row.dataset.color;
      const size = row.dataset.size;
      const stock = parseInt(row.dataset.stock, 10) || 0;
      const qtyInput = row.querySelector(".label-size-qty");
      const qty = parseInt(qtyInput.value, 10) || stock;

      if (qty <= 0) {
        alert("La cantidad debe ser mayor a 0");
        return;
      }

      printProductLabelsZebra(sku, name, color, size, qty);
    });
  });

  // Botones globales
  document.querySelector(".btn-print-all-stock")?.addEventListener("click", () => {
    const rows = document.querySelectorAll(".label-size-row");
    rows.forEach(row => {
      const sku = row.dataset.sku;
      const name = row.dataset.name;
      const color = row.dataset.color;
      const size = row.dataset.size;
      const stock = parseInt(row.dataset.stock, 10) || 0;

      if (stock > 0) {
        printProductLabelsZebra(sku, name, color, size, stock);
      }
    });
  });

  document.querySelector(".btn-print-selected")?.addEventListener("click", () => {
    const allRows = document.querySelectorAll(".label-size-row");
    const selectedRows = Array.from(allRows).filter(row => {
      const checkbox = row.querySelector(".label-size-selected");
      return checkbox && checkbox.checked;
    });
    
    if (selectedRows.length === 0) {
      alert("No hay filas seleccionadas");
      return;
    }

    selectedRows.forEach(row => {
      const sku = row.dataset.sku;
      const name = row.dataset.name;
      const color = row.dataset.color;
      const size = row.dataset.size;
      const stock = parseInt(row.dataset.stock, 10) || 0;
      const qtyInput = row.querySelector(".label-size-qty");
      const qty = parseInt(qtyInput.value, 10) || stock;

      if (qty > 0) {
        printProductLabelsZebra(sku, name, color, size, qty);
      }
    });
  });
}

// ============================================================================
// Setup de búsqueda
// ============================================================================

function setupLabelProductSearch() {
  const debouncedSearch = debounce(async (term) => {
    if (!term || term.trim().length < 2) {
      resultsContainer.innerHTML = "";
      return;
    }

    resultsContainer.innerHTML = '<div class="loading">Buscando...</div>';

    const products = await searchProductsForLabels(term);
    renderSearchResults(products);
  }, 300);

  searchInput.addEventListener("input", (e) => {
    const term = e.target.value.trim();
    debouncedSearch(term);
  });
}

// ============================================================================
// QZ Tray - Funciones helper
// ============================================================================

async function qzConnect() {
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    throw new Error("QZ Tray no está disponible");
  }
  
  if (!qz.websocket.isActive()) {
    try {
      await qz.websocket.connect();
      console.log("✅ QZ Tray conectado");
    } catch (error) {
      throw error;
    }
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
    const config = qz.configs.create(printerName);
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
  const colorSizeShort = (sColor + " " + sSize).trim().slice(0, 20);

  return (
`^XA
^PW648
^LL160
^LH0,0

^FO24,20^BQN,2,4
^FDLA,${sQr}^FS

^FO120,30^A0N,18,18^FD${sSku}^FS
^FO120,64^A0N,48,44^FD${nameShort}^FS
^FO120,104^A0N,40,36^FD${colorSizeShort}^FS

^XZ`
  ).trim();
}

function buildZplForDoubleLabel(sku, productName, color, size, qrData) {
  const sSku = cleanZplText(sku);
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  // Limitar longitud de textos para que no se corten
  const nameShort = sName.slice(0, 20);
  const colorSizeShort = (sColor + " " + sSize).trim().slice(0, 20);

  return (
`^XA
^PW648
^LL160
^LH0,0

^FX ----- ETIQUETA IZQUIERDA -----
^FO24,20^BQN,2,4
^FDLA,${sQr}^FS

^FO120,30^A0N,18,18^FD${sSku}^FS
^FO120,64^A0N,48,44^FD${nameShort}^FS
^FO120,104^A0N,40,36^FD${colorSizeShort}^FS

^FX ----- ETIQUETA DERECHA -----
^FO360,20^BQN,2,4
^FDLA,${sQr}^FS

^FO456,30^A0N,18,18^FD${sSku}^FS
^FO456,64^A0N,48,44^FD${nameShort}^FS
^FO456,104^A0N,40,36^FD${colorSizeShort}^FS

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

  const qrData = qrDataOverride || (sku + "|" + size);

  try {
    await qzConnect();
    const cfg = await qzGetPrinterConfig();

    const jobs = [];

    const totalLabels = copies;
    const pairs = Math.floor(totalLabels / 2); // cuantas veces imprimo doble
    const remainder = totalLabels % 2;         // 0 o 1 etiquetas sueltas

    // ZPL doble (2 etiquetas por vez)
    const zplDouble = buildZplForDoubleLabel(sku, productName, color, size, qrData);

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
      jobs.push({
        type: "raw",
        format: "command",
        data: zplSingle
      });
    }

    if (jobs.length > 0) {
      await qz.print(cfg, jobs);
      console.log(`✅ ${copies} etiqueta(s) enviada(s) a la impresora`);
    }
  } catch (err) {
    console.error("Error imprimiendo etiquetas Zebra:", err);
    alert("No se pudo imprimir la etiqueta en la Zebra. Verifica que QZ Tray esté instalado y la impresora esté conectada.");
  }
}

// ============================================================================
// Inicialización
// ============================================================================

setupLabelProductSearch();

