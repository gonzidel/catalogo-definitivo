// scripts/size-filter.js - Filtro de talles con modal bottom sheet

import { supabase } from "./supabase-client.js";
import { normalizeSize } from "./utils/size-normalizer.js";

// Estado global
let currentCategory = null;
let selectedSizes = [];
let sizeFilterActive = false;
let tempCategoryForSizeFilter = null; // Para almacenar categoría seleccionada temporalmente
let combinedSizesMap = new Map(); // Mapa de talles combinados: "37/38" -> ["37", "38"]

// Obtener categoría actual
function getCurrentCategory() {
  // Intentar detectar desde la URL
  const urlParams = new URLSearchParams(window.location.search);
  const tabSlug = urlParams.get('tab');
  
  // Mapear slugs a categorías
  const slugToCategory = {
    'calzado': 'Calzado',
    'ropa': 'Ropa',
    'lenceria': 'Lenceria',
    'marroquineria': 'Marroquineria',
    'novedades': 'Novedades',
    'ofertas': 'Ofertas'
  };
  
  if (tabSlug && slugToCategory[tabSlug]) {
    return slugToCategory[tabSlug];
  }

  // Misma categoría que está mostrando el catálogo (Lencería/Marroquinería vía Otros+tags, etc.)
  const synced = typeof window.__fylCategoriaActual === 'string' ? window.__fylCategoriaActual.trim() : '';
  if (synced && synced !== 'all') {
    return synced;
  }
  
  // Detectar desde el botón activo de acciones rápidas
  const activeBtn = document.querySelector('.quick-action-btn.active');
  if (activeBtn) {
    const actionValue = activeBtn.dataset.actionValue;
    if (actionValue && actionValue !== 'all') {
      // Mapear valores comunes
      if (actionValue === 'Ofertas') return 'Ofertas';
      if (actionValue === 'Novedades') return 'Novedades';
      return actionValue;
    }
  }
  
  // Detectar desde el menú desktop activo (si existe)
  const activeMenuBtn = document.querySelector('.menu-desktop button.active, .menu button.active');
  if (activeMenuBtn && activeMenuBtn.textContent) {
    const text = activeMenuBtn.textContent.trim();
    if (text.includes('Calzado')) return 'Calzado';
    if (text.includes('Ropa')) return 'Ropa';
    if (text.includes('Lencería')) return 'Lenceria';
    if (text.includes('Accesorios')) return 'Marroquineria';
    if (text.includes('Novedades')) return 'Novedades';
    if (text.includes('Ofertas')) return 'Ofertas';
  }
  
  return currentCategory || null;
}

// Función helper para expandir talles combinados
function expandCombinedSizes(sizes) {
  const expanded = new Set();
  const combinedMap = new Map(); // Para tracking: "37/38" -> ["37", "38"]
  
  sizes.forEach(size => {
    if (size && typeof size === 'string' && size.includes('/')) {
      // Es un talle combinado, expandirlo
      const parts = size.split('/').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        combinedMap.set(size, parts);
        parts.forEach(part => {
          if (part && part.trim() !== '') {
            expanded.add(part.trim());
          }
        });
      } else {
        // Si solo tiene una parte después de split, tratarlo como talle individual
        expanded.add(size.trim());
      }
    } else {
      // Es un talle individual
      if (size && size.trim() !== '') {
        expanded.add(size.trim());
      }
    }
  });
  
  return {
    individualSizes: Array.from(expanded),
    combinedMap: combinedMap
  };
}

// Detectar si hay búsqueda activa
function hasActiveSearch() {
  const searchInput = document.getElementById("searchInput") || document.getElementById("search-bar-mobile");
  if (!searchInput) return false;
  const searchTerm = searchInput.value?.trim();
  return searchTerm && searchTerm.length > 0;
}

