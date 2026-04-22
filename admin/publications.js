// admin/publications.js
import { supabase } from "../scripts/supabase-client.js";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js";
import { normalizeSize, compareCatalogSizes } from "../scripts/utils/size-normalizer.js";

// Verificar que Supabase esté disponible (puede fallar en error de config, no de red)
if (!supabase) {
  console.error("❌ Cliente de Supabase no disponible");
  document.body.innerHTML = `
    <div style="padding: 20px; text-align: center;">
      <h1>Error de configuración</h1>
      <p>El cliente de Supabase no está disponible. Verifica la configuración.</p>
    </div>
  `;
}

let _publicationsAuthAllowed = false;
let _publicationsAuthChecked = false;

// Auth gate único para evitar cargas ambiguas antes de validar permisos.
const publicationsAuthReady = (async () => {
  try {
    const { user } = await preloadAuthState();
    if (!user) {
      window.location.href = "./index.html";
      return false;
    }

    // Mantener fallback seguro: si no hay key explícita pero sí perfil admin,
    // no bloquear por inconsistencias transitorias de permisos.
    const canViewPublications = can("publications", "view");
    if (!canViewPublications && !isAdminUser()) {
      window.location.href = "./index.html";
      return false;
    }

    _publicationsAuthAllowed = true;
    return true;
  } catch (authErr) {
    console.warn("[publications] error verificando auth-state:", authErr);
    window.location.href = "./index.html";
    return false;
  } finally {
    _publicationsAuthChecked = true;
  }
})();

async function ensurePublicationsAuth() {
  if (_publicationsAuthChecked && !_publicationsAuthAllowed) return false;
  const ok = await publicationsAuthReady;
  return ok && _publicationsAuthAllowed;
}

function runPublicationsTask(label, task) {
  Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error(`[publications] ${label} failed:`, err);
      const msg = err?.message || "Error inesperado. Reintentá.";
      showMessage(msg, "error");
    });
}

// Estado
let newProducts = [];
let recommendedProducts = [];
let lowStockProducts = [];
let allProducts = [];
let selectedForPublication = []; // Array de { productId, color }

// Programados por día (lunes, martes, miercoles, jueves, viernes, sabado)
const DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
let scheduledByDay = { lunes: [], martes: [], miercoles: [], jueves: [], viernes: [], sabado: [] };
let programadosDiaActual = null;

// Tamaño del primer lote para mostrar productos rápidamente (antes de que termine la carga completa)
const INITIAL_BATCH_SIZE = 12;

// Estado de paginación para cada tab
const paginationState = {
  new: { offset: 0, limit: 10, loading: false, hasMore: true, allLoaded: [] },
  recommended: { offset: 0, limit: 10, loading: false, hasMore: true, allLoaded: [] },
  lowStock: { offset: 0, limit: 10, loading: false, hasMore: true, allLoaded: [] },
  all: { offset: 0, limit: 10, loading: false, hasMore: true, allLoaded: [] }
};

// Elementos DOM
const tabs = document.querySelectorAll(".tab");
const tabContents = document.querySelectorAll(".tab-content");
const searchNew = document.getElementById("search-new");
const searchRecommended = document.getElementById("search-recommended");
const searchLowStock = document.getElementById("search-low-stock");
const searchAll = document.getElementById("search-all");
const searchPublication = document.getElementById("search-publication");
const categoryFilterNew = document.getElementById("category-filter-new");
const categoryFilterRecommended = document.getElementById("category-filter-recommended");
const categoryFilterLowStock = document.getElementById("category-filter-low-stock");
const categoryFilterAll = document.getElementById("category-filter-all");
const newContainer = document.getElementById("new-products-container");
const recommendedContainer = document.getElementById("recommended-products-container");
const lowStockContainer = document.getElementById("low-stock-products-container");
const allContainer = document.getElementById("all-products-container");
const publicationTableBody = document.getElementById("publication-table-body");
const publicationCount = document.getElementById("publication-count");
const selectedCount = document.getElementById("selected-count");
const publishBtn = document.getElementById("publish-btn");
const copyToSheetBtn = document.getElementById("copy-to-sheet-btn");
const clearAllBtn = document.getElementById("clear-all");
const messageContainer = document.getElementById("message-container");

/**
 * Genera URL optimizada de Cloudinary (imagen más pequeña para carga rápida)
 * @param {string} url - URL de imagen (Cloudinary o externa)
 * @param {number} width - Ancho deseado en px
 * @returns {string} URL optimizada o original si no es Cloudinary
 */
