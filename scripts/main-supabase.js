// scripts/main-supabase.js - Versión que prioriza Supabase con fallback a Google Sheets
// Esta versión carga productos desde Supabase primero, y si falla, usa Google Sheets

import {
  SUPABASE_URL as CONFIG_SUPABASE_URL,
  SUPABASE_ANON_KEY as CONFIG_SUPABASE_ANON_KEY,
  USE_SUPABASE as CONFIG_USE_SUPABASE,
  USE_OPEN_SHEET_FALLBACK as CONFIG_USE_OPEN_SHEET_FALLBACK,
  configReady,
} from "./config.js";
import { supabase as supabaseClient } from "./supabase-client.js";

await configReady;

// Constantes
const SHEET_ID = "1kdhxSWHl3Rg0tXpaRsKhR_m30oTZhzqYj5ypsjtcTig";
const CATEGORIAS = ["Calzado", "Ropa", "Lenceria", "Marroquineria"];

// Configuración ya resuelta
const SUPABASE_URL = CONFIG_SUPABASE_URL;
const SUPABASE_ANON_KEY = CONFIG_SUPABASE_ANON_KEY;
const USE_SUPABASE = CONFIG_USE_SUPABASE;
const USE_OPEN_SHEET_FALLBACK = CONFIG_USE_OPEN_SHEET_FALLBACK;

// Cliente de Supabase (se toma del módulo dedicado; usar siempre la instancia global si existe)
let supabase = supabaseClient;

// Asegurar que usamos la instancia global si existe (para evitar múltiples instancias)
if (typeof window !== "undefined" && window.supabase && typeof window.supabase.from === 'function') {
  supabase = window.supabase;
}

// Variables globales para modal de producto con SKU
let skuIndex = new Map(); // sku -> { producto, color, talle, variant_id, available, image }
let productoActualEnModal = null;
let modalEventsInitialized = false;
let gridEventsInitialized = false;
let escInit = false;
let ultimoTabSlug = null; // Para trackear cambios de tab en popstate

// Constantes para slugs de categorías
const TAB_SLUGS = {
  'calzado': 'Calzado',
  'ropa': 'Ropa',
  'lenceria': 'Lenceria',
  'marroquineria': 'Marroquineria',
  'novedades': 'Novedades',
  'ofertas': 'Ofertas'
};

const CATEGORIA_TO_SLUG = {
  'Calzado': 'calzado',
  'Ropa': 'ropa',
  'Lenceria': 'lenceria',
  'Marroquineria': 'marroquineria',
  'Novedades': 'novedades',
  'Ofertas': 'ofertas',
  // Mapeos de botones
  'Lencería': 'lenceria',
  'Accesorios': 'marroquineria'
};

// Utilidades básicas
function parseFecha(str) {
  if (!str) return new Date(2000, 0, 1);
  const [d, m, y] = str.split("/").map((n) => parseInt(n, 10));
  if (!d || !m || !y) return new Date(2000, 0, 1);
  return new Date(y, m - 1, d);
}

function cloudinaryOptimized(url, w) {
  if (!url || typeof url !== "string") return url || "";
  url = url.startsWith("http://") ? url.replace("http://", "https://") : url;
  return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${w}/`);
}

// Inicializar Supabase
async function inicializarSupabase() {
  try {
    // Verificar configuración
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error(
        "❌ Configuración de Supabase no encontrada. Verifica config.js o config.local.js"
      );
      return false;
    }

    console.log("🔧 Configuración Supabase cargada:", {
      URL: SUPABASE_URL,
      KEY: SUPABASE_ANON_KEY ? "Configurada" : "No configurada",
      USE_SUPABASE: USE_SUPABASE,
      FALLBACK: USE_OPEN_SHEET_FALLBACK,
    });

    // Usar SOLO el cliente importado de supabase-client.js (evitar crear múltiples instancias)
    if (!supabase || !supabase.from) {
      console.error("❌ Cliente de Supabase no disponible. Verifica que supabase-client.js se cargue correctamente.");
      return false;
    }
    
    // Asegurar que el cliente esté disponible globalmente
    if (typeof window !== "undefined") {
      window.supabase = supabase;
      window.supabaseClient = supabase;
    }
    console.log("✅ Cliente de Supabase disponible (usando instancia única de supabase-client.js)");

    // Verificar que el cliente funciona haciendo una consulta de prueba
    const { data: testData, error: testError } = await supabase
      .from("catalog_public_view")
      .select("count", { count: "exact", head: true })
      .limit(1);

    if (testError) {
      console.error("❌ Error verificando conexión a Supabase:", testError);
      console.error("Detalles:", {
        message: testError.message,
        details: testError.details,
        hint: testError.hint,
      });
      return false;
    }

    console.log("✅ Supabase inicializado y verificado correctamente");
    return true;
  } catch (error) {
    console.error("❌ Error inicializando Supabase:", error);
    console.error("Stack:", error.stack);
    return false;
  }
}

// Cargar datos desde Supabase
async function cargarDesdeSupabase(cat) {
  if (!supabase) {
    throw new Error("Cliente de Supabase no disponible");
  }

  try {
    console.log(`🗄️ Cargando desde Supabase: ${cat}`);

    // Primero, verificar qué categorías existen en la vista
    const { data: allCategories, error: catError } = await supabase
      .from("catalog_public_view")
      .select("Categoria")
      .limit(100);
    
    if (!catError && allCategories) {
      const uniqueCategories = [...new Set(allCategories.map(c => c.Categoria))];
      console.log(`📋 Categorías disponibles en la vista:`, uniqueCategories);
      console.log(`🔍 Buscando categoría: "${cat}"`);
      
      // Verificar si la categoría existe (case-insensitive)
      const categoryExists = uniqueCategories.some(c => 
        c && c.toLowerCase() === cat.toLowerCase()
      );
      
      if (!categoryExists && cat !== "Novedades" && cat !== "Ofertas") {
        console.warn(`⚠️ La categoría "${cat}" no existe en la vista.`);
        console.warn(`💡 Categorías disponibles: ${uniqueCategories.join(", ")}`);
      }
    }

    let query = supabase.from("catalog_public_view").select("*");

    if (cat === "Novedades" || cat === "Ofertas" || cat === "all") {
      // Para categorías especiales o 'all', cargar todas las categorías
      console.log(`📦 Cargando todas las categorías para: ${cat}`);
      const { data, error } = await query;
      if (error) {
        console.error("❌ Error en consulta:", error);
        throw error;
      }

      console.log(`📊 Total de registros obtenidos: ${data?.length || 0}`);
      let items = data || [];

      if (cat === "Novedades") {
        const hoy = new Date();
        const hace7 = new Date(
          hoy.getFullYear(),
          hoy.getMonth(),
          hoy.getDate() - 7
        );
        items = items.filter((i) => {
          const mostrar = i.Mostrar;
          const mostrarOk = mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
          return mostrarOk && i.FechaIngreso && parseFecha(i.FechaIngreso) >= hace7;
        });
        console.log(`🆕 Productos de novedades (últimos 7 días): ${items.length}`);
      }

      if (cat === "Ofertas") {
        items = items.filter((i) => {
          const mostrar = i.Mostrar;
          const oferta = i.Oferta;
          const mostrarOk = mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
          const ofertaOk = oferta === "TRUE" || oferta === true || oferta === "true" || oferta === 1;
          return mostrarOk && ofertaOk;
        });
        console.log(`🔥 Productos en ofertas: ${items.length}`);
      }

      return items;
    } else {
      // Para categorías normales, filtrar por categoría
      console.log(`📦 Filtrando por categoría: "${cat}"`);
      const { data, error } = await query.eq("Categoria", cat);
      
      if (error) {
        console.error("❌ Error en consulta filtrada:", error);
        console.error("Detalles del error:", {
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      console.log(`📊 Registros obtenidos antes de filtrar Mostrar: ${data?.length || 0}`);
      
      // La vista devuelve Mostrar como booleano true, no como string "TRUE"
      // Aceptar ambos: true (booleano) y "TRUE" (string)
      const filtered = (data || []).filter((i) => {
        const mostrar = i.Mostrar;
        return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
      });
      console.log(`✅ Registros después de filtrar Mostrar: ${filtered.length}`);
      
      if (filtered.length === 0 && data && data.length > 0) {
        console.warn(`⚠️ Hay ${data.length} registros pero ninguno pasa el filtro de Mostrar`);
        console.warn(`📋 Primeros registros (mostrando valor de Mostrar):`, data.slice(0, 3).map(r => ({
          Articulo: r.Articulo,
          Mostrar: r.Mostrar,
          MostrarType: typeof r.Mostrar,
          Categoria: r.Categoria
        })));
        console.warn(`💡 La vista devuelve Mostrar como: ${typeof data[0]?.Mostrar} (valor: ${data[0]?.Mostrar})`);
      }
      
      return filtered;
    }
  } catch (error) {
    console.error("❌ Error cargando desde Supabase:", error);
    console.error("Stack:", error.stack);
    throw error;
  }
}

// Cargar datos desde Google Sheets (fallback)
async function cargarDesdeGoogleSheets(cat) {
  console.log(`📊 Cargando desde Google Sheets (fallback): ${cat}`);

  try {
    let data = [];

    if (cat === "Novedades" || cat === "Ofertas") {
      // Para categorías especiales, cargar todas las categorías
      const promises = CATEGORIAS.map((categoria) =>
        fetch(`https://opensheet.elk.sh/${SHEET_ID}/${categoria}`)
          .then((r) => r.json())
          .catch(() => [])
      );
      const allData = await Promise.all(promises);
      data = allData.flat();
    } else {
      // Para categorías normales, cargar solo esa categoría
      const response = await fetch(
        `https://opensheet.elk.sh/${SHEET_ID}/${cat}`
      );
      data = await response.json();
    }

    // Filtrar productos que se deben mostrar
    let items = data.filter((i) => i.Mostrar === "TRUE");

    // Filtrar según categoría especial
    if (cat === "Novedades") {
      const hoy = new Date();
      const hace7 = new Date(
        hoy.getFullYear(),
        hoy.getMonth(),
        hoy.getDate() - 7
      );
      items = items.filter(
        (i) => i.FechaIngreso && parseFecha(i.FechaIngreso) >= hace7
      );
    }

    if (cat === "Ofertas") {
      items = items.filter((i) => i.Oferta === "TRUE");
    }

    return items;
  } catch (error) {
    console.error("❌ Error cargando desde Google Sheets:", error);
    throw error;
  }
}

// Función principal de carga de categoría
async function cargarCategoria(cat) {
  console.log("🔄 Cargando categoría:", cat);

  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");

  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";

  try {
    let data = [];
    let fuente = "Supabase";

    // SOLO cargar desde Supabase - NO usar Google Sheets
    if (!supabase) {
      console.error("❌ Cliente de Supabase no disponible");
      throw new Error(
        "Cliente de Supabase no disponible. Verifica la configuración en config.js o config.local.js"
      );
    }

    console.log(`🔄 Intentando cargar categoría "${cat}" desde Supabase...`);
    console.log(`🔧 Cliente Supabase disponible:`, supabase ? "SÍ" : "NO");
    
    data = await cargarDesdeSupabase(cat);
    console.log(`✅ Datos cargados desde Supabase: ${data.length} productos`);
    console.log(`📊 Fuente de datos: ${fuente}`);
    
    // Log detallado de los primeros productos
    if (data.length > 0) {
      console.log("📋 Primeros productos cargados:", data.slice(0, 3).map(p => ({
        Articulo: p.Articulo,
        Categoria: p.Categoria,
        Color: p.Color,
        OfertaActiva: p.OfertaActiva,
        PrecioOferta: p.PrecioOferta,
        PromoActiva: p.PromoActiva
      })));
      
      // Verificar si hay ofertas activas
      const productosConOferta = data.filter(p => p.OfertaActiva === true || p.OfertaActiva === 'true');
      if (productosConOferta.length > 0) {
        console.log(`🔥 Se encontraron ${productosConOferta.length} variantes con ofertas activas`);
        console.log("📊 Ejemplos de ofertas:", productosConOferta.slice(0, 3).map(p => ({
          Articulo: p.Articulo,
          Color: p.Color,
          PrecioOriginal: p.Precio,
          PrecioOferta: p.PrecioOferta
        })));
      }
    } else {
      console.warn("⚠️ No se cargaron productos. Verifica:");
      console.warn("   - Que la categoría existe en la base de datos");
      console.warn("   - Que los productos tienen status = 'active'");
      console.warn("   - Que los productos tienen variantes activas");
    }

    if (data.length === 0) {
      if (cont) {
        cont.innerHTML =
          '<div class="no-data">No hay productos disponibles en esta categoría</div>';
      }
      console.log("⚠️ No hay productos para mostrar en la categoría:", cat);
      return;
    }

    // Ordenar por fecha de ingreso
    data.sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });

    // Agrupar productos por artículo
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
          // Preservar información de ofertas y promociones
          OfertaActiva: false,
          PrecioOferta: '',
          PromoActiva: '',
          DetalleColor: [],
        };
      }

      // Si esta variante tiene oferta activa, actualizar la información del producto
      // Priorizar la oferta del color que tiene la imagen principal
      if (i.OfertaActiva === true || i.OfertaActiva === 'true') {
        acc[art].OfertaActiva = true;
        // Si esta es la variante con imagen principal, usar su precio de oferta
        if (i["Imagen Principal"] && i["Imagen Principal"] === acc[art].VariantePrincipal) {
          acc[art].PrecioOferta = i.PrecioOferta || acc[art].PrecioOferta;
        } else if (!acc[art].PrecioOferta) {
          // Si no hay precio de oferta aún, usar el primero encontrado
          acc[art].PrecioOferta = i.PrecioOferta || '';
        }
      }

      // Si esta variante tiene promoción activa, actualizar la información del producto
      if (i.PromoActiva && i.PromoActiva !== '') {
        acc[art].PromoActiva = i.PromoActiva;
      }

      acc[art].DetalleColor.push({
        color: i.Color || "Sin color",
        talles: i.Numeracion?.split(",").map((t) => t.trim()) || ["Único"],
        images: Object.keys(i)
          .filter((k) => k.toLowerCase().startsWith("imagen"))
          .map((k) => i[k])
          .filter(Boolean),
        // Preservar información de ofertas por color
        OfertaActiva: i.OfertaActiva === true || i.OfertaActiva === 'true',
        PrecioOferta: i.PrecioOferta || '',
        PromoActiva: i.PromoActiva || '',
      });

      return acc;
    }, {});

    console.log(`📦 Productos agrupados: ${Object.keys(grupos).length}`);

    // Obtener ofertas activas con imágenes
    let offersCards = [];
    try {
      const { data: offers, error: offersError } = await supabase
        .rpc('get_active_offers_with_images');
      
      if (!offersError && offers && offers.length > 0) {
        console.log(`🔥 Se encontraron ${offers.length} campañas de ofertas con imágenes`);
        offersCards = offers.map(offer => ({
          type: 'offer',
          campaignId: offer.offer_campaign_id,
          imageUrl: offer.offer_image_url,
          title: offer.offer_title,
          productCount: offer.product_count,
          startDate: offer.start_date,
          endDate: offer.end_date
        }));
      }
    } catch (error) {
      console.warn('Error obteniendo ofertas con imágenes:', error);
    }

    // Renderizar productos y ofertas
    await renderizarProductos(Object.values(grupos), cont, offersCards);

    // Configurar eventos
    configurarEventos();
    
    // Si hay un SKU en la URL y el modal ya está abierto, verificar si ahora está en skuIndex
    // y actualizar si es necesario (para mejorar la experiencia cuando se carga la categoría)
    const urlParams = new URLSearchParams(window.location.search);
    const sku = urlParams.get('sku');
    if (sku) {
      const modal = document.getElementById('product-modal');
      if (modal && modal.classList.contains('active') && modal.dataset.sku === sku) {
        // El modal ya está abierto con este SKU, verificar si ahora está en skuIndex
        if (skuIndex.has(sku)) {
          // Ahora está en skuIndex, re-renderizar con datos actualizados
          abrirModalPorSKU(sku, { pushState: false });
        }
      } else if (skuIndex.has(sku)) {
        // Hay SKU en URL y ahora está en skuIndex, abrir modal
        abrirModalPorSKU(sku, { pushState: false });
      }
    }
  } catch (error) {
    console.error("❌ Error cargando categoría:", error);
    console.error("Detalles del error:", {
      message: error.message,
      stack: error.stack,
      categoria: cat,
    });
    
    if (cont) {
      const errorDetails = error.message || "Error desconocido";
      cont.innerHTML = `
        <div class="error-message" style="text-align: center; padding: 40px; color: #666; background: #f8f9fa; border-radius: 8px; margin: 20px;">
          <h3>⚠️ Error al cargar productos desde Supabase</h3>
          <p style="color: #c0392b; font-weight: bold; margin: 15px 0;">${errorDetails}</p>
          <p>No se pudieron cargar los productos desde la base de datos. Verifica:</p>
          <ul style="text-align: left; margin: 20px 0; max-width: 600px; margin-left: auto; margin-right: auto;">
            <li>Que tu configuración de Supabase sea correcta (config.js o config.local.js)</li>
            <li>Que la vista 'catalog_public_view' exista y tenga datos</li>
            <li>Que los permisos RLS estén configurados correctamente</li>
            <li>Que la categoría "${cat}" exista en la base de datos</li>
          </ul>
          <p style="margin-top: 20px; font-size: 12px; color: #999;">Revisa la consola del navegador para más detalles.</p>
          <button onclick="location.reload()" style="background: #CD844D; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 15px;">Reintentar</button>
        </div>
      `;
    }
  } finally {
    if (loader) loader.classList.remove("show");
  }
}

// Funciones auxiliares para renderizar ofertas y promociones
function renderOfferAndPromoBadges(producto) {
  // Si hay promo, solo mostrar badge de promo (prioridad)
  if (producto.PromoActiva && producto.PromoActiva !== '') {
    return `<div class="tags"><div class="talle tag-chip promo-chip">${producto.PromoActiva}</div></div>`;
  }
  // Si hay oferta activa, mostrar badge de oferta
  if (producto.OfertaActiva === true || producto.OfertaActiva === 'true') {
    return '<div class="tags"><div class="talle tag-chip oferta-chip" data-oferta="1">🔥 Oferta</div></div>';
  }
  return '';
}

function renderOfferFireIcon(producto) {
  // Si hay promo, no mostrar fuego (prioridad)
  if (producto.PromoActiva && producto.PromoActiva !== '') {
    return '';
  }
  // Si hay oferta activa, mostrar fuego
  if (producto.OfertaActiva === true || producto.OfertaActiva === 'true') {
    return ' <span class="article-fire">🔥</span>';
  }
  return '';
}

function renderPriceWithOffer(producto) {
  const hasOffer = producto.OfertaActiva === true || producto.OfertaActiva === 'true';
  const hasPromo = producto.PromoActiva && producto.PromoActiva !== '';
  const originalPrice = producto.Precio || '';
  const offerPrice = producto.PrecioOferta || '';
  
  // Si hay promo, mostrar precio original con badge de promo (sin oferta)
  if (hasPromo) {
    return `
      <div class="price">${originalPrice}</div>
    `;
  }
  
  // Si hay oferta, mostrar precio original tachado y precio de oferta
  if (hasOffer && offerPrice) {
    // Formatear precio de oferta si no tiene símbolo de peso
    let formattedOfferPrice = offerPrice;
    if (offerPrice && !offerPrice.includes('$')) {
      formattedOfferPrice = `$${offerPrice}`;
    }
    
    return `
      <div class="price">
        <span class="price-original">${originalPrice}</span>
        <span class="price-offer">${formattedOfferPrice}</span>
      </div>
    `;
  }
  
  // Precio normal
  return `<div class="price">${originalPrice}</div>`;
}

// Función para renderizar card de oferta
function renderOfferCard(offer) {
  const title = offer.title || 'Oferta Especial';
  const productCount = offer.productCount || 0;
  
  return `
    <div class="card offer-card" data-offer-campaign-id="${offer.campaignId}" style="cursor: pointer; border: 3px solid #ff9800; position: relative; overflow: hidden;">
      <div style="position: relative; width: 100%; padding-top: 100%; background: #fff;">
        <img src="${offer.imageUrl}" alt="${title}" 
             style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: cover;"
             onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'400\\' height=\\'400\\'%3E%3Crect width=\\'400\\' height=\\'400\\' fill=\\'%23ff9800\\'/%3E%3Ctext x=\\'50%25\\' y=\\'50%25\\' text-anchor=\\'middle\\' dy=\\'.3em\\' fill=\\'white\\' font-size=\\'24\\' font-weight=\\'bold\\'%3EOferta%3C/text%3E%3C/svg%3E'">
        <div style="position: absolute; top: 0; left: 0; right: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); padding: 12px;">
          <div class="oferta-chip" style="display: inline-block; background: #ff9800; color: white; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;">🔥 Oferta</div>
        </div>
        <div style="position: absolute; bottom: 0; left: 0; right: 0; background: linear-gradient(to top, rgba(0,0,0,0.8), transparent); padding: 16px; color: white;">
          <h3 style="margin: 0 0 8px; font-size: 18px; font-weight: 600; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">${title}</h3>
          <p style="margin: 0; font-size: 14px; opacity: 0.9;">${productCount} producto${productCount !== 1 ? 's' : ''} en oferta</p>
        </div>
      </div>
    </div>
  `;
}

// Función para renderizar productos (igual que antes)
async function renderizarProductos(productos, container, offersCards = []) {
  await enrichProductsWithStock(productos);
  
  // Crear array combinado de productos y ofertas
  const allItems = [];
  
  // Agregar ofertas al inicio (destacadas)
  offersCards.forEach(offer => {
    allItems.push({ type: 'offer', data: offer });
  });
  
  // Agregar productos
  productos
    .sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    })
    .forEach((producto) => {
      allItems.push({ type: 'product', data: producto });
    });
  
  // Renderizar todos los items
  allItems.forEach((item) => {
    if (item.type === 'offer') {
      const offerCardHTML = renderOfferCard(item.data);
      container.insertAdjacentHTML('beforeend', offerCardHTML);
    } else {
      const producto = item.data;
      const gal = renderizarGaleria(producto);
      const colores = renderizarColores(producto);
      const variants = renderizarVariantes(producto);
      const tags = renderizarTags(producto);
      
      // Obtener SKU por defecto para la card
      const skuDefecto = obtenerSKUDefecto(producto);

      const productoHTML = `
        <div class="card producto"
             data-filtro1="${producto.Filtro1 || ""}"
             data-filtro2="${producto.Filtro2 || ""}"
             data-filtro3="${producto.Filtro3 || ""}"
             data-sku="${skuDefecto || ''}">
          <div class="download-container">
            <button class="download-btn" onclick="window.downloadImage(this)">
              <svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
                <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/>
                <polyline points='7 10 12 15 17 10'/>
                <line x1='12' y1='15' x2='12' y2='3'/>
              </svg>
            </button>
            <button class="download-btn share-btn" title="Compartir imagen" style="margin-top:8px;">
              <svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
                <circle cx='18' cy='5' r='3'/>
                <circle cx='6' cy='12' r='3'/>
                <circle cx='18' cy='19' r='3'/>
                <line x1='8.59' y1='13.51' x2='15.42' y2='17.49'/>
                <line x1='15.41' y1='6.51' x2='8.59' y2='10.49'/>
              </svg>
            </button>
          </div>
          <img class="main-image" loading="lazy" 
               src="${cloudinaryOptimized(producto.VariantePrincipal, 800)}" 
               alt="${producto.Articulo}"
               data-sku="${skuDefecto || ''}"/>
          <div class="image-loader"><div class="spinner"></div></div>
          <div class="gallery">${gal}</div>
          ${renderOfferAndPromoBadges(producto)}
          ${tags}
          <div class="title-row">
            <h3>Art: <span class="article-box">${producto.Articulo}</span>${renderOfferFireIcon(producto)}</h3>
            <div class="colors">${colores}</div>
          </div>
          <div class="description">${producto.Descripcion || ""}</div>
          <div class="price-container">
            ${renderPriceWithOffer(producto)}
          </div>
          ${variants}
        </div>
      `;

      container.innerHTML += productoHTML;
    }
  });
  
  // Agregar event listeners a los cards de oferta
  container.querySelectorAll('.offer-card').forEach(card => {
    card.addEventListener('click', () => {
      const campaignId = card.dataset.offerCampaignId;
      if (campaignId) {
        filterByOffer(campaignId);
      }
    });
  });
}

// Función para filtrar productos por oferta
async function filterByOffer(campaignId) {
  console.log('🔥 Filtrando productos por oferta:', campaignId);
  
  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");
  
  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";
  
  try {
    // Cargar todos los productos con ofertas activas
    const data = await cargarDesdeSupabase('all');
    
    // Filtrar solo productos que tienen oferta activa
    const productosConOferta = data.filter(p => 
      (p.OfertaActiva === true || p.OfertaActiva === 'true') &&
      p.OfferCampaignId === campaignId
    );
    
    if (productosConOferta.length === 0) {
      cont.innerHTML = '<div class="no-data">No hay productos disponibles en esta oferta</div>';
      return;
    }
    
    // Agrupar productos
    const grupos = productosConOferta.reduce((acc, i) => {
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

      if (i.OfertaActiva === true || i.OfertaActiva === 'true') {
        if (!acc[art].OfertaActiva || !acc[art].PrecioOferta) {
          acc[art].OfertaActiva = true;
          acc[art].PrecioOferta = i.PrecioOferta || '';
        }
      }

      if (i.PromoActiva && i.PromoActiva !== '') {
        acc[art].PromoActiva = i.PromoActiva;
      }

      const colorExists = acc[art].DetalleColor.find(c => c.color === i.Color);
      if (!colorExists) {
        acc[art].DetalleColor.push({
          color: i.Color,
          talles: i.Numeracion?.split(",").map(t => t.trim()).filter(Boolean) || [],
          images: [
            i["Imagen Principal"],
            i["Imagen 1"],
            i["Imagen 2"],
            i["Imagen 3"],
          ].filter(Boolean),
        });
      } else {
        const talles = i.Numeracion?.split(",").map(t => t.trim()).filter(Boolean) || [];
        talles.forEach(talle => {
          if (!colorExists.talles.includes(talle)) {
            colorExists.talles.push(talle);
          }
        });
      }

      return acc;
    }, {});
    
    // Mostrar mensaje indicando que se están mostrando ofertas
    const messageHTML = `
      <div style="background: #fff3e0; border-left: 4px solid #ff9800; padding: 16px; margin-bottom: 20px; border-radius: 8px;">
        <h3 style="margin: 0 0 8px; color: #ff9800; font-size: 18px;">🔥 Productos en Oferta</h3>
        <p style="margin: 0; color: #666;">Mostrando ${Object.keys(grupos).length} producto${Object.keys(grupos).length !== 1 ? 's' : ''} con ofertas activas</p>
        <button onclick="location.reload()" style="margin-top: 12px; padding: 8px 16px; background: #CD844D; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">Ver todos los productos</button>
      </div>
    `;
    cont.innerHTML = messageHTML;
    
    // Renderizar productos
    await renderizarProductos(Object.values(grupos), cont, []);
    
    // Configurar eventos
    configurarEventos();
  } catch (error) {
    console.error('Error filtrando por oferta:', error);
    cont.innerHTML = '<div class="no-data">Error al cargar productos en oferta</div>';
  } finally {
    if (loader) loader.classList.remove("show");
  }
}

// Funciones auxiliares de renderizado (igual que antes)
function renderizarGaleria(producto) {
  return producto.DetalleColor.flatMap((v) => v.images)
    .map((src) => {
      const thumb = cloudinaryOptimized(src, 200);
      const full = cloudinaryOptimized(src, 800);
      return `<img loading="lazy" src="${thumb}" data-full="${full}" alt="Miniatura de producto" class="miniatura">`;
    })
    .join("");
}

async function enrichProductsWithStock(productos = []) {
  try {
    // Limpiar skuIndex antes de reconstruirlo
    skuIndex.clear();
    
    const nombres = [
      ...new Set(
        productos
          .map((p) => (p.Articulo || "").trim())
          .filter((nombre) => nombre.length > 0)
      ),
    ];

    if (!nombres.length) return;

    const { data, error } = await supabase
      .from("products")
      .select(
        "name, product_variants(id, color, size, reserved_qty, active, sku)"
      )
      .in("name", nombres);

    if (error) {
      console.warn(
        "⚠️ No se pudieron obtener las variantes para los productos:",
        error.message
      );
      return;
    }

    const variantesPorProducto = new Map();
    const allVariantIds = [];
    (data || []).forEach((producto) => {
      const variants = producto.product_variants || [];
      variants.forEach(v => {
        if (v.id) allVariantIds.push(v.id);
      });
      variantesPorProducto.set(
        (producto.name || "").trim().toLowerCase(),
        variants
      );
    });

    // Obtener stock total de todas las variantes de una vez
    const stockMap = new Map();
    if (allVariantIds.length > 0) {
      try {
        const { data: stockData, error: stockError } = await supabase
          .from("variant_warehouse_stock")
          .select("variant_id, stock_qty")
          .in("variant_id", allVariantIds);

        if (!stockError && stockData) {
          stockData.forEach(row => {
            const current = stockMap.get(row.variant_id) || 0;
            stockMap.set(row.variant_id, current + (Number(row.stock_qty) || 0));
          });
        }
      } catch (e) {
        console.warn("Error obteniendo stock de almacenes:", e);
      }
    }

    productos.forEach((producto) => {
      const clave = (producto.Articulo || "").trim().toLowerCase();
      const variantes = variantesPorProducto.get(clave);
      if (!variantes) return;

      producto.DetalleColor = (producto.DetalleColor || []).map((detalle) => {
        const variantDetails = (detalle.talles || []).map((talle) => {
          const variante = variantes.find((v) => {
            const colorVar = (v.color || "").trim().toLowerCase();
            const sizeVar = (v.size || "").trim().toLowerCase();
            return (
              colorVar === (detalle.color || "").trim().toLowerCase() &&
              sizeVar === (talle || "").trim().toLowerCase()
            );
          });

          const isActive = variante?.active !== false;
          // Obtener stock total de todos los almacenes desde el mapa
          const stock = isActive && variante?.id ? (stockMap.get(variante.id) || 0) : 0;
          const reserved = isActive ? Number(variante?.reserved_qty ?? 0) : 0;
          const available = Math.max(0, stock - reserved);

          // Construir skuIndex solo con variantes activas que tengan SKU
          if (isActive && variante?.sku && variante.sku.trim()) {
            const sku = variante.sku.trim();
            const detalleColor = producto.DetalleColor.find(d => 
              (d.color || "").trim().toLowerCase() === (variante.color || "").trim().toLowerCase()
            );
            const image = detalleColor?.images?.[0] || producto.VariantePrincipal || '';
            
            skuIndex.set(sku, {
              producto,
              color: detalleColor?.color || variante.color || "",
              talle,
              variant_id: variante.id,
              available,
              image
            });
          }

          return {
            talle,
            stock,
            reserved,
            available,
            variant_id: variante?.id || null,
            sku: variante?.sku || null,
          };
        });

        return {
          ...detalle,
          variantDetails,
        };
      });
    });
  } catch (error) {
    console.warn("⚠️ Error enriqueciendo productos con stock:", error.message);
  }
}

// Funciones helper para modal con SKU
function obtenerSKUDefecto(producto) {
  if (!producto || !producto.DetalleColor) return null;
  
  for (const detalleColor of producto.DetalleColor) {
    if (!detalleColor.variantDetails) continue;
    
    // Preferir el primer variantDetail con sku y stock (available null o >0)
    const conStock = detalleColor.variantDetails.find(vd => 
      vd.sku && (vd.available === null || vd.available > 0)
    );
    if (conStock && conStock.sku) return conStock.sku;
    
    // Si no hay con stock, el primer sku
    const primerSku = detalleColor.variantDetails.find(vd => vd.sku);
    if (primerSku && primerSku.sku) return primerSku.sku;
  }
  
  return null;
}

function obtenerPrimerSkuConStock(producto, color) {
  if (!producto || !producto.DetalleColor) return null;
  
  const detalleColor = producto.DetalleColor.find(d => 
    (d.color || "").trim().toLowerCase() === (color || "").trim().toLowerCase()
  );
  
  if (!detalleColor || !detalleColor.variantDetails) return null;
  
  // Buscar primer variantDetail con sku y stock válido (available null o >0)
  const conStock = detalleColor.variantDetails.find(vd => 
    vd.sku && (vd.available === null || vd.available > 0)
  );
  if (conStock && conStock.sku) {
    return {
      sku: conStock.sku,
      talle: conStock.talle,
      variantDetail: conStock
    };
  }
  
  // Si no hay con stock, el primer sku
  const primerSku = detalleColor.variantDetails.find(vd => vd.sku);
  if (primerSku && primerSku.sku) {
    return {
      sku: primerSku.sku,
      talle: primerSku.talle,
      variantDetail: primerSku
    };
  }
  
  return null;
}

function buscarPorSKU(sku) {
  if (!sku) return null;
  return skuIndex.get(sku.trim()) || null;
}

async function buscarPorSKUEnSupabase(sku) {
  if (!sku || !supabase) return null;
  
  try {
    // 1. Consultar product_variants por sku (y active=true)
    const { data: variantData, error: variantError } = await supabase
      .from("product_variants")
      .select("id, color, size, reserved_qty, product_id, name")
      .eq("sku", sku.trim())
      .eq("active", true)
      .limit(1);
    
    if (variantError || !variantData || variantData.length === 0) {
      return null;
    }
    
    const variant = variantData[0];
    const variantId = variant.id;
    
    // 2. Consultar variant_warehouse_stock y sumar stock_qty
    const { data: stockData, error: stockError } = await supabase
      .from("variant_warehouse_stock")
      .select("stock_qty")
      .eq("variant_id", variantId);
    
    let stockTotal = 0;
    if (!stockError && stockData) {
      stockTotal = stockData.reduce((sum, row) => sum + (Number(row.stock_qty) || 0), 0);
    }
    
    // 3. Calcular available = max(0, stock_total - reserved_qty)
    const reserved = Number(variant.reserved_qty || 0);
    const available = Math.max(0, stockTotal - reserved);
    
    // 4. Consultar producto padre
    const productId = variant.product_id;
    
    let productoData = null;
    if (productId) {
      const { data: prodData, error: prodError } = await supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .limit(1);
      
      if (!prodError && prodData && prodData.length > 0) {
        productoData = prodData[0];
      }
    }
    
    if (!productoData) return null;
    
    // 5. Determinar image (preferir imagen del color si existe; fallback a VariantePrincipal)
    // Necesitamos consultar variant_images o usar una imagen por defecto
    let image = productoData.VariantePrincipal || '';
    
    // Intentar obtener imagen del color desde variant_images
    const { data: variantImages, error: imgError } = await supabase
      .from("variant_images")
      .select("image_url")
      .eq("variant_id", variantId)
      .order("position", { ascending: true })
      .limit(1);
    
    if (!imgError && variantImages && variantImages.length > 0) {
      image = variantImages[0].image_url || image;
    }
    
    // 6. Construir "producto mínimo compatible"
    const producto = {
      Articulo: productoData.name || productoData.Articulo || '',
      Descripcion: productoData.description || productoData.Descripcion || '',
      VariantePrincipal: image,
      DetalleColor: [{
        color: variant.color || '',
        images: [image].filter(Boolean),
        variantDetails: [{
          talle: variant.size || '',
          sku: sku.trim(),
          variant_id: variantId,
          available: available,
          stock: stockTotal,
          reserved: reserved
        }]
      }]
    };
    
    // 7. Retornar resultado
    return {
      producto,
      color: variant.color || '',
      talle: variant.size || '',
      variant_id: variantId,
      available,
      image
    };
  } catch (error) {
    console.warn("⚠️ Error en buscarPorSKUEnSupabase:", error);
    return null;
  }
}

// Funciones helper para slugs y URLs
function validarSlugTab(slug) {
  return slug && TAB_SLUGS.hasOwnProperty(slug);
}

function categoriaToSlug(cat) {
  if (!cat) return null;
  // Si ya es un slug válido, devolverlo
  if (validarSlugTab(cat)) {
    return cat;
  }
  // Mapear desde CATEGORIA_TO_SLUG
  return CATEGORIA_TO_SLUG[cat] || null;
}

function slugToCategoria(slug) {
  if (!slug) return null;
  return TAB_SLUGS[slug] || null;
}

function getTabFromURL() {
  const urlParams = new URLSearchParams(window.location.search);
  const tabSlug = urlParams.get('tab');
  if (tabSlug && validarSlugTab(tabSlug)) {
    return tabSlug;
  }
  return null;
}

// Función unificada para actualizar URLs
// undefined = no tocar ese param, '' = borrar param, string = setear param
function updateURL({tab, sku}, {mode = 'replace'} = {}) {
  const url = new URL(window.location);
  
  // Manejar tab: undefined = no tocar, '' = borrar, string = setear
  if (tab !== undefined) {
    if (tab === '') {
      url.searchParams.delete('tab');
    } else {
      const slug = categoriaToSlug(tab);
      if (slug) {
        url.searchParams.set('tab', slug);
      }
    }
  }
  // Si tab === undefined, no hacer nada (preservar existente)
  
  // Manejar sku: undefined = no tocar, '' = borrar, string = setear
  if (sku !== undefined) {
    if (sku === '') {
      url.searchParams.delete('sku');
    } else {
      url.searchParams.set('sku', sku);
    }
  }
  // Si sku === undefined, no hacer nada (preservar existente)
  
  // Aplicar cambio según modo
  const state = { tab: url.searchParams.get('tab'), sku: url.searchParams.get('sku') };
  if (mode === 'push') {
    history.pushState(state, '', url);
  } else {
    history.replaceState(state, '', url);
  }
}

// Funciones de modal
function updateSKUEnURL(sku) {
  // Usar undefined para tab para preservar tab existente automáticamente
  updateURL({ tab: undefined, sku }, { mode: 'replace' });
}

function abrirModalPorSKU(sku, { pushState = true } = {}) {
  if (!sku) return false;
  
  const resultado = buscarPorSKU(sku);
  if (!resultado) return false;
  
  productoActualEnModal = resultado.producto;
  const modal = document.getElementById('product-modal');
  if (!modal) return false;
  
  // Guardar SKU en dataset
  modal.dataset.sku = sku;
  
  renderizarModalProducto(resultado.producto, resultado.color, resultado.talle);
  
  // Usar updateURL preservando tab existente
  updateURL({ tab: undefined, sku }, { mode: pushState ? 'push' : 'replace' });
  
  modal.classList.add('active');
  document.body.classList.add('modal-open');
  
  return true;
}

function abrirModalConResultado(resultado, { pushState = true } = {}) {
  if (!resultado || !resultado.producto) return false;
  
  productoActualEnModal = resultado.producto;
  const modal = document.getElementById('product-modal');
  if (!modal) return false;
  
  // Obtener SKU del resultado
  const sku = resultado.producto.DetalleColor?.[0]?.variantDetails?.[0]?.sku || '';
  
  // Guardar SKU en dataset
  if (sku) {
    modal.dataset.sku = sku;
  }
  
  renderizarModalProducto(resultado.producto, resultado.color, resultado.talle);
  
  // Usar updateURL preservando tab existente
  if (sku) {
    updateURL({ tab: undefined, sku }, { mode: pushState ? 'push' : 'replace' });
  }
  
  modal.classList.add('active');
  document.body.classList.add('modal-open');
  
  return true;
}