// Obtener IDs de productos visibles actualmente
async function getVisibleProductIds() {
  const cards = document.querySelectorAll('.card.producto:not([style*="display: none"])');
  const productNames = new Set();
  
  cards.forEach(card => {
    const articulo = card.querySelector('.article-box')?.textContent?.trim();
    if (articulo) {
      productNames.add(articulo);
    }
  });
  
  if (productNames.size === 0) return [];
  
  // Consultar products para obtener IDs
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, name')
      .in('name', Array.from(productNames))
      .eq('status', 'active');
    
    if (error) {
      console.error('Error obteniendo IDs de productos:', error);
      return [];
    }
    
    return (data || []).map(p => p.id);
  } catch (error) {
    console.error('Error en getVisibleProductIds:', error);
    return [];
  }
}

function sortExpandedSizes(individualSizes) {
  return individualSizes.sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    const isNumA = !isNaN(numA);
    const isNumB = !isNaN(numB);
    if (isNumA && isNumB) return numA - numB;
    if (isNumA) return -1;
    if (isNumB) return 1;
    return a.localeCompare(b);
  });
}

// Obtener talles: preferir la misma fuente que el catálogo (cargarDesdeSupabase → catalog_public_view)
// para que coincida con Lencería/Otros por tags y no falle .eq('category') en products.
async function getAvailableSizes(category = null, productIds = null) {
  try {
    const canUseCatalogLoader =
      typeof window.cargarDesdeSupabase === 'function' &&
      category &&
      category !== 'all';

    if (canUseCatalogLoader) {
      const rows = await window.cargarDesdeSupabase(category);
      let list = Array.isArray(rows) ? rows : [];

      if (hasActiveSearch()) {
        const visibleNames = new Set();
        document.querySelectorAll('.card.producto').forEach((card) => {
          if (card.style.display === 'none') return;
          const articulo = card.querySelector('.article-box')?.textContent?.trim();
          if (articulo) visibleNames.add(articulo);
        });
        if (visibleNames.size > 0) {
          list = list.filter((r) => visibleNames.has((r.Articulo || '').trim()));
        }
      } else if (productIds && productIds.length > 0) {
        const { data: prods, error: pidErr } = await supabase
          .from('products')
          .select('id, name')
          .in('id', productIds)
          .eq('status', 'active');
        if (pidErr) {
          console.warn('getAvailableSizes: error resolviendo nombres por id', pidErr);
        }
        const names = new Set((prods || []).map((p) => (p.name || '').trim()).filter(Boolean));
        if (names.size > 0) {
          list = list.filter((r) => names.has((r.Articulo || '').trim()));
        }
      }

      const sizesSet = new Set();
      for (const row of list) {
        const raw = row.Numeracion;
        if (raw == null || raw === '') continue;
        String(raw)
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t && t !== 'Único')
          .forEach((t) => sizesSet.add(t));
      }

      console.log('📊 Talles desde catálogo (filas):', list.length, '| talles únicos (pre-expansión):', sizesSet.size);

      if (sizesSet.size > 0) {
        const { individualSizes, combinedMap } = expandCombinedSizes(Array.from(sizesSet));
        combinedSizesMap = combinedMap;
        console.log('🔍 Talles combinados encontrados:', Array.from(combinedMap.keys()));
        console.log('📏 Talles individuales para grid:', individualSizes.length);
        return sortExpandedSizes(individualSizes);
      }
      if (list.length > 0) {
        console.warn('⚠️ Catálogo con filas pero sin Numeracion útil; intentando variant_sizes vía products.');
      }
    }

    // Fallback: consultar variant_sizes vía products.category (Calzado/Ropa puros en products)
    let productQuery = supabase
      .from('products')
      .select('id, name')
      .eq('status', 'active');
    
    // Filtrar por categoría si se proporciona
    if (category && category !== 'all' && category !== 'Novedades' && category !== 'Ofertas') {
      productQuery = productQuery.eq('category', category);
    }
    
    // Filtrar por IDs si se proporcionan
    if (productIds && productIds.length > 0) {
      productQuery = productQuery.in('id', productIds);
    }
    
    const { data: products, error: productsError } = await productQuery;
    
    if (productsError) {
      console.error('Error obteniendo productos:', productsError);
      throw productsError;
    }
    
    if (!products || products.length === 0) {
      return [];
    }
    
    const productIdsToUse = products.map(p => p.id);
    
    // Obtener variantes activas de esos productos
    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id')
      .in('product_id', productIdsToUse)
      .eq('active', true);
    
    if (variantsError) {
      console.error('Error obteniendo variantes:', variantsError);
      throw variantsError;
    }
    
    if (!variants || variants.length === 0) {
      return [];
    }
    
    const variantIds = variants.map(v => v.id);
    
    // Obtener talles con stock > 0 de esas variantes
    console.log('🔍 Consultando variant_sizes para', variantIds.length, 'variantes');
    const { data: sizes, error: sizesError } = await supabase
      .from('variant_sizes')
      .select('size, stock_qty')
      .in('variant_id', variantIds)
      .gt('stock_qty', 0);
    
    if (sizesError) {
      console.error('❌ Error obteniendo talles:', sizesError);
      throw sizesError;
    }
    
    console.log('📊 Registros de variant_sizes obtenidos:', sizes?.length || 0);
    
    // Extraer talles únicos (incluyendo talles combinados)
    const sizesSet = new Set();
    (sizes || []).forEach(item => {
      if (item.size && item.size.trim() !== '' && item.size.trim() !== 'Único') {
        sizesSet.add(item.size.trim());
      }
    });
    
    // Expandir talles combinados
    const { individualSizes, combinedMap } = expandCombinedSizes(Array.from(sizesSet));
    
    // Guardar mapa de talles combinados globalmente para usar en checkProductHasSizes
    combinedSizesMap = combinedMap;
    
    console.log('🔍 Talles combinados encontrados:', Array.from(combinedMap.keys()));
    console.log('📏 Talles individuales para grid:', individualSizes.length);

    return sortExpandedSizes(individualSizes);
  } catch (error) {
    console.error('Error en getAvailableSizes:', error);
    return [];
  }
}

