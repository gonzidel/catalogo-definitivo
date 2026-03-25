// scripts/fyl-originals-banner.js - Banner de productos FYL Originals

import { supabase } from "./supabase-client.js";

let fylProducts = [];
let fylProductsLoaded = 0; // Contador de productos mostrados
const PRODUCTS_PER_PAGE = 10; // Cantidad de productos a cargar por página
let scrollListenerAttached = false; // Flag para evitar múltiples listeners
let currentScrollHandler = null; // Referencia al handler de scroll actual

// Cargar productos del proveedor FYL
export async function loadFYLOriginals() {
  try {
    // Primero obtener el proveedor FYL
    const { data: supplierData, error: supplierError } = await supabase
      .from("suppliers")
      .select("id, code")
      .eq("code", "FYL")
      .limit(1)
      .single();

    if (supplierError || !supplierData) {
      console.warn("⚠️ No se encontró el proveedor FYL:", supplierError);
      return [];
    }

    // Obtener productos del proveedor FYL desde catalog_public_view
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select("*")
      .eq("SupplierCode", "FYL")
      .order("FechaIngreso", { ascending: false });

    if (error) {
      console.error("❌ Error cargando productos FYL:", error);
      return [];
    }

    if (!data || data.length === 0) {
      console.log("ℹ️ No hay productos del proveedor FYL");
      return [];
    }

    // Agrupar productos por artículo (similar a cargarCategoria)
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

      // Agregar color si no existe
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

    fylProducts = Object.values(grupos);
    console.log(`✅ Productos FYL cargados: ${fylProducts.length}`);

    return fylProducts;
  } catch (error) {
    console.error("❌ Error en loadFYLOriginals:", error);
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

// Máximo 3 colores visibles; si hay más, se muestra un "+" en la misma fila
const FYL_ORIGINALS_MAX_VISIBLE_COLORS = 3;

// Renderizar puntos de colores (solo 3 visibles + círculo "+" si hay más)
function renderColorDots(producto, cardIndex) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) {
    return '';
  }

  // Obtener colores únicos con hex_color e imagen
  const todosColores = producto.DetalleColor
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
    );

  if (todosColores.length === 0) {
    return '';
  }

  const coloresVisibles = todosColores.slice(0, FYL_ORIGINALS_MAX_VISIBLE_COLORS);
  const hayMas = todosColores.length > FYL_ORIGINALS_MAX_VISIBLE_COLORS;

  return `
    <div class="fyl-originals-colors">
      ${coloresVisibles.map((c) => `
        <button class="color-dot color-dot-btn" 
             style="background-color: ${c.hex};"
             data-color-image="${c.imagen || ''}"
             data-card-index="${cardIndex}"
             title="${c.color}"
             type="button">
        </button>
      `).join('')}
      ${hayMas ? `<span class="color-dot color-dot-more" title="Más colores" aria-hidden="true">+</span>` : ''}
    </div>
  `;
}

// Renderizar card individual de producto
function renderFYLProductCard(producto, index) {
  const skuDefecto = obtenerSKUDefecto(producto);
  const imagen = producto.VariantePrincipal || producto.DetalleColor?.[0]?.images?.[0] || '';
  const precioDisplay = producto.OfertaActiva && producto.PrecioOferta 
    ? producto.PrecioOferta 
    : producto.Precio;
  
  const precioFormateado = formatPrice(precioDisplay);
  const colorDots = renderColorDots(producto, index);

  const nombreProducto = producto.Articulo || producto.Descripcion || 'Producto';
  
  return `
    <div class="fyl-originals-card" 
         data-articulo="${producto.Articulo}"
         data-sku="${skuDefecto || ''}">
      <div class="fyl-originals-badge">${nombreProducto}</div>
      <img class="fyl-originals-card-image" 
           src="${cloudinaryOptimized(imagen, 400)}" 
           alt="${producto.Descripcion || producto.Articulo}"
           loading="lazy"
           data-sku="${skuDefecto || ''}">
      ${colorDots}
      <div class="fyl-originals-card-content">
        <div class="fyl-originals-card-price">${precioFormateado}</div>
        <div class="fyl-originals-card-wholesale">Precio por Mayor</div>
      </div>
    </div>
  `;
}

// Función helper para obtener SKU defecto (reutilizar de main-supabase.js si está disponible)
function obtenerSKUDefecto(producto) {
  if (!producto || !producto.DetalleColor) return null;
  
  // Buscar en skuIndex si está disponible
  if (typeof window !== 'undefined' && window.skuIndex) {
    for (const detalleColor of producto.DetalleColor) {
      if (!detalleColor.variantDetails) continue;
      
      const conStock = detalleColor.variantDetails.find(vd => 
        vd.sku && (vd.available === null || vd.available > 0)
      );
      if (conStock && conStock.sku) return conStock.sku;
      
      const primerSku = detalleColor.variantDetails.find(vd => vd.sku);
      if (primerSku && primerSku.sku) return primerSku.sku;
    }
  }
  
  return null;
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
function renderMoreFYLProducts(products, startIndex, count) {
  const scrollContainer = document.getElementById("fyl-originals-scroll");
  if (!scrollContainer) return;

  const endIndex = Math.min(startIndex + count, products.length);
  const productsToAdd = products.slice(startIndex, endIndex);

  productsToAdd.forEach((producto, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;
    const cardHTML = renderFYLProductCard(producto, globalIndex);
    scrollContainer.insertAdjacentHTML('beforeend', cardHTML);
  });

  // Configurar event listeners para las nuevas cards
  setupFYLCardListeners(scrollContainer, startIndex, endIndex);
  
  return endIndex;
}

// Configurar event listeners para las cards
function setupFYLCardListeners(scrollContainer, startIndex = 0, endIndex = null) {
  const allCards = scrollContainer.querySelectorAll('.fyl-originals-card');
  const cards = endIndex !== null 
    ? Array.from(allCards).slice(startIndex, endIndex)
    : Array.from(allCards).slice(startIndex);

  cards.forEach((card, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;
    
    // Configurar click en puntos de color usando delegación de eventos
    card.querySelectorAll('.color-dot-btn').forEach(dot => {
      dot.setAttribute('data-card-index', globalIndex);
      
      // Remover listeners previos si existen
      const newDot = dot.cloneNode(true);
      dot.parentNode.replaceChild(newDot, dot);
      
      newDot.addEventListener('click', (e) => {
        e.stopPropagation();
        // En el banner F&L Originals no cambiamos la imagen al seleccionar color
      });
    });

    // Configurar click en la card para abrir PDP
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const sku = card.dataset.sku;
      const articulo = card.dataset.articulo;
      
      if (sku && typeof window.abrirModalPorSKU === 'function') {
        const abierto = window.abrirModalPorSKU(sku, { pushState: true });
        if (abierto) return;
      }
      
      const productoEncontrado = fylProducts.find(p => 
        (p.Articulo || "").trim() === (articulo || "").trim()
      );
      
      if (productoEncontrado) {
        let skuDisponible = null;
        for (const detalleColor of productoEncontrado.DetalleColor || []) {
          if (!detalleColor.variantDetails) continue;
          const conStock = detalleColor.variantDetails.find(vd => 
            vd.sku && (vd.available === null || vd.available > 0)
          );
          if (conStock && conStock.sku) {
            skuDisponible = conStock.sku;
            break;
          }
          const primerSku = detalleColor.variantDetails.find(vd => vd.sku);
          if (primerSku && primerSku.sku) {
            skuDisponible = primerSku.sku;
            break;
          }
        }
        
        if (skuDisponible && typeof window.abrirModalPorSKU === 'function') {
          window.abrirModalPorSKU(skuDisponible, { pushState: true });
          return;
        }
        
        // Fallback: abrir con producto directo si no hay SKU (abrirModalConResultado)
        if (typeof window.abrirModalConResultado === 'function') {
          const primerColor = productoEncontrado.DetalleColor?.[0]?.color || null;
          window.abrirModalConResultado(
            { producto: productoEncontrado, color: primerColor, talle: null },
            { pushState: true }
          );
          return;
        }
        
        const cardsEnCatalogo = document.querySelectorAll(`.card.producto`);
        for (const cardEnCatalogo of cardsEnCatalogo) {
          const cardArticulo = cardEnCatalogo.querySelector('.article-box')?.textContent?.trim();
          if (cardArticulo === (articulo || "").trim()) {
            cardEnCatalogo.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => {
              const img = cardEnCatalogo.querySelector('.main-image');
              if (img) img.click();
              else cardEnCatalogo.click();
            }, 300);
            return;
          }
        }
      }
    });
  });
}

// Manejar scroll horizontal para cargar más productos
function setupFYLScrollListener(scrollContainer, allProducts) {
  // Remover listener previo si existe
  if (scrollListenerAttached && currentScrollHandler) {
    scrollContainer.removeEventListener('scroll', currentScrollHandler);
    scrollListenerAttached = false;
    currentScrollHandler = null;
  }

  let isLoading = false;
  
  currentScrollHandler = () => {
    // Verificar si ya se cargaron todos los productos
    if (fylProductsLoaded >= allProducts.length) {
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
      const nextIndex = renderMoreFYLProducts(allProducts, fylProductsLoaded, PRODUCTS_PER_PAGE);
      fylProductsLoaded = nextIndex;
      
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
export function renderFYLOriginalsBanner(products) {
  const banner = document.getElementById("fyl-originals-banner");
  const scrollContainer = document.getElementById("fyl-originals-scroll");
  
  if (!banner || !scrollContainer) {
    console.warn("⚠️ Contenedor de banner FYL no encontrado");
    return;
  }

  if (!products || products.length === 0) {
    banner.style.display = 'none';
    return;
  }

  // Resetear contador
  fylProductsLoaded = 0;

  // Limpiar contenedor
  scrollContainer.innerHTML = '';

  // Renderizar primeros productos (máximo 10)
  const initialCount = Math.min(PRODUCTS_PER_PAGE, products.length);
  fylProductsLoaded = renderMoreFYLProducts(products, 0, initialCount);

  // Configurar listener de scroll para cargar más productos
  setupFYLScrollListener(scrollContainer, products);


  // El CTA "Ver colección →" es un <a href="#/coleccion/fyl-originals">; el router maneja la navegación


  // Mostrar banner
  banner.style.display = 'block';
}

// Ocultar banner
export function hideFYLOriginalsBanner() {
  const banner = document.getElementById("fyl-originals-banner");
  if (banner) {
    banner.style.display = 'none';
  }
}

// Función principal para cargar y mostrar banner
export async function loadAndShowFYLBanner() {
  const products = await loadFYLOriginals();
  
  // Enriquecer productos con información de stock/variantes si es necesario
  if (products.length > 0 && typeof window.enrichProductsWithStock === 'function') {
    await window.enrichProductsWithStock(products);
  }
  
  renderFYLOriginalsBanner(products);
}

// Exportar funciones globalmente
if (typeof window !== 'undefined') {
  window.loadAndShowFYLBanner = loadAndShowFYLBanner;
  window.hideFYLOriginalsBanner = hideFYLOriginalsBanner;
}