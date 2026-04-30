// scripts/custom-banner.js - Banner de productos personalizable

import { supabase } from "./supabase-client.js";

/** Logs verbosos del banner/catálogo. Activar: `window.FYL_DEBUG_CATALOG = true` antes de cargar, o `?debug=catalog` en la URL. */
function fylCatalogDebugEnabled() {
  if (typeof window === "undefined") return false;
  if (window.FYL_DEBUG_CATALOG === true) return true;
  try {
    return /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || "");
  } catch (_) {
    return false;
  }
}
function fylCatalogDbg(...args) {
  if (fylCatalogDebugEnabled()) console.log.apply(console, args);
}
function fylCatalogWarn(...args) {
  if (fylCatalogDebugEnabled()) console.warn.apply(console, args);
}

let customBannerProducts = [];
let customBannerProductsLoaded = 0; // Contador de productos mostrados
const PRODUCTS_PER_PAGE = 10; // Cantidad de productos a cargar por página
let scrollListenerAttached = false; // Flag para evitar múltiples listeners
let currentScrollHandler = null; // Referencia al handler de scroll actual

// Cargar configuración del banner desde Supabase
export async function loadCustomBannerConfig() {
  try {
    const { data, error } = await supabase
      .from("custom_product_banners")
      .select("*")
      .eq("enabled", true)
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No hay banner configurado
        return null;
      }
      console.error("❌ Error cargando configuración del banner:", error);
      return null;
    }

    return data;
  } catch (error) {
    console.error("❌ Error en loadCustomBannerConfig:", error);
    return null;
  }
}

// Obtener todos los tags únicos de Filtro1, Filtro2 y Filtro3
export async function getAllUniqueTags() {
  try {
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select("Filtro1, Filtro2, Filtro3")
      .eq("Mostrar", true);

    if (error) {
      console.error("❌ Error cargando tags:", error);
      return [];
    }

    if (!data || data.length === 0) {
      return [];
    }

    // Recolectar todos los tags únicos (mantener formato original para mostrar, pero normalizar para deduplicar)
    const tagsMap = new Map(); // Map: lowercase -> original
    
    data.forEach(item => {
      const processTag = (tagValue) => {
        if (!tagValue) return;
        // Eliminar espacios extra y normalizar para deduplicar
        const tagTrimmed = tagValue.trim().replace(/\s+/g, ' ');
        if (!tagTrimmed) return;
        
        // Normalizar para deduplicar (case-insensitive)
        const tagNormalized = tagTrimmed.toLowerCase();
        
        // Mantener el formato original del tag (la primera vez que aparece)
        if (!tagsMap.has(tagNormalized)) {
          tagsMap.set(tagNormalized, tagTrimmed);
        }
      };
      
      processTag(item.Filtro1);
      processTag(item.Filtro2);
      if (item.Filtro3) item.Filtro3.split(/[,;]/).forEach(part => processTag(part));
    });

    // Convertir a array de valores originales y ordenar alfabéticamente (case-insensitive)
    const tags = Array.from(tagsMap.values()).sort((a, b) => 
      a.localeCompare(b, 'es', { sensitivity: 'base' })
    );

    fylCatalogDbg(`✅ Tags únicos encontrados: ${tags.length}`, tags.slice(0, 10));
    return tags;
  } catch (error) {
    console.error("❌ Error en getAllUniqueTags:", error);
    return [];
  }
}

// Cargar productos filtrados según el tag especificado (busca en Filtro1, Filtro2 y Filtro3)
// IMPORTANTE: Este banner muestra productos de TODAS las categorías (Calzado, Ropa, Lencería, Accesorios, etc.)
export async function loadCustomBannerProducts(tagValue) {
  try {
    fylCatalogDbg(`🔍 loadCustomBannerProducts llamado con tagValue: "${tagValue}"`);
    
    // Cargar TODOS los productos visibles de TODAS las categorías
    // No se filtra por categoría, solo por el tag especificado
    let query = supabase
      .from("catalog_public_view")
      .select("*")
      .eq("Mostrar", true);
      // NOTA: No agregamos filtro por Categoria para incluir productos de todas las categorías

    const { data: allData, error: queryError } = await query.order("FechaIngreso", { ascending: false });
    
    fylCatalogDbg(`📊 Productos cargados (Mostrar=true): ${allData?.length || 0}`);
    
    // Log para confirmar que se cargan productos de todas las categorías
    if (allData && allData.length > 0) {
      const categoriasUnicas = [...new Set(allData.map(p => p.Categoria).filter(Boolean))];
      const productosOtros = allData.filter(p => (p.Categoria || "").trim().toLowerCase() === "otros");
      fylCatalogDbg(`📦 Productos cargados para banner: ${allData.length} productos de ${categoriasUnicas.length} categorías:`, categoriasUnicas);
      fylCatalogDbg(`📦 Productos de categoría "Otros": ${productosOtros.length}`);
      if (productosOtros.length > 0) {
        fylCatalogDbg(`   Ejemplos de productos "Otros":`, productosOtros.slice(0, 3).map(p => ({
          Articulo: p.Articulo,
          Filtro1: p.Filtro1,
          Filtro2: p.Filtro2,
          Filtro3: p.Filtro3
        })));
      }
    }
    
    if (fylCatalogDebugEnabled()) {
      const { data: allDataDebug } = await supabase
        .from("catalog_public_view")
        .select("Articulo, Descripcion, Mostrar, Filtro1, Filtro2, Filtro3")
        .ilike("Articulo", "%F314%")
        .limit(10);

      if (allDataDebug && allDataDebug.length > 0) {
        fylCatalogDbg(`🔍 Productos F314 encontrados en catalog_public_view:`, allDataDebug);
      } else {
        console.warn(`⚠️ F314 NO encontrado en catalog_public_view. Esto puede deberse a:`);
        console.warn(`   1. El producto tiene status != 'active'`);
        console.warn(`   2. No tiene variantes activas (pv.active = true)`);
        console.warn(`   3. No tiene stock > 0 en ningún talle`);
        console.warn(`   4. No tiene imágenes asociadas`);
        console.warn(`   5. El nombre del artículo no es exactamente "F314"`);

        try {
          const { data: productDirect } = await supabase
            .from("products")
            .select("id, name, status, created_at")
            .ilike("name", "%F314%")
            .limit(5);

          if (productDirect && productDirect.length > 0) {
            fylCatalogDbg(`🔍 Productos F314 encontrados en tabla products:`, productDirect);
          } else {
            console.warn(`   Tampoco encontrado en tabla products`);
          }
        } catch (err) {
          console.warn(`   No se pudo consultar tabla products directamente:`, err.message);
        }
      }
    }

    if (queryError) {
      console.error("❌ Error cargando productos del banner:", queryError);
      return [];
    }

    if (!allData || allData.length === 0) {
      fylCatalogDbg(`ℹ️ No hay productos visibles`);
      return [];
    }

    // Filtrar en memoria: buscar el tag en Filtro1, Filtro2 o Filtro3
    // Normalizar el tag buscado para comparación case-insensitive
    // Eliminar espacios extra y normalizar
    const tagValueNormalized = (tagValue || "").trim().replace(/\s+/g, ' ').toLowerCase();
    
    fylCatalogDbg(`🔍 Filtrando productos con tag: "${tagValue}" (normalizado: "${tagValueNormalized}")`);
    fylCatalogDbg(`📦 Total de productos a filtrar: ${allData.length}`);

    // Función helper para normalizar tags para comparación
    // Elimina espacios extra y normaliza a minúsculas
    const normalizeTag = (tag) => {
      if (!tag) return "";
      return tag.toString().trim().replace(/\s+/g, ' ').toLowerCase();
    };

    if (fylCatalogDebugEnabled()) {
      const productosF314 = allData.filter(i => {
        const art = (i.Articulo || "").toString().trim().toUpperCase();
        const desc = (i.Descripcion || "").toString().trim().toUpperCase();
        return art.includes("F314") || desc.includes("F314") || art === "F314";
      });

      if (productosF314.length > 0) {
        fylCatalogDbg(`🔍 Productos F314 encontrados (${productosF314.length}):`);
        productosF314.forEach(prod => {
          fylCatalogDbg(`  - Articulo: "${prod.Articulo}", Descripcion: "${prod.Descripcion}"`, {
            Filtro1: prod.Filtro1,
            Filtro2: prod.Filtro2,
            Filtro3: prod.Filtro3,
            Mostrar: prod.Mostrar,
            Filtro1_normalized: normalizeTag(prod.Filtro1),
            Filtro2_normalized: normalizeTag(prod.Filtro2),
            Filtro3_normalized: normalizeTag(prod.Filtro3),
            tagBuscado: tagValueNormalized,
            coincide: normalizeTag(prod.Filtro1) === tagValueNormalized ||
                     normalizeTag(prod.Filtro2) === tagValueNormalized ||
                     normalizeTag(prod.Filtro3) === tagValueNormalized
          });
        });
      } else {
        console.warn(`⚠️ Producto F314 NO encontrado en los productos visibles`);
        console.warn(`   Esto puede indicar que:`);
        console.warn(`   1. El producto no tiene Mostrar=true en la base de datos`);
        console.warn(`   2. El artículo no se llama exactamente "F314" (puede tener espacios o formato diferente)`);
        console.warn(`   3. El producto no está en la vista catalog_public_view`);
        fylCatalogDbg(`🔍 Intentando buscar F314 en TODOS los productos (sin filtro Mostrar)...`);
      }
    }

    fylCatalogDbg(`🔍 Filtrando productos por tag normalizado: "${tagValueNormalized}"`);
    
    // Usar la misma lógica que el buscador: buscar con includes() en lugar de comparación exacta
    // IMPORTANTE: Filtro3 puede contener múltiples tags separados por comas (ej: "Colegio, Lona")
    // Cada tag debe tratarse como independiente
    const filteredData = allData.filter(i => {
      // Normalizar todos los campos a minúsculas para búsqueda
      const art = (i.Articulo || '').toLowerCase();
      const descripcion = (i.Descripcion || '').toLowerCase();
      const nombre = ((i.name || i.Articulo) || '').toLowerCase();
      
      // Filtro1 y Filtro2 son tags únicos
      const filtro1 = (i.Filtro1 || '').toLowerCase();
      const filtro2 = (i.Filtro2 || '').toLowerCase();
      
      // Filtro3 puede tener múltiples tags separados por comas - dividir y normalizar cada uno
      const filtro3Tags = (i.Filtro3 || '')
        .split(',')
        .map(tag => tag.trim().toLowerCase())
        .filter(tag => tag.length > 0);
      
      // Buscar el tag en cada campo
      // Para Filtro3, verificar cada tag individualmente
      const match = art.includes(tagValueNormalized) || 
                   descripcion.includes(tagValueNormalized) || 
                   nombre.includes(tagValueNormalized) ||
                   filtro1.includes(tagValueNormalized) ||
                   filtro2.includes(tagValueNormalized) ||
                   filtro3Tags.some(tag => tag === tagValueNormalized || tag.includes(tagValueNormalized));
      
      if (match) {
        const categoria = i.Categoria || 'Sin categoría';
        fylCatalogDbg(`✅ Producto ${i.Articulo} (${categoria}) coincide: Filtro1="${i.Filtro1 || ''}", Filtro2="${i.Filtro2 || ''}", Filtro3="${i.Filtro3 || ''}"`);
      }
      
      return match;
    });

    fylCatalogDbg(`📊 Productos filtrados: ${filteredData.length} de ${allData.length} totales`);
    
    // Log específico para productos de categoría "Otros"
    const productosOtrosFiltrados = filteredData.filter(p => (p.Categoria || "").trim().toLowerCase() === "otros");
    if (productosOtrosFiltrados.length > 0) {
      fylCatalogDbg(`📦 Productos de categoría "Otros" encontrados: ${productosOtrosFiltrados.length}`);
    } else if (fylCatalogDebugEnabled()) {
      console.warn(`⚠️ No se encontraron productos de categoría "Otros" con el tag "${tagValue}"`);
      const productosOtrosEjemplo = allData.filter(p => (p.Categoria || "").trim().toLowerCase() === "otros").slice(0, 3);
      if (productosOtrosEjemplo.length > 0) {
        fylCatalogDbg(`   Ejemplos de productos "Otros" disponibles:`, productosOtrosEjemplo.map(p => ({
          Articulo: p.Articulo,
          Filtro1: p.Filtro1,
          Filtro2: p.Filtro2,
          Filtro3: p.Filtro3
        })));
      }
    }

    if (filteredData.length === 0) {
      fylCatalogDbg(`ℹ️ No hay productos con el tag "${tagValue}"`);
      return [];
    }

    // Usar los datos filtrados para continuar
    const data = filteredData;

    // Agrupar productos por artículo (similar a cargarCategoria)
    // El filtrado inicial ya garantiza que todos los productos tienen el tag correcto
    const grupos = data.reduce((acc, i) => {
      const art = i.Articulo?.trim();
      if (!art) return acc;

      if (!acc[art]) {
        acc[art] = {
          Articulo: art,
          Descripcion: i.Descripcion || "",
          Precio: i.Precio || "",
          VariantePrincipal: i["Imagen Principal"],
          Oferta: i.Oferta || "",
          FechaIngreso: i.FechaIngreso || "",
          Filtro1: i.Filtro1 || "",
          Filtro2: i.Filtro2 || "",
          Filtro3: i.Filtro3 || "",
          OfertaActiva: false,
          PrecioOferta: '',
          PromoActiva: '',
          DetalleColor: [],
        };
      }

      // Actualizar información de ofertas
      if (i.OfertaActiva === true || i.OfertaActiva === 'true') {
        acc[art].OfertaActiva = true;
        if (!acc[art].PrecioOferta) {
          acc[art].PrecioOferta = i.PrecioOferta || '';
        }
      }

      if (i.PromoActiva && i.PromoActiva !== '') {
        acc[art].PromoActiva = i.PromoActiva;
      }

      // Agregar color si no existe - SOLO si este producto tiene el tag correcto
      const colorExists = acc[art].DetalleColor.find(c => 
        (c.color || "").trim().toLowerCase() === (i.Color || "").trim().toLowerCase()
      );

      if (!colorExists) {
        acc[art].DetalleColor.push({
          color: i.Color || "Sin color",
          hex_color: i.ColorHex || null,
          talles: i.Numeracion?.split(",").map((t) => t.trim()) || ["Único"],
          images: [
            i["Imagen Principal"],
            i["Imagen 1"],
            i["Imagen 2"],
            i["Imagen 3"],
          ].filter(Boolean),
        });
      }

      return acc;
    }, {});

    customBannerProducts = Object.values(grupos);
    fylCatalogDbg(`✅ Productos del banner personalizado cargados: ${customBannerProducts.length}`);

    return customBannerProducts;
  } catch (error) {
    console.error("❌ Error en loadCustomBannerProducts:", error);
    return [];
  }
}

// Función para formatear precio con punto como separador de miles
function formatPrice(precio) {
  if (!precio) return '$0';
  
  // Limpiar el precio de símbolos y espacios
  let precioLimpio = precio.toString().replace(/[^\d.,]/g, '').replace(',', '.');
  const precioNum = parseFloat(precioLimpio);
  
  if (isNaN(precioNum)) return '$0';
  
  // Formatear con punto como separador de miles y sin decimales
  const precioFormateado = Math.round(precioNum).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  
  return `$${precioFormateado}`;
}

// Renderizar puntos de colores
function renderColorDots(producto, cardIndex) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) {
    return '';
  }

  // Obtener colores únicos con hex_color e imagen
  const colores = producto.DetalleColor
    .filter(detalle => detalle.hex_color && detalle.images && detalle.images.length > 0)
    .map(detalle => ({
      color: detalle.color,
      hex: detalle.hex_color,
      imagen: detalle.images[0] || null
    }))
    .filter((color, index, self) => 
      index === self.findIndex(c => 
        (c.color || "").trim().toLowerCase() === (color.color || "").trim().toLowerCase()
      )
    )
    .slice(0, 8); // Máximo 8 colores visibles

  if (colores.length === 0) {
    return '';
  }

  return `
    <div class="custom-banner-colors">
      ${colores.map((c, idx) => `
        <button class="color-dot color-dot-btn" 
             style="background-color: ${c.hex};"
             data-color-image="${c.imagen || ''}"
             data-card-index="${cardIndex}"
             title="${c.color}"
             type="button">
        </button>
      `).join('')}
    </div>
  `;
}

// Renderizar card individual de producto
function renderCustomBannerProductCard(producto, index) {
  const skuDefecto = getSafePdpSku(producto);
  const imagen = producto.VariantePrincipal || producto.DetalleColor?.[0]?.images?.[0] || '';
  const precioDisplay = producto.OfertaActiva && producto.PrecioOferta 
    ? producto.PrecioOferta 
    : producto.Precio;
  
  const precioFormateado = formatPrice(precioDisplay);

  const nombreProducto = producto.Articulo || producto.Descripcion || 'Producto';
  
  return `
    <div class="custom-banner-card" 
         data-articulo="${producto.Articulo}"
         data-sku="${skuDefecto || ''}">
      <div class="custom-banner-badge">${nombreProducto}</div>
      <img class="custom-banner-card-image" 
           src="${cloudinaryOptimized(imagen, 400)}" 
           alt="${producto.Descripcion || producto.Articulo}"
           loading="lazy"
           data-sku="${skuDefecto || ''}">
      <div class="custom-banner-card-content">
        <div class="custom-banner-card-price">${precioFormateado}</div>
      </div>
    </div>
  `;
}

// Función helper para obtener SKU defecto (reutilizar de main-supabase.js si está disponible)
function obtenerSKUDefecto(producto) {
  if (!producto || !producto.DetalleColor) return null;
  
  // Resolver SKU desde variantDetails enriquecido (no depender de window.skuIndex)
  for (const detalleColor of producto.DetalleColor) {
    if (!detalleColor.variantDetails) continue;
    
    const conStock = detalleColor.variantDetails.find(vd => 
      vd?.sku && Number(vd?.available) > 0
    );
    if (conStock && conStock.sku) return conStock.sku;
  }
  
  return null;
}

function getSafePdpSku(producto) {
  return obtenerSKUDefecto(producto);
}

function hasUsableImage(producto) {
  const imagen = producto?.VariantePrincipal || producto?.DetalleColor?.[0]?.images?.[0] || '';
  return Boolean(String(imagen || '').trim());
}

function hasAtLeastOneVariantWithRealStock(producto) {
  if (!producto || !Array.isArray(producto.DetalleColor)) return false;
  return producto.DetalleColor.some((detalleColor) =>
    Array.isArray(detalleColor?.variantDetails) &&
    detalleColor.variantDetails.some((vd) => vd?.sku && Number(vd?.available) > 0)
  );
}

function isCustomBannerEligible(producto) {
  if (!producto) return false;
  if (!hasUsableImage(producto)) return false;
  const skuSeguro = getSafePdpSku(producto);
  if (!skuSeguro) return false;
  if (!hasAtLeastOneVariantWithRealStock(producto)) return false;
  return true;
}

// Función helper para cloudinaryOptimized (reutilizar si está disponible)
function cloudinaryOptimized(url, width) {
  if (typeof window !== 'undefined' && typeof window.cloudinaryOptimized === 'function') {
    return window.cloudinaryOptimized(url, width);
  }
  
  // Fallback básico
  if (!url) return '';
  if (url.includes('cloudinary.com')) {
    return url.replace(/\/upload\//, `/upload/w_${width},q_auto,f_auto/`);
  }
  return url;
}

// Renderizar más productos en el carrusel
function renderMoreCustomBannerProducts(products, startIndex, count) {
  const scrollContainer = document.getElementById("custom-banner-scroll");
  if (!scrollContainer) return;

  const endIndex = Math.min(startIndex + count, products.length);
  const productsToAdd = products.slice(startIndex, endIndex);

  productsToAdd.forEach((producto, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;
    const cardHTML = renderCustomBannerProductCard(producto, globalIndex);
    scrollContainer.insertAdjacentHTML('beforeend', cardHTML);
  });

  // Configurar event listeners para las nuevas cards
  setupCustomBannerCardListeners(scrollContainer, startIndex, endIndex);
  
  return endIndex;
}

// Configurar event listeners para las cards
function setupCustomBannerCardListeners(scrollContainer, startIndex = 0, endIndex = null) {
  const allCards = scrollContainer.querySelectorAll('.custom-banner-card');
  const cards = endIndex !== null 
    ? Array.from(allCards).slice(startIndex, endIndex)
    : Array.from(allCards).slice(startIndex);

  cards.forEach((card, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;

    // Configurar click en la card
    card.addEventListener('click', () => {
      const articulo = card.dataset.articulo;
      const productoEncontrado = customBannerProducts.find(p => 
        (p.Articulo || "").trim() === (articulo || "").trim()
      );
      const skuSeguro = getSafePdpSku(productoEncontrado);
      
      if (skuSeguro && typeof window.abrirModalPorSKU === 'function') {
        const abierto = window.abrirModalPorSKU(skuSeguro, { pushState: true });
        if (abierto) return;
        fylCatalogWarn("⚠️ abrirModalPorSKU no pudo abrir desde custom banner para SKU seguro:", skuSeguro, "artículo:", articulo);
      } else {
        fylCatalogWarn("⚠️ Custom banner sin SKU seguro; se omite apertura PDP.", { articulo });
      }
    });
  });
}

// Manejar scroll horizontal para cargar más productos
function setupCustomBannerScrollListener(scrollContainer, allProducts) {
  // Remover listener previo si existe
  if (scrollListenerAttached && currentScrollHandler) {
    scrollContainer.removeEventListener('scroll', currentScrollHandler);
    scrollListenerAttached = false;
    currentScrollHandler = null;
  }

  let isLoading = false;
  
  currentScrollHandler = () => {
    // Verificar si ya se cargaron todos los productos
    if (customBannerProductsLoaded >= allProducts.length) {
      return;
    }

    // Verificar si ya se está cargando para evitar múltiples cargas simultáneas
    if (isLoading) {
      return;
    }

    // Calcular si el usuario está cerca del final (80% del scroll)
    const scrollLeft = scrollContainer.scrollLeft;
    const scrollWidth = scrollContainer.scrollWidth;
    const clientWidth = scrollContainer.clientWidth;
    const scrollPercentage = (scrollLeft + clientWidth) / scrollWidth;

    if (scrollPercentage >= 0.8) {
      isLoading = true;
      
      // Cargar los siguientes productos
      const nextIndex = renderMoreCustomBannerProducts(allProducts, customBannerProductsLoaded, PRODUCTS_PER_PAGE);
      customBannerProductsLoaded = nextIndex;
      
      // Permitir cargar más después de un pequeño delay
      setTimeout(() => {
        isLoading = false;
      }, 300);
    }
  };

  scrollContainer.addEventListener('scroll', currentScrollHandler);
  scrollListenerAttached = true;
}

// Renderizar banner con productos
export function renderCustomBanner(products, bannerName, tagValue) {
  // Buscar el banner inline primero (dentro del grid), luego el normal
  let banner = document.getElementById("custom-banner-container-inline");
  let scrollContainer = banner ? banner.querySelector("#custom-banner-scroll") : null;
  let headerTitle = banner ? banner.querySelector("#custom-banner-title") : null;
  let headerContainer = banner ? banner.querySelector(".custom-banner-header") : null;
  
  // Si no está inline, buscar el contenedor normal
  if (!banner) {
    banner = document.getElementById("custom-banner-container");
    scrollContainer = document.getElementById("custom-banner-scroll");
    headerTitle = document.getElementById("custom-banner-title");
    headerContainer = banner ? banner.querySelector(".custom-banner-header") : null;
  }
  
  if (!banner || !scrollContainer) {
    console.warn("⚠️ Contenedor de banner personalizado no encontrado");
    return;
  }

  if (!products || products.length === 0) {
    banner.style.display = 'none';
    return;
  }

  // Actualizar título del banner
  if (headerTitle) {
    headerTitle.textContent = bannerName || 'Productos Destacados';
  }
  
  // Agregar botón "Ver todo >" si no existe
  if (headerContainer) {
    let verTodoBtn = headerContainer.querySelector('.custom-banner-ver-todo-btn');
    if (!verTodoBtn && tagValue) {
      const tagNormalized = encodeURIComponent(tagValue.trim().toLowerCase());
      verTodoBtn = document.createElement('a');
      verTodoBtn.href = `banner.html?banner=${tagNormalized}`;
      verTodoBtn.className = 'custom-banner-ver-todo-btn';
      verTodoBtn.style.cssText = 'display: flex; align-items: center; gap: 4px; color: #CD844D; text-decoration: none; font-size: 0.9rem; font-weight: 500;';
      verTodoBtn.innerHTML = 'Ver todo <svg class="custom-banner-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      headerContainer.appendChild(verTodoBtn);
    } else if (verTodoBtn && tagValue) {
      const tagNormalized = encodeURIComponent(tagValue.trim().toLowerCase());
      verTodoBtn.href = `banner.html?banner=${tagNormalized}`;
    }
  }

  // Resetear contador
  customBannerProductsLoaded = 0;

  // Limpiar contenedor
  scrollContainer.innerHTML = '';

  // Renderizar primeros productos (máximo 10)
  const initialCount = Math.min(PRODUCTS_PER_PAGE, products.length);
  customBannerProductsLoaded = renderMoreCustomBannerProducts(products, 0, initialCount);

  // Configurar listener de scroll para cargar más productos
  setupCustomBannerScrollListener(scrollContainer, products);

  // Mostrar banner
  banner.style.display = 'block';
}

// Ocultar banner
export function hideCustomBanner() {
  const banner = document.getElementById("custom-banner-container");
  if (banner) {
    banner.style.display = 'none';
  }
  // También ocultar banner inline si existe
  const inlineBanner = document.getElementById("custom-banner-container-inline");
  if (inlineBanner) {
    inlineBanner.style.display = 'none';
  }
  // Eliminar wrapper del banner inline si existe
  const bannerWrapper = document.getElementById("custom-banner-wrapper");
  if (bannerWrapper) {
    bannerWrapper.remove();
  }
}

// Cantidad de productos del catálogo que ya están visibles arriba del banner (no duplicar en Productos Destacados)
const PRODUCTOS_CATALOGO_ANTES_DEL_BANNER = 12;

function getArticulosYaMostradosEnCatalogo() {
  const catalogo = document.getElementById("catalogo");
  if (!catalogo) return new Set();
  const cards = catalogo.querySelectorAll(".card.producto");
  const yaMostrados = new Set();
  for (let i = 0; i < Math.min(PRODUCTOS_CATALOGO_ANTES_DEL_BANNER, cards.length); i++) {
    const art = (cards[i].dataset.articulo || cards[i].getAttribute("data-articulo") || "").trim();
    if (art) yaMostrados.add(art);
  }
  return yaMostrados;
}

// Función principal para cargar y mostrar banner
export async function loadAndShowCustomBanner() {
  try {
    // No mostrar en vista colección FYL
    if (location.hash === "#/coleccion/fyl-originals") {
      hideCustomBanner();
      return;
    }
    fylCatalogDbg("🔄 Iniciando carga de banner personalizado...");
    
    // Verificar si hay parámetro ?banner en la URL
    const urlParams = new URLSearchParams(window.location.search);
    const bannerParam = urlParams.get('banner');
    
    let tagValue = null;
    let bannerName = null;
    
    if (bannerParam) {
      // Usar tag de la URL si existe
      tagValue = bannerParam.trim();
      fylCatalogDbg(`📋 Usando tag de URL: "${tagValue}"`);
    } else {
      // Cargar configuración de la BD
      const config = await loadCustomBannerConfig();
      
      if (!config || !config.enabled) {
        fylCatalogDbg("ℹ️ Banner personalizado no está habilitado o no hay configuración");
        hideCustomBanner();
        return;
      }
      
      tagValue = config.tag_value;
      bannerName = config.name;
      
      fylCatalogDbg(`📋 Configuración del banner:`, {
        name: config.name,
        tag_value: config.tag_value,
        enabled: config.enabled
      });
    }

    // Cargar productos filtrados
    let products = await loadCustomBannerProducts(tagValue);
    
    fylCatalogDbg(`📦 Productos cargados para banner: ${products.length}`);

    // Excluir productos que ya están visibles arriba en el catálogo (evitar duplicados)
    const yaMostrados = getArticulosYaMostradosEnCatalogo();
    if (yaMostrados.size > 0) {
      const antes = products.length;
      products = products.filter((p) => !yaMostrados.has((p.Articulo || "").trim()));
      if (antes !== products.length) {
        fylCatalogDbg(`📌 Excluidos ${antes - products.length} productos ya mostrados en el catálogo`);
      }
    }
    
    if (products.length === 0) {
      fylCatalogDbg("⚠️ No se encontraron productos para el banner (o todos ya están arriba)");
      hideCustomBanner();
      return;
    }

    // Enriquecer productos con información de stock/variantes si es necesario
    if (products.length > 0 && typeof window.enrichProductsWithStock === 'function') {
      fylCatalogDbg("🔄 Enriqueciendo productos con información de stock...");
      await window.enrichProductsWithStock(products);
    }

    products = products.filter(isCustomBannerEligible);
    fylCatalogDbg(`📉 Productos elegibles para custom banner (stock real > 0): ${products.length}`);

    if (products.length === 0) {
      fylCatalogWarn("⚠️ Custom banner oculto: no hay productos elegibles con stock real positivo.");
      hideCustomBanner();
      return;
    }
    
    if (location.hash === "#/coleccion/fyl-originals") {
      hideCustomBanner();
      return;
    }
    renderCustomBanner(products, bannerName, tagValue);
    fylCatalogDbg("✅ Banner personalizado renderizado exitosamente");
  } catch (error) {
    console.error("❌ Error en loadAndShowCustomBanner:", error);
    hideCustomBanner();
  }
}

// Exportar funciones globalmente
if (typeof window !== 'undefined') {
  window.loadAndShowCustomBanner = loadAndShowCustomBanner;
  window.hideCustomBanner = hideCustomBanner;
  window.getAllUniqueTags = getAllUniqueTags;
}