// Renderizar selector de categoría
function renderCategorySelector() {
  const body = document.getElementById('size-filter-body');
  const footer = document.getElementById('size-filter-footer');
  
  if (!body) return;
  
  footer.style.display = 'none';
  
  body.innerHTML = `
    <div class="size-filter-category-selector">
      <p>Seleccione una categoría</p>
      <div class="size-filter-category-buttons">
        <button class="size-filter-category-btn" data-category="Calzado">Calzado</button>
        <button class="size-filter-category-btn" data-category="Ropa">Ropa</button>
        <button class="size-filter-category-btn" data-category="Lenceria">Lencería</button>
      </div>
    </div>
  `;
  
  // Event listeners para botones de categoría
  body.querySelectorAll('.size-filter-category-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const category = btn.dataset.category;
      tempCategoryForSizeFilter = category;
      await loadSizesForCategory(category);
    });
  });
}

// Cargar talles para una categoría
async function loadSizesForCategory(category) {
  const body = document.getElementById('size-filter-body');
  const footer = document.getElementById('size-filter-footer');
  
  if (!body) {
    console.error('size-filter-body no encontrado');
    return;
  }
  
  body.innerHTML = '<div class="size-filter-loading">Cargando talles...</div>';
  footer.style.display = 'none';
  
  try {
    let sizes = [];
    const hasSearch = hasActiveSearch();
    
    console.log('🔍 Cargando talles. Categoría:', category, 'Búsqueda activa:', hasSearch);
    
    if (hasSearch) {
      // Si hay búsqueda activa, obtener IDs de productos visibles
      console.log('📦 Obteniendo IDs de productos visibles...');
      const productIds = await getVisibleProductIds();
      console.log('📦 Productos visibles encontrados:', productIds.length);
      sizes = await getAvailableSizes(category, productIds);
    } else {
      // Si no hay búsqueda, usar solo categoría
      console.log('📦 Consultando talles por categoría...');
      sizes = await getAvailableSizes(category, null);
    }
    
    console.log('✅ Talles encontrados:', sizes.length, sizes);
    
    if (sizes.length === 0) {
      body.innerHTML = '<div class="size-filter-empty">No hay talles disponibles para esta categoría</div>';
      footer.style.display = 'none';
      return;
    }
    
    renderSizeGrid(sizes);
    footer.style.display = 'flex';
  } catch (error) {
    console.error('❌ Error cargando talles:', error);
    body.innerHTML = `<div class="size-filter-empty">Error al cargar talles: ${error.message}</div>`;
    footer.style.display = 'none';
  }
}

