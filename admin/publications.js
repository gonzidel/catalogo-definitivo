// admin/publications.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

// Estado
let newProducts = [];
let recommendedProducts = [];
let allProducts = [];
let selectedForPublication = []; // Array de { productId, color }

// Elementos DOM
const tabs = document.querySelectorAll(".tab");
const tabContents = document.querySelectorAll(".tab-content");
const searchNew = document.getElementById("search-new");
const searchRecommended = document.getElementById("search-recommended");
const searchAll = document.getElementById("search-all");
const searchPublication = document.getElementById("search-publication");
const newContainer = document.getElementById("new-products-container");
const recommendedContainer = document.getElementById("recommended-products-container");
const allContainer = document.getElementById("all-products-container");
const publicationTableBody = document.getElementById("publication-table-body");
const publicationCount = document.getElementById("publication-count");
const selectedCount = document.getElementById("selected-count");
const publishBtn = document.getElementById("publish-btn");
const copyToSheetBtn = document.getElementById("copy-to-sheet-btn");
const clearAllBtn = document.getElementById("clear-all");
const messageContainer = document.getElementById("message-container");

// Sistema de tabs
tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    const targetTab = tab.dataset.tab;
    
    // Actualizar tabs
    tabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    
    // Actualizar contenido
    tabContents.forEach(content => {
      content.classList.remove("active");
      if (content.id === `tab-${targetTab}`) {
        content.classList.add("active");
      }
    });
    
    // Cargar datos si es necesario
    if (targetTab === "new" && newProducts.length === 0) {
      loadNewProducts();
    } else if (targetTab === "recommended" && recommendedProducts.length === 0) {
      loadRecommendedProducts();
    } else if (targetTab === "all" && allProducts.length === 0) {
      loadAllProducts();
    } else if (targetTab === "publication") {
      renderPublicationTable();
    }
  });
});

// Obtener datos de producto+color (variantes, talles, imágenes)
async function getProductColorData(productId, color) {
  // Obtener variantes del color específico
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("id, sku, size, stock_qty, price")
    .eq("product_id", productId)
    .eq("color", color)
    .eq("active", true);
  
  if (error || !variants || variants.length === 0) {
    return null;
  }
  
  // Filtrar variantes con stock > 1
  const availableVariants = variants.filter(v => (v.stock_qty || 0) > 1);
  
  if (availableVariants.length === 0) {
    return null; // No hay talles disponibles
  }
  
  // Obtener talles disponibles
  const sizes = [...new Set(availableVariants.map(v => v.size).filter(Boolean))].sort((a, b) => {
    const numA = parseInt(a, 10) || 0;
    const numB = parseInt(b, 10) || 0;
    return numA - numB;
  });
  
  // Obtener imágenes de las variantes
  const variantIds = variants.map(v => v.id);
  const { data: images } = await supabase
    .from("variant_images")
    .select("url, position")
    .in("variant_id", variantIds)
    .order("position");
  
  // Obtener URLs únicas (eliminar duplicados)
  const allImageUrls = (images || [])
    .map(img => img.url)
    .filter(Boolean);
  
  // Eliminar duplicados usando Set (mantiene orden de primera aparición)
  const uniqueImageUrls = [...new Set(allImageUrls)];
  
  // Obtener precio (tomar el precio de la primera variante disponible, normalmente todas tienen el mismo precio)
  const price = availableVariants.length > 0 && availableVariants[0].price 
    ? parseFloat(availableVariants[0].price) 
    : null;
  
  return {
    variants: availableVariants,
    sizes,
    imageUrls: uniqueImageUrls,
    firstImage: uniqueImageUrls[0] || null,
    price,
  };
}

// Formatear talles como string
function formatSizes(sizes) {
  return sizes.join(",");
}

function getNumericPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) return null;
  return `$${value.toLocaleString("es-AR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

// Agrupar productos por color
async function groupProductsByColor(products) {
  const grouped = [];
  
  for (const product of products) {
    // Obtener todas las variantes del producto
    const { data: variants } = await supabase
      .from("product_variants")
      .select("color")
      .eq("product_id", product.id)
      .eq("active", true);
    
    if (!variants || variants.length === 0) continue;
    
    // Obtener colores únicos
    const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
    
    // Para cada color, crear una entrada
    for (const color of colors) {
      const colorData = await getProductColorData(product.id, color);
      
      // Solo agregar si tiene talles disponibles
      if (colorData && colorData.sizes.length > 0) {
        grouped.push({
          productId: product.id,
          productName: product.name,
          category: product.category,
          color,
          created_at: product.created_at,
          last_published_at: product.last_published_at,
          publication_status: product.publication_status || 'nuevo',
          ...colorData,
        });
      }
    }
  }
  
  return grouped;
}

// Calcular días desde última publicación
function daysSincePublished(date) {
  if (!date) return null;
  const now = new Date();
  const published = new Date(date);
  const diffTime = Math.abs(now - published);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

// Cargar productos nuevos
async function loadNewProducts() {
  try {
    // Obtener productos que nunca fueron publicados
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category, created_at, last_published_at, publication_status")
      .eq("status", "active")
      .or("publication_status.eq.nuevo,last_published_at.is.null,publication_status.is.null")
      .order("created_at", { ascending: false });
    
    if (error) throw error;
    
    newProducts = await groupProductsByColor(products || []);
    renderNewProducts();
  } catch (error) {
    showMessage(`Error cargando productos nuevos: ${error.message}`, "err");
  }
}

// Cargar productos recomendados (10+ días sin publicar)
async function loadRecommendedProducts() {
  try {
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category, created_at, last_published_at, publication_status")
      .not("last_published_at", "is", null)
      .lt("last_published_at", tenDaysAgo.toISOString())
      .eq("status", "active")
      .order("last_published_at", { ascending: true });
    
    if (error) throw error;
    
    recommendedProducts = await groupProductsByColor(products || []);
    renderRecommendedProducts();
  } catch (error) {
    showMessage(`Error cargando productos recomendados: ${error.message}`, "err");
  }
}

// Cargar todos los productos (sin filtros)
async function loadAllProducts() {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category, created_at, last_published_at, publication_status")
      .eq("status", "active")
      .order("created_at", { ascending: false });
    
    if (error) throw error;
    
    allProducts = await groupProductsByColor(products || []);
    renderAllProducts();
  } catch (error) {
    showMessage(`Error cargando todos los productos: ${error.message}`, "err");
  }
}

// Renderizar productos nuevos
function renderNewProducts(filtered = null) {
  const products = filtered || newProducts;
  
  if (products.length === 0) {
    newContainer.innerHTML = '<div class="empty-state">No hay productos nuevos para mostrar</div>';
    return;
  }
  
  newContainer.innerHTML = products.map(item => {
    const isSelected = selectedForPublication.some(
      s => s.productId === item.productId && s.color === item.color
    );
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imageUrlEscaped = item.firstImage ? String(item.firstImage).replace(/"/g, "&quot;") : "";
    const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
    const numericPrice = getNumericPrice(item.price);
    const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : null;
    const editPriceArg = numericPrice !== null ? numericPrice : "null";
    
    return `
      <div class="product-color-card ${isSelected ? 'selected' : ''}" data-product-id="${productIdEscaped}" data-color="${colorEscaped}">
        <div class="checkbox-wrapper">
          <input type="checkbox" ${isSelected ? 'checked' : ''} 
                 onchange="togglePublication('${productIdEscaped}', '${colorEscaped}')" />
        </div>
        ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
        <div class="product-info">
          <span class="product-color-badge">${colorEscaped}</span>
          <h3>${productNameEscaped}</h3>
          <p><strong>Categoría:</strong> ${item.category || 'N/A'}</p>
          ${formattedPrice ? `<p><strong>Precio:</strong> ${formattedPrice}</p>` : '<p><strong>Precio:</strong> N/A</p>'}
          <p><strong>Creado:</strong> ${new Date(item.created_at).toLocaleDateString('es-AR')}</p>
          <div class="sizes-info">Talles: ${formatSizes(item.sizes)}</div>
          <div class="card-actions">
            <button class="btn-small btn-primary" onclick="editVariantPrice('${productIdEscaped}', '${colorEscaped}', ${editPriceArg})">
              ✏️ Editar precio
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Renderizar productos recomendados
function renderRecommendedProducts(filtered = null) {
  const products = filtered || recommendedProducts;
  
  if (products.length === 0) {
    recommendedContainer.innerHTML = '<div class="empty-state">No hay productos recomendados para mostrar</div>';
    return;
  }
  
  recommendedContainer.innerHTML = products.map(item => {
    const isSelected = selectedForPublication.some(
      s => s.productId === item.productId && s.color === item.color
    );
    const days = daysSincePublished(item.last_published_at);
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imageUrlEscaped = item.firstImage ? String(item.firstImage).replace(/"/g, "&quot;") : "";
    const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
    const numericPrice = getNumericPrice(item.price);
    const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : null;
    const editPriceArg = numericPrice !== null ? numericPrice : "null";
    
    return `
      <div class="product-color-card ${isSelected ? 'selected' : ''}" data-product-id="${productIdEscaped}" data-color="${colorEscaped}">
        <div class="checkbox-wrapper">
          <input type="checkbox" ${isSelected ? 'checked' : ''} 
                 onchange="togglePublication('${productIdEscaped}', '${colorEscaped}')" />
        </div>
        ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
        <div class="product-info">
          <span class="product-color-badge">${colorEscaped}</span>
          <h3>${productNameEscaped}</h3>
          <p><strong>Categoría:</strong> ${item.category || 'N/A'}</p>
          ${formattedPrice ? `<p><strong>Precio:</strong> ${formattedPrice}</p>` : '<p><strong>Precio:</strong> N/A</p>'}
          <p><strong>Última publicación:</strong> Hace ${days} días</p>
          <div class="sizes-info">Talles: ${formatSizes(item.sizes)}</div>
          <div class="card-actions">
            <button class="btn-small btn-primary" onclick="editVariantPrice('${productIdEscaped}', '${colorEscaped}', ${editPriceArg})">
              ✏️ Editar precio
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Renderizar todos los productos
function renderAllProducts(filtered = null) {
  const products = filtered || allProducts;
  
  if (products.length === 0) {
    allContainer.innerHTML = '<div class="empty-state">No hay productos para mostrar</div>';
    return;
  }
  
  allContainer.innerHTML = products.map(item => {
    const isSelected = selectedForPublication.some(
      s => s.productId === item.productId && s.color === item.color
    );
    const days = item.last_published_at ? daysSincePublished(item.last_published_at) : null;
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imageUrlEscaped = item.firstImage ? String(item.firstImage).replace(/"/g, "&quot;") : "";
    const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
    const numericPrice = getNumericPrice(item.price);
    const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : null;
    const editPriceArg = numericPrice !== null ? numericPrice : "null";
    
    let publicationInfo = '';
    if (item.last_published_at) {
      publicationInfo = `<p><strong>Última publicación:</strong> Hace ${days} días</p>`;
    } else {
      publicationInfo = '<p><strong>Estado:</strong> <span style="color:#28a745;">Nunca publicado</span></p>';
    }
    
    return `
      <div class="product-color-card ${isSelected ? 'selected' : ''}" data-product-id="${productIdEscaped}" data-color="${colorEscaped}">
        <div class="checkbox-wrapper">
          <input type="checkbox" ${isSelected ? 'checked' : ''} 
                 onchange="togglePublication('${productIdEscaped}', '${colorEscaped}')" />
        </div>
        ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
        <div class="product-info">
          <span class="product-color-badge">${colorEscaped}</span>
          <h3>${productNameEscaped}</h3>
          <p><strong>Categoría:</strong> ${item.category || 'N/A'}</p>
          ${formattedPrice ? `<p><strong>Precio:</strong> ${formattedPrice}</p>` : '<p><strong>Precio:</strong> N/A</p>'}
          <p><strong>Creado:</strong> ${new Date(item.created_at).toLocaleDateString('es-AR')}</p>
          ${publicationInfo}
          <div class="sizes-info">Talles: ${formatSizes(item.sizes)}</div>
          <div class="card-actions">
            <button class="btn-small btn-primary" onclick="editVariantPrice('${productIdEscaped}', '${colorEscaped}', ${editPriceArg})">
              ✏️ Editar precio
            </button>
            <button class="btn-small btn-danger" onclick="deleteVariantColor('${productIdEscaped}', '${colorEscaped}')">
              🗑️ Eliminar variante
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Renderizar tabla de publicación
async function renderPublicationTable(filtered = null) {
  const items = filtered || selectedForPublication;
  
  if (items.length === 0) {
    publicationTableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No hay productos seleccionados para publicar</td></tr>';
    selectedCount.textContent = "0";
    publishBtn.disabled = true;
    copyToSheetBtn.disabled = true;
    return;
  }
  
  // Obtener datos completos de cada producto+color
  const tableData = await Promise.all(
    items.map(async ({ productId, color }) => {
      const allProductsList = [...newProducts, ...recommendedProducts, ...allProducts];
      let item = allProductsList.find(p => p.productId === productId && p.color === color);
      
      // Si no está en cache, cargarlo
      if (!item) {
        const { data: product } = await supabase
          .from("products")
          .select("id, name, category")
          .eq("id", productId)
          .single();
        
        if (product) {
          const colorData = await getProductColorData(productId, color);
          if (colorData) {
            item = {
              productId,
              productName: product.name,
              category: product.category,
              color,
              ...colorData,
            };
          }
        }
      }
      
      return item;
    })
  );
  
  const validItems = tableData.filter(Boolean);
  
  publicationTableBody.innerHTML = validItems.map(item => {
    const imageUrlsText = item.imageUrls.join(" | ");
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imageUrlEscaped = item.firstImage ? String(item.firstImage).replace(/"/g, "&quot;") : "";
    const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
    const categoryEscaped = String(item.category || 'N/A').replace(/"/g, "&quot;");
    const numericPrice = getNumericPrice(item.price);
    const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : "N/A";
    const editPriceArg = numericPrice !== null ? numericPrice : "null";
    
    return `
      <tr>
        <td>
          ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" onerror="this.style.display='none'">` : '<span style="color:#999;">Sin imagen</span>'}
        </td>
        <td><strong>${productNameEscaped}</strong><br><small>${categoryEscaped}</small></td>
        <td><span class="product-color-badge">${colorEscaped}</span></td>
        <td>
          <strong>${formattedPrice}</strong>
          <div class="card-actions" style="margin-top:8px;">
            <button class="btn-small btn-primary" onclick="editVariantPrice('${productIdEscaped}', '${colorEscaped}', ${editPriceArg})">
              ✏️ Editar precio
            </button>
          </div>
        </td>
        <td><code style="background:#e9ecef;padding:4px 8px;border-radius:4px;">${formatSizes(item.sizes)}</code></td>
        <td>
          <div class="image-urls" title="${imageUrlsText.replace(/"/g, "&quot;")}">
            ${item.imageUrls.length} imagen(es)
            <button class="btn-small btn-secondary" onclick="copyImageUrls('${productIdEscaped}', '${colorEscaped}')" style="margin-left:8px;">
              📋 Copiar URLs
            </button>
          </div>
        </td>
        <td>
          <div class="action-buttons">
            <button class="btn-small btn-secondary" onclick="copySizes('${productIdEscaped}', '${colorEscaped}')">
              📋 Copiar talles
            </button>
            <button class="btn-small btn-danger" onclick="removeFromPublication('${productIdEscaped}', '${colorEscaped}')">
              ✕ Quitar
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  selectedCount.textContent = validItems.length;
  publicationCount.textContent = validItems.length;
  publishBtn.disabled = validItems.length === 0;
  copyToSheetBtn.disabled = validItems.length === 0;
}

// Toggle agregar/quitar de publicación
window.togglePublication = function(productId, color) {
  const index = selectedForPublication.findIndex(
    s => s.productId === productId && s.color === color
  );
  
  if (index >= 0) {
    selectedForPublication.splice(index, 1);
  } else {
    selectedForPublication.push({ productId, color });
  }
  
  // Actualizar UI
  renderNewProducts();
  renderRecommendedProducts();
  renderAllProducts();
  renderPublicationTable();
  
  // Guardar en localStorage
  saveToLocalStorage();
};

// Remover de publicación
window.removeFromPublication = function(productId, color) {
  const index = selectedForPublication.findIndex(
    s => s.productId === productId && s.color === color
  );
  
  if (index >= 0) {
    selectedForPublication.splice(index, 1);
    renderNewProducts();
    renderRecommendedProducts();
    renderPublicationTable();
    saveToLocalStorage();
  }
};

// Copiar talles al portapapeles
window.copySizes = async function(productId, color) {
  const allProductsList = [...newProducts, ...recommendedProducts, ...allProducts];
  const item = allProductsList.find(p => p.productId === productId && p.color === color);
  
  if (item && item.sizes.length > 0) {
    const sizesText = formatSizes(item.sizes);
    await navigator.clipboard.writeText(sizesText);
    showMessage(`✅ Talles copiados: ${sizesText}`, "ok");
  }
};

// Copiar URLs de imágenes al portapapeles
window.copyImageUrls = async function(productId, color) {
  const allProductsList = [...newProducts, ...recommendedProducts, ...allProducts];
  const item = allProductsList.find(p => p.productId === productId && p.color === color);
  
  if (item && item.imageUrls.length > 0) {
    const urlsText = item.imageUrls.join("\n");
    await navigator.clipboard.writeText(urlsText);
    showMessage(`✅ ${item.imageUrls.length} URL(s) de imagen(es) copiada(s)`, "ok");
  }
};

async function refreshAllProductLists() {
  await loadNewProducts();
  await loadRecommendedProducts();
  await loadAllProducts();
  renderPublicationTable();
}

window.editVariantPrice = async function(productId, color, currentPrice = null) {
  const currentValue = Number.isFinite(currentPrice) ? currentPrice : "";
  const promptLabel = currentValue !== "" ? currentValue : "";
  const input = prompt(`Ingresá el nuevo precio para la variante "${color}"`, promptLabel);
  if (input === null) return;
  const trimmed = input.trim();
  if (!trimmed) {
    showMessage("Ingresá un precio válido.", "err");
    return;
  }
  const normalized = trimmed.replace(/\s/g, "").replace(/\./g, "").replace(/,/g, ".");
  const newPrice = Number(normalized);
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    showMessage("El precio debe ser un número positivo.", "err");
    return;
  }
  try {
    const { error } = await supabase
      .from("product_variants")
      .update({ price: newPrice })
      .eq("product_id", productId)
      .eq("color", color)
      .eq("active", true);
    if (error) throw error;
    showMessage(`✅ Precio actualizado a ${formatCurrency(newPrice)}`, "ok");
    await refreshAllProductLists();
  } catch (error) {
    showMessage(`❌ Error actualizando precio: ${error.message}`, "err");
  }
};

window.deleteVariantColor = async function(productId, color) {
  if (!confirm(`¿Seguro que querés eliminar la variante "${color}"? Esta acción no se puede deshacer.`)) {
    return;
  }
  try {
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", productId)
      .eq("color", color)
      .eq("active", true);
    if (error) throw error;
    if (!variants || variants.length === 0) {
      showMessage("No se encontraron variantes activas para ese color.", "err");
      return;
    }
    const variantIds = variants.map(v => v.id);
    if (variantIds.length === 0) {
      showMessage("No se encontraron variantes para eliminar.", "err");
      return;
    }
    // Eliminar imágenes asociadas primero (si existen)
    const { error: deleteImagesError } = await supabase
      .from("variant_images")
      .delete()
      .in("variant_id", variantIds);
    if (deleteImagesError) throw deleteImagesError;
    const { error: deleteError } = await supabase
      .from("product_variants")
      .delete()
      .in("id", variantIds);
    if (deleteError) throw deleteError;
    const prevLength = selectedForPublication.length;
    selectedForPublication = selectedForPublication.filter(
      item => !(item.productId === productId && item.color === color)
    );
    if (prevLength !== selectedForPublication.length) {
      saveToLocalStorage();
    }
    await refreshAllProductLists();
    showMessage(`✅ Variante "${color}" eliminada correctamente.`, "ok");
  } catch (error) {
    console.error("Error eliminando variante:", error);
    showMessage(`❌ Error eliminando variante: ${error.message}`, "err");
  }
};

// Copiar productos seleccionados en formato TSV para Google Sheets
async function copyToSheet() {
  if (selectedForPublication.length === 0) {
    showMessage("No hay productos seleccionados para copiar", "err");
    return;
  }
  
  try {
    copyToSheetBtn.disabled = true;
    copyToSheetBtn.innerHTML = '<span>⏳</span><span>Copiando...</span>';
    
    // Obtener datos completos de cada producto+color
    const allProductsList = [...newProducts, ...recommendedProducts, ...allProducts];
    const items = selectedForPublication
      .map(({ productId, color }) => {
        return allProductsList.find(p => p.productId === productId && p.color === color);
      })
      .filter(Boolean);
    
    if (items.length === 0) {
      showMessage("No se pudieron cargar los datos de los productos seleccionados", "err");
      return;
    }
    
    // Generar encabezados
    const headers = ["Facebook", "Instagram", "Producto", "Color", "Talles Disponibles", "Precio"];
    for (let i = 1; i <= 12; i++) {
      headers.push(`URLs ${i}`);
    }
    
    // Generar filas de datos
    const rows = items.map(item => {
      // Determinar si el producto es nuevo
      const isNew = item.publication_status === 'nuevo' || !item.last_published_at;
      const instagramValue = isNew ? "si" : "no";
      
      // Formatear precio
      const numericPrice = getNumericPrice(item.price);
      const priceValue = numericPrice !== null ? formatCurrency(numericPrice) : "";
      
      const row = [
        "si", // Facebook siempre "si"
        instagramValue, // Instagram: "si" si es nuevo, "no" si ya fue publicado
        item.productName || "",
        item.color || "",
        formatSizes(item.sizes) || "",
        priceValue
      ];
      
      // Agregar URLs (hasta 12)
      for (let i = 0; i < 12; i++) {
        row.push(item.imageUrls[i] || "");
      }
      
      return row;
    });
    
    // Combinar encabezados y filas
    const allRows = [headers, ...rows];
    
    // Convertir a formato TSV (Tab Separated Values)
    const tsvContent = allRows
      .map(row => row.map(cell => {
        // Escapar tabs y saltos de línea en las celdas
        return String(cell).replace(/\t/g, " ").replace(/\n/g, " ").replace(/\r/g, "");
      }).join("\t"))
      .join("\n");
    
    // Copiar al portapapeles
    await navigator.clipboard.writeText(tsvContent);
    
    showMessage(`✅ ${items.length} producto(s) copiado(s) en formato Sheet. Pegá directamente en Google Sheets.`, "ok");
    
  } catch (error) {
    console.error("Error copiando a Sheet:", error);
    showMessage(`❌ Error al copiar: ${error.message}`, "err");
  } finally {
    copyToSheetBtn.disabled = false;
    copyToSheetBtn.innerHTML = '<span>📋</span><span>Copiar para Sheet</span>';
  }
}

// Publicar productos seleccionados
async function publishSelected() {
  if (selectedForPublication.length === 0) {
    showMessage("No hay productos seleccionados para publicar", "err");
    return;
  }
  
  // Obtener productIds únicos (puede haber varios colores del mismo producto)
  const uniqueProductIds = [...new Set(selectedForPublication.map(s => s.productId))];
  
  try {
    publishBtn.disabled = true;
    publishBtn.textContent = "Publicando...";
    
    // Actualizar todos los productos
    const { error } = await supabase
      .from("products")
      .update({
        last_published_at: new Date().toISOString(),
        publication_status: 'ya_publicado'
      })
      .in("id", uniqueProductIds);
    
    if (error) throw error;
    
    showMessage(`✅ ${uniqueProductIds.length} producto(s) publicado(s) exitosamente`, "ok");
    
    // Limpiar selección
    selectedForPublication = [];
    saveToLocalStorage();
    
    // Recargar datos
    newProducts = [];
    recommendedProducts = [];
    allProducts = [];
    await loadNewProducts();
    await loadRecommendedProducts();
    await loadAllProducts();
    renderPublicationTable();
    
  } catch (error) {
    showMessage(`❌ Error al publicar: ${error.message}`, "err");
  } finally {
    publishBtn.disabled = false;
    publishBtn.innerHTML = '<span>📤</span><span>Publicar Seleccionados</span>';
  }
}

// Limpiar todo
clearAllBtn.addEventListener("click", () => {
  if (selectedForPublication.length === 0) return;
  
  if (confirm("¿Estás seguro de quitar todos los productos de la publicación?")) {
    selectedForPublication = [];
    saveToLocalStorage();
    renderNewProducts();
    renderRecommendedProducts();
    renderAllProducts();
    renderPublicationTable();
  }
});

// Buscador
function searchProducts(query, products) {
  if (!query.trim()) return products;
  
  const lowerQuery = query.toLowerCase();
  return products.filter(item =>
    item.productName.toLowerCase().includes(lowerQuery) ||
    item.category.toLowerCase().includes(lowerQuery) ||
    item.color.toLowerCase().includes(lowerQuery)
  );
}

searchNew.addEventListener("input", (e) => {
  const filtered = searchProducts(e.target.value, newProducts);
  renderNewProducts(filtered);
});

searchRecommended.addEventListener("input", (e) => {
  const filtered = searchProducts(e.target.value, recommendedProducts);
  renderRecommendedProducts(filtered);
});

searchAll.addEventListener("input", (e) => {
  const filtered = searchProducts(e.target.value, allProducts);
  renderAllProducts(filtered);
});

searchPublication.addEventListener("input", (e) => {
  // Filtrar en la tabla de publicación
  renderPublicationTable();
});

// Guardar en localStorage
function saveToLocalStorage() {
  localStorage.setItem("publication_selected", JSON.stringify(selectedForPublication));
}

// Cargar de localStorage
function loadFromLocalStorage() {
  const saved = localStorage.getItem("publication_selected");
  if (saved) {
    try {
      selectedForPublication = JSON.parse(saved);
    } catch (e) {
      console.warn("Error cargando selección guardada:", e);
    }
  }
}

// Mostrar mensaje
function showMessage(text, type = "ok") {
  const message = document.createElement("div");
  message.className = `message ${type}`;
  message.textContent = text;
  messageContainer.innerHTML = "";
  messageContainer.appendChild(message);
  
  if (type === "ok") {
    setTimeout(() => {
      message.remove();
    }, 5000);
  }
}

// Event listeners
publishBtn.addEventListener("click", publishSelected);
copyToSheetBtn.addEventListener("click", copyToSheet);

// Cargar datos iniciales
loadFromLocalStorage();
loadNewProducts();