function cloudinaryOptimized(url, width) {
  if (!url || typeof url !== "string") return url || "";
  const u = url.startsWith("http://") ? url.replace("http://", "https://") : url;
  if (!u.includes("res.cloudinary.com") || !u.includes("/image/upload/")) {
    return u;
  }
  if (u.includes("/upload/f_") || u.includes("/upload/v")) {
    if (u.includes("w_") && /\bw_\d+/.test(u)) {
      return u.replace(/w_\d+/g, `w_${width}`);
    }
  }
  return u.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${width}/`);
}

function normalizeUniqueSortedSizes(rawSizes) {
  const normalized = (rawSizes || [])
    .map(size => normalizeSize(size))
    .filter(Boolean);

  const unique = [...new Set(normalized)];
  unique.sort(compareCatalogSizes);

  return unique;
}

let generalWarehouseIdCache = null;

async function getGeneralWarehouseId() {
  if (generalWarehouseIdCache) return generalWarehouseIdCache;
  const { data, error } = await supabase
    .from("warehouses")
    .select("id")
    .eq("code", "general")
    .maybeSingle();
  if (error) {
    console.warn("⚠️ Error obteniendo warehouse general:", error);
    return null;
  }
  generalWarehouseIdCache = data?.id || null;
  return generalWarehouseIdCache;
}

async function getGeneralSizeStockByVariantIds(variantIds) {
  if (!Array.isArray(variantIds) || variantIds.length === 0) return [];
  const generalWarehouseId = await getGeneralWarehouseId();
  if (!generalWarehouseId) return [];

  const { data, error } = await supabase
    .from("variant_size_warehouse_stock")
    .select("variant_id, size, stock_qty")
    .in("variant_id", variantIds)
    .eq("warehouse_id", generalWarehouseId);

  if (error) {
    console.warn("⚠️ Error obteniendo stock por talle en general:", error);
    return [];
  }
  return data || [];
}

async function getPublicationVariantSizes(variantIds) {
  if (!Array.isArray(variantIds) || variantIds.length === 0) return [];

  const stockRows = await getGeneralSizeStockByVariantIds(variantIds);
  const { data: sizeMetaRows, error: sizeMetaError } = await supabase
    .from("variant_sizes")
    .select("variant_id, size")
    .in("variant_id", variantIds);

  if (sizeMetaError) {
    console.warn("⚠️ Error obteniendo metadatos de talles en publications:", sizeMetaError);
    return [];
  }

  const stockByKey = new Map();
  (stockRows || []).forEach((row) => {
    const size = normalizeSize(row.size);
    if (!size) return;
    stockByKey.set(`${row.variant_id}::${size}`, Number(row.stock_qty) || 0);
  });

  const mergedByKey = new Map();
  (sizeMetaRows || []).forEach((row) => {
    const size = normalizeSize(row.size);
    if (!size) return;
    const key = `${row.variant_id}::${size}`;
    mergedByKey.set(key, {
      variant_id: row.variant_id,
      size,
      stock_qty: stockByKey.get(key) || 0,
    });
  });

  // Compatibilidad: conservar filas de stock que aún no tengan metadato en variant_sizes.
  (stockRows || []).forEach((row) => {
    const size = normalizeSize(row.size);
    if (!size) return;
    const key = `${row.variant_id}::${size}`;
    if (!mergedByKey.has(key)) {
      mergedByKey.set(key, {
        variant_id: row.variant_id,
        size,
        stock_qty: Number(row.stock_qty) || 0,
      });
    }
  });

  return [...mergedByKey.values()];
}

// Funciones para mostrar/ocultar indicador de carga
function showLoadingIndicator(tabName) {
  const indicator = document.getElementById(`loading-${tabName}`);
  if (indicator) {
    indicator.classList.add('active');
  }
}

function hideLoadingIndicator(tabName) {
  const indicator = document.getElementById(`loading-${tabName}`);
  if (indicator) {
    indicator.classList.remove('active');
  }
}

// Configurar scroll infinito para cada contenedor
function setupInfiniteScroll(containerId, tabName, loadFunction) {
  const container = document.getElementById(containerId);
  if (!container) return;
  
  // Usar el contenedor padre (tab-content) para detectar scroll
  const tabContent = container.closest('.tab-content');
  if (!tabContent) return;
  
  // Detectar scroll en el contenedor padre o window
  const scrollHandler = () => {
    const state = paginationState[tabName];
    if (state.loading || !state.hasMore) return;
    
    // Para la pestaña "all", NO cargar más productos cuando hay búsqueda activa
    // porque la búsqueda directa ya devuelve todos los resultados filtrados
    if (tabName === "all") {
      const hasSearch = searchAll?.value?.trim() || categoryFilterAll?.value;
      if (hasSearch) return; // No cargar más si hay búsqueda activa (búsqueda directa ya tiene todos los resultados)
    }
    
    // Calcular si estamos cerca del final (100px antes del final)
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const windowHeight = window.innerHeight;
    const documentHeight = document.documentElement.scrollHeight;
    
    if (scrollTop + windowHeight >= documentHeight - 100) {
      runPublicationsTask(`scroll:${tabName}`, async () => {
        if (!(await ensurePublicationsAuth())) return;
        await loadFunction(false); // false = no reset, cargar más
      });
    }
  };
  
  // Throttle para evitar demasiadas llamadas
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(scrollHandler, 100);
  }, { passive: true });
}

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
      runPublicationsTask("tab:new", async () => {
        if (!(await ensurePublicationsAuth())) return;
        await loadNewProducts(true);
      });
    } else if (targetTab === "recommended" && recommendedProducts.length === 0) {
      runPublicationsTask("tab:recommended", async () => {
        if (!(await ensurePublicationsAuth())) return;
        await loadRecommendedProducts(true);
      });
    } else if (targetTab === "low-stock" && lowStockProducts.length === 0) {
      runPublicationsTask("tab:low-stock", async () => {
        if (!(await ensurePublicationsAuth())) return;
        await loadLowStockProducts(true);
      });
    } else if (targetTab === "all") {
      // No cargar automáticamente - solo buscar si hay búsqueda activa
      const hasSearch = searchAll?.value?.trim() || categoryFilterAll?.value;
      if (hasSearch) {
        // Usar búsqueda directa en lugar de cargar todos los productos
        runPublicationsTask("tab:all_search", async () => {
          if (!(await ensurePublicationsAuth())) return;
          await searchAllProductsDirect(searchAll?.value?.trim() || "", categoryFilterAll?.value || "");
        });
      } else {
        renderAllProducts();
      }
    } else if (targetTab === "publication") {
      renderPublicationTable();
    }
  });
});

// Configurar scroll infinito para cada tab
setupInfiniteScroll('new-products-container', 'new', loadNewProducts);
setupInfiniteScroll('recommended-products-container', 'recommended', loadRecommendedProducts);
setupInfiniteScroll('low-stock-products-container', 'lowStock', loadLowStockProducts);
setupInfiniteScroll('all-products-container', 'all', loadAllProducts);

// Cargar productos iniciales cuando se carga la página
document.addEventListener('DOMContentLoaded', async () => {
  const canBoot = await ensurePublicationsAuth();
  if (!canBoot) return;

  // Solo cargar si el tab "new" está activo (ya no es el por defecto)
  if (document.getElementById('tab-new')?.classList.contains('active')) {
    runPublicationsTask("boot:new", () => loadNewProducts(true));
  }
  // La pestaña "Todo" es la activa por defecto, pero no carga productos automáticamente
  // Solo muestra el mensaje de búsqueda hasta que el usuario busque
});

// Obtener datos de producto+color (variantes, talles, imágenes)
async function getProductColorData(productId, color) {
  // Obtener variantes del color específico (size/stock se resuelven aparte).
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("id, sku, price, last_published_at")
    .eq("product_id", productId)
    .eq("color", color)
    .eq("active", true);
  
  if (error) {
    console.warn(`⚠️ Error obteniendo variantes para producto ${productId} color ${color}:`, error);
    return null;
  }
  
  if (!variants || variants.length === 0) {
    return null;
  }
  
  const variantIds = variants.map(v => v.id);
  
  // Misma lógica que products/stock:
  // - variant_sizes: metadato de talles
  // - variant_size_warehouse_stock (general): stock operativo
  const variantSizes = await getPublicationVariantSizes(variantIds);
  
  if (!variantSizes || variantSizes.length === 0) {
    // No hay talles definidos para estas variantes.
    return null;
  }
  
  const variantSizesWithStock = variantSizes.filter(vs => Number(vs.stock_qty || 0) > 0);

  // Mantener comportamiento original: solo publicar colores con al menos un talle con stock.
  if (variantSizesWithStock.length === 0) {
    return null;
  }

  // Variantes que tienen al menos un talle con stock (gating de publicación).
  const variantIdsWithStock = [...new Set(variantSizesWithStock.map(vs => vs.variant_id))];
  const availableVariants = variants.filter(v => variantIdsWithStock.includes(v.id));
  
  if (availableVariants.length === 0) {
    return null;
  }
  
  // Mostrar solo talles que realmente tengan stock > 0.
  const sizes = normalizeUniqueSortedSizes(variantSizesWithStock.map(vs => vs.size));
  
  // Obtener imágenes de las variantes (url, public_id para optimización)
  const { data: images } = await supabase
    .from("variant_images")
    .select("url, public_id, secure_url, position")
    .in("variant_id", variantIds)
    .order("position");
  
  // Obtener URLs únicas (priorizar url o secure_url)
  const allImageUrls = (images || [])
    .map(img => img.url || img.secure_url)
    .filter(Boolean);
  
  // Eliminar duplicados usando Set (mantiene orden de primera aparición)
  const uniqueImageUrls = [...new Set(allImageUrls)];
  
  // Obtener precio (tomar el precio de la primera variante disponible, normalmente todas tienen el mismo precio)
  const price = availableVariants.length > 0 && availableVariants[0].price 
    ? parseFloat(availableVariants[0].price) 
    : null;
  const colorLastPublishedAt = availableVariants
    .map(v => v.last_published_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;
  
  return {
    variants: availableVariants.map(v => ({
      ...v,
      sizes: variantSizesWithStock
        .filter(vs => vs.variant_id === v.id)
        .map(vs => ({ size: normalizeSize(vs.size), stock: vs.stock_qty }))
    })),
    sizes,
    imageUrls: uniqueImageUrls,
    firstImage: uniqueImageUrls[0] || null,
    price,
    last_published_at: colorLastPublishedAt,
  };
}

// Formatear talles como string
function formatSizes(sizes) {
  return normalizeUniqueSortedSizes(sizes).join(", ");
}

function resolveColorPublishedAt(productLastPublishedAt, colorData) {
  if (colorData?.last_published_at) return colorData.last_published_at;
  return productLastPublishedAt || null;
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

// Agrupar productos por color (optimizado con procesamiento en paralelo)
async function groupProductsByColor(products, batchSize = 10) {
  const grouped = [];
  let productsWithoutVariants = 0;
  let colorsWithoutStock = 0;
  
  // Procesar en lotes para mejor rendimiento
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    
    // Procesar el lote en paralelo
    const batchPromises = batch.map(async (product) => {
      try {
        // Obtener todas las variantes del producto
        const { data: variants, error: variantsError } = await supabase
          .from("product_variants")
          .select("color")
          .eq("product_id", product.id)
          .eq("active", true);
        
        if (variantsError) {
          console.warn(`⚠️ Error obteniendo variantes para producto ${product.id}:`, variantsError);
          return [];
        }
        
        if (!variants || variants.length === 0) {
          productsWithoutVariants++;
          return [];
        }
        
        // Obtener colores únicos
        const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
        
        if (colors.length === 0) {
          productsWithoutVariants++;
          return [];
        }
        
        // Procesar colores en paralelo
        const colorPromises = colors.map(async (color) => {
          try {
            const colorData = await getProductColorData(product.id, color);
            
            // Incluir productos incluso si no tienen talles disponibles (para la pestaña "Todo")
            if (colorData) {
              return {
                productId: product.id,
                productName: product.name,
                category: product.category,
                description: product.description || "",
                color,
                created_at: product.created_at,
                last_published_at: resolveColorPublishedAt(product.last_published_at, colorData),
                publication_status: product.publication_status || 'nuevo',
                ...colorData,
              };
            } else {
              // Si no hay colorData, crear un objeto básico para que el producto aparezca
              return {
                productId: product.id,
                productName: product.name,
                category: product.category,
                description: product.description || "",
                color,
                created_at: product.created_at,
                last_published_at: resolveColorPublishedAt(product.last_published_at, colorData),
                publication_status: product.publication_status || 'nuevo',
                sizes: [],
                imageUrls: [],
                firstImage: null,
                price: null,
                stockInfo: "Sin stock",
              };
            }
          } catch (colorError) {
            console.warn(`⚠️ Error obteniendo datos de color ${color} para producto ${product.id}:`, colorError);
            return null;
          }
        });
        
        const colorResults = await Promise.all(colorPromises);
        return colorResults.filter(item => item !== null);
      } catch (productError) {
        console.warn(`⚠️ Error procesando producto ${product.id}:`, productError);
        return [];
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    const flatResults = batchResults.flat();
    grouped.push(...flatResults);
    
    // Log de progreso cada 20 productos
    if ((i + batchSize) % 20 === 0 || i + batchSize >= products.length) {
      console.log(`📊 Procesados ${Math.min(i + batchSize, products.length)}/${products.length} productos...`);
    }
  }
  
  console.log(`📊 Resumen de agrupación: ${grouped.length} productos-colores agrupados, ${productsWithoutVariants} productos sin variantes, ${colorsWithoutStock} colores sin stock suficiente`);
  
  if (grouped.length === 0 && products.length > 0) {
    console.warn(`⚠️ ADVERTENCIA: Se encontraron ${products.length} productos pero ninguno tiene variantes con stock >= 1`);
    console.warn(`   Esto puede indicar que no hay stock > 0 en variant_size_warehouse_stock (general).`);
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

// Cargar productos nuevos (con paginación optimizada)
async function loadNewProducts(reset = false) {
  const state = paginationState.new;
  
  if (state.loading) return;
  
  try {
    state.loading = true;
    showLoadingIndicator('new');
    
    // Si es reset, cargar productos y agruparlos de forma optimizada
    if (reset || state.allLoaded.length === 0) {
      const queries = [
        supabase
          .from("products")
          .select("id, name, category, description, created_at, last_published_at, publication_status")
          .eq("status", "active")
          .eq("publication_status", "nuevo"),
        supabase
          .from("products")
          .select("id, name, category, description, created_at, last_published_at, publication_status")
          .eq("status", "active")
          .is("last_published_at", null),
        supabase
          .from("products")
          .select("id, name, category, description, created_at, last_published_at, publication_status")
          .eq("status", "active")
          .is("publication_status", null)
      ];
      
      const results = await Promise.all(queries.map(q => q.order("created_at", { ascending: false })));
      
      const allProducts = [];
      const seenIds = new Set();
      
      for (const result of results) {
        if (result.error) {
          console.warn("Error en una de las consultas:", result.error);
          continue;
        }
        if (result.data) {
          for (const product of result.data) {
            if (!seenIds.has(product.id)) {
              seenIds.add(product.id);
              allProducts.push(product);
            }
          }
        }
      }
      
      allProducts.sort((a, b) => {
        const dateA = new Date(a.created_at);
        const dateB = new Date(b.created_at);
        return dateB - dateA;
      });
      
      console.log(`📦 Productos encontrados (sin agrupar): ${allProducts.length}`);
      
      if (allProducts.length === 0) {
        state.allLoaded = [];
        newProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('new');
        renderNewProducts();
        return;
      }
      
      // Optimización: procesar primero batch pequeño para mostrar resultados rápido y permitir búsqueda
      const initialBatch = allProducts.slice(0, INITIAL_BATCH_SIZE);
      console.log(`🔄 Agrupando primeros ${initialBatch.length} productos por color (carga rápida)...`);
      
      // Procesar lote inicial en paralelo
      const initialGrouped = await groupProductsByColor(initialBatch, 4);
      state.allLoaded = initialGrouped;
      state.offset = 0;
      state.hasMore = allProducts.length > INITIAL_BATCH_SIZE;
      
      // Mostrar primeros resultados inmediatamente
      const firstBatch = initialGrouped.slice(0, state.limit);
      newProducts = firstBatch;
      state.offset = state.limit;
    renderNewProducts();
    populateCategoryFilters(); // Actualizar filtros de categorías
    hideLoadingIndicator('new');
    applyCurrentCategoryFilterToAllTabs();
      
      // Continuar procesando el resto en segundo plano
      if (allProducts.length > INITIAL_BATCH_SIZE) {
        console.log(`🔄 Continuando con el resto de productos en segundo plano...`);
        showLoadingIndicator('new');
        const remainingProducts = allProducts.slice(INITIAL_BATCH_SIZE);
        groupProductsByColor(remainingProducts, 5).then(remainingGrouped => {
          state.allLoaded = [...initialGrouped, ...remainingGrouped];
          state.hasMore = state.allLoaded.length > state.offset;
          console.log(`✅ Todos los productos agrupados: ${state.allLoaded.length}`);
          populateCategoryFilters();
          applyCurrentCategoryFilterToAllTabs();
          hideLoadingIndicator('new');
        }).catch(err => {
          console.error("Error procesando productos restantes:", err);
          hideLoadingIndicator('new');
        });
      } else {
        console.log(`✅ Productos agrupados: ${state.allLoaded.length}`);
      }
    } else {
      // Cargar siguiente lote desde productos ya agrupados
      const start = state.offset;
      const end = start + state.limit;
      const batch = state.allLoaded.slice(start, end);
      
      if (batch.length > 0) {
        newProducts = [...newProducts, ...batch];
        state.offset = end;
        state.hasMore = end < state.allLoaded.length;
        applyFilters("new", searchNew, categoryFilterNew, renderNewProducts);
      }
      hideLoadingIndicator('new');
    }
  } catch (error) {
    console.error("❌ Error cargando productos nuevos:", error);
    showMessage(`Error cargando productos nuevos: ${error.message}`, "err");
    newProducts = [];
    hideLoadingIndicator('new');
    renderNewProducts();
  } finally {
    state.loading = false;
  }
}

// Cargar productos recomendados (10+ días sin publicar, reingresados, y productos vendidos)
async function loadRecommendedProducts(reset = false) {
  const state = paginationState.recommended;
  
  if (state.loading) return;
  
  try {
    state.loading = true;
    showLoadingIndicator('recommended');
    
    // Si es reset, cargar todos los productos y agruparlos
    if (reset || state.allLoaded.length === 0) {
      const allRecommendedProducts = [];
      const seenProductIds = new Set();
    
    // 1. Productos con más de 10 días sin publicar
    const tenDaysAgo = new Date();
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    
    const { data: oldPublished, error: error1 } = await supabase
      .from("products")
      .select("id, name, category, description, created_at, last_published_at, publication_status")
      .not("last_published_at", "is", null)
      .lt("last_published_at", tenDaysAgo.toISOString())
      .eq("status", "active");
    
    if (!error1 && oldPublished) {
      oldPublished.forEach(p => {
        if (!seenProductIds.has(p.id)) {
          seenProductIds.add(p.id);
          allRecommendedProducts.push(p);
        }
      });
    }
    
    // 2. Productos reingresados (stock por talle en depósito general con updated_at reciente)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const generalWarehouseId = await getGeneralWarehouseId();
    let recentVariantSizes = [];
    let error2 = null;
    if (generalWarehouseId) {
      // Obtener talles con stock > 0 actualizados recientemente en depósito general
      const { data, error } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, updated_at")
        .eq("warehouse_id", generalWarehouseId)
        .gte("updated_at", sevenDaysAgo.toISOString())
        .gt("stock_qty", 0);
      recentVariantSizes = data || [];
      error2 = error;
    } else {
      console.warn("⚠️ No se encontró warehouse 'general'. No se calcularán reingresados por stock.");
    }
    
    if (!error2 && recentVariantSizes && recentVariantSizes.length > 0) {
      const recentVariantIds = [...new Set(recentVariantSizes.map(vs => vs.variant_id))];
      
      // Obtener product_ids desde las variantes
      const { data: recentVariants, error: error2b } = await supabase
        .from("product_variants")
        .select("product_id")
        .in("id", recentVariantIds)
        .eq("active", true);
      
      if (!error2b && recentVariants) {
        const reentryProductIds = [...new Set(recentVariants.map(v => v.product_id))];
        
        if (reentryProductIds.length > 0) {
          const { data: reentryProducts, error: error3 } = await supabase
            .from("products")
            .select("id, name, category, description, created_at, last_published_at, publication_status")
            .in("id", reentryProductIds)
            .eq("status", "active");
          
          if (!error3 && reentryProducts) {
            reentryProducts.forEach(p => {
              if (!seenProductIds.has(p.id)) {
                seenProductIds.add(p.id);
                allRecommendedProducts.push(p);
              }
            });
          }
        }
      }
    }
    
    // 3. Productos que se venden bien (12+ ventas en últimos 7 días)
    // Intentar obtener cart_items, pero no fallar si hay error (tabla puede no existir o no tener permisos)
    try {
      const { data: cartItems, error: error4 } = await supabase
        .from("cart_items")
        .select("variant_id, created_at")
        .in("status", ["confirmed", "picked"])
        .gte("created_at", sevenDaysAgo.toISOString());
      
      if (!error4 && cartItems && cartItems.length > 0) {
        // Contar ventas por variant_id
        const variantSales = {};
        cartItems.forEach(item => {
          variantSales[item.variant_id] = (variantSales[item.variant_id] || 0) + 1;
        });
        
        // Filtrar variantes con 12+ ventas
        const bestSellerVariantIds = Object.keys(variantSales)
          .filter(vid => variantSales[vid] >= 12)
          .map(vid => vid);
        
        if (bestSellerVariantIds.length > 0) {
          // Obtener product_ids desde las variantes
          const { data: bestSellerVariants, error: error5 } = await supabase
            .from("product_variants")
            .select("product_id")
            .in("id", bestSellerVariantIds)
            .eq("active", true);
          
          if (!error5 && bestSellerVariants) {
            const bestSellerProductIds = [...new Set(bestSellerVariants.map(v => v.product_id))];
            
            if (bestSellerProductIds.length > 0) {
              const { data: bestSellerProducts, error: error6 } = await supabase
              .from("products")
              .select("id, name, category, description, created_at, last_published_at, publication_status")
              .in("id", bestSellerProductIds)
                .eq("status", "active");
              
              if (!error6 && bestSellerProducts) {
                bestSellerProducts.forEach(p => {
                  if (!seenProductIds.has(p.id)) {
                    seenProductIds.add(p.id);
                    allRecommendedProducts.push(p);
                  }
                });
              }
            }
          }
        }
      }
    } catch (cartItemsError) {
      // Si hay error obteniendo cart_items, simplemente continuar sin productos vendidos
      console.warn("⚠️ Error obteniendo cart_items (ignorado):", cartItemsError);
    }
    
      console.log(`📦 Productos recomendados encontrados (total): ${allRecommendedProducts.length}`);
      
      if (allRecommendedProducts.length === 0) {
        state.allLoaded = [];
        recommendedProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('recommended');
        renderRecommendedProducts();
        return;
      }
      
      // Optimización: procesar primero batch pequeño para mostrar resultados rápido
      const initialBatch = allRecommendedProducts.slice(0, INITIAL_BATCH_SIZE);
      console.log(`🔄 Agrupando primeros ${initialBatch.length} productos recomendados por color (carga rápida)...`);
      
      const initialGrouped = await groupProductsByColor(initialBatch, 4);
      state.allLoaded = initialGrouped;
      state.offset = 0;
      state.hasMore = allRecommendedProducts.length > INITIAL_BATCH_SIZE;
      
      // Mostrar primeros resultados inmediatamente
      const firstBatch = initialGrouped.slice(0, state.limit);
      recommendedProducts = firstBatch;
      state.offset = state.limit;
    renderRecommendedProducts();
    populateCategoryFilters(); // Actualizar filtros de categorías
    hideLoadingIndicator('recommended');
    applyCurrentCategoryFilterToAllTabs();
      
      // Continuar procesando el resto en segundo plano
      if (allRecommendedProducts.length > INITIAL_BATCH_SIZE) {
        console.log(`🔄 Continuando con el resto de productos recomendados en segundo plano...`);
        showLoadingIndicator('recommended');
        const remainingProducts = allRecommendedProducts.slice(INITIAL_BATCH_SIZE);
        groupProductsByColor(remainingProducts, 5).then(remainingGrouped => {
          state.allLoaded = [...initialGrouped, ...remainingGrouped];
          state.hasMore = state.allLoaded.length > state.offset;
          console.log(`✅ Todos los productos recomendados agrupados: ${state.allLoaded.length}`);
          populateCategoryFilters();
          applyCurrentCategoryFilterToAllTabs();
          hideLoadingIndicator('recommended');
        }).catch(err => {
          console.error("Error procesando productos restantes:", err);
          hideLoadingIndicator('recommended');
        });
      } else {
        console.log(`✅ Productos recomendados agrupados: ${state.allLoaded.length}`);
      }
    } else {
      // Cargar siguiente lote desde productos ya agrupados
      const start = state.offset;
      const end = start + state.limit;
      const batch = state.allLoaded.slice(start, end);
      
      if (batch.length > 0) {
        recommendedProducts = [...recommendedProducts, ...batch];
        state.offset = end;
        state.hasMore = end < state.allLoaded.length;
        applyFilters("recommended", searchRecommended, categoryFilterRecommended, renderRecommendedProducts);
      }
      hideLoadingIndicator('recommended');
    }
  } catch (error) {
    console.error("❌ Error cargando productos recomendados:", error);
    showMessage(`Error cargando productos recomendados: ${error.message}`, "err");
    recommendedProducts = [];
    hideLoadingIndicator('recommended');
    renderRecommendedProducts();
  } finally {
    state.loading = false;
  }
}

// Cargar productos con poco stock (stock <= 10)
async function loadLowStockProducts(reset = false) {
  const state = paginationState.lowStock;
  
  if (state.loading) return;
  
  try {
    state.loading = true;
    showLoadingIndicator('low-stock');
    
    // Si es reset, cargar todos los productos y agruparlos
    if (reset || state.allLoaded.length === 0) {
      // Obtener talles con stock <= 10 (depósito general)
      const generalWarehouseId = await getGeneralWarehouseId();
      if (!generalWarehouseId) {
        console.warn("⚠️ No se encontró warehouse 'general'. No se pueden calcular productos de poco stock.");
        state.allLoaded = [];
        lowStockProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('low-stock');
        renderLowStockProducts();
        return;
      }

      const { data: lowStockVariantSizes, error: error1 } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, stock_qty")
        .eq("warehouse_id", generalWarehouseId)
        .lte("stock_qty", 10)
        .gt("stock_qty", 0);
      
      if (error1) {
        console.error("❌ Error obteniendo stock por talle (general) con poco stock:", error1);
        throw error1;
      }
      
      if (!lowStockVariantSizes || lowStockVariantSizes.length === 0) {
        state.allLoaded = [];
        lowStockProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('low-stock');
        renderLowStockProducts();
        return;
      }
      
      // Obtener variant_ids únicos
      const variantIds = [...new Set(lowStockVariantSizes.map(vs => vs.variant_id))];
      
      // Obtener product_ids desde las variantes
      const { data: variants, error: error1b } = await supabase
        .from("product_variants")
        .select("product_id")
        .in("id", variantIds)
        .eq("active", true);
      
      if (error1b) {
        console.error("❌ Error obteniendo variantes con poco stock:", error1b);
        throw error1b;
      }
      
      if (!variants || variants.length === 0) {
        state.allLoaded = [];
        lowStockProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('low-stock');
        renderLowStockProducts();
        return;
      }
      
      // Obtener product_ids únicos
      const productIds = [...new Set(variants.map(v => v.product_id))];
      
      // Obtener productos
      const { data: products, error: error2 } = await supabase
        .from("products")
        .select("id, name, category, description, created_at, last_published_at, publication_status")
        .in("id", productIds)
        .eq("status", "active");
      
      if (error2) {
        console.error("❌ Error obteniendo productos con poco stock:", error2);
        throw error2;
      }
      
      console.log(`📦 Productos con poco stock encontrados: ${(products || []).length}`);
      
      if ((products || []).length === 0) {
        state.allLoaded = [];
        lowStockProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('low-stock');
        renderLowStockProducts();
        return;
      }
      
      // Optimización: procesar primero batch pequeño para mostrar resultados rápido
      const initialBatch = (products || []).slice(0, INITIAL_BATCH_SIZE);
      console.log(`🔄 Agrupando primeros ${initialBatch.length} productos con poco stock por color (carga rápida)...`);
      
      const initialGrouped = await groupProductsByColorLowStock(initialBatch, 4);
      state.allLoaded = initialGrouped;
      state.offset = 0;
      state.hasMore = (products || []).length > INITIAL_BATCH_SIZE;
      
      // Mostrar primeros resultados inmediatamente
      const firstBatch = initialGrouped.slice(0, state.limit);
      lowStockProducts = firstBatch;
      state.offset = state.limit;
      renderLowStockProducts();
      populateCategoryFilters(); // Actualizar filtros de categorías
      hideLoadingIndicator('low-stock');
      applyCurrentCategoryFilterToAllTabs();
      
      // Continuar procesando el resto en segundo plano
      if ((products || []).length > INITIAL_BATCH_SIZE) {
        console.log(`🔄 Continuando con el resto de productos en segundo plano...`);
        showLoadingIndicator('low-stock');
        const remainingProducts = (products || []).slice(INITIAL_BATCH_SIZE);
        groupProductsByColorLowStock(remainingProducts, 5).then(remainingGrouped => {
          state.allLoaded = [...initialGrouped, ...remainingGrouped];
          state.hasMore = state.allLoaded.length > state.offset;
          console.log(`✅ Todos los productos con poco stock agrupados: ${state.allLoaded.length}`);
          populateCategoryFilters();
          applyCurrentCategoryFilterToAllTabs();
          hideLoadingIndicator('low-stock');
        }).catch(err => {
          console.error("Error procesando productos restantes:", err);
          hideLoadingIndicator('low-stock');
        });
      } else {
        console.log(`✅ Productos con poco stock agrupados: ${state.allLoaded.length}`);
      }
    } else {
      // Cargar siguiente lote desde productos ya agrupados
      const start = state.offset;
      const end = start + state.limit;
      const batch = state.allLoaded.slice(start, end);
      
      if (batch.length > 0) {
        lowStockProducts = [...lowStockProducts, ...batch];
        state.offset = end;
        state.hasMore = end < state.allLoaded.length;
        applyFilters("lowStock", searchLowStock, categoryFilterLowStock, renderLowStockProducts);
      }
      hideLoadingIndicator('low-stock');
    }
  } catch (error) {
    console.error("❌ Error cargando productos con poco stock:", error);
    showMessage(`Error cargando productos con poco stock: ${error.message}`, "err");
    lowStockProducts = [];
    hideLoadingIndicator('low-stock');
    renderLowStockProducts();
  } finally {
    state.loading = false;
  }
}

// Agrupar productos por color pero solo con stock <= 10 (optimizado)
async function groupProductsByColorLowStock(products, batchSize = 10) {
  const grouped = [];
  let productsWithoutVariants = 0;
  let colorsWithoutLowStock = 0;
  
  // Procesar en lotes para mejor rendimiento
  for (let i = 0; i < products.length; i += batchSize) {
    const batch = products.slice(i, i + batchSize);
    
    // Procesar el lote en paralelo
    const batchPromises = batch.map(async (product) => {
      try {
        // Obtener todas las variantes del producto
        const { data: variants, error: variantsError } = await supabase
          .from("product_variants")
          .select("color")
          .eq("product_id", product.id)
          .eq("active", true);
        
        if (variantsError) {
          console.warn(`⚠️ Error obteniendo variantes para producto ${product.id}:`, variantsError);
          return [];
        }
        
        if (!variants || variants.length === 0) {
          productsWithoutVariants++;
          return [];
        }
        
        // Obtener colores únicos
        const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
        
        if (colors.length === 0) {
          productsWithoutVariants++;
          return [];
        }
        
        // Procesar colores en paralelo
        const colorPromises = colors.map(async (color) => {
          try {
            const colorData = await getProductColorDataLowStock(product.id, color);
            
            // Solo agregar si tiene talles disponibles con stock <= 10
            if (colorData && colorData.sizes.length > 0) {
              return {
                productId: product.id,
                productName: product.name,
                category: product.category,
                description: product.description || "",
                color,
                created_at: product.created_at,
                last_published_at: resolveColorPublishedAt(product.last_published_at, colorData),
                publication_status: product.publication_status || 'nuevo',
                stockInfo: colorData.stockInfo,
                ...colorData,
              };
            } else {
              colorsWithoutLowStock++;
              return null;
            }
          } catch (colorError) {
            console.warn(`⚠️ Error obteniendo datos de color ${color} para producto ${product.id}:`, colorError);
            return null;
          }
        });
        
        const colorResults = await Promise.all(colorPromises);
        return colorResults.filter(item => item !== null);
      } catch (productError) {
        console.warn(`⚠️ Error procesando producto ${product.id}:`, productError);
        return [];
      }
    });
    
    const batchResults = await Promise.all(batchPromises);
    const flatResults = batchResults.flat();
    grouped.push(...flatResults);
  }
  
  console.log(`📊 Resumen de agrupación (poco stock): ${grouped.length} productos-colores agrupados, ${productsWithoutVariants} productos sin variantes, ${colorsWithoutLowStock} colores sin stock bajo`);
  
  if (grouped.length === 0 && products.length > 0) {
    console.warn(`⚠️ ADVERTENCIA: Se encontraron ${products.length} productos con poco stock pero ninguno tiene stock por talle entre 1 y 10 en depósito general`);
  }
  
  return grouped;
}

// Obtener datos de producto+color pero solo con stock <= 10
async function getProductColorDataLowStock(productId, color) {
  // Obtener variantes del color específico (size/stock se resuelven aparte).
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("id, sku, price, last_published_at")
    .eq("product_id", productId)
    .eq("color", color)
    .eq("active", true);
  
  if (error || !variants || variants.length === 0) {
    return null;
  }
  
  const variantIds = variants.map(v => v.id);
  
  let variantSizes = await getPublicationVariantSizes(variantIds);
  variantSizes = variantSizes.filter(vs => {
    const stock = Number(vs.stock_qty || 0);
    return stock >= 1 && stock <= 10;
  });
  
  if (!variantSizes || variantSizes.length === 0) {
    return null;
  }
  
  // Filtrar solo variantes que tienen talles con stock <= 10
  const variantIdsWithLowStock = [...new Set(variantSizes.map(vs => vs.variant_id))];
  const availableVariants = variants.filter(v => variantIdsWithLowStock.includes(v.id));
  
  if (availableVariants.length === 0) {
    return null;
  }
  
  // Obtener talles únicos ordenados
  const sizes = normalizeUniqueSortedSizes(variantSizes.map(vs => vs.size));
  
  // Obtener información de stock por talle
  const stockInfo = variantSizes.map(vs => ({
    size: normalizeSize(vs.size),
    stock: vs.stock_qty || 0
  }));
  
  // Obtener imágenes de las variantes (url, public_id para optimización)
  const { data: images } = await supabase
    .from("variant_images")
    .select("url, public_id, secure_url, position")
    .in("variant_id", variantIds)
    .order("position");
  
  // Obtener URLs únicas (priorizar url o secure_url)
  const allImageUrls = (images || [])
    .map(img => img.url || img.secure_url)
    .filter(Boolean);
  
  const uniqueImageUrls = [...new Set(allImageUrls)];
  
  // Obtener precio
  const price = availableVariants.length > 0 && availableVariants[0].price 
    ? parseFloat(availableVariants[0].price) 
    : null;
  const colorLastPublishedAt = availableVariants
    .map(v => v.last_published_at)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] || null;
  
  return {
    variants: availableVariants.map(v => ({
      ...v,
      sizes: variantSizes
        .filter(vs => vs.variant_id === v.id)
        .map(vs => ({ size: normalizeSize(vs.size), stock: vs.stock_qty }))
    })),
    sizes,
    imageUrls: uniqueImageUrls,
    firstImage: uniqueImageUrls[0] || null,
    price,
    stockInfo, // Información de stock para mostrar
    last_published_at: colorLastPublishedAt,
  };
}

// Variable para cancelar búsquedas anteriores
let currentSearchAbortController = null;
let searchAllRequestSeq = 0;

function normalizeSearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function matchesProductSearch(item, normalizedQuery) {
  if (!normalizedQuery) return true;
  const productName = normalizeSearchText(item?.productName);
  const category = normalizeSearchText(item?.category);
  const color = normalizeSearchText(item?.color);
  return (
    productName.includes(normalizedQuery) ||
    category.includes(normalizedQuery) ||
    color.includes(normalizedQuery)
  );
}

function isSafeServerSearchQuery(value) {
  return /^[\p{L}\p{N}\s\-_]+$/u.test(String(value ?? "").trim());
}

// Búsqueda directa en la base de datos sin cargar todos los productos
async function searchAllProductsDirect(searchQuery, categoryValue) {
  const state = paginationState.all;
  
  // Cancelar búsqueda anterior si existe
  if (currentSearchAbortController) {
    currentSearchAbortController.abort();
  }
  currentSearchAbortController = new AbortController();

  const reqSeq = ++searchAllRequestSeq;
  const isLatest = () => reqSeq === searchAllRequestSeq;
  
  try {
    state.loading = true;
    if (isLatest()) showLoadingIndicator('all');
    
    // Construir consulta base - TODOS los productos sin importar estado
    let query = supabase
      .from("products")
      .select("id, name, category, description, created_at, last_published_at, publication_status, status")
      .order("created_at", { ascending: false });

    // Cancelar request HTTP si el usuario cambia la búsqueda mientras está en vuelo
    if (typeof query.abortSignal === "function") {
      query = query.abortSignal(currentSearchAbortController.signal);
    }
    
    // Aplicar filtro de categoría si existe
    if (categoryValue && categoryValue.trim()) {
      query = query.eq("category", categoryValue.trim());
    }
    
    // Aplicar filtro de búsqueda de texto si existe
    if (searchQuery && searchQuery.trim()) {
      const searchLower = searchQuery.trim();
      // Evitar errores del parser PostgREST con caracteres especiales.
      // Si la query no es segura, filtramos localmente después de agrupar.
      if (isSafeServerSearchQuery(searchLower)) {
        query = query.or(`name.ilike.%${searchLower}%,category.ilike.%${searchLower}%`);
      }
    }
    
    const { data: products, error } = await query;
    
    if (error) {
      // Si fue abort, no hacer nada (viene otra búsqueda)
      if (!isLatest()) return;
      console.error("❌ Error en búsqueda directa:", error);
      showMessage(`Error buscando productos: ${error.message}`, "err");
      state.loading = false;
      hideLoadingIndicator('all');
      renderAllProducts([]);
      return;
    }
    if (!isLatest()) return;
    
    console.log(`🔍 Productos encontrados en búsqueda directa: ${(products || []).length}`);
    
    if ((products || []).length === 0) {
      state.loading = false;
      if (isLatest()) hideLoadingIndicator('all');
      renderAllProducts([]);
      return;
    }
    
    // Procesar primero un batch pequeño para mostrar resultados rápidamente
    const initialBatch = (products || []).slice(0, INITIAL_BATCH_SIZE);
    console.log(`🔄 Agrupando primeros ${initialBatch.length} productos por color (carga rápida)...`);
    
    const initialGrouped = await groupProductsByColor(initialBatch, 4);
    if (!isLatest()) return;
    
    // Filtrar resultados por búsqueda de texto (por color también) en el batch inicial
    let filtered = initialGrouped;
    if (searchQuery && searchQuery.trim()) {
      const searchLower = normalizeSearchText(searchQuery);
      filtered = initialGrouped.filter(item => matchesProductSearch(item, searchLower));
    }
    
    // Guardar productos en el estado para que estén disponibles cuando se seleccionen
    state.allLoaded = initialGrouped; // Guardar todos los productos agrupados (sin filtrar)
    allProducts = filtered; // Guardar productos filtrados para mostrar
    
    // Mostrar primeros resultados inmediatamente
    state.loading = false;
    if (isLatest()) {
      hideLoadingIndicator('all');
      renderAllProducts(filtered);
    }
    
    // Continuar procesando el resto en segundo plano si hay más productos
    if ((products || []).length > INITIAL_BATCH_SIZE) {
      console.log(`🔄 Continuando con el resto de productos en segundo plano...`);
      if (isLatest()) showLoadingIndicator('all');
      const remainingProducts = (products || []).slice(INITIAL_BATCH_SIZE);
      groupProductsByColor(remainingProducts, 5).then(remainingGrouped => {
        if (!isLatest()) return;
        // Filtrar el resto también
        let remainingFiltered = remainingGrouped;
        if (searchQuery && searchQuery.trim()) {
          const searchLower = normalizeSearchText(searchQuery);
          remainingFiltered = remainingGrouped.filter(item => matchesProductSearch(item, searchLower));
        }
        // Combinar y guardar todos los resultados en el estado
        const allGrouped = [...initialGrouped, ...remainingGrouped];
        const allFiltered = [...filtered, ...remainingFiltered];
        state.allLoaded = allGrouped; // Guardar todos los productos agrupados (sin filtrar)
        allProducts = allFiltered; // Guardar productos filtrados para mostrar
        if (isLatest()) {
          renderAllProducts(allFiltered);
          hideLoadingIndicator('all');
        }
      }).catch(err => {
        if (!isLatest()) return;
        console.error("Error procesando productos restantes:", err);
        hideLoadingIndicator('all');
      });
    }
    
  } catch (error) {
    if (!isLatest()) return;
    console.error("❌ Error en búsqueda directa:", error);
    showMessage(`Error buscando productos: ${error.message}`, "err");
    state.loading = false;
    hideLoadingIndicator('all');
    renderAllProducts([]);
  } finally {
    // Solo el request más reciente debe “apagar” el loading
    if (isLatest()) {
      state.loading = false;
      hideLoadingIndicator('all');
    }
  }
}

// Cargar todos los productos (sin filtros)
async function loadAllProducts(reset = false) {
  const state = paginationState.all;
  
  if (state.loading) return;
  
  try {
    state.loading = true;
    showLoadingIndicator('all');
    
    // Si es reset, cargar todos los productos y agruparlos
    if (reset || state.allLoaded.length === 0) {
      // Cargar TODOS los productos sin importar el estado
      const { data: products, error } = await supabase
        .from("products")
        .select("id, name, category, description, created_at, last_published_at, publication_status, status")
        .order("created_at", { ascending: false });
      
      if (error) {
        console.error("❌ Error en consulta de todos los productos:", error);
        showMessage(`Error cargando todos los productos: ${error.message}`, "err");
        state.allLoaded = [];
        allProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('all');
        renderAllProducts();
        return;
      }
      
      console.log(`📦 Todos los productos encontrados: ${(products || []).length}`);
      
      if ((products || []).length === 0) {
        state.allLoaded = [];
        allProducts = [];
        state.hasMore = false;
        hideLoadingIndicator('all');
        renderAllProducts();
        return;
      }
      
      // Optimización: procesar primero batch pequeño para mostrar resultados rápido
      const initialBatch = (products || []).slice(0, INITIAL_BATCH_SIZE);
      console.log(`🔄 Agrupando primeros ${initialBatch.length} productos por color (carga rápida)...`);
      
      const initialGrouped = await groupProductsByColor(initialBatch, 4);
      state.allLoaded = initialGrouped;
      state.offset = 0;
      state.hasMore = (products || []).length > INITIAL_BATCH_SIZE;
      
      // Mostrar primeros resultados inmediatamente
      const firstBatch = initialGrouped.slice(0, state.limit);
      allProducts = firstBatch;
      state.offset = state.limit;
      
      // Aplicar filtros actuales inmediatamente para mostrar resultados de búsqueda
      const hasActiveSearch = searchAll?.value?.trim() || categoryFilterAll?.value;
      if (hasActiveSearch) {
        // Si hay búsqueda activa, filtrar y mostrar resultados inmediatamente
        const filtered = searchProducts(searchAll?.value?.trim() || "", initialGrouped, categoryFilterAll?.value || "");
        renderAllProducts(filtered);
      } else {
        // Si no hay búsqueda, mostrar primeros productos
        renderAllProducts();
      }
      
      populateCategoryFilters(); // Actualizar filtros de categorías
      hideLoadingIndicator('all');
      
      // Continuar procesando el resto en segundo plano
      if ((products || []).length > INITIAL_BATCH_SIZE) {
        console.log(`🔄 Continuando con el resto de productos en segundo plano...`);
        showLoadingIndicator('all');
        const remainingProducts = (products || []).slice(INITIAL_BATCH_SIZE);
        groupProductsByColor(remainingProducts, 5).then(remainingGrouped => {
          state.allLoaded = [...initialGrouped, ...remainingGrouped];
          state.hasMore = state.allLoaded.length > state.offset;
          console.log(`✅ Todos los productos agrupados: ${state.allLoaded.length}`);
          populateCategoryFilters();
          // Aplicar filtros actuales después de cargar el resto para actualizar resultados
          const hasSearch = searchAll?.value?.trim() || categoryFilterAll?.value;
          if (hasSearch) {
            applyFilters("all", searchAll, categoryFilterAll, renderAllProducts);
          }
          hideLoadingIndicator('all');
        }).catch(err => {
          console.error("Error procesando productos restantes:", err);
          hideLoadingIndicator('all');
        });
      } else {
        console.log(`✅ Todos los productos agrupados: ${state.allLoaded.length}`);
      }
    } else {
      // Cargar siguiente lote desde productos ya agrupados
      const start = state.offset;
      const end = start + state.limit;
      const batch = state.allLoaded.slice(start, end);
      
      if (batch.length > 0) {
        allProducts = [...allProducts, ...batch];
        state.offset = end;
        state.hasMore = end < state.allLoaded.length;
        applyFilters("all", searchAll, categoryFilterAll, renderAllProducts);
      }
      hideLoadingIndicator('all');
    }
  } catch (error) {
    console.error("❌ Error cargando todos los productos:", error);
    showMessage(`Error cargando todos los productos: ${error.message}`, "err");
    allProducts = [];
    hideLoadingIndicator('all');
    renderAllProducts();
  } finally {
    state.loading = false;
  }
}

// Renderizar productos nuevos
function renderNewProducts(filtered = null) {
  // Verificar que el contenedor existe - obtenerlo dinámicamente por si acaso
  const container = document.getElementById("new-products-container");
  if (!container) {
    console.warn("⚠️ Contenedor new-products-container no encontrado");
    return;
  }
  
  const products = filtered || newProducts;
  
  // Si hay filtro, reemplazar todo
  if (filtered !== null) {
    if (products.length === 0) {
      container.innerHTML = '<div class="empty-state">No hay productos nuevos para mostrar<br><small style="color:#999;margin-top:8px;display:block;">Los productos deben tener variantes activas con stock disponible</small></div>';
      return;
    }
    container.innerHTML = products.map(item => createProductCard(item)).join('');
    return;
  }
  
  // Sin filtro: paginación - reemplazar todo si es reset, o agregar si es scroll
  if (products.length === 0 && !paginationState.new.loading) {
    container.innerHTML = '<div class="empty-state">No hay productos nuevos para mostrar<br><small style="color:#999;margin-top:8px;display:block;">Los productos deben tener variantes activas con stock disponible</small></div>';
    return;
  }
  
  // Reemplazar todo el contenido (para mantener sincronización con el estado)
  container.innerHTML = products.map(item => createProductCard(item)).join('');
}

// Función auxiliar para crear una tarjeta de producto
function createProductCard(item) {
  const isSelected = selectedForPublication.some(
    s => s.productId === item.productId && s.color === item.color
  );
  const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
  const colorEscaped = String(item.color).replace(/'/g, "&#39;");
  const imgSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 400) : "";
  const imageUrlEscaped = imgSrc ? String(imgSrc).replace(/"/g, "&quot;") : "";
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
      ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" loading="lazy" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
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
}

// Renderizar productos recomendados
function renderRecommendedProducts(filtered = null) {
  // Verificar que el contenedor existe - obtenerlo dinámicamente por si acaso
  const container = document.getElementById("recommended-products-container");
  if (!container) {
    console.warn("⚠️ Contenedor recommended-products-container no encontrado");
    return;
  }
  
  const products = filtered || recommendedProducts;
  
  if (products.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay productos recomendados para mostrar</div>';
    return;
  }
  
  container.innerHTML = products.map(item => {
    const isSelected = selectedForPublication.some(
      s => s.productId === item.productId && s.color === item.color
    );
    const days = daysSincePublished(item.last_published_at);
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imgSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 400) : "";
    const imageUrlEscaped = imgSrc ? String(imgSrc).replace(/"/g, "&quot;") : "";
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
        ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" loading="lazy" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
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
  // Verificar que el contenedor existe - obtenerlo dinámicamente por si acaso
  const container = document.getElementById("all-products-container");
  if (!container) {
    console.warn("⚠️ Contenedor all-products-container no encontrado");
    return;
  }
  
  const hasSearch = searchAll?.value?.trim() || categoryFilterAll?.value;
  
  // Si no hay búsqueda activa, siempre mostrar mensaje de búsqueda
  if (!hasSearch) {
    container.innerHTML = '<div class="empty-state" style="text-align: center; padding: 40px; color: #6c757d;"><p style="font-size: 18px; margin-bottom: 12px;">🔍 Buscá productos para ver resultados</p><p style="font-size: 14px;">Usá el campo de búsqueda o seleccioná una categoría para comenzar</p></div>';
    return;
  }
  
  // Si hay búsqueda activa, usar productos filtrados o todos los productos
  const products = filtered !== null ? filtered : allProducts;
  
  if (products.length === 0) {
    container.innerHTML = '<div class="empty-state">No se encontraron productos que coincidan con tu búsqueda</div>';
    return;
  }
  
  container.innerHTML = products.map(item => {
    const isSelected = selectedForPublication.some(
      s => s.productId === item.productId && s.color === item.color
    );
    const days = item.last_published_at ? daysSincePublished(item.last_published_at) : null;
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imgSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 400) : "";
    const imageUrlEscaped = imgSrc ? String(imgSrc).replace(/"/g, "&quot;") : "";
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
        ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" loading="lazy" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
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

// Renderizar productos con poco stock
function renderLowStockProducts(filtered = null) {
  // Verificar que el contenedor existe - obtenerlo dinámicamente por si acaso
  const container = document.getElementById("low-stock-products-container");
  if (!container) {
    console.warn("⚠️ Contenedor low-stock-products-container no encontrado");
    return;
  }
  
  const products = filtered || lowStockProducts;
  
  if (products.length === 0) {
    container.innerHTML = '<div class="empty-state">No hay productos con poco stock para mostrar<br><small style="color:#999;margin-top:8px;display:block;">Los productos deben tener variantes activas con stock <= 10</small></div>';
    return;
  }
  
  container.innerHTML = products.map(item => {
    const isSelected = selectedForPublication.some(
      s => s.productId === item.productId && s.color === item.color
    );
    const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
    const colorEscaped = String(item.color).replace(/'/g, "&#39;");
    const imgSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 400) : "";
    const imageUrlEscaped = imgSrc ? String(imgSrc).replace(/"/g, "&quot;") : "";
    const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
    const numericPrice = getNumericPrice(item.price);
    const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : null;
    const editPriceArg = numericPrice !== null ? numericPrice : "null";
    
    // Formatear información de stock
    const stockInfoText = item.stockInfo && item.stockInfo.length > 0
      ? item.stockInfo.map(si => `${si.size}: ${si.stock}`).join(", ")
      : "N/A";
    
    return `
      <div class="product-color-card ${isSelected ? 'selected' : ''}" data-product-id="${productIdEscaped}" data-color="${colorEscaped}">
        <div class="checkbox-wrapper">
          <input type="checkbox" ${isSelected ? 'checked' : ''} 
                 onchange="togglePublication('${productIdEscaped}', '${colorEscaped}')" />
        </div>
        ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" loading="lazy" onerror="this.style.display='none'">` : '<div class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
        <div class="product-info">
          <span class="product-color-badge">${colorEscaped}</span>
          <h3>${productNameEscaped}</h3>
          <p><strong>Categoría:</strong> ${item.category || 'N/A'}</p>
          ${formattedPrice ? `<p><strong>Precio:</strong> ${formattedPrice}</p>` : '<p><strong>Precio:</strong> N/A</p>'}
          <div class="sizes-info">Talles: ${formatSizes(item.sizes)}</div>
          <div class="sizes-info" style="background:#fff3cd;color:#856404;margin-top:8px;">
            <strong>⚠️ Stock:</strong> ${stockInfoText}
          </div>
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

// Renderizar tabla de publicación
async function renderPublicationTable(filtered = null) {
  const items = filtered || selectedForPublication;
  const publicationQuery = normalizeSearchText(searchPublication?.value || "");
  
  if (items.length === 0) {
    if (publicationTableBody) publicationTableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No hay productos seleccionados para publicar</td></tr>';
    if (selectedCount) selectedCount.textContent = "0";
    if (publishBtn) publishBtn.disabled = true;
    if (copyToSheetBtn) copyToSheetBtn.disabled = true;
    return;
  }
  
  const allProductsList = getFullProductsList();
  const tableData = items.map(({ productId, color }) => {
    // Intentar encontrar el producto con diferentes formatos de ID
    let item = allProductsList.find(p => {
      const pId = String(p.productId);
      const pColor = String(p.color || "");
      const sId = String(productId);
      const sColor = String(color || "");
      return pId === sId && pColor === sColor;
    });
    
    if (!item) {
      console.warn(`⚠️ Producto ${productId} color ${color} no encontrado en cache`);
      console.warn(`   Total productos en cache: ${allProductsList.length}`);
      console.warn(`   IDs disponibles: ${allProductsList.slice(0, 5).map(p => `${p.productId}-${p.color}`).join(", ")}...`);
      // Intentar cargar el producto desde la base de datos si no está en cache
      return { productId, color, _needsLoad: true };
    }
    return item;
  });
  
  // Filtrar items válidos y cargar los que faltan desde la base de datos
  const validItems = [];
  const itemsToLoad = [];
  
  for (const item of tableData) {
    if (!item) continue;
    if (item._needsLoad) {
      itemsToLoad.push({ productId: item.productId, color: item.color });
    } else {
      validItems.push(item);
    }
  }
  
  // Cargar productos faltantes desde la base de datos
  if (itemsToLoad.length > 0) {
    const loadPromises = itemsToLoad.map(async ({ productId, color }) => {
      try {
        const colorData = await getProductColorData(productId, color);
        if (colorData) {
          // Obtener datos del producto
          const { data: product, error } = await supabase
            .from("products")
            .select("id, name, category, description, created_at, last_published_at, publication_status")
            .eq("id", productId)
            .single();
          
          if (error || !product) {
            console.warn(`⚠️ Error cargando producto ${productId}:`, error);
            return null;
          }
          
          return {
            productId: product.id,
            productName: product.name,
            category: product.category,
            description: product.description || "",
            color,
            created_at: product.created_at,
            last_published_at: resolveColorPublishedAt(product.last_published_at, colorData),
            publication_status: product.publication_status || 'nuevo',
            ...colorData,
          };
        }
      } catch (err) {
        console.warn(`⚠️ Error cargando producto ${productId} color ${color}:`, err);
      }
      return null;
    });
    
    const loadedItems = await Promise.all(loadPromises);
    validItems.push(...loadedItems.filter(Boolean));
  }
  
  const itemsToRender = publicationQuery
    ? validItems.filter(item => matchesProductSearch(item, publicationQuery))
    : validItems;

  if (publicationTableBody) {
    if (itemsToRender.length === 0) {
      publicationTableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No hay resultados para esa búsqueda en la tabla de publicación</td></tr>';
    } else {
      publicationTableBody.innerHTML = itemsToRender.map(item => {
      const imageUrlsText = item.imageUrls.join(" | ");
      const productIdEscaped = String(item.productId).replace(/'/g, "&#39;");
      const colorEscaped = String(item.color).replace(/'/g, "&#39;");
      const thumbSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 120) : "";
      const imageUrlEscaped = thumbSrc ? String(thumbSrc).replace(/"/g, "&quot;") : "";
      const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
      const categoryEscaped = String(item.category || 'N/A').replace(/"/g, "&quot;");
      const numericPrice = getNumericPrice(item.price);
      const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : "N/A";
      const editPriceArg = numericPrice !== null ? numericPrice : "null";
      
      return `
        <tr>
          <td>
            ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" loading="lazy" onerror="this.style.display='none'">` : '<span style="color:#999;">Sin imagen</span>'}
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
    }
  }
  
  if (selectedCount) selectedCount.textContent = validItems.length;
  if (publicationCount) publicationCount.textContent = validItems.length;
  if (publishBtn) publishBtn.disabled = validItems.length === 0;
  if (copyToSheetBtn) copyToSheetBtn.disabled = validItems.length === 0;
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
  
  // Actualizar UI respetando el filtro de categoría actual
  refreshAllTabsRespectingFilter();
  
  // Renderizar tabla de publicación (async, no bloquear)
  renderPublicationTable().catch(err => {
    console.error("Error renderizando tabla de publicación:", err);
  });
  
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
    refreshAllTabsRespectingFilter();
    
    // Renderizar tabla de publicación (async, no bloquear)
    renderPublicationTable().catch(err => {
      console.error("Error renderizando tabla de publicación:", err);
    });
    
    saveToLocalStorage();
  }
};

// Copiar talles al portapapeles
window.copySizes = async function(productId, color) {
  const allProductsList = getFullProductsList();
  const item = allProductsList.find(p => p.productId === productId && p.color === color);
  
  if (item && item.sizes.length > 0) {
    const sizesText = formatSizes(item.sizes);
    await navigator.clipboard.writeText(sizesText);
    showMessage(`✅ Talles copiados: ${sizesText}`, "ok");
  }
};

// Copiar URLs de imágenes al portapapeles
window.copyImageUrls = async function(productId, color) {
  const allProductsList = getFullProductsList();
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
  await loadLowStockProducts();
  await loadAllProducts();
  populateCategoryFilters(); // Actualizar filtros de categorías después de cargar productos
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
// Si hay varios colores del mismo producto, se agrupan en una fila: colores unidos, talles combinados sin repetir, URLs1=primer color, URLs2=segundo color, etc.
async function copyToSheet() {
  if (selectedForPublication.length === 0) {
    showMessage("No hay productos seleccionados para copiar", "err");
    return;
  }
  
  try {
    if (copyToSheetBtn) {
      copyToSheetBtn.disabled = true;
      copyToSheetBtn.innerHTML = '<span>⏳</span><span>Copiando...</span>';
    }
    
    const allProductsList = getFullProductsList();
    // Resolver cada selección a su item completo, manteniendo el orden de selección
    const orderedItems = [];
    const itemsToLoad = [];
    
    // Primero intentar encontrar productos en cache
    for (const { productId, color } of selectedForPublication) {
      const found = allProductsList.find(p => p.productId === productId && p.color === color);
      if (found) {
        orderedItems.push(found);
      } else {
        // Si no está en cache, agregarlo a la lista para cargar desde la base de datos
        itemsToLoad.push({ productId, color });
      }
    }
    
    // Cargar productos faltantes desde la base de datos (incluyendo productos sin tags)
    if (itemsToLoad.length > 0) {
      const loadPromises = itemsToLoad.map(async ({ productId, color }) => {
        try {
          const colorData = await getProductColorData(productId, color);
          // Obtener datos del producto incluso si no tiene tags
          const { data: product, error } = await supabase
            .from("products")
            .select("id, name, category, description, created_at, last_published_at, publication_status")
            .eq("id", productId)
            .single();
          
          if (error || !product) {
            console.warn(`⚠️ Error cargando producto ${productId}:`, error);
            return null;
          }
          
          // Si no hay colorData (sin variantes/talles), crear un objeto básico para que se copie igual
          if (!colorData) {
            return {
              productId: product.id,
              productName: product.name,
              category: product.category,
              description: product.description || "",
              color,
              created_at: product.created_at,
              last_published_at: product.last_published_at,
              publication_status: product.publication_status || 'nuevo',
              sizes: [],
              imageUrls: [],
              firstImage: null,
              price: null,
            };
          }
          
          return {
            productId: product.id,
            productName: product.name,
            category: product.category,
            description: product.description || "",
            color,
            created_at: product.created_at,
            last_published_at: resolveColorPublishedAt(product.last_published_at, colorData),
            publication_status: product.publication_status || 'nuevo',
            ...colorData,
          };
        } catch (err) {
          console.warn(`⚠️ Error cargando producto ${productId} color ${color}:`, err);
          return null;
        }
      });
      
      const loadedItems = await Promise.all(loadPromises);
      // Agregar productos cargados, incluso si no tienen tags o variantes
      orderedItems.push(...loadedItems.filter(Boolean));
    }
    
    if (orderedItems.length === 0) {
      showMessage("No se pudieron cargar los datos de los productos seleccionados", "err");
      return;
    }
    
    // Agrupar por productId manteniendo orden de selección dentro de cada producto
    // productId -> [ item1, item2, ... ] en el orden en que fueron seleccionados
    const byProduct = new Map();
    for (const item of orderedItems) {
      const id = item.productId;
      if (!byProduct.has(id)) {
        byProduct.set(id, []);
      }
      const list = byProduct.get(id);
      if (!list.some(entry => entry.color === item.color)) {
        list.push(item);
      }
    }
    
    const headers = ["Facebook", "Instagram", "Oferta", "Producto", "Color", "Talles Disponibles", "Precio", "Descripción"];
    for (let i = 1; i <= 12; i++) {
      headers.push(`URLs ${i}`);
    }
    
    // Obtener ofertas activas (product_id + color) para los productos seleccionados
    const today = new Date().toISOString().slice(0, 10);
    const productColorPairs = [...byProduct].flatMap(([, its]) => its.map(i => ({ product_id: i.productId, color: i.color })));
    const inOfferSet = new Set();
    if (productColorPairs.length > 0) {
      const { data: offers } = await supabase
        .from("color_price_offers")
        .select("product_id, color")
        .in("product_id", [...new Set(productColorPairs.map(p => p.product_id))])
        .eq("status", "active")
        .lte("start_date", today)
        .gte("end_date", today);
      if (offers && offers.length > 0) {
        offers.forEach(o => inOfferSet.add(`${o.product_id}|${(o.color || "").trim()}`));
      }
    }
    
    const rows = [];
    for (const [, items] of byProduct) {
      const first = items[0];
      const isNew = first.publication_status === 'nuevo' || !first.last_published_at;
      const instagramValue = isNew ? "si" : "no";
      const numericPrice = getNumericPrice(first.price);
      const priceValue = numericPrice !== null ? formatCurrency(numericPrice) : "";
      
      // ¿Algún color de este producto está en oferta?
      const hasOffer = items.some(i => inOfferSet.has(`${i.productId}|${(i.color || "").trim()}`));
      const facebookValue = hasOffer ? "no" : "si";
      const ofertaValue = hasOffer ? "si" : "no";
      
      // Colores en orden de selección: "Rojo, Negro"
      const colorsCell = items.map(i => i.color || "").filter(Boolean).join(", ");
      
      // Talles: unión sin repetir, ordenados (ej: rojo 2,3,4 y negro 3,4 -> 2,3,4)
      const allSizes = new Set();
      items.forEach(i => {
        (i.sizes || []).forEach(s => allSizes.add(String(s)));
      });
      const sizesSorted = normalizeUniqueSortedSizes([...allSizes]);
      const tallesCell = formatSizes(sizesSorted);
      
      const descriptionCell = (first.description || "").trim();
      const row = [
        facebookValue,
        instagramValue,
        ofertaValue,
        first.productName || "",
        colorsCell,
        tallesCell,
        priceValue,
        descriptionCell
      ];
      
      // URLs: recopilar TODAS las URLs de imágenes de todos los colores (no solo la principal)
      const allUrls = [];
      for (const item of items) {
        if (item && item.imageUrls && Array.isArray(item.imageUrls)) {
          for (const url of item.imageUrls) {
            if (url && !allUrls.includes(url)) allUrls.push(url);
          }
        }
      }
      for (let i = 0; i < 12; i++) {
        row.push(allUrls[i] || "");
      }
      
      rows.push(row);
    }
    
    const allRows = [headers, ...rows];
    const tsvContent = allRows
      .map(row => row.map(cell => {
        return String(cell).replace(/\t/g, " ").replace(/\n/g, " ").replace(/\r/g, "");
      }).join("\t"))
      .join("\n");
    
    await navigator.clipboard.writeText(tsvContent);
    
    const totalRows = rows.length;
    showMessage(`✅ ${totalRows} fila(s) copiada(s) para Sheet (productos agrupados por color). Pegá en Google Sheets.`, "ok");
    
  } catch (error) {
    console.error("Error copiando a Sheet:", error);
    showMessage(`❌ Error al copiar: ${error.message}`, "err");
  } finally {
    if (copyToSheetBtn) {
      copyToSheetBtn.disabled = false;
      copyToSheetBtn.innerHTML = '<span>📋</span><span>Copiar para Sheet</span>';
    }
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
  const selectedColorKeys = new Set(selectedForPublication.map(s => `${s.productId}|${s.color}`));
  
  try {
    if (publishBtn) {
      publishBtn.disabled = true;
      publishBtn.innerHTML = '<span>⏳</span><span>Publicando...</span>';
    }
    
    const nowIso = new Date().toISOString();

    // Actualizar variantes por color seleccionado para mantener fecha por variante/color
    const updateVariantPromises = selectedForPublication.map(({ productId, color }) =>
      supabase
        .from("product_variants")
        .update({ last_published_at: nowIso })
        .eq("product_id", productId)
        .eq("color", color)
        .eq("active", true)
    );
    const variantResults = await Promise.all(updateVariantPromises);
    const variantError = variantResults.find(result => result.error)?.error;
    if (variantError) throw variantError;

    // Actualizar productos para mantener compatibilidad con filtros actuales
    const { error } = await supabase
      .from("products")
      .update({
        last_published_at: nowIso,
        publication_status: 'ya_publicado'
      })
      .in("id", uniqueProductIds);
    
    if (error) throw error;
    
    showMessage(`✅ ${selectedForPublication.length} variante(s)/color(es) publicado(s) exitosamente`, "ok");
    
    // Actualizar datos en memoria (remover solo colores publicados de la lista "nuevos")
    newProducts = newProducts.filter(item => !selectedColorKeys.has(`${item.productId}|${item.color}`));
    
    // Limpiar selección
    selectedForPublication = [];
    saveToLocalStorage();
    
    // Actualizar UI inmediatamente respetando filtro actual
    refreshAllTabsRespectingFilter();
    renderPublicationTable();
    
    // Recargar datos en segundo plano (sin esperar)
    // Esto permite que la UI responda inmediatamente
    Promise.all([
      loadNewProducts(true).catch(err => console.warn("Error recargando productos nuevos:", err)),
      loadRecommendedProducts(true).catch(err => console.warn("Error recargando productos recomendados:", err)),
      loadLowStockProducts(true).catch(err => console.warn("Error recargando productos con poco stock:", err)),
      loadAllProducts(true).catch(err => console.warn("Error recargando todos los productos:", err))
    ]).then(() => {
      console.log("✅ Recarga de datos completada en segundo plano");
    });
    
  } catch (error) {
    console.error("Error al publicar:", error);
    showMessage(`❌ Error al publicar: ${error.message}`, "err");
  } finally {
    if (publishBtn) {
      publishBtn.disabled = false;
      publishBtn.innerHTML = '<span>📤</span><span>Publicar Seleccionados</span>';
    }
  }
}

// Limpiar todo
if (clearAllBtn) {
  clearAllBtn.addEventListener("click", () => {
    if (selectedForPublication.length === 0) return;
    
    if (confirm("¿Estás seguro de quitar todos los productos de la publicación?")) {
      selectedForPublication = [];
      saveToLocalStorage();
      refreshAllTabsRespectingFilter();
      renderPublicationTable();
    }
  });
}

// Buscador
function searchProducts(query, products, categoryFilter = "") {
  let filtered = products;
  
  // Filtrar por categoría si está seleccionada (normalizar espacios para coincidencia)
  if (categoryFilter && categoryFilter.trim() !== "") {
    const cat = categoryFilter.trim();
    filtered = filtered.filter(item => (item.category || "").trim() === cat);
  }
  
  // Filtrar por texto de búsqueda si hay
  if (query && query.trim()) {
    const lowerQuery = normalizeSearchText(query);
    filtered = filtered.filter(item => matchesProductSearch(item, lowerQuery));
  }
  
  return filtered;
}

// Obtener categorías únicas de los productos cargados
function getAvailableCategories(productsList) {
  const categories = new Set();
  productsList.forEach(item => {
    if (item.category) {
      categories.add(item.category);
    }
  });
  return Array.from(categories).sort();
}

// Poblar los selects de categorías (usa allLoaded cuando existe para incluir todas las categorías)
function populateCategoryFilters() {
  const fromNew = paginationState.new.allLoaded.length > 0 ? paginationState.new.allLoaded : newProducts;
  const fromRecommended = paginationState.recommended.allLoaded.length > 0 ? paginationState.recommended.allLoaded : recommendedProducts;
  const fromLowStock = paginationState.lowStock.allLoaded.length > 0 ? paginationState.lowStock.allLoaded : lowStockProducts;
  const fromAll = paginationState.all.allLoaded.length > 0 ? paginationState.all.allLoaded : allProducts;
  const allProductsList = [...fromNew, ...fromRecommended, ...fromLowStock, ...fromAll];
  const categories = getAvailableCategories(allProductsList);
  
  const filters = [categoryFilterNew, categoryFilterRecommended, categoryFilterLowStock, categoryFilterAll];
  
  filters.forEach(select => {
    if (!select) return;
    
    // Guardar el valor actual
    const currentValue = select.value;
    
    // Limpiar opciones excepto la primera (Todas las categorías)
    while (select.options.length > 1) {
      select.remove(1);
    }
    
    // Agregar categorías
    categories.forEach(category => {
      const option = document.createElement("option");
      option.value = category;
      option.textContent = category;
      select.appendChild(option);
    });
    
    // Restaurar el valor si existe
    if (currentValue && Array.from(select.options).some(opt => opt.value === currentValue)) {
      select.value = currentValue;
    }
  });
}

// Función para aplicar filtros (texto + categoría)
function applyFilters(tabName, searchInput, categorySelect, renderFunction) {
  const searchQuery = searchInput ? searchInput.value.trim() : "";
  const categoryValue = categorySelect ? categorySelect.value : "";
  
  // Para la pestaña "Todo", solo cargar si hay búsqueda activa
  if (tabName === "all") {
    const hasActiveSearch = searchQuery || categoryValue;
    
    if (!hasActiveSearch) {
      // Sin búsqueda activa: mostrar mensaje y no cargar productos
      renderAllProducts([]);
      return;
    }
    
    // Hay búsqueda activa: buscar directamente en la base de datos
    // Esto es más eficiente que cargar todos los productos primero
    runPublicationsTask("filters:all_search", async () => {
      if (!(await ensurePublicationsAuth())) return;
      await searchAllProductsDirect(searchQuery, categoryValue);
    });
    return;
  }
  
  // Usar el array completo desde paginationState, no el array paginado
  let productsArray = [];
  if (tabName === "new") {
    productsArray = paginationState.new.allLoaded.length > 0 ? paginationState.new.allLoaded : newProducts;
  } else if (tabName === "recommended") {
    productsArray = paginationState.recommended.allLoaded.length > 0 ? paginationState.recommended.allLoaded : recommendedProducts;
  } else if (tabName === "lowStock") {
    productsArray = paginationState.lowStock.allLoaded.length > 0 ? paginationState.lowStock.allLoaded : lowStockProducts;
  } else if (tabName === "all") {
    productsArray = paginationState.all.allLoaded.length > 0 ? paginationState.all.allLoaded : allProducts;
  }
  
  const filtered = searchProducts(searchQuery, productsArray, categoryValue);
  renderFunction(filtered);
}

// Sincronizar filtro de categoría en todas las pestañas y aplicar filtros globalmente
function syncCategoryFilterAndApplyAll(selectedValue) {
  const filters = [categoryFilterNew, categoryFilterRecommended, categoryFilterLowStock, categoryFilterAll];
  
  filters.forEach(select => {
    if (!select) return;
    select.value = selectedValue || "";
  });
  
  // Aplicar filtros en todas las pestañas con el valor de categoría seleccionado
  applyFilters("new", searchNew, categoryFilterNew, renderNewProducts);
  applyFilters("recommended", searchRecommended, categoryFilterRecommended, renderRecommendedProducts);
  applyFilters("lowStock", searchLowStock, categoryFilterLowStock, renderLowStockProducts);
  applyFilters("all", searchAll, categoryFilterAll, renderAllProducts);
}

// Aplicar el filtro de categoría actual a todas las pestañas (usado tras cargar datos)
function applyCurrentCategoryFilterToAllTabs() {
  const currentValue = categoryFilterNew?.value || categoryFilterRecommended?.value || categoryFilterLowStock?.value || categoryFilterAll?.value || "";
  if (currentValue) {
    syncCategoryFilterAndApplyAll(currentValue);
  }
}

// Re-renderizar todas las pestañas respetando el filtro de categoría actual (usado al seleccionar/deseleccionar productos)
function refreshAllTabsRespectingFilter() {
  const currentValue = categoryFilterNew?.value || categoryFilterRecommended?.value || categoryFilterLowStock?.value || categoryFilterAll?.value || "";
  syncCategoryFilterAndApplyAll(currentValue);
}

// Lista completa de productos cargados (allLoaded cuando exista) para que la pestaña Publicación y Copiar encuentren todos los seleccionados
function getFullProductsList() {
  const fromNew = paginationState.new.allLoaded.length > 0 ? paginationState.new.allLoaded : newProducts;
  const fromRecommended = paginationState.recommended.allLoaded.length > 0 ? paginationState.recommended.allLoaded : recommendedProducts;
  const fromLowStock = paginationState.lowStock.allLoaded.length > 0 ? paginationState.lowStock.allLoaded : lowStockProducts;
  const fromAll = paginationState.all.allLoaded.length > 0 ? paginationState.all.allLoaded : allProducts;
  return [...fromNew, ...fromRecommended, ...fromLowStock, ...fromAll];
}

// Event listeners para búsqueda de texto
if (searchNew) {
  searchNew.addEventListener("input", () => {
    applyFilters("new", searchNew, categoryFilterNew, renderNewProducts);
  });
}

if (searchRecommended) {
  searchRecommended.addEventListener("input", () => {
    applyFilters("recommended", searchRecommended, categoryFilterRecommended, renderRecommendedProducts);
  });
}

if (searchLowStock) {
  searchLowStock.addEventListener("input", () => {
    applyFilters("lowStock", searchLowStock, categoryFilterLowStock, renderLowStockProducts);
  });
}

// Debounce para búsqueda en "Todo" - esperar 300ms después de que el usuario deje de escribir
let searchAllTimeout = null;
if (searchAll) {
  searchAll.addEventListener("input", () => {
    // Cancelar timeout anterior
    if (searchAllTimeout) {
      clearTimeout(searchAllTimeout);
    }
    // Esperar 300ms antes de buscar
    searchAllTimeout = setTimeout(() => {
      applyFilters("all", searchAll, categoryFilterAll, renderAllProducts);
    }, 300);
  });
}

// Event listeners para filtro de categorías (sincronizado en todas las pestañas)
if (categoryFilterNew) {
  categoryFilterNew.addEventListener("change", () => {
    syncCategoryFilterAndApplyAll(categoryFilterNew.value);
  });
}

if (categoryFilterRecommended) {
  categoryFilterRecommended.addEventListener("change", () => {
    syncCategoryFilterAndApplyAll(categoryFilterRecommended.value);
  });
}

if (categoryFilterLowStock) {
  categoryFilterLowStock.addEventListener("change", () => {
    syncCategoryFilterAndApplyAll(categoryFilterLowStock.value);
  });
}

if (categoryFilterAll) {
  categoryFilterAll.addEventListener("change", () => {
    syncCategoryFilterAndApplyAll(categoryFilterAll.value);
  });
}

if (searchPublication) {
  searchPublication.addEventListener("input", (e) => {
    // Filtrar en la tabla de publicación
    renderPublicationTable();
  });
}

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

// Programados: cargar y guardar
function loadScheduledFromLocalStorage() {
  const saved = localStorage.getItem("publication_scheduled");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      DIAS.forEach(d => {
        if (Array.isArray(parsed[d])) scheduledByDay[d] = parsed[d];
      });
    } catch (e) {
      console.warn("Error cargando programados:", e);
    }
  }
}

function saveScheduledToLocalStorage() {
  localStorage.setItem("publication_scheduled", JSON.stringify(scheduledByDay));
}

// Modal Guardar: mostrar y guardar en día seleccionado
function openGuardarModal() {
  if (selectedForPublication.length === 0) {
    showMessage("No hay productos seleccionados para guardar", "err");
    return;
  }
  const modal = document.getElementById("modal-guardar");
  if (modal) modal.style.display = "flex";
}

function closeGuardarModal() {
  const modal = document.getElementById("modal-guardar");
  if (modal) modal.style.display = "none";
}

function guardarEnDia(dia) {
  const list = scheduledByDay[dia] || [];
  const toAdd = selectedForPublication.filter(s => !list.some(l => l.productId === s.productId && l.color === s.color));
  scheduledByDay[dia] = [...list, ...toAdd];
  saveScheduledToLocalStorage();
  updateProgramadosButtonsState();
  closeGuardarModal();
  showMessage(`Guardados ${toAdd.length} producto(s) para ${dia.charAt(0).toUpperCase() + dia.slice(1)}`, "ok");
  
  // Limpiar la lista de seleccionados después de guardar
  selectedForPublication = [];
  saveToLocalStorage();
  refreshAllTabsRespectingFilter();
  renderPublicationTable();
}

// Actualizar estado visual de botones de días programados
function updateProgramadosButtonsState() {
  document.querySelectorAll(".modal-dia-btn.programados-dia").forEach(btn => {
    const dia = btn.dataset.dia;
    const hasContent = scheduledByDay[dia] && scheduledByDay[dia].length > 0;
    btn.classList.toggle("has-content", hasContent);
  });
}

// Modal Programados: mostrar y gestionar
function openProgramadosModal() {
  const modal = document.getElementById("modal-programados");
  if (modal) modal.style.display = "flex";
  programadosDiaActual = null;
  document.querySelectorAll(".modal-dia-btn.programados-dia").forEach(btn => btn.classList.remove("active"));
  updateProgramadosButtonsState();
  document.getElementById("programados-detalle").innerHTML = '<p style="color: #6c757d; margin: 0;">Seleccioná un día para ver los productos</p>';
  document.getElementById("btn-preparar").style.display = "none";
}

function closeProgramadosModal() {
  const modal = document.getElementById("modal-programados");
  if (modal) modal.style.display = "none";
}

function mostrarProgramadosDia(dia) {
  programadosDiaActual = dia;
  updateProgramadosButtonsState();
  document.querySelectorAll(".modal-dia-btn.programados-dia").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.dia === dia);
  });
  const list = scheduledByDay[dia] || [];
  const detalle = document.getElementById("programados-detalle");
  const prepararBtn = document.getElementById("btn-preparar");
  if (list.length === 0) {
    detalle.innerHTML = `<p style="color: #6c757d; margin: 0;">No hay productos guardados para ${dia.charAt(0).toUpperCase() + dia.slice(1)}</p>`;
    prepararBtn.style.display = "none";
    return;
  }
  const allProductsList = getFullProductsList();
  const items = list.map(({ productId, color }) => allProductsList.find(p => p.productId === productId && p.color === color)).filter(Boolean);
  detalle.innerHTML = items.map((item, idx) => {
    const img = item.firstImage ? cloudinaryOptimized(item.firstImage, 80) : "";
    const name = (item.productName || "").replace(/"/g, "&quot;");
    const col = (item.color || "").replace(/"/g, "&quot;");
    return `<div class="programados-item" data-dia="${dia}" data-idx="${idx}" style="display: flex; align-items: center; gap: 12px; padding: 8px; background: white; border-radius: 8px; margin-bottom: 8px; border: 1px solid #e9ecef;">
      ${img ? `<img src="${img.replace(/"/g, "&quot;")}" alt="" style="width: 48px; height: 48px; object-fit: cover; border-radius: 6px;" onerror="this.style.display='none'">` : ""}
      <span style="flex:1; font-weight: 600;">${name}</span>
      <span class="product-color-badge">${col}</span>
      <button type="button" class="btn-small btn-danger btn-quitar-programado" data-dia="${dia}" data-idx="${idx}" title="Quitar">✕</button>
    </div>`;
  }).join("");
  prepararBtn.style.display = "block";
  // Delegación de eventos para botones Quitar
  detalle.querySelectorAll(".btn-quitar-programado").forEach(btn => {
    btn.addEventListener("click", () => quitarDeProgramadosPorIndice(btn.dataset.dia, parseInt(btn.dataset.idx, 10)));
  });
}

function quitarDeProgramadosPorIndice(dia, idx) {
  const list = scheduledByDay[dia] || [];
  if (idx < 0 || idx >= list.length) return;
  const removed = list[idx];
  scheduledByDay[dia] = list.filter((_, i) => i !== idx);
  saveScheduledToLocalStorage();
  updateProgramadosButtonsState();
  mostrarProgramadosDia(dia);
  showMessage("Producto quitado de la lista", "ok");
}

function prepararProgramados() {
  if (!programadosDiaActual) return;
  const list = scheduledByDay[programadosDiaActual] || [];
  if (list.length === 0) {
    showMessage("No hay productos para preparar", "err");
    return;
  }
  // Agregar al final de selectedForPublication (sin duplicar)
  const existentes = new Set(selectedForPublication.map(s => `${s.productId}|${s.color}`));
  list.forEach(s => {
    const key = `${s.productId}|${s.color}`;
    if (!existentes.has(key)) {
      existentes.add(key);
      selectedForPublication.push(s);
    }
  });
  saveToLocalStorage();
  closeProgramadosModal();
  // Activar tab Publicación
  document.querySelector('.tab[data-tab="publication"]')?.click();
  refreshAllTabsRespectingFilter();
  renderPublicationTable();
  showMessage(`${list.length} producto(s) agregados a la tabla de publicación`, "ok");
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
if (publishBtn) {
  publishBtn.addEventListener("click", publishSelected);
}
if (copyToSheetBtn) {
  copyToSheetBtn.addEventListener("click", copyToSheet);
}

// Botón Guardar y modal
const btnGuardar = document.getElementById("btn-guardar");
if (btnGuardar) btnGuardar.addEventListener("click", openGuardarModal);
document.querySelectorAll("#modal-guardar .modal-dia-btn").forEach(btn => {
  btn.addEventListener("click", () => guardarEnDia(btn.dataset.dia));
});
document.querySelector("#modal-guardar .modal-cerrar")?.addEventListener("click", closeGuardarModal);

// Botón Programados y modal
const btnProgramados = document.getElementById("btn-programados");
if (btnProgramados) btnProgramados.addEventListener("click", openProgramadosModal);
document.querySelectorAll(".modal-dia-btn.programados-dia").forEach(btn => {
  btn.addEventListener("click", () => mostrarProgramadosDia(btn.dataset.dia));
});
document.getElementById("btn-preparar")?.addEventListener("click", prepararProgramados);
document.querySelector(".modal-cerrar-programados")?.addEventListener("click", closeProgramadosModal);

// Cerrar modales al hacer click fuera
document.getElementById("modal-guardar")?.addEventListener("click", (e) => {
  if (e.target.id === "modal-guardar") closeGuardarModal();
});
document.getElementById("modal-programados")?.addEventListener("click", (e) => {
  if (e.target.id === "modal-programados") closeProgramadosModal();
});

// Cargar datos iniciales
loadFromLocalStorage();
loadScheduledFromLocalStorage();
updateProgramadosButtonsState();

// Cargar productos nuevos con manejo de errores mejorado
if (supabase) {
  loadNewProducts().catch(error => {
    console.error("Error inicial cargando productos nuevos:", error);
    showMessage(`Error cargando productos: ${error.message}`, "err");
  });
} else {
  showMessage("Error: Cliente de Supabase no disponible", "err");
}

