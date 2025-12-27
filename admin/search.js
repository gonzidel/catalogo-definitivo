// admin/search.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

const searchInput = document.getElementById("search-input");
const searchSuggestions = document.getElementById("search-suggestions");
const searchSuggestionsList = document.getElementById("search-suggestions-list");
const tagsFilter = document.getElementById("tags-filter");
const sizesInput = document.getElementById("sizes-input");
const sizesDatalist = document.getElementById("sizes-datalist");
const sizesChips = document.getElementById("sizes-chips");
const warehouseFilter = document.getElementById("warehouse-filter");
const includeInactive = document.getElementById("include-inactive");
const searchBtn = document.getElementById("search-btn");
const clearBtn = document.getElementById("clear-btn");
const resultsTbody = document.getElementById("results-tbody");
const resultsCount = document.getElementById("results-count");
const messageContainer = document.getElementById("message-container");

let allTags = [];
let allSizes = [];
let selectedSizes = []; // Array de talles seleccionados
let variantHistories = new Map(); // Cache de historiales
let searchTimeout = null;

// Cargar tags disponibles
async function loadTags() {
  try {
    const { data, error } = await supabase
      .from("tags")
      .select("id, name")
      .order("name");

    if (error) throw error;

    allTags = data || [];
    tagsFilter.innerHTML = "";
    
    allTags.forEach(tag => {
      const option = document.createElement("option");
      option.value = tag.id;
      option.textContent = tag.name;
      tagsFilter.appendChild(option);
    });
  } catch (error) {
    console.error("Error cargando tags:", error);
    tagsFilter.innerHTML = '<option value="">Error cargando tags</option>';
  }
}

// Cargar talles disponibles
async function loadSizes() {
  try {
    const { data, error } = await supabase
      .from("product_variants")
      .select("size")
      .not("size", "is", null);

    if (error) throw error;

    const uniqueSizes = [...new Set((data || []).map(v => v.size).filter(Boolean))].sort();
    allSizes = uniqueSizes;
    
    // Actualizar datalist
    sizesDatalist.innerHTML = "";
    uniqueSizes.forEach(size => {
      const option = document.createElement("option");
      option.value = size;
      sizesDatalist.appendChild(option);
    });
    
    renderSizeChips();
  } catch (error) {
    console.error("Error cargando talles:", error);
  }
}

// Renderizar chips de talles seleccionados
function renderSizeChips() {
  if (selectedSizes.length === 0) {
    sizesChips.innerHTML = "";
    return;
  }
  
  sizesChips.innerHTML = selectedSizes.map(size => `
    <span class="chip">
      ${escapeHtml(size)}
      <span class="chip-remove" data-size="${escapeHtml(size)}">×</span>
    </span>
  `).join("");
  
  // Agregar event listeners a los botones de eliminar
  sizesChips.querySelectorAll(".chip-remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const sizeToRemove = e.target.getAttribute("data-size");
      selectedSizes = selectedSizes.filter(s => s !== sizeToRemove);
      renderSizeChips();
    });
  });
}

// Agregar talle desde el input
function addSizeFromInput() {
  const sizeValue = sizesInput.value.trim();
  if (!sizeValue) return;
  
  // Verificar si el talle existe en la lista disponible
  const normalizedSize = sizeValue;
  if (!allSizes.includes(normalizedSize)) {
    // Si no existe, agregarlo de todos modos (puede ser un talle nuevo)
    if (!allSizes.includes(normalizedSize)) {
      allSizes.push(normalizedSize);
      allSizes.sort();
      // Actualizar datalist
      const option = document.createElement("option");
      option.value = normalizedSize;
      sizesDatalist.appendChild(option);
    }
  }
  
  // Agregar si no está ya seleccionado
  if (!selectedSizes.includes(normalizedSize)) {
    selectedSizes.push(normalizedSize);
    renderSizeChips();
  }
  
  sizesInput.value = "";
}