function cerrarModal() {
  const modal = document.getElementById('product-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.dataset.sku = ''; // Limpiar SKU del dataset
  }
  document.body.classList.remove('modal-open');
  productoActualEnModal = null;
  // Eliminar solo sku, preservar tab con undefined
  updateURL({ tab: undefined, sku: '' }, { mode: 'replace' });
}

// Función helper para mostrar toast
function showToast(message, type = 'error') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${type === 'error' ? '#dc3545' : '#17a2b8'};
    color: white;
    padding: 12px 20px;
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 10001;
    font-weight: 500;
    max-width: 300px;
    word-wrap: break-word;
    transform: translateX(100%);
    transition: transform 0.3s ease;
  `;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.style.transform = 'translateX(0)';
  }, 100);
  
  setTimeout(() => {
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, 3000);
}

async function inicializarModalDesdeURL() {
  const urlParams = new URLSearchParams(window.location.search);
  const sku = urlParams.get('sku');
  
  // SKU es fuente de verdad - si existe, siempre abrir modal
  if (!sku) return;
  
  // Si está en skuIndex, abrir normal
  if (skuIndex.has(sku)) {
    abrirModalPorSKU(sku, { pushState: false });
    return;
  }
  
  // Si no, usar fallback
  const resultado = await buscarPorSKUEnSupabase(sku);
  if (resultado) {
    abrirModalConResultado(resultado, { pushState: false });
  } else {
    // Mostrar mensaje en modal en lugar de alert
    const modal = document.getElementById('product-modal');
    const modalBody = document.getElementById('product-modal-body');
    if (modal && modalBody) {
      modalBody.innerHTML = `
        <div style="padding: 40px; text-align: center;">
          <h3 style="color: #dc3545; margin-bottom: 16px;">⚠️ Producto no disponible</h3>
          <p style="color: #666; margin-bottom: 20px;">El producto solicitado no está disponible en este momento.</p>
          <button onclick="window.cerrarModal()" style="
            background: #CD844D;
            color: white;
            border: none;
            padding: 10px 20px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
          ">Cerrar</button>
        </div>
      `;
      modal.classList.add('active');
      document.body.classList.add('modal-open');
    } else {
      // Fallback a toast si no hay modal disponible
      showToast('Producto no disponible', 'error');
    }
  }
}

// Funciones de renderizado del modal
function renderizarModalProducto(producto, colorSeleccionado, talleSeleccionado) {
  const modalBody = document.getElementById('product-modal-body');
  if (!modalBody) return;
  
  const detalleColor = producto.DetalleColor?.find(d => 
    (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase()
  ) || producto.DetalleColor?.[0];
  
  const imagenPrincipal = detalleColor?.images?.[0] || producto.VariantePrincipal || '';
  const gal = renderizarGaleria(producto);
  const colores = renderizarColoresModal(producto, colorSeleccionado);
  const variantes = renderizarVariantesModal(producto, colorSeleccionado, talleSeleccionado);
  const tags = renderizarTags(producto);
  
  modalBody.innerHTML = `
    <div class="product-modal-main-content">
      <div class="product-modal-images">
        <img class="product-modal-main-image" 
             src="${cloudinaryOptimized(imagenPrincipal, 1200)}" 
             alt="${producto.Articulo}"/>
        <div class="product-modal-gallery">${gal}</div>
      </div>
      <div class="product-modal-info">
        <h2>Art: <span class="article-box">${producto.Articulo}</span>${renderOfferFireIcon(producto)}</h2>
        ${renderOfferAndPromoBadges(producto)}
        ${tags}
        <div class="product-modal-description">${producto.Descripcion || ""}</div>
        <div class="product-modal-price-container">
          ${renderPriceWithOffer(producto)}
        </div>
        <div class="product-modal-colors">
          ${colores}
        </div>
        <div class="product-modal-variants">
          ${variantes}
        </div>
      </div>
    </div>
  `;
}

function renderizarColoresModal(producto, colorSeleccionado) {
  if (!producto.DetalleColor) return '';
  
  return producto.DetalleColor.map((detalle) => {
    const resultado = obtenerPrimerSkuConStock(producto, detalle.color);
    const sku = resultado?.sku || null;
    const imagen = detalle.images?.[0] || '';
    const selected = (detalle.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase() ? 'selected' : '';
    
    return `<button class="color-btn ${selected}" 
                    data-color="${detalle.color}" 
                    data-src="${imagen}" 
                    data-sku="${sku || ''}">${detalle.color}</button>`;
  }).join('');
}

function renderizarVariantesModal(producto, colorSeleccionado, talleSeleccionado) {
  const detalleColor = producto.DetalleColor?.find(d => 
    (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase()
  ) || producto.DetalleColor?.[0];
  
  if (!detalleColor) return '';
  
  const variantDetails = detalleColor.variantDetails || [];
  
  // Chips de talles
  const chips = variantDetails.map((vd) => {
    const sinStock = vd.available !== null && vd.available <= 0;
    const selected = (vd.talle || "").trim().toLowerCase() === (talleSeleccionado || "").trim().toLowerCase() ? 'selected' : '';
    const clase = `talle ${selected}${sinStock ? ' talle-out' : ''}`;
    const titulo = vd.available === null 
      ? "Disponibilidad por confirmar" 
      : sinStock 
        ? "Sin stock" 
        : `Disponible: ${vd.available}`;
    
    return `<div class="${clase}" 
                 data-size="${vd.talle}" 
                 data-sku="${vd.sku || ''}" 
                 data-available="${vd.available ?? ''}" 
                 title="${titulo}">${vd.talle}</div>`;
  }).join('');
  
  // Select de talles
  let primeraSeleccion = false;
  const sizeOptions = variantDetails.map((vd) => {
    const sinStock = vd.available !== null && vd.available <= 0;
    let selected = "";
    if (!sinStock && !primeraSeleccion && (!talleSeleccionado || vd.talle === talleSeleccionado)) {
      selected = "selected";
      primeraSeleccion = true;
    }
    const etiqueta = vd.available === null
      ? vd.talle
      : sinStock
        ? `${vd.talle} (sin stock)`
        : `${vd.talle} (disp. ${vd.available})`;
    
    return `<option value="${vd.talle}" 
                    data-variant-id="${vd.variant_id || ''}" 
                    data-sku="${vd.sku || ''}" 
                    data-available="${vd.available ?? ''}" 
                    ${sinStock ? 'disabled' : ''} 
                    ${selected}>${etiqueta}</option>`;
  }).join('');
  
  const hayStock = variantDetails.some(vd => vd.available === null || Number(vd.available) > 0);
  
  return `
    <div class="variant">
      <strong>${detalleColor.color}:</strong>
      <div class="talles">${chips}</div>
      <div class="reserve-controls" style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;">
        <label>Talle: <select class="res-size">${sizeOptions}</select></label>
        <label>Cant: <input type="number" class="res-qty" min="1" value="1" style="width:64px" ${hayStock ? '' : 'disabled'}/></label>
        <button class="reserve-btn" 
                data-articulo="${producto.Articulo}" 
                data-color="${detalleColor.color}" 
                ${hayStock ? '' : 'disabled'}>Agregar</button>
      </div>
    </div>
  `;
}

function renderizarColores(producto) {
  return producto.DetalleColor.map(
    (v) =>
      `<button class='color-btn' data-src="${v.images[0] || ""}">${
        v.color
      }</button>`
  ).join("");
}

function renderizarVariantes(producto) {
  return producto.DetalleColor.map((v) => {
    const detalles =
      v.variantDetails && v.variantDetails.length
        ? v.variantDetails
        : (v.talles || []).map((talle) => ({
            talle,
            stock: null,
            reserved: null,
            available: null,
            variant_id: null,
          }));

    const chips = detalles
      .map(({ talle, available }) => {
        const sinStock = available !== null && available <= 0;
        const clase = `talle${sinStock ? " talle-out" : ""}`;
        const titulo =
          available === null
            ? "Disponibilidad por confirmar"
            : sinStock
            ? "Sin stock"
            : `Disponible: ${available}`;
        return `<div class="${clase}" data-size="${talle}" data-available="${available ?? ""}" title="${titulo}">${talle}</div>`;
      })
      .join("");

    let primeraSeleccion = false;
    const sizeOptions = detalles
      .map(({ talle, available, variant_id }) => {
        const sinStock = available !== null && available <= 0;
        let selected = "";
        if (!sinStock && !primeraSeleccion) {
          selected = "selected";
          primeraSeleccion = true;
        }
        const etiqueta =
          available === null
            ? talle
            : sinStock
            ? `${talle} (sin stock)`
            : `${talle} (disp. ${available})`;
        return `<option value="${talle}" data-variant-id="${variant_id || ""}" data-available="${available ?? ""}" ${
          sinStock ? "disabled" : ""
        } ${selected}>${etiqueta}</option>`;
      })
      .join("");

    const hayStock = detalles.some(
      (detalle) =>
        detalle.available === null || Number(detalle.available) > 0
    );

    return `
      <div class="variant">
        <strong>${v.color}:</strong>
        <div class="talles">${chips}</div>
        <div class="reserve-controls" style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;">
          <label>Talle: <select class="res-size">${sizeOptions}</select></label>
          <label>Cant: <input type="number" class="res-qty" min="1" value="1" style="width:64px" ${
            hayStock ? "" : "disabled"
          }/></label>
          <button class="reserve-btn" data-articulo="${
            producto.Articulo
          }" data-color="${v.color}" ${hayStock ? "" : "disabled"}>Agregar</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderizarTags(producto) {
  const tagList = [producto.Filtro1, producto.Filtro2, producto.Filtro3].filter(
    (t) => t && t.trim()
  );

  return tagList.length
    ? `
    <div class="tags">${tagList
      .map((t) => `<div class="talle tag-chip" data-tag="${t}">${t}</div>`)
      .join("")}</div>
  `
    : "";
}

// Inicialización de eventos del modal (UNA sola vez)
function initModalEvents() {
  if (modalEventsInitialized) return;
  modalEventsInitialized = true;
  
  const modal = document.getElementById('product-modal');
  if (!modal) return;
  
  modal.addEventListener('click', (e) => {
    // Click en backdrop (el modal mismo)
    if (e.target === modal) {
      cerrarModal();
      return;
    }
    
    // Click en botón cerrar
    if (e.target.classList.contains('product-modal-close')) {
      cerrarModal();
      return;
    }
    
    // Click en botón de color
    if (e.target.classList.contains('color-btn')) {
      const btn = e.target;
      const color = btn.dataset.color;
      if (!productoActualEnModal || !color) return;
      
      // NO usar talle[0]: usar obtenerPrimerSkuConStock
      const resultado = obtenerPrimerSkuConStock(productoActualEnModal, color);
      if (!resultado) return;
      
      const { sku, talle } = resultado;
      
      // Actualizar imagen principal
      const mainImage = modal.querySelector('.product-modal-main-image');
      if (mainImage && btn.dataset.src) {
        mainImage.src = cloudinaryOptimized(btn.dataset.src, 1200);
      }
      
      // Re-renderizar variantes con talle elegido
      const detalleColor = productoActualEnModal.DetalleColor?.find(d => 
        (d.color || "").trim().toLowerCase() === (color || "").trim().toLowerCase()
      );
      if (detalleColor) {
        const variantesHTML = renderizarVariantesModal(productoActualEnModal, color, talle);
        const variantsContainer = modal.querySelector('.product-modal-variants');
        if (variantsContainer) {
          variantsContainer.innerHTML = variantesHTML;
        }
      }
      
      // Actualizar URL con replaceState
      updateSKUEnURL(sku);
      
      // Actualizar dataset del modal
      modal.dataset.sku = sku;
      
      // Actualizar botones de color seleccionado
      modal.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      
      return;
    }
    
    // Click en chip de talle
    if (e.target.classList.contains('talle') && !e.target.classList.contains('tag-chip')) {
      const chip = e.target;
      const sku = chip.dataset.sku;
      const size = chip.dataset.size;
      
      if (!sku) return;
      
      // Marcar chip como seleccionado
      const variantContainer = chip.closest('.variant');
      if (variantContainer) {
        variantContainer.querySelectorAll('.talle').forEach(t => t.classList.remove('selected'));
        chip.classList.add('selected');
        
        // Sincronizar select
        const select = variantContainer.querySelector('.res-size');
        if (select) {
          select.value = size;
        }
      }
      
      // Actualizar URL
      updateSKUEnURL(sku);
      modal.dataset.sku = sku;
      
      return;
    }
    
    // Click en miniatura
    if (e.target.classList.contains('miniatura')) {
      const img = e.target;
      const fullSrc = img.getAttribute('data-full') || img.src;
      const mainImage = modal.querySelector('.product-modal-main-image');
      if (mainImage) {
        mainImage.src = fullSrc;
      }
      return;
    }
    
    // Click en botón agregar
    if (e.target.classList.contains('reserve-btn')) {
      const btn = e.target;
      const controls = btn.closest('.reserve-controls');
      if (!controls) return;
      
      const sizeSelect = controls.querySelector('.res-size');
      const qtyInput = controls.querySelector('.res-qty');
      
      if (!sizeSelect || !qtyInput) return;
      
      const selectedOption = sizeSelect.options[sizeSelect.selectedIndex];
      if (!selectedOption || selectedOption.disabled) {
        alert('Este talle no tiene stock disponible');
        return;
      }
      
      const available = parseInt(selectedOption.dataset.available ?? '', 10);
      let qty = parseInt(qtyInput.value || '1', 10);
      if (!Number.isFinite(qty) || qty <= 0) qty = 1;
      
      // Validar stock
      if (Number.isFinite(available) && available <= 0) {
        alert('Este talle no tiene stock disponible');
        return;
      }
      
      if (Number.isFinite(available) && qty > available) {
        alert(`Solo hay ${available} unidades disponibles para este talle.`);
        qty = available;
        qtyInput.value = available;
      }
      
      const size = selectedOption.value;
      const variantId = selectedOption.dataset.variantId || null;
      const articulo = btn.dataset.articulo;
      const color = btn.dataset.color;
      
      const precio = modal.querySelector('.product-modal-price-container .price')?.textContent || '0';
      const descripcion = modal.querySelector('.product-modal-description')?.textContent || '';
      const imagen = modal.querySelector('.product-modal-main-image')?.src || '';
      
      const productData = {
        articulo,
        color,
        talle: size,
        cantidad: qty,
        precio: parseFloat(precio.replace(/[^0-9.,]/g, '').replace(',', '.')) || 0,
        imagen,
        descripcion,
        variant_id: variantId,
      };
      
      if (window.addToCart) {
        window.addToCart(productData);
        btn.textContent = 'Agregado';
        btn.style.background = '#4CAF50';
        setTimeout(() => {
          btn.textContent = 'Agregar';
          btn.style.background = '';
        }, 1200);
      } else {
        alert('Sistema de carrito no disponible');
      }
      
      return;
    }
  });
  
  // Change en select de talles
  modal.addEventListener('change', (e) => {
    if (e.target.classList.contains('res-size')) {
      const select = e.target;
      const selectedOption = select.options[select.selectedIndex];
      if (!selectedOption) return;
      
      const sku = selectedOption.dataset.sku;
      const size = select.value;
      
      if (!sku) return;
      
      // Sincronizar chips
      const variantContainer = select.closest('.variant');
      if (variantContainer) {
        variantContainer.querySelectorAll('.talle').forEach(chip => {
          chip.classList.remove('selected');
          if (chip.dataset.size === size) {
            chip.classList.add('selected');
          }
        });
      }
      
      // Actualizar URL
      updateSKUEnURL(sku);
      modal.dataset.sku = sku;
    }
  });
}

function initGridEvents() {
  if (gridEventsInitialized) return;
  gridEventsInitialized = true;
  
  const catalogo = document.getElementById('catalogo');
  if (!catalogo) return;
  
  catalogo.addEventListener('click', (e) => {
    // Ignorar clicks en botones, controles de reserva, botones de color, y download-container
    if (e.target.tagName === 'BUTTON' || 
        e.target.closest('.reserve-controls') ||
        e.target.closest('.color-btn') ||
        e.target.closest('.download-container')) {
      return;
    }
    
    // Encontrar .card.producto más cercana
    const card = e.target.closest('.card.producto');
    if (!card) return;
    
    // Obtener SKU de card o .main-image
    const sku = card.dataset.sku || card.querySelector('.main-image')?.dataset.sku;
    if (!sku) return;
    
    abrirModalPorSKU(sku);
  });
}

function initEscClose() {
  if (escInit) return;
  escInit = true;
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('product-modal');
      if (modal && modal.classList.contains('active')) {
        cerrarModal();
      }
    }
  });
}

// Handler popstate para navegación con botón atrás
window.addEventListener('popstate', async (e) => {
  const urlParams = new URLSearchParams(window.location.search);
  const sku = urlParams.get('sku');
  const tabSlug = getTabFromURL();
  const modal = document.getElementById('product-modal');
  
  if (!modal) return;
  
  // Solo llamar cargarCategoria() si cambió realmente el tab slug
  if (tabSlug !== ultimoTabSlug) {
    ultimoTabSlug = tabSlug;
    if (tabSlug) {
      const categoria = slugToCategoria(tabSlug);
      if (categoria) {
        // Actualizar grid sin cerrar modal
        await cargarCategoria(categoria);
      }
    }
  }
  
  // Manejar cambios de SKU
  if (sku) {
    if (modal.dataset.sku === sku && modal.classList.contains('active')) {
      // Ya está renderizado con este SKU, no re-renderizar
      return;
    }
    abrirModalPorSKU(sku, { pushState: false });
  } else {
    cerrarModal();
  }
});

// Configurar eventos (igual que antes)
function configurarEventos() {
  // Galería de imágenes
  document.querySelectorAll(".card .gallery .miniatura").forEach((img) => {
    img.addEventListener("click", function () {
      const main = this.closest(".card").querySelector(".main-image");
      if (main) main.src = this.getAttribute("data-full");
    });
  });

  // Botones de color
  document.querySelectorAll(".card .color-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      const main = this.closest(".card").querySelector(".main-image");
      if (main) main.src = this.dataset.src;
    });
  });

  // Configurar controles de variante (stock, límites)
  document.querySelectorAll(".card .reserve-controls").forEach((controls) => {
    const sizeSelect = controls.querySelector(".res-size");
    const qtyInput = controls.querySelector(".res-qty");
    const reserveBtn = controls.querySelector(".reserve-btn");

    const updateState = () => {
      if (!sizeSelect || !qtyInput || !reserveBtn) return;
      const options = Array.from(sizeSelect.options);
      const primeraDisponible = options.find((opt) => !opt.disabled);

      if (!primeraDisponible) {
        reserveBtn.disabled = true;
        qtyInput.disabled = true;
        qtyInput.value = 0;
        return;
      }

      if (
        !sizeSelect.value ||
        sizeSelect.options[sizeSelect.selectedIndex]?.disabled
      ) {
        sizeSelect.value = primeraDisponible.value;
      }

      const seleccionada = sizeSelect.options[sizeSelect.selectedIndex];
      const disponible = parseInt(
        seleccionada?.dataset.available ?? "",
        10
      );

      const hayStock =
        Number.isFinite(disponible) ? disponible > 0 : true;

      reserveBtn.disabled = !hayStock;
      qtyInput.disabled = !hayStock;

      if (hayStock && Number.isFinite(disponible)) {
        qtyInput.max = disponible;
        if (!qtyInput.value || Number(qtyInput.value) <= 0) {
          qtyInput.value = Math.min(1, disponible);
        }
        if (Number(qtyInput.value) > disponible) {
          qtyInput.value = disponible;
        }
      } else {
        qtyInput.max = "";
        if (!qtyInput.value || Number(qtyInput.value) <= 0) {
          qtyInput.value = hayStock ? 1 : 0;
        }
      }
    };

    updateState();

    if (sizeSelect) {
      sizeSelect.addEventListener("change", updateState);
    }

    controls.__updateVariantState = updateState;
  });

  // Botones de reserva
  document.querySelectorAll(".card .reserve-btn").forEach((btn) => {
    btn.addEventListener("click", async function () {
      const controls = this.closest(".reserve-controls");
      const sizeSelect = controls.querySelector(".res-size");
      const qtyInput = controls.querySelector(".res-qty");
      const updateState = controls.__updateVariantState;

      if (!sizeSelect || !qtyInput) return;

      const selectedOption =
        sizeSelect.options[sizeSelect.selectedIndex];
      if (!selectedOption || selectedOption.disabled) {
        // Mostrar modal de alternativas
        const talle = selectedOption?.value || "";
        const articulo = this.dataset.articulo;
        const card = this.closest(".card");
        const producto = {
          articulo,
          talle,
          tags: [
            card.dataset.filtro1,
            card.dataset.filtro2,
            card.dataset.filtro3,
          ].filter((t) => t && t.trim()),
          color: this.dataset.color || null,
        };
        
        mostrarAlternativasParaTalleSinStock(producto);
        if (typeof updateState === "function") updateState();
        return;
      }

      const available = parseInt(
        selectedOption.dataset.available ?? "",
        10
      );

      let qty = parseInt(qtyInput.value || "1", 10);
      if (!Number.isFinite(qty) || qty <= 0) qty = 1;

      if (Number.isFinite(available) && available <= 0) {
        // Mostrar modal de alternativas
        const talle = selectedOption?.value || "";
        const articulo = this.dataset.articulo;
        const card = this.closest(".card");
        const producto = {
          articulo,
          talle,
          tags: [
            card.dataset.filtro1,
            card.dataset.filtro2,
            card.dataset.filtro3,
          ].filter((t) => t && t.trim()),
          color: this.dataset.color || null,
        };
        
        mostrarAlternativasParaTalleSinStock(producto);
        if (typeof updateState === "function") updateState();
        return;
      }

      if (Number.isFinite(available) && qty > available) {
        alert(
          `Solo hay ${available} unidades disponibles para este talle.`
        );
        qty = available;
        qtyInput.value = available;
      }

      const size = selectedOption.value;
      const variantId = selectedOption.dataset.variantId || null;
      const articulo = this.dataset.articulo;
      const color = this.dataset.color;

      const card = this.closest(".card");
      const precio = card.querySelector(".price")?.textContent || "0";
      const descripcion = card.querySelector(".description")?.textContent || "";
      const imagen = card.querySelector(".main-image")?.src || "";

      const productData = {
        articulo,
        color,
        talle: size,
        cantidad: qty,
        precio:
          parseFloat(precio.replace(/[^0-9.,]/g, "").replace(",", ".")) || 0,
        imagen,
        descripcion,
        variant_id: variantId,
        // Agregar tags para que addToCart pueda usarlos para buscar alternativas
        tags: [
          card.dataset.filtro1,
          card.dataset.filtro2,
          card.dataset.filtro3,
        ].filter((t) => t && t.trim()),
      };

      if (window.addToCart) {
        // Intentar agregar al carrito (addToCart ahora manejará mostrar alternativas si no hay stock)
        const result = await window.addToCart(productData);
        // Si addToCart retorna false, significa que no se pudo agregar (probablemente sin stock)
        // y ya se mostró el modal de alternativas
        if (result !== false) {
          this.textContent = "Agregado";
          this.style.background = "#4CAF50";
          setTimeout(() => {
            this.textContent = "Agregar";
            this.style.background = "";
          }, 1200);
        }
      } else {
        alert("Sistema de carrito no disponible");
      }

      if (typeof updateState === "function") {
        updateState();
      }
    });
  });

  // Tags
  document.querySelectorAll(".card .tag-chip").forEach((chip) => {
    chip.addEventListener("click", function () {
      const tag = this.dataset.tag || this.textContent.trim();
      const input = document.getElementById("searchInput");
      if (input) {
        input.value = tag;
        input.dispatchEvent(new Event("input"));
      }
    });
  });

  // Botones de compartir
  document.querySelectorAll(".card .share-btn").forEach((btn) => {
    btn.addEventListener("click", async function () {
      const card = this.closest(".card");
      const mainImg = card.querySelector(".main-image");
      const imgUrl = mainImg.src;

      if (navigator.share) {
        try {
          await navigator.share({ url: imgUrl });
        } catch (e) {
          console.log("Compartir cancelado");
        }
      } else {
        alert("La función de compartir no está disponible en este dispositivo");
      }
    });
  });
}

// Función para cambiar categoría
async function cambiarCategoria(cat) {
  console.log("🔄 Cambiando a categoría:", cat);

  // Actualizar botón activo
  document.querySelectorAll(".menu button").forEach((btn) => {
    btn.classList.remove("active");
    const buttonText = btn.textContent.trim();
    let shouldActivate = false;

    if (cat === "Lenceria" && buttonText === "Lencería") {
      shouldActivate = true;
    } else if (cat === "Marroquineria" && buttonText === "Accesorios") {
      shouldActivate = true;
    } else if (buttonText.includes(cat)) {
      shouldActivate = true;
    }

    if (shouldActivate) {
      btn.classList.add("active");
    }
  });

  // SIEMPRE actualizar el grid a la nueva categoría (aunque el modal esté abierto)
  await cargarCategoria(cat);
  
  // Actualizar URL con slug, preservando sku existente
  // NO cerrar modal si está abierto (productoActualEnModal ya se mantiene)
  updateURL({ tab: cat, sku: undefined }, { mode: 'replace' });
}

// Función para descargar imagen
async function downloadImage(btn) {
  try {
    const card = btn.closest(".card");
    const src = card.querySelector(".main-image").src;

    const filename = src
      .split("/")
      .pop()
      .split("?")[0]
      .replace(/\.\w+$/, ".jpg");

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    canvas.toBlob(
      (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      "image/jpeg",
      0.92
    );
  } catch (error) {
    console.error("Error descargando imagen:", error);
    // Fallback directo
    const a = document.createElement("a");
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// Verificar si hay novedades
async function existeNovedades() {
  try {
    const hoy = new Date();
    const hace7 = new Date(
      hoy.getFullYear(),
      hoy.getMonth(),
      hoy.getDate() - 7
    );

    // SOLO usar Supabase - NO usar Google Sheets
    if (!supabase) {
      console.warn(
        "⚠️ Cliente de Supabase no disponible para verificar novedades"
      );
      return false;
    }

    // La vista devuelve Mostrar como booleano true, no como string "TRUE"
    // Por eso no usamos .eq() aquí, sino que filtramos después
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select("*");

    if (error) throw error;

    // Filtrar por Mostrar (aceptar tanto booleano true como string "TRUE")
    const items = (data || []).filter((item) => {
      const mostrar = item.Mostrar;
      return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
    });

    return items.some(
      (item) => item.FechaIngreso && parseFecha(item.FechaIngreso) >= hace7
    );
  } catch (error) {
    console.error("Error verificando novedades:", error);
    return false;
  }
}

// Función de diagnóstico
function ejecutarDiagnostico() {
  console.log("🔍 DIAGNÓSTICO RÁPIDO - CATÁLOGO FYL (SUPABASE)");
  console.log("================================================");

  // 1. Verificar configuración
  console.log("\n1. 📋 CONFIGURACIÓN:");
  console.log("USE_SUPABASE:", USE_SUPABASE);
  console.log(
    "USE_OPEN_SHEET_FALLBACK:",
    USE_OPEN_SHEET_FALLBACK,
    "(DESHABILITADO - Solo Supabase)"
  );
  console.log("SUPABASE_URL:", SUPABASE_URL);
  console.log(
    "SUPABASE_ANON_KEY:",
    SUPABASE_ANON_KEY ? "Configurada" : "NO CONFIGURADA"
  );

  // 2. Verificar cliente de Supabase
  console.log("\n2. 🗄️ CLIENTE SUPABASE:");
  console.log("Cliente disponible:", supabase ? "SÍ" : "NO");
  console.log(
    "Estado de conexión:",
    supabase ? "Inicializado" : "No inicializado"
  );

  // 3. Verificar funciones disponibles
  console.log("\n3. 🔧 FUNCIONES DISPONIBLES:");
  console.log("cargarCategoria:", typeof window.cargarCategoria);
  console.log("cambiarCategoria:", typeof window.cambiarCategoria);
  console.log("downloadImage:", typeof window.downloadImage);

  // 4. Verificar estado del catálogo
  console.log("\n4. 🎯 ESTADO DEL CATÁLOGO:");
  const catalogo = document.getElementById("catalogo");
  const loader = document.getElementById("loader");
  console.log("Elemento catálogo:", catalogo ? "Encontrado" : "NO ENCONTRADO");
  console.log("Elemento loader:", loader ? "Encontrado" : "NO ENCONTRADO");
  console.log(
    "Contenido del catálogo:",
    catalogo?.innerHTML?.substring(0, 100) + "..."
  );

  console.log("\n================================================");
  console.log("🔍 DIAGNÓSTICO COMPLETADO");
}

// Inicialización
window.addEventListener("DOMContentLoaded", async () => {
  console.log("🚀 Inicializando catálogo con Supabase...");

  // Inicializar Supabase
  const supabaseInicializado = await inicializarSupabase();

  if (!supabaseInicializado) {
    console.error("❌ No se pudo inicializar Supabase. El catálogo no funcionará correctamente.");
    const cont = document.getElementById("catalogo");
    if (cont) {
      cont.innerHTML = `
        <div class="error-message" style="text-align: center; padding: 40px; color: #666; background: #f8f9fa; border-radius: 8px; margin: 20px;">
          <h3>❌ Error de Configuración</h3>
          <p>No se pudo conectar a Supabase. Por favor verifica:</p>
          <ul style="text-align: left; margin: 20px 0; max-width: 600px; margin-left: auto; margin-right: auto;">
            <li>Que el archivo <code>scripts/config.local.js</code> exista y tenga la configuración correcta</li>
            <li>Que <code>SUPABASE_URL</code> y <code>SUPABASE_ANON_KEY</code> estén configurados</li>
            <li>Revisa la consola del navegador para más detalles</li>
          </ul>
          <button onclick="location.reload()" style="background: #CD844D; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 15px;">Reintentar</button>
        </div>
      `;
    }
    return;
  }

  // Ejecutar diagnóstico
  ejecutarDiagnostico();

  try {
    // Verificar que podemos consultar la vista antes de cargar
    console.log("🔍 Verificando acceso a catalog_public_view...");
    const { data: testData, error: testError } = await supabase
      .from("catalog_public_view")
      .select("Articulo, Categoria, Color")
      .limit(10);
    
    if (testError) {
      console.error("❌ Error accediendo a catalog_public_view:", testError);
      console.error("Detalles:", {
        message: testError.message,
        details: testError.details,
        hint: testError.hint,
        code: testError.code
      });
      const cont = document.getElementById("catalogo");
      if (cont) {
        cont.innerHTML = `
          <div class="error-message" style="text-align: center; padding: 40px; color: #666; background: #f8f9fa; border-radius: 8px; margin: 20px;">
            <h3>❌ Error de Acceso</h3>
            <p>No se puede acceder a la vista del catálogo:</p>
            <p style="color: #c00; font-weight: bold;">${testError.message}</p>
            <p>Verifica los permisos RLS en Supabase.</p>
            <button onclick="location.reload()" style="background: #CD844D; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 15px;">Reintentar</button>
          </div>
        `;
      }
      return;
    }
    
    console.log(`✅ Acceso a vista OK. Total de productos en vista: ${testData?.length || 0}`);
    if (testData && testData.length > 0) {
      console.log("📋 Primeros productos en la vista:", testData.slice(0, 5).map(p => ({
        Articulo: p.Articulo,
        Categoria: p.Categoria,
        Color: p.Color
      })));
      
      // Verificar categorías únicas
      const categorias = [...new Set(testData.map(p => p.Categoria).filter(Boolean))];
      console.log("📂 Categorías encontradas:", categorias);
    } else {
      console.warn("⚠️ La vista está vacía. Verifica que:");
      console.warn("   1. Hay productos con status='active' en la tabla products");
      console.warn("   2. Hay variantes con active=true en product_variants");
      console.warn("   3. Los permisos RLS permiten lectura pública");
    }
    
    // Inicializar eventos del modal
    initGridEvents();
    initModalEvents();
    initEscClose();
    
    // Resolver categoría inicial por ?tab=
    const tabSlug = getTabFromURL();
    let categoriaInicial;
    
    if (tabSlug) {
      const categoria = slugToCategoria(tabSlug);
      if (categoria) {
        categoriaInicial = categoria;
      } else {
        // Slug inválido, usar fallback
        categoriaInicial = (await existeNovedades()) ? "Novedades" : "Calzado";
      }
    } else {
      // No hay tab en URL, usar fallback
      categoriaInicial = (await existeNovedades()) ? "Novedades" : "Calzado";
    }
    
    console.log(`📦 Cargando categoría inicial: ${categoriaInicial}`);
    
    // Cargar categoría inicial (esto construye skuIndex)
    await cargarCategoria(categoriaInicial);
    
    // Actualizar botón activo
    document.querySelectorAll(".menu button").forEach((btn) => {
      btn.classList.remove("active");
      const buttonText = btn.textContent.trim();
      let shouldActivate = false;

      if (categoriaInicial === "Lenceria" && buttonText === "Lencería") {
        shouldActivate = true;
      } else if (categoriaInicial === "Marroquineria" && buttonText === "Accesorios") {
        shouldActivate = true;
      } else if (buttonText.includes(categoriaInicial)) {
        shouldActivate = true;
      }

      if (shouldActivate) {
        btn.classList.add("active");
      }
    });
    
    // Actualizar URL con tab (sin sku, solo para restaurar UI)
    if (tabSlug) {
      updateURL({ tab: categoriaInicial, sku: undefined }, { mode: 'replace' });
    }
    
    // Inicializar tab slug para popstate (usar slug actual de URL o convertir categoría)
    ultimoTabSlug = tabSlug || categoriaToSlug(categoriaInicial);
    
    // Ahora inicializar modal desde URL (skuIndex ya está construido)
    // SKU manda - siempre abre modal si existe
    await inicializarModalDesdeURL();

    // Ocultar botón de novedades si no hay novedades
    const btnNovedades = document.getElementById("btn-novedades");
    if (btnNovedades && !(await existeNovedades())) {
      btnNovedades.style.display = "none";
    }

    console.log("✅ Catálogo inicializado correctamente");
    console.log("📊 Fuente de datos: Supabase (ÚNICA FUENTE)");
    console.log("🚫 Google Sheets: DESHABILITADO");
  } catch (error) {
    console.error("❌ Error inicializando catálogo:", error);
    console.error("Stack:", error.stack);
  }
});

// Configurar eventos de la interfaz
document.addEventListener("DOMContentLoaded", () => {
  // Toggle de vista
  const viewToggle = document.getElementById("view-toggle");
  if (viewToggle) {
    viewToggle.addEventListener("click", () => {
      const catEl = document.getElementById("catalogo");
      catEl.classList.toggle("compact");
      viewToggle.textContent = catEl.classList.contains("compact")
        ? "🔳 Normal"
        : "🔳 Comunas";
    });
  }

  // Limpiar búsqueda
  const clearBtn = document.getElementById("clear-search");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      const input = document.getElementById("searchInput");
      if (input) input.value = "";
      document
        .querySelectorAll(".card")
        .forEach((c) => (c.style.display = "block"));
    });
  }
});

// Función para mostrar alternativas cuando un talle está sin stock
async function mostrarAlternativasParaTalleSinStock(producto) {
  try {
    if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
      alert(
        `Este producto no tiene stock en el talle ${producto.talle}. Por favor selecciona otro talle.`
      );
      return;
    }

    const mensaje = `Este producto no tiene stock en el talle ${producto.talle}. ¿Querés ver alternativas similares en talle ${producto.talle}?`;

    // Crear un modal inicial con dos opciones
    const confirmacion = await new Promise((resolve) => {
      const modalInicial = document.createElement("div");
      modalInicial.className = "alternativas-modal active";
      modalInicial.innerHTML = `
        <div class="alternativas-modal-content" style="max-width: 500px;">
          <div class="alternativas-modal-header">
            <h2>⚠️ Sin Stock</h2>
            <button class="alternativas-modal-close" onclick="window.__verAlternativasResolve(false)">×</button>
          </div>
          <div class="alternativas-modal-body">
            <p class="alternativas-modal-message">${mensaje}</p>
          </div>
          <div class="alternativas-modal-footer" style="gap: 12px; display: flex; justify-content: flex-end;">
            <button class="alternativas-cerrar-btn" onclick="window.__verAlternativasResolve(false)">Cerrar</button>
            <button class="alternativa-select-btn" style="margin: 0;" onclick="window.__verAlternativasResolve(true)">Ver alternativas</button>
          </div>
        </div>
      `;
      
      const backdrop = document.createElement("div");
      backdrop.className = "alternativas-modal-backdrop";
      backdrop.style.cssText = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1999;";
      
      window.__verAlternativasResolve = (result) => {
        modalInicial.remove();
        backdrop.remove();
        delete window.__verAlternativasResolve;
        resolve(result);
      };
      
      backdrop.addEventListener("click", () => {
        window.__verAlternativasResolve(false);
      });
      
      document.body.appendChild(backdrop);
      document.body.appendChild(modalInicial);
    });

    if (!confirmacion) return;

    // Buscar alternativas
    const productos = await window.buscarProductosAlternativos({
      articulo: producto.articulo,
      talle: producto.talle,
      tags: producto.tags,
      color: producto.color,
      limit: 6,
    });

    // Mostrar modal con alternativas
    window.mostrarModalAlternativas({
      mensaje: `Productos alternativos disponibles en talle ${producto.talle}:`,
      productos,
      onProductoSeleccionado: async (productoSeleccionado) => {
        // Agregar el producto seleccionado al carrito
        if (window.addToCart) {
          const productData = {
            articulo: productoSeleccionado.articulo,
            color: productoSeleccionado.color,
            talle: productoSeleccionado.talle,
            cantidad: 1,
            precio: productoSeleccionado.precio,
            imagen: productoSeleccionado.imagen,
            descripcion: productoSeleccionado.descripcion,
            variant_id: productoSeleccionado.variant_id,
          };
          
          await window.addToCart(productData);
          alert(`✅ ${productoSeleccionado.articulo} agregado al carrito`);
        }
      },
      onCerrar: () => {
        console.log("Modal de alternativas cerrado");
      },
    });
  } catch (error) {
    console.error("❌ Error mostrando alternativas:", error);
    alert(
      `Este producto no tiene stock en el talle ${producto.talle}. Por favor selecciona otro talle.`
    );
  }
}

// Exportar funciones globales
window.cargarCategoria = cargarCategoria;
window.cambiarCategoria = cambiarCategoria;
window.downloadImage = downloadImage;
window.existeNovedades = existeNovedades;
window.parseFecha = parseFecha;
window.cloudinaryOptimized = cloudinaryOptimized;
window.mostrarAlternativasParaTalleSinStock = mostrarAlternativasParaTalleSinStock;
window.cerrarModal = cerrarModal;