// Organizar talles en grupos específicos según categoría
function organizeSizesInGroups(sizes, category) {
  const categoryLower = (category || '').toLowerCase();
  
  // Si es Ropa
  if (categoryLower === 'ropa') {
    const letterSizes = []; // S, M, L, XL, 2XL, 3XL, etc.
    const size36_58 = []; // 36, 37, 38, 39, hasta 58
    const size1_35 = []; // 1, 2, 3, 4, etc. (hasta 35)
    const otherSizes = [];
    
    // Orden esperado para letras: S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL, 7XL, 8XL
    const letterOrder = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL', '8XL'];
    
    sizes.forEach(size => {
      const sizeUpper = size.toUpperCase().trim();
      const numSize = parseInt(size);
      
      // Verificar si es un talle de letra (S, M, L, XL, 2XL, etc.)
      if (letterOrder.includes(sizeUpper) || sizeUpper.match(/^[0-9]*XL$/)) {
        letterSizes.push(size);
      } else if (!isNaN(numSize)) {
        if (numSize >= 36 && numSize <= 58) {
          size36_58.push(size);
        } else if (numSize >= 1 && numSize <= 35) {
          size1_35.push(size);
        } else {
          otherSizes.push(size);
        }
      } else {
        otherSizes.push(size);
      }
    });
    
    // Ordenar letras según el orden esperado
    letterSizes.sort((a, b) => {
      const aUpper = a.toUpperCase();
      const bUpper = b.toUpperCase();
      const aIndex = letterOrder.indexOf(aUpper);
      const bIndex = letterOrder.indexOf(bUpper);
      
      if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      
      // Si no está en el orden, ordenar alfabéticamente
      return aUpper.localeCompare(bUpper);
    });
    
    // Ordenar números
    size36_58.sort((a, b) => parseInt(a) - parseInt(b));
    size1_35.sort((a, b) => parseInt(a) - parseInt(b));
    otherSizes.sort((a, b) => {
      const numA = parseInt(a);
      const numB = parseInt(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
    
    return {
      group1: letterSizes,
      group2: size36_58,
      group3: size1_35,
      others: otherSizes
    };
  } 
  // Si es Calzado (o cualquier otra categoría)
  else {
    const size35_40 = [];
    const size41_46 = [];
    const size18_34 = [];
    const otherSizes = [];
    
    sizes.forEach(size => {
      const numSize = parseInt(size);
      if (!isNaN(numSize)) {
        if (numSize >= 35 && numSize <= 40) {
          size35_40.push(size);
        } else if (numSize >= 41 && numSize <= 46) {
          size41_46.push(size);
        } else if (numSize >= 18 && numSize <= 34) {
          size18_34.push(size);
        } else {
          otherSizes.push(size);
        }
      } else {
        otherSizes.push(size);
      }
    });
    
    // Ordenar cada grupo
    size35_40.sort((a, b) => parseInt(a) - parseInt(b));
    size41_46.sort((a, b) => parseInt(a) - parseInt(b));
    size18_34.sort((a, b) => parseInt(a) - parseInt(b));
    otherSizes.sort((a, b) => {
      const numA = parseInt(a);
      const numB = parseInt(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
    
    return {
      group1: size35_40,
      group2: size41_46,
      group3: size18_34,
      others: otherSizes
    };
  }
}

// Renderizar grid de talles
function renderSizeGrid(sizes) {
  const body = document.getElementById('size-filter-body');
  
  if (!body) {
    console.error('size-filter-body no encontrado para renderizar grid');
    return;
  }
  
  console.log('🎨 Renderizando grid con', sizes.length, 'talles');
  
  // Obtener categoría actual
  const category = tempCategoryForSizeFilter || getCurrentCategory() || '';
  
  // Organizar talles en grupos según categoría
  const groups = organizeSizesInGroups(sizes, category);
  
  let gridHTML = '';
  
  // Función helper para renderizar un grupo de talles
  const renderGroup = (groupSizes) => {
    return groupSizes.map(size => {
      const isActive = selectedSizes.includes(size);
      return `
        <button class="size-filter-size-btn ${isActive ? 'active' : ''}" 
                data-size="${size}"
                data-category="${tempCategoryForSizeFilter || getCurrentCategory() || ''}">
          ${size}
        </button>
      `;
    }).join('');
  };
  
  // Renderizar grupo 1: 35-40
  if (groups.group1.length > 0) {
    gridHTML += renderGroup(groups.group1);
    gridHTML += '<div class="size-filter-separator"></div>';
  }
  
  // Renderizar grupo 2: 41-46
  if (groups.group2.length > 0) {
    gridHTML += renderGroup(groups.group2);
    gridHTML += '<div class="size-filter-separator"></div>';
  }
  
  // Renderizar grupo 3: 18-34
  if (groups.group3.length > 0) {
    gridHTML += renderGroup(groups.group3);
    if (groups.others.length > 0) {
      gridHTML += '<div class="size-filter-separator"></div>';
    }
  }
  
  // Renderizar otros talles
  if (groups.others.length > 0) {
    gridHTML += renderGroup(groups.others);
  }
  
  body.innerHTML = `<div class="size-filter-grid">${gridHTML}</div>`;
  
  // Event listeners para botones de talles
  const sizeButtons = body.querySelectorAll('.size-filter-size-btn');
  console.log('🔘 Botones de talles creados:', sizeButtons.length);
  
  sizeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.dataset.size;
      toggleSize(size);
      btn.classList.toggle('active');
      console.log('📏 Talle toggled:', size, 'Seleccionados:', selectedSizes);
    });
  });
}

// Toggle selección de talle
function toggleSize(size) {
  const index = selectedSizes.indexOf(size);
  if (index > -1) {
    selectedSizes.splice(index, 1);
  } else {
    selectedSizes.push(size);
  }
}

// Abrir modal de filtro de talles
async function openSizeFilterModal() {
  const modal = document.getElementById('size-filter-modal');
  if (!modal) {
    console.error('Modal size-filter-modal no encontrado');
    return;
  }
  
  console.log('🔍 Abriendo modal de filtro de talles...');
  
  selectedSizes = [];
  tempCategoryForSizeFilter = null;
  
  const category = getCurrentCategory();
  const hasSearch = hasActiveSearch();
  
  console.log('📊 Estado actual:', { category, hasSearch });
  
  modal.classList.add('active');
  document.body.classList.add('modal-open');
  
  // Si no hay categoría activa (está en "Inicio/Todas"), mostrar selector
  if (!category || category === 'all' || (!hasSearch && (category === 'Novedades' || category === 'Ofertas'))) {
    console.log('📋 Mostrando selector de categoría');
    renderCategorySelector();
  } else {
    // Cargar talles directamente
    console.log('📏 Cargando talles para categoría:', category);
    await loadSizesForCategory(category);
  }
}

// Cerrar modal
function closeSizeFilterModal() {
  const modal = document.getElementById('size-filter-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  document.body.classList.remove('modal-open');
  
  // Si estaba en selector de categoría, limpiar estado temporal
  if (tempCategoryForSizeFilter && !sizeFilterActive) {
    tempCategoryForSizeFilter = null;
  }
}

// Aplicar filtro de talles
async function applySizeFilter() {
  if (selectedSizes.length === 0) {
    clearSizeFilter();
    closeSizeFilterModal();
    return;
  }
  
  const category = tempCategoryForSizeFilter || getCurrentCategory();
  
  // Marcar filtro como activo
  sizeFilterActive = true;
  
  // Obtener todos los productos visibles
  const cards = document.querySelectorAll('.card.producto');
  
  let visibleCount = 0;
  
  for (const card of cards) {
    // Obtener el nombre del producto
    const articulo = card.querySelector('.article-box')?.textContent?.trim();
    if (!articulo) {
      card.style.display = 'none';
      continue;
    }
    
    // Consultar si este producto tiene alguno de los talles seleccionados
    const hasSelectedSize = await checkProductHasSizes(articulo, selectedSizes, category);
    
    if (hasSelectedSize) {
      card.style.display = '';
      card.setAttribute('data-filtered-by-size', 'true');
      visibleCount++;
    } else {
      card.style.display = 'none';
      card.setAttribute('data-filtered-by-size', 'true');
    }
  }
  
  // Mostrar mensaje si no hay resultados
  const catalogContainer = document.getElementById('catalogo') || document.getElementById('catalog-container');
  let noResultsMsg = catalogContainer.querySelector('.no-results-size-filter');
  
  if (visibleCount === 0) {
    if (!noResultsMsg) {
      noResultsMsg = document.createElement('div');
      noResultsMsg.className = 'no-results-size-filter';
      noResultsMsg.style.cssText = 'text-align: center; padding: 40px 20px; color: #666; background: white; border-radius: 8px; margin: 20px;';
      noResultsMsg.innerHTML = `
        <h3 style="margin: 0 0 12px; color: #333;">No se encontraron productos</h3>
        <p style="margin: 0 0 20px;">No hay productos disponibles con los talles seleccionados.</p>
        <button onclick="window.clearSizeFilter()" style="
          background: #CD844D;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        ">Limpiar filtros</button>
      `;
      if (catalogContainer) {
        catalogContainer.insertBefore(noResultsMsg, catalogContainer.firstChild);
      }
    }
  } else {
    if (noResultsMsg) {
      noResultsMsg.remove();
    }
  }
  
  closeSizeFilterModal();
  
  // Actualizar botón de filtro para indicar que está activo
  const sizeFilterBtn = document.getElementById('size-filter-btn');
  if (sizeFilterBtn) {
    sizeFilterBtn.style.background = '#CD844D';
    sizeFilterBtn.style.color = 'white';
    sizeFilterBtn.style.borderColor = '#CD844D';
  }
}

// Verificar si un producto tiene alguno de los talles seleccionados
async function checkProductHasSizes(articulo, selectedSizesArray, category) {
  try {
    // Obtener el producto
    const { data: products, error: productError } = await supabase
      .from('products')
      .select('id, category')
      .eq('name', articulo)
      .eq('status', 'active')
      .limit(1);
    
    if (productError || !products || products.length === 0) {
      return false;
    }
    
    const product = products[0];
    
    // Si hay categoría, verificar que coincida
    if (category && category !== product.category) {
      return false;
    }
    
    // Obtener variantes del producto
    const { data: variants, error: variantError } = await supabase
      .from('product_variants')
      .select('id')
      .eq('product_id', product.id)
      .eq('active', true);
    
    if (variantError || !variants || variants.length === 0) {
      return false;
    }
    
    const variantIds = variants.map(v => v.id);
    
    // Obtener todos los talles del producto (incluyendo combinados)
    const { data: variantSizes, error: sizeError } = await supabase
      .from('variant_sizes')
      .select('size')
      .in('variant_id', variantIds)
      .gt('stock_qty', 0);
    
    if (sizeError) {
      console.error('Error verificando talles:', sizeError);
      return false;
    }
    
    if (!variantSizes || variantSizes.length === 0) {
      return false;
    }
    
    // Verificar si algún talle del producto coincide con los seleccionados
    for (const variantSize of variantSizes) {
      const size = variantSize.size?.trim();
      if (!size) continue;
      
      // Verificar si es un talle combinado
      if (size.includes('/')) {
        // Es un talle combinado, expandirlo en números individuales
        // El producto aparece si AL MENOS UNO de sus números está seleccionado
        const parts = size.split('/').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          // Verificar si AL MENOS UNO de los números está seleccionado
          const anyPartSelected = parts.some(part => selectedSizesArray.includes(part));
          if (anyPartSelected) {
            return true; // El producto tiene este talle combinado y al menos uno de sus números está seleccionado
          }
        }
      } else {
        // Es un talle individual, verificar si está en selectedSizesArray
        if (selectedSizesArray.includes(size)) {
          return true; // El producto tiene este talle individual seleccionado
        }
      }
    }
    
    return false; // Ningún talle coincide
  } catch (error) {
    console.error('Error en checkProductHasSizes:', error);
    return false;
  }
}

// Limpiar filtro de talles
function clearSizeFilter() {
  selectedSizes = [];
  sizeFilterActive = false;
  tempCategoryForSizeFilter = null;
  
  // Mostrar todos los productos y remover marca de filtro
  const cards = document.querySelectorAll('.card.producto');
  cards.forEach(card => {
    card.style.display = '';
    card.removeAttribute('data-filtered-by-size');
  });
  
  // Si hay búsqueda activa, re-aplicarla
  if (hasActiveSearch()) {
    const searchInput = document.getElementById("searchInput") || document.getElementById("search-bar-mobile");
    if (searchInput && typeof window.performSearch === 'function') {
      window.performSearch(searchInput.value.trim().toLowerCase());
    }
  }
  
  // Remover mensaje de no resultados
  const noResultsMsg = document.querySelector('.no-results-size-filter');
  if (noResultsMsg) {
    noResultsMsg.remove();
  }
  
  // Restaurar estilo del botón
  const sizeFilterBtn = document.getElementById('size-filter-btn');
  if (sizeFilterBtn) {
    sizeFilterBtn.style.background = '';
    sizeFilterBtn.style.color = '';
    sizeFilterBtn.style.borderColor = '';
  }
}

// Inicializar event listeners
function initSizeFilter() {
  const modal = document.getElementById('size-filter-modal');
  const closeBtn = document.getElementById('size-filter-close');
  const overlay = modal?.querySelector('.size-filter-overlay');
  const applyBtn = document.getElementById('size-filter-apply');
  const clearBtn = document.getElementById('size-filter-clear');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSizeFilterModal);
  }
  
  if (overlay) {
    overlay.addEventListener('click', closeSizeFilterModal);
  }
  
  if (applyBtn) {
    applyBtn.addEventListener('click', applySizeFilter);
  }
  
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearSizeFilter();
      closeSizeFilterModal();
    });
  }
  
  // Cerrar con ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal?.classList.contains('active')) {
      closeSizeFilterModal();
    }
  });
}