// Cargar sugerencias de productos para autocompletado
async function loadProductSuggestions(term) {
  if (!term || term.trim().length < 2) {
    searchSuggestions.style.display = "none";
    return;
  }

  try {
    const searchTerm = term.trim().toLowerCase();
    
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category")
      .ilike("name", `%${searchTerm}%`)
      .limit(10);

    if (error) throw error;

    if (!products || products.length === 0) {
      searchSuggestions.style.display = "none";
      return;
    }

    // Eliminar duplicados por nombre (mantener solo el primero)
    const uniqueProducts = [];
    const seenNames = new Set();
    for (const product of products) {
      if (!seenNames.has(product.name)) {
        seenNames.add(product.name);
        uniqueProducts.push(product);
      }
    }

    // Mostrar sugerencias en dropdown personalizado
    searchSuggestionsList.innerHTML = uniqueProducts.map(p => `
      <div class="suggestion-item" data-product-name="${escapeHtml(p.name)}">
        <div class="suggestion-name">${escapeHtml(p.name)}</div>
        <div class="suggestion-details">${escapeHtml(p.category || "")}</div>
      </div>
    `).join("");

    // Agregar event listeners a las sugerencias
    searchSuggestionsList.querySelectorAll(".suggestion-item").forEach(item => {
      item.addEventListener("click", () => {
        const productName = item.getAttribute("data-product-name");
        searchInput.value = productName;
        searchSuggestions.style.display = "none";
        performSearch();
      });
    });

    searchSuggestions.style.display = "block";
  } catch (error) {
    console.error("Error cargando sugerencias:", error);
    searchSuggestions.style.display = "none";
  }
}

// Realizar búsqueda
async function performSearch() {
  const searchTerm = searchInput.value.trim();
  const selectedTagIds = Array.from(tagsFilter.selectedOptions).map(opt => opt.value).filter(Boolean);
  const warehouse = warehouseFilter.value;
  const includeInactiveValue = includeInactive.checked;
  
  // Ocultar sugerencias al buscar
  searchSuggestions.style.display = "none";

  resultsTbody.innerHTML = '<tr><td colspan="8" class="no-results">Buscando...</td></tr>';

  try {
    let query = supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        size,
        price,
        active,
        products (
          id,
          name,
          category,
          status
        )
      `);

    // Filtro de búsqueda por texto
    // Buscar primero productos por nombre para obtener sus IDs
    let productIdsByName = [];
    if (searchTerm) {
      const { data: productsByName, error: productsError } = await supabase
        .from("products")
        .select("id")
        .ilike("name", `%${searchTerm}%`);
      
      if (productsError) throw productsError;
      
      productIdsByName = productsByName ? productsByName.map(p => p.id) : [];
    }
    
    // Aplicar filtros de búsqueda
    if (searchTerm) {
      if (productIdsByName.length > 0) {
        // Buscar variantes de productos encontrados por nombre
        query = query.in("product_id", productIdsByName);
        // También buscar variantes por SKU/color/size y combinar resultados
        // Haremos esto en dos pasos y combinaremos
      } else {
        // Solo buscar en campos de variantes (SKU, color, size)
        query = query.or(
          `sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%,size.ilike.%${searchTerm}%`
        );
      }
    }

    // Filtro de estado del producto - no podemos filtrar directamente por campos de relaciones
    // Filtraremos en JavaScript después de obtener los datos

    // Filtro de variante activa (si no se incluyen inactivos)
    if (!includeInactiveValue) {
      query = query.eq("active", true);
    }

    // Filtro por tags - obtener product_ids primero
    let productIdsWithTags = null;
    if (selectedTagIds.length > 0) {
      const { data: productTags, error: tagsError } = await supabase
        .from("product_tags")
        .select("product_id")
        .in("tag_id", selectedTagIds);
      
      if (tagsError) throw tagsError;
      
      if (productTags && productTags.length > 0) {
        productIdsWithTags = [...new Set(productTags.map(pt => pt.product_id))];
        query = query.in("product_id", productIdsWithTags);
      } else {
        // Si no hay productos con esos tags, no hay resultados
        resultsTbody.innerHTML = '<tr><td colspan="10" class="no-results">No se encontraron productos con los tags seleccionados</td></tr>';
        resultsCount.textContent = "0 productos encontrados";
        return;
      }
    }

    // Filtro por talles (usar el array selectedSizes)
    if (selectedSizes.length > 0) {
      query = query.in("size", selectedSizes);
    }

    // No podemos ordenar por campos de relaciones anidadas directamente
    // Ordenaremos en JavaScript después de obtener los datos
    let { data: variants, error } = await query.limit(500);
    
    // Si hay búsqueda por término y productos encontrados por nombre, también buscar por SKU/color/size
    if (searchTerm && productIdsByName.length > 0) {
      const { data: variantsByFields, error: fieldsError } = await supabase
        .from("product_variants")
        .select(`
          id,
          sku,
          color,
          size,
          price,
          active,
          products (
            id,
            name,
            category,
            status
          )
        `)
        .or(`sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%,size.ilike.%${searchTerm}%`)
        .limit(500);
      
      if (!fieldsError && variantsByFields) {
        // Combinar resultados y eliminar duplicados
        const existingIds = new Set((variants || []).map(v => v.id));
        const newVariants = (variantsByFields || []).filter(v => !existingIds.has(v.id));
        variants = [...(variants || []), ...newVariants];
      }
    }

    if (error) throw error;

    if (!variants || variants.length === 0) {
      resultsTbody.innerHTML = '<tr><td colspan="8" class="no-results">No se encontraron productos</td></tr>';
      resultsCount.textContent = "0 productos encontrados";
      return;
    }

    // Filtrar por estado del producto
    let filteredVariants = variants;
    if (!includeInactiveValue) {
      filteredVariants = variants.filter(v => v.products?.status === "active" && v.active === true);
    } else {
      filteredVariants = variants.filter(v => v.products?.status !== "archived");
    }
    
    // Ordenar por nombre de producto en JavaScript
    filteredVariants.sort((a, b) => {
      const nameA = (a.products?.name || "").toLowerCase();
      const nameB = (b.products?.name || "").toLowerCase();
      return nameA.localeCompare(nameB, "es");
    });

    // Cargar stock para cada variante
    const variantsWithStock = await Promise.all(
      filteredVariants.map(async (variant) => {
        const stockData = await getVariantStock(variant.id);
        return { ...variant, stockData };
      })
    );

    // Filtrar por almacén si es necesario
    let finalFilteredVariants = variantsWithStock;
    if (warehouse !== "all") {
      finalFilteredVariants = variantsWithStock.filter(v => {
        if (warehouse === "general") {
          return v.stockData.general.stock > 0;
        } else if (warehouse === "venta-publico") {
          return v.stockData.ventaPublico.stock > 0;
        }
        return true;
      });
    }

    // Agrupar variantes por producto y color
    const groupedProducts = {};
    for (const variant of finalFilteredVariants) {
      const product = variant.products || {};
      const key = `${product.id}_${variant.color || 'sin-color'}`;
      
      if (!groupedProducts[key]) {
        groupedProducts[key] = {
          productId: product.id,
          productName: product.name || "",
          category: product.category || "",
          color: variant.color || "",
          status: product.status || "inactive",
          variants: [],
          price: variant.price || 0
        };
      }
      
      groupedProducts[key].variants.push(variant);
      
      // Actualizar precio si esta variante tiene un precio diferente (usar el primero encontrado)
      // O podrías usar el precio más común si prefieres
    }

    // Obtener imágenes para cada grupo
    const productGroups = Object.values(groupedProducts);
    const variantIds = finalFilteredVariants.map(v => v.id);
    
    let imagesMap = {};
    if (variantIds.length > 0) {
      const { data: images } = await supabase
        .from("variant_images")
        .select("variant_id, url, position")
        .in("variant_id", variantIds)
        .eq("position", 1); // Solo imagen principal
      
      if (images) {
        images.forEach(img => {
          if (!imagesMap[img.variant_id] || img.position === 1) {
            imagesMap[img.variant_id] = img.url;
          }
        });
      }
    }

    // Asignar imágenes a los grupos
    for (const group of productGroups) {
      // Buscar la primera variante con imagen
      const variantWithImage = group.variants.find(v => imagesMap[v.id]);
      group.imageUrl = variantWithImage ? imagesMap[variantWithImage.id] : null;
    }

    renderResults(productGroups);
    resultsCount.textContent = `${productGroups.length} producto(s) encontrado(s)`;

  } catch (error) {
    console.error("Error en búsqueda:", error);
    showMessage("Error al realizar la búsqueda: " + error.message, "error");
    resultsTbody.innerHTML = '<tr><td colspan="8" class="no-results">Error al realizar la búsqueda</td></tr>';
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

// Renderizar resultados agrupados
function renderResults(productGroups) {
  if (productGroups.length === 0) {
    resultsTbody.innerHTML = '<tr><td colspan="8" class="no-results">No se encontraron productos</td></tr>';
    return;
  }

  let html = "";

  for (const group of productGroups) {
    // Ordenar variantes por tamaño
    group.variants.sort((a, b) => {
      const sizeA = parseFloat(a.size) || 0;
      const sizeB = parseFloat(b.size) || 0;
      if (sizeA !== sizeB) return sizeA - sizeB;
      return (a.size || "").localeCompare(b.size || "", "es");
    });

    // Calcular totales
    const totalGeneral = group.variants.reduce((sum, v) => sum + (v.stockData?.general?.stock || 0), 0);
    const totalVentaPublico = group.variants.reduce((sum, v) => sum + (v.stockData?.ventaPublico?.stock || 0), 0);
    const totalStock = totalGeneral + totalVentaPublico;

    const statusClass = group.status === "active" ? "status-active" : "status-inactive";
    const statusText = group.status === "active" ? "Activo" : "Inactivo";

    // Generar cuadros de talles
    const sizeBoxes = group.variants.map(v => {
      const total = v.stockData?.total || 0;
      let boxClass = "size-box";
      let style = "";
      
      if (total === 0) {
        boxClass += " size-zero";
        style = "text-decoration: line-through;";
      } else if (total < 5) {
        boxClass += " size-low";
      }
      
      return `<span class="${boxClass}" style="${style}" title="Talle ${escapeHtml(v.size || '')}: ${total} unidades">${escapeHtml(v.size || '')}</span>`;
    }).join("");

    const groupKey = `${group.productId}_${group.color}`;
    html += `
      <tr class="product-row" data-group-key="${groupKey}">
        <td>${escapeHtml(group.productName)}</td>
        <td>${escapeHtml(group.category)}</td>
        <td>$${group.price.toLocaleString('es-AR')}</td>
        <td>${escapeHtml(group.color)}</td>
        <td class="sizes-cell">${sizeBoxes}</td>
        <td class="stock-cell stock-general">${totalGeneral}</td>
        <td class="stock-cell stock-venta">${totalVentaPublico}</td>
        <td class="stock-cell stock-total">${totalStock}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td>
          <button class="btn-image" data-image-url="${escapeHtml(group.imageUrl || '')}" title="Ver imagen">
            📷
          </button>
          <button class="btn-expand" data-group-key="${groupKey}">
            ▼
          </button>
        </td>
      </tr>
      <tr class="details-row" data-group-key="${groupKey}" style="display: none;">
        <td colspan="8">
          <div class="variant-details">
            <table class="variant-table">
              <thead>
                <tr>
                  <th>Talle</th>
                  <th>Stock General</th>
                  <th>Stock Venta Público</th>
                  <th>Stock Total</th>
                  <th>Historial</th>
                </tr>
              </thead>
              <tbody>
                ${group.variants.map(v => {
                  const vStock = v.stockData || {
                    general: { stock: 0 },
                    ventaPublico: { stock: 0 },
                    total: 0
                  };
                  return `
                    <tr>
                      <td>${escapeHtml(v.size || "")}</td>
                      <td class="stock-cell stock-general">${vStock.general.stock}</td>
                      <td class="stock-cell stock-venta">${vStock.ventaPublico.stock}</td>
                      <td class="stock-cell stock-total">${vStock.total}</td>
                      <td>
                        <button class="history-toggle" data-variant-id="${v.id}">
                          Ver historial
                        </button>
                        <div class="history-section" id="history-${v.id}"></div>
                      </td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </td>
      </tr>
    `;
  }

  resultsTbody.innerHTML = html;

  // Función para expandir/colapsar
  function toggleDetails(groupKey) {
    const detailsRow = document.querySelector(`tr.details-row[data-group-key="${groupKey}"]`);
    const expandBtn = document.querySelector(`.btn-expand[data-group-key="${groupKey}"]`);
    const productRow = document.querySelector(`tr.product-row[data-group-key="${groupKey}"]`);
    
    if (detailsRow.style.display === "none" || !detailsRow.style.display) {
      detailsRow.style.display = "";
      if (expandBtn) expandBtn.textContent = "▲";
      if (productRow) productRow.classList.add("expanded");
    } else {
      detailsRow.style.display = "none";
      if (expandBtn) expandBtn.textContent = "▼";
      if (productRow) productRow.classList.remove("expanded");
    }
  }

  // Event listeners para expandir/colapsar - botón
  document.querySelectorAll(".btn-expand").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // Evitar que se propague al clic de la fila
      const groupKey = btn.getAttribute("data-group-key");
      toggleDetails(groupKey);
    });
  });

  // Event listeners para expandir/colapsar - clic en la fila
  document.querySelectorAll(".product-row").forEach(row => {
    row.addEventListener("click", (e) => {
      // No expandir si se hace clic en un botón o enlace
      if (e.target.closest("button") || e.target.closest("a")) {
        return;
      }
      const groupKey = row.getAttribute("data-group-key");
      toggleDetails(groupKey);
    });
  });

  // Event listeners para mostrar imagen
  document.querySelectorAll(".btn-image").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const imageUrl = btn.getAttribute("data-image-url");
      if (imageUrl) {
        showImageModal(imageUrl);
      } else {
        showMessage("No hay imagen disponible para este producto", "error");
      }
    });
  });

  // Agregar event listeners a los botones de historial
  document.querySelectorAll(".history-toggle").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const variantId = btn.getAttribute("data-variant-id");
      const historySection = document.getElementById(`history-${variantId}`);
      
      if (historySection.classList.contains("show")) {
        historySection.classList.remove("show");
        btn.textContent = "Ver historial";
      } else {
        btn.textContent = "Cargando...";
        await loadHistory(variantId);
        historySection.classList.add("show");
        btn.textContent = "Ocultar historial";
      }
    });
  });
}

// Mostrar modal de imagen
function showImageModal(imageUrl) {
  // Crear modal si no existe
  let modal = document.getElementById("image-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "image-modal";
    modal.className = "image-modal";
    modal.innerHTML = `
      <div class="image-modal-content">
        <span class="image-modal-close">&times;</span>
        <img id="modal-image" src="" alt="Imagen del producto" />
      </div>
    `;
    document.body.appendChild(modal);
    
    // Cerrar modal al hacer clic en X o fuera
    modal.querySelector(".image-modal-close").addEventListener("click", () => {
      modal.style.display = "none";
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.style.display = "none";
      }
    });
  }
  
  document.getElementById("modal-image").src = imageUrl;
  modal.style.display = "flex";
}

// Cargar historial de movimientos
async function loadHistory(variantId) {
  const historySection = document.getElementById(`history-${variantId}`);
  
  // Verificar cache
  if (variantHistories.has(variantId)) {
    renderHistory(historySection, variantHistories.get(variantId));
    return;
  }

  try {
    const { data, error } = await supabase
      .from("stock_movements")
      .select(`
        id,
        quantity,
        created_at,
        notes,
        from_warehouse_id,
        to_warehouse_id,
        warehouses_from:warehouses!stock_movements_from_warehouse_id_fkey(code, name),
        warehouses_to:warehouses!stock_movements_to_warehouse_id_fkey(code, name),
        moved_by
      `)
      .eq("variant_id", variantId)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    const history = data || [];
    variantHistories.set(variantId, history);
    renderHistory(historySection, history);

  } catch (error) {
    console.error("Error cargando historial:", error);
    historySection.innerHTML = '<div class="history-item">Error al cargar historial</div>';
  }
}

// Renderizar historial
function renderHistory(container, history) {
  if (!history || history.length === 0) {
    container.innerHTML = '<div class="history-item">No hay movimientos registrados</div>';
    return;
  }

  let html = "";
  for (const movement of history) {
    const fromWarehouse = movement.warehouses_from?.name || "N/A";
    const toWarehouse = movement.warehouses_to?.name || "N/A";
    const date = new Date(movement.created_at).toLocaleString("es-AR");
    const notes = movement.notes ? ` - ${escapeHtml(movement.notes)}` : "";

    html += `
      <div class="history-item">
        <div>
          <strong>${movement.quantity}</strong> unidades de <strong>${fromWarehouse}</strong> a <strong>${toWarehouse}</strong>${notes}
        </div>
        <div class="history-date">${date}</div>
      </div>
    `;
  }

  container.innerHTML = html;
}

// Limpiar filtros
function clearFilters() {
  searchInput.value = "";
  searchSuggestions.style.display = "none";
  tagsFilter.selectedIndex = -1;
  sizesInput.value = "";
  selectedSizes = [];
  renderSizeChips();
  warehouseFilter.value = "all";
  includeInactive.checked = false;
  resultsTbody.innerHTML = '<tr><td colspan="10" class="no-results">Realiza una búsqueda para ver resultados</td></tr>';
  resultsCount.textContent = "0 productos encontrados";
  messageContainer.innerHTML = "";
}

// Escapar HTML
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Mostrar mensaje
function showMessage(text, type = "info") {
  messageContainer.innerHTML = `
    <div class="message ${type}">
      ${escapeHtml(text)}
    </div>
  `;

  setTimeout(() => {
    messageContainer.innerHTML = "";
  }, 5000);
}

// Event listeners
searchBtn.addEventListener("click", performSearch);
clearBtn.addEventListener("click", clearFilters);

// Autocompletado del buscador principal
searchInput.addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  const term = e.target.value.trim();
  
  searchTimeout = setTimeout(() => {
    loadProductSuggestions(term);
  }, 300);
});

searchInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    searchSuggestions.style.display = "none";
    performSearch();
  }
});

// Ocultar sugerencias al hacer clic fuera
document.addEventListener("click", (e) => {
  if (!searchInput.contains(e.target) && !searchSuggestions.contains(e.target)) {
    searchSuggestions.style.display = "none";
  }
});

// Input de talles - agregar al presionar Enter o seleccionar del datalist
sizesInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addSizeFromInput();
  }
});

sizesInput.addEventListener("change", () => {
  // Cuando se selecciona del datalist
  if (sizesInput.value.trim()) {
    addSizeFromInput();
  }
});

// Cargar datos iniciales
loadTags();
loadSizes();