// Función para hookear cambiarCategoria
function hookCambiarCategoria() {
  // Esperar a que cambiarCategoria esté disponible
  let attempts = 0;
  const maxAttempts = 10;
  const checkInterval = setInterval(() => {
    attempts++;
    if (typeof window.cambiarCategoria !== 'undefined' || attempts >= maxAttempts) {
      clearInterval(checkInterval);
      if (typeof window.cambiarCategoria !== 'undefined') {
        const originalCambiarCategoria = window.cambiarCategoria;
        window.cambiarCategoria = function(cat) {
          currentCategory = cat;
          // Si hay filtro de talles activo, limpiarlo al cambiar categoría
          if (sizeFilterActive) {
            clearSizeFilter();
          }
          // Cerrar modal si está abierto
          closeSizeFilterModal();
          return originalCambiarCategoria.apply(this, arguments);
        };
        console.log('✅ Hook de cambiarCategoria configurado');
      }
    }
  }, 100);
}

/** Aplicar filtro de talle desde URL (ej. "Ver similares" desde dashboard). No abre el modal. */
async function applySizeFilterFromURL(talle) {
  const normalized = normalizeSize(talle) || String(talle || '').trim();
  if (!normalized) return;
  selectedSizes = [normalized];
  // No usar categoría: los productos ya están filtrados por tag (ej. Bota). Si usáramos
  // getCurrentCategory() podría devolver el tag y checkProductHasSizes excluiría todos
  // porque product.category es "Calzado"/"Otros", no el tag.
  tempCategoryForSizeFilter = null;
  await applySizeFilter();
}

// Exportar funciones globales inmediatamente
if (typeof window !== 'undefined') {
  window.openSizeFilterModal = openSizeFilterModal;
  window.clearSizeFilter = clearSizeFilter;
  window.applySizeFilterFromURL = applySizeFilterFromURL;
  console.log('✅ Funciones de size-filter exportadas globalmente');
}

// Actualizar categoría cuando cambia
// Esto se ejecutará después de que main-supabase.js se cargue
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initSizeFilter();
    hookCambiarCategoria();
  });
} else {
  initSizeFilter();
  // Ya cargado, ejecutar después de un breve delay
  setTimeout(hookCambiarCategoria, 500);
}