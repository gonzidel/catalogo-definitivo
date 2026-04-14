// scripts/main-supabase.js - Versión que prioriza Supabase con fallback a Google Sheets
// Esta versión carga productos desde Supabase primero, y si falla, usa Google Sheets

import {
  SUPABASE_URL as CONFIG_SUPABASE_URL,
  SUPABASE_ANON_KEY as CONFIG_SUPABASE_ANON_KEY,
  USE_SUPABASE as CONFIG_USE_SUPABASE,
  USE_OPEN_SHEET_FALLBACK as CONFIG_USE_OPEN_SHEET_FALLBACK,
  configReady,
} from "./config.js";
import { supabase as supabaseClient } from "./supabase-client.js?v=m260418";
import { normalizeSize } from "./utils/size-normalizer.js";
import { fylAnalytics } from "./analytics.js";
import { formatARS as formatARSValue, parseARSNumber } from "./utils/price.js";

await configReady;

function fylCatalogTrackViewItemList(contextKey, groupedProducts, itemListName) {
  try {
    if (!fylAnalytics.isReady()) return;
    const items = fylAnalytics.buildItemsFromGroupedProducts(groupedProducts || []);
    if (!items.length) return;
    fylAnalytics.trackViewItemListOnce(contextKey, {
      item_list_id: contextKey,
      item_list_name: itemListName || contextKey,
      items,
      currency: "ARS",
    });
  } catch (_e) {}
}

function fylCatalogViewItemForProducto(producto, skuHint) {
  try {
    if (!fylAnalytics.isReady() || !producto) return;
    const items = fylAnalytics.buildItemsFromGroupedProducts([producto], 1);
    if (!items.length) return;
    if (skuHint) items[0].item_variant = String(skuHint);
    const val = fylAnalytics.parsePriceNumberFromProduct(producto);
    fylAnalytics.ecommerceEvent("view_item", { currency: "ARS", value: val, items });
  } catch (_e) {}
}

function trackMetaViewContent(producto, skuHint) {
  if (!producto) return;
  const contentName = String(producto.Articulo || "").trim();
  const sku = String(skuHint || "").trim();
  if (!sku) return;

  const hasOffer = producto.OfertaActiva === true || producto.OfertaActiva === "true";
  const rawPrice = hasOffer && producto.PrecioOferta ? producto.PrecioOferta : producto.Precio;
  const parsed = Number(parseARSNumber(rawPrice));
  const priceNumber = Number.isFinite(parsed) ? parsed : 0;

  const payload = {
    content_name: contentName,
    content_ids: [sku],
    content_type: "product",
    value: priceNumber,
    currency: "ARS",
  };

  if (typeof fbq === "function") {
    fbq("track", "ViewContent", payload);
    return;
  }

  // Delay corto defensivo para carreras de carga del pixel.
  setTimeout(() => {
    if (typeof fbq === "function") {
      fbq("track", "ViewContent", payload);
    }
  }, 300);
}

function fylCatalogPdpSurface() {
  try {
    if (!fylAnalytics.isReady()) return;
    fylAnalytics.setPageType("pdp");
    fylAnalytics.syncCatalogSurface({ emit: true });
  } catch (_e) {}
}


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
let productosActualesMap = new Map(); // Articulo -> producto (para Bottom Sheet)
// Variables para paginación incremental
let productosPendientes = []; // Array de productos pendientes de renderizar
let productosRenderizados = 0; // Cantidad de productos ya renderizados
let offersCardsPendientes = []; // Ofertas pendientes de renderizar
/** Tras insertar el banner destacado inline (4.ª card en Inicio), se dispara carga al finalizar el render. */
let fylPendingHomeCustomBanner = false;
let isLoadingMore = false; // Flag para evitar múltiples cargas simultáneas
const PRODUCTOS_INICIALES = 14; // Cantidad de productos en la primera carga
const PRODUCTOS_POR_PAGINA = 14; // Cantidad de productos a cargar por página con el botón
const CATALOGO_AUTOLOAD_SCROLL = true;
const CATALOGO_AUTOLOAD_ROOT_MARGIN_PX = 900;
const CATALOGO_AUTOLOAD_FALLBACK_THRESHOLD_PX = 900;
let catalogoLoadMode = "paged"; // paged | full
let catalogoAutoloadObserver = null;
let catalogoAutoloadSentinel = null;
let catalogoAutoloadFallbackEnabled = false;

/** Logs verbosos del catálogo/stock. Activar: `window.FYL_DEBUG_CATALOG = true` antes de cargar, o `?debug=catalog` en la URL. */
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

/** Oculta el overlay de arranque (index2) y restaura scroll del body. */
function hideCatalogBootOverlay() {
  const el = document.getElementById("catalog-boot-overlay");
  if (el) {
    el.classList.add("catalog-boot-overlay--hidden");
    el.setAttribute("aria-busy", "false");
    el.setAttribute("aria-hidden", "true");
    // Android/WebView: visibility/opacity a veces dejan la capa o el scroll bloqueado
    el.style.display = "none";
  }
  document.body.classList.remove("catalog-boot-active");
  window.dispatchEvent(new CustomEvent("fyl-catalog-boot-done"));
}

/** Muestra nuevamente el overlay para transiciones pesadas (ej. volver a Inicio). */
function showCatalogBootOverlay() {
  const el = document.getElementById("catalog-boot-overlay");
  if (el) {
    el.style.display = "";
    el.classList.remove("catalog-boot-overlay--hidden");
    el.setAttribute("aria-busy", "true");
    el.setAttribute("aria-hidden", "false");
  }
  document.body.classList.add("catalog-boot-active");
}

/** Evita que consultas Supabase queden colgadas sin tope (red lenta / Android). */
function fylAwaitWithTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`fyl_timeout:${label}`)), ms);
    }),
  ]);
}

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

// Helpers para imágenes: generan URL optimizada desde public_id si existe, sino usan url
const CLOUDINARY_CLOUD_NAME_SUPABASE = "dnuedzuzm";

/**
 * Genera URL optimizada de Cloudinary desde public_id
 * @param {string} public_id - public_id de Cloudinary (sin extensión)
 * @param {number} width - Ancho deseado en px
 * @returns {string} URL optimizada
 */
function cloudinaryOptimizedFromPublicId(public_id, width) {
  if (!public_id) return "";
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME_SUPABASE}/image/upload/f_auto,q_auto,c_scale,w_${width}/${public_id}`;
}

/**
 * Obtiene URL de thumbnail (200px) desde objeto imagen
 * @param {Object|string} img - Objeto con public_id y/o url/secure_url, o string URL
 * @returns {string} URL optimizada
 */
function getImgThumb(img) {
  if (!img) return "";
  // Si es string (legacy), usar directamente con cloudinaryOptimized
  if (typeof img === "string") {
    return cloudinaryOptimized(img, 200);
  }
  // Si es objeto con public_id, usar desde public_id
  if (img.public_id) {
    return cloudinaryOptimizedFromPublicId(img.public_id, 200);
  }
  // Fallback a url (legacy) - aplicar transformación si es URL de Cloudinary
  const url = img.url || img.secure_url || "";
  if (!url) return "";
  return cloudinaryOptimized(url, 200);
}

/**
 * Obtiene URL de imagen completa (800px) desde objeto imagen
 * @param {Object|string} img - Objeto con public_id y/o url/secure_url, o string URL
 * @returns {string} URL optimizada
 */
function getImgFull(img) {
  if (!img) return "";
  // Si es string (legacy), usar directamente con cloudinaryOptimized
  if (typeof img === "string") {
    return cloudinaryOptimized(img, 800);
  }
  // Si es objeto con public_id, usar desde public_id
  if (img.public_id) {
    return cloudinaryOptimizedFromPublicId(img.public_id, 800);
  }
  // Fallback a url (legacy) - aplicar transformación si es URL de Cloudinary
  const url = img.url || img.secure_url || "";
  if (!url) return "";
  return cloudinaryOptimized(url, 800);
}

/** Resuelve URL de imagen (string o objeto con public_id) para cualquier ancho */
function getImgUrl(img, width) {
  if (!img) return "";
  if (typeof img === "string") return cloudinaryOptimized(img, width);
  if (img.public_id) return cloudinaryOptimizedFromPublicId(img.public_id, width);
  const url = img.url || img.secure_url || "";
  return url ? cloudinaryOptimized(url, width) : "";
}

/**
 * Lista ordenada de URLs de imagen para una card: principal primero, luego el resto (para fallback si la principal falla).
 * @param {Object} producto - producto con VariantePrincipal y DetalleColor[].images
 * @param {number} width - ancho para Cloudinary (ej. 800)
 * @returns {string[]} URLs únicas, sin vacías
 */
function getMainImageFallbackUrls(producto, width = 800) {
  const seen = new Set();
  const urls = [];
  const add = (img) => {
    const url = getImgUrl(img, width);
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  };
  add(producto.VariantePrincipal);
  (producto.DetalleColor || []).forEach((d) => (d.images || []).forEach(add));
  return urls;
}

/** Si la imagen principal falla, intenta la siguiente URL de data-fallback-urls (JSON array). */
function mainImageFallback(imgEl) {
  const raw = imgEl.getAttribute("data-fallback-urls");
  if (!raw) return;
  try {
    const urls = JSON.parse(raw);
    if (urls.length) {
      imgEl.src = urls.shift();
      imgEl.setAttribute("data-fallback-urls", JSON.stringify(urls));
    }
  } catch (_) {}
}

// Inicializar Supabase
async function inicializarSupabase() {
  const setFail = (code, hint) => {
    if (typeof globalThis !== "undefined") {
      globalThis.__FYL_SUPABASE_INIT_FAIL__ = { code, hint: hint || "", t: Date.now() };
    }
    return false;
  };
  try {
    if (typeof globalThis !== "undefined") {
      delete globalThis.__FYL_SUPABASE_INIT_FAIL__;
    }

    // Verificar configuración
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error(
        "❌ Configuración de Supabase no encontrada. En producción: /config.prod.js y deploy; en local: scripts/config.local.js"
      );
      return setFail("missing_config", "Faltan SUPABASE_URL o SUPABASE_ANON_KEY.");
    }

    fylCatalogDbg("🔧 Configuración Supabase cargada:", {
      URL: SUPABASE_URL,
      KEY: SUPABASE_ANON_KEY ? "Configurada" : "No configurada",
      USE_SUPABASE: USE_SUPABASE,
      FALLBACK: USE_OPEN_SHEET_FALLBACK,
    });

    // Usar SOLO el cliente importado de supabase-client.js (evitar crear múltiples instancias)
    if (!supabase || !supabase.from) {
      console.error(
        "❌ Cliente de Supabase no disponible (p. ej. Safari bloqueó la carga del script o falló la red). Revisá [FYL supabase] en consola."
      );
      return setFail(
        "no_client",
        "El navegador no pudo cargar la librería de Supabase. Probá recargar, otra red Wi‑Fi/datos, o ventana privada."
      );
    }
    
    // Asegurar que el cliente esté disponible globalmente
    if (typeof window !== "undefined") {
      window.supabase = supabase;
      window.supabaseClient = supabase;
    }
    fylCatalogDbg("✅ Cliente de Supabase disponible (usando instancia única de supabase-client.js)");

    // [PERF] Sonda HEAD eliminada: la conectividad se valida en cargarDesdeSupabase().
    if (typeof globalThis !== "undefined") {
      delete globalThis.__FYL_SUPABASE_INIT_FAIL__;
    }
    return true;
  } catch (error) {
    console.error("❌ Error inicializando Supabase:", error);
    console.error("Stack:", error.stack);
    return setFail(
      "exception",
      error?.message ? String(error.message).slice(0, 180) : String(error)
    );
  }
}

// Cargar datos desde Supabase
async function cargarDesdeSupabase(cat) {
  if (!supabase) {
    throw new Error("Cliente de Supabase no disponible");
  }

  try {
    fylCatalogDbg(`🗄️ Cargando desde Supabase: ${cat}`);

    // [PERF] Query de validacion de categorias eliminada (era solo diagnostico).

    let query = supabase.from("catalog_public_view").select("*");

    if (cat === "Novedades" || cat === "Ofertas" || cat === "all") {
      // Para categorías especiales o 'all', cargar todas las categorías
      fylCatalogDbg(`📦 Cargando todas las categorías para: ${cat}`);
      // [PERF] Para "all", limitar payload inicial para acelerar primer render.
      // Novedades/Ofertas necesitan todos los datos para filtrar en JS.
      const fetchQuery = cat === "all"
        ? query.limit(100)
        : query;
      const { data, error } = await fetchQuery;
      if (error) {
        console.error("❌ Error en consulta:", error);
        throw error;
      }

      fylCatalogDbg(`📊 Total de registros obtenidos: ${data?.length || 0}`);
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
        fylCatalogDbg(`🆕 Productos de novedades (últimos 7 días): ${items.length}`);
      }

      if (cat === "Ofertas") {
        items = items.filter((i) => {
          const mostrar = i.Mostrar;
          const oferta = i.Oferta;
          const mostrarOk = mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
          const ofertaOk = oferta === "TRUE" || oferta === true || oferta === "true" || oferta === 1;
          return mostrarOk && ofertaOk;
        });
        fylCatalogDbg(`🔥 Productos en ofertas: ${items.length}`);
      }

      if (cat === "all") {
        // Filtrar por Mostrar también para "all"
        items = items.filter((i) => {
          const mostrar = i.Mostrar;
          return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
        });
        fylCatalogDbg(`📦 Productos en "all" (filtrados por Mostrar): ${items.length}`);
      }

      return items;
    } else {
      // Caso especial: "Lenceria" y otros tags de "Otros" deben mostrar productos de "Otros" con Filtro1 correspondiente
      // Primero, verificar si es un tag de "Otros" obteniendo todos los tags únicos
      let isOtrosTag = false;
      let tagValue = null;
      
      if (cat === "Lenceria") {
        isOtrosTag = true;
        tagValue = "lenceria";
      } else {
        // Verificar si la categoría corresponde a un tag de "Otros"
        // Obtener todos los tags únicos de "Otros" (Filtro1, Filtro2, Filtro3)
        try {
          const { data: otrosTags, error: tagsError } = await supabase
            .from("catalog_public_view")
            .select("Filtro1, Filtro2, Filtro3")
            .eq("Categoria", "Otros");
          
          if (!tagsError && otrosTags && otrosTags.length > 0) {
            // Recolectar todos los tags únicos de todos los filtros
            const allTags = new Set();
            otrosTags.forEach(item => {
              if (item.Filtro1) allTags.add(item.Filtro1.trim().toLowerCase());
              if (item.Filtro2) allTags.add(item.Filtro2.trim().toLowerCase());
              if (item.Filtro3) {
                item.Filtro3.split(',').forEach(tag => {
                  const trimmedTag = tag.trim().toLowerCase();
                  if (trimmedTag) allTags.add(trimmedTag);
                });
              }
            });
            
            const uniqueTags = Array.from(allTags);
            fylCatalogDbg(`🔍 Tags únicos encontrados en "Otros":`, uniqueTags);
            
            // Verificar si la categoría coincide con algún tag (case-insensitive)
            const catLower = cat.toLowerCase();
            const matchingTag = uniqueTags.find(tag => 
              tag === catLower || 
              tag.replace(/\s+/g, '-') === catLower ||
              tag.replace(/\s+/g, '') === catLower
            );
            
            if (matchingTag) {
              isOtrosTag = true;
              tagValue = matchingTag;
              fylCatalogDbg(`📋 Detectado tag de "Otros": "${cat}" -> "${tagValue}"`);
            } else {
              fylCatalogDbg(`⚠️ Tag "${cat}" no encontrado en tags de "Otros"`);
            }
          }
        } catch (error) {
          console.warn("⚠️ Error verificando tags de Otros:", error);
        }
      }
      
      if (isOtrosTag && tagValue) {
        fylCatalogDbg(`📦 Filtrando por tag "${tagValue}" en TODAS las categorías`);
        
        // Obtener TODOS los productos (no limitar a "Otros")
        const { data: todosProductos, error: errorProductos } = await query;
        
        if (errorProductos) {
          console.error("❌ Error en consulta de productos:", errorProductos);
          console.error("Detalles del error:", {
            message: errorProductos.message,
            details: errorProductos.details,
            hint: errorProductos.hint
          });
          throw errorProductos;
        }

        fylCatalogDbg(`📊 Registros obtenidos (todas las categorías): ${todosProductos?.length || 0}`);
        
        // Filtrar en memoria para usar búsqueda más flexible (como en custom-banner.js)
        const tagValueNormalized = tagValue.toLowerCase().trim();
        fylCatalogDbg(`🔍 Buscando productos con tag normalizado: "${tagValueNormalized}"`);
        
        // Primero, ver TODOS los productos y sus tags
        if (todosProductos && todosProductos.length > 0) {
          const ejemplos = todosProductos.slice(0, 5);
          fylCatalogDbg(`📋 Ejemplos de productos (primeros 5):`, ejemplos.map(p => ({
            Articulo: p.Articulo,
            Categoria: p.Categoria,
            Filtro1: p.Filtro1,
            Filtro2: p.Filtro2,
            Filtro3: p.Filtro3
          })));
        }
        
        const dataFiltrada = (todosProductos || []).filter((i) => {
          // Normalizar tags para comparación
          const filtro1 = (i.Filtro1 || '').toLowerCase().trim();
          const filtro2 = (i.Filtro2 || '').toLowerCase().trim();
          const filtro3Tags = (i.Filtro3 || '')
            .split(',')
            .map(tag => tag.trim().toLowerCase())
            .filter(tag => tag.length > 0);
          
          // Buscar coincidencia en cualquiera de los filtros
          const match = filtro1.includes(tagValueNormalized) ||
                        filtro2.includes(tagValueNormalized) ||
                        filtro3Tags.some(tag => tag.includes(tagValueNormalized));
          
          if (match) {
            fylCatalogDbg(`✓ INCLUIDO: ${i.Articulo} - F1:"${i.Filtro1}" F2:"${i.Filtro2}" F3:"${i.Filtro3}"`);
          }
          
          return match;
        });
        
        fylCatalogDbg(`📋 Registros filtrados por tag "${tagValue}": ${dataFiltrada.length} de ${todosProductos?.length || 0}`);
        
        // Mostrar algunos productos que NO coincidieron (para debug)
        const noCoincidieron = (todosProductos || []).filter((i) => {
          const filtro1 = (i.Filtro1 || '').toLowerCase().trim();
          const filtro2 = (i.Filtro2 || '').toLowerCase().trim();
          const filtro3Tags = (i.Filtro3 || '')
            .split(',')
            .map(tag => tag.trim().toLowerCase())
            .filter(tag => tag.length > 0);
          
          return !(filtro1.includes(tagValueNormalized) ||
                   filtro2.includes(tagValueNormalized) ||
                   filtro3Tags.some(tag => tag.includes(tagValueNormalized)));
        });
        
        if (noCoincidieron.length > 0) {
          fylCatalogDbg(`❌ Productos excluidos (primeros 10):`, noCoincidieron.slice(0, 10).map(p => ({
            Articulo: p.Articulo,
            Filtro1: p.Filtro1,
            Filtro2: p.Filtro2,
            Filtro3: p.Filtro3
          })));
        }
        
        // La vista devuelve Mostrar como booleano true, no como string "TRUE"
        // Aceptar ambos: true (booleano) y "TRUE" (string)
        const filtered = dataFiltrada.filter((i) => {
          const mostrar = i.Mostrar;
          return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
        });
        fylCatalogDbg(`✅ Registros después de filtrar Mostrar: ${filtered.length}`);
        
        if (filtered.length === 0 && dataFiltrada.length > 0) {
          console.warn(`⚠️ Hay ${dataFiltrada.length} registros pero ninguno pasa el filtro de Mostrar`);
          console.warn(`📋 Primeros registros (mostrando valor de Mostrar):`, dataFiltrada.slice(0, 3).map(r => ({
            Articulo: r.Articulo,
            Mostrar: r.Mostrar,
            MostrarType: typeof r.Mostrar,
            Categoria: r.Categoria,
            Filtro1: r.Filtro1
          })));
          console.warn(`💡 La vista devuelve Mostrar como: ${typeof dataFiltrada[0]?.Mostrar} (valor: ${dataFiltrada[0]?.Mostrar})`);
        }
        
        return filtered;
      }
      
      // Para categorías normales, filtrar por categoría
      fylCatalogDbg(`📦 Filtrando por categoría: "${cat}"`);
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

      fylCatalogDbg(`📊 Registros obtenidos antes de filtrar Mostrar: ${data?.length || 0}`);
      
      // La vista devuelve Mostrar como booleano true, no como string "TRUE"
      // Aceptar ambos: true (booleano) y "TRUE" (string)
      const filtered = (data || []).filter((i) => {
        const mostrar = i.Mostrar;
        return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
      });
      fylCatalogDbg(`✅ Registros después de filtrar Mostrar: ${filtered.length}`);
      
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
  fylCatalogDbg(`📊 Cargando desde Google Sheets (fallback): ${cat}`);

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

// Función para intercalar productos según el patrón especificado
function intercalarProductosPorCategoria(productos) {
  // Separar productos por categoría y filtro, y ordenarlos por fecha (más nuevos primero)
  const calzado = productos
    .filter(p => (p.Categoria || "").trim().toLowerCase() === "calzado")
    .sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA; // Más reciente primero
    });
  
  const ropa = productos
    .filter(p => (p.Categoria || "").trim().toLowerCase() === "ropa")
    .sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA; // Más reciente primero
    });
  
  const otrosMarroquineria = productos
    .filter(p => 
      (p.Categoria || "").trim().toLowerCase() === "otros" && 
      (p.Filtro1 || "").trim().toLowerCase() === "marroquineria"
    )
    .sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA; // Más reciente primero
    });
  
  const otrosLenceria = productos
    .filter(p => 
      (p.Categoria || "").trim().toLowerCase() === "otros" && 
      (p.Filtro1 || "").trim().toLowerCase() === "lenceria"
    )
    .sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA; // Más reciente primero
    });
  
  // Índices para rastrear qué productos ya se han usado
  let idxCalzado = 0;
  let idxRopa = 0;
  let idxOtrosMarroquineria = 0;
  let idxOtrosLenceria = 0;
  
  const resultado = [];
  let patronCompleto = 0; // Contador para rastrear cuántas veces se ha completado el patrón
  
  // Función helper para obtener los siguientes N productos de un array
  const obtenerSiguientes = (array, indice, cantidad) => {
    const productos = [];
    for (let i = 0; i < cantidad && indice + i < array.length; i++) {
      productos.push(array[indice + i]);
    }
    return { productos, nuevoIndice: indice + productos.length };
  };
  
  // Continuar hasta que no haya más productos en ninguna categoría
  while (idxCalzado < calzado.length || 
         idxRopa < ropa.length || 
         idxOtrosMarroquineria < otrosMarroquineria.length || 
         idxOtrosLenceria < otrosLenceria.length) {
    
    // Patrón: 3 Calzado, 2 Ropa, 3 Calzado, 2 Otros(Marroquineria), 2 Calzado, 2 Otros(Lenceria)
    
    // 1. 3 Calzado
    if (idxCalzado < calzado.length) {
      const { productos: productosCalzado, nuevoIndice } = obtenerSiguientes(calzado, idxCalzado, 3);
      resultado.push(...productosCalzado);
      idxCalzado = nuevoIndice;
    }
    
    // 2. 2 Ropa
    if (idxRopa < ropa.length) {
      const { productos: productosRopa, nuevoIndice } = obtenerSiguientes(ropa, idxRopa, 2);
      resultado.push(...productosRopa);
      idxRopa = nuevoIndice;
    }
    
    // 3. 3 Calzado
    if (idxCalzado < calzado.length) {
      const { productos: productosCalzado, nuevoIndice } = obtenerSiguientes(calzado, idxCalzado, 3);
      resultado.push(...productosCalzado);
      idxCalzado = nuevoIndice;
    }
    
    // 4. 2 Otros(Marroquineria)
    if (idxOtrosMarroquineria < otrosMarroquineria.length) {
      const { productos: productosOtrosMarroquineria, nuevoIndice } = obtenerSiguientes(otrosMarroquineria, idxOtrosMarroquineria, 2);
      resultado.push(...productosOtrosMarroquineria);
      idxOtrosMarroquineria = nuevoIndice;
    }
    
    // 5. 2 Calzado
    if (idxCalzado < calzado.length) {
      const { productos: productosCalzado, nuevoIndice } = obtenerSiguientes(calzado, idxCalzado, 2);
      resultado.push(...productosCalzado);
      idxCalzado = nuevoIndice;
    }
    
    // 6. 2 Otros(Lenceria)
    if (idxOtrosLenceria < otrosLenceria.length) {
      const { productos: productosOtrosLenceria, nuevoIndice } = obtenerSiguientes(otrosLenceria, idxOtrosLenceria, 2);
      resultado.push(...productosOtrosLenceria);
      idxOtrosLenceria = nuevoIndice;
    }
    
    patronCompleto++;
    
    // Si no se agregó ningún producto en este ciclo, salir para evitar loop infinito
    const longitudAntes = resultado.length;
    // Verificar si algún producto se agregó en este ciclo
    if (idxCalzado >= calzado.length && 
        idxRopa >= ropa.length && 
        idxOtrosMarroquineria >= otrosMarroquineria.length && 
        idxOtrosLenceria >= otrosLenceria.length) {
      break;
    }
  }
  
  fylCatalogDbg(`🔄 Productos intercalados: ${resultado.length} productos siguiendo el patrón`);
  fylCatalogDbg(`📊 Distribución: Calzado=${idxCalzado}, Ropa=${idxRopa}, Otros(Marroquineria)=${idxOtrosMarroquineria}, Otros(Lenceria)=${idxOtrosLenceria}`);
  
  return resultado;
}

/** Agrupar filas crudas (variantes) en productos por Articulo. Reutilizable por cargarCategoria y ensureAllCacheLoadedGrouped. */
function agruparProductos(rows) {
  if (!rows || rows.length === 0) return [];
  const grupos = rows.reduce((acc, i) => {
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
        Categoria: i.Categoria || "",
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
      acc[art].OfertaActiva = true;
      if (i["Imagen Principal"] && i["Imagen Principal"] === acc[art].VariantePrincipal) {
        acc[art].PrecioOferta = i.PrecioOferta || acc[art].PrecioOferta;
      } else if (!acc[art].PrecioOferta) {
        acc[art].PrecioOferta = i.PrecioOferta || '';
      }
    }
    if (i.PromoActiva && i.PromoActiva !== '') acc[art].PromoActiva = i.PromoActiva;
    acc[art].DetalleColor.push({
      color: i.Color || "Sin color",
      hex_color: i.ColorHex || null,
      ColorDisplayNumber: i.ColorDisplayNumber || null,
      talles: i.Numeracion?.split(",").map((t) => t.trim()) || ["Único"],
      images: Object.keys(i)
        .filter((k) => k.toLowerCase().startsWith("imagen"))
        .map((k) => i[k])
        .filter(Boolean),
      OfertaActiva: i.OfertaActiva === true || i.OfertaActiva === 'true',
      PrecioOferta: i.PrecioOferta || '',
      PromoActiva: i.PromoActiva || '',
    });
    return acc;
  }, {});
  return Object.values(grupos);
}

// Función principal de carga de categoría
async function cargarCategoria(cat) {
  fylCatalogDbg("🔄 Cargando categoría:", cat);

  // Actualizar categoría actual
  categoriaActual = cat || 'all';
  // Sincronizar con el filtro de talles (misma categoría que ve el usuario; incluye Lencería/Otros por tag)
  window.__fylCategoriaActual = categoriaActual;

  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");

  // Ocultar indicador de scroll infinito al cambiar de categoría
  ocultarIndicadorCarga();
  
  // Ocultar indicador de carga inferior al cambiar de categoría
  ocultarIndicadorCargaInferior();
  indicadorCargaActivo = false;

  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";
  
  // Ocultar banner dinámico si no estamos en inicio (solo se muestra en index puro)
  if (cat !== "all" && typeof window.hideCustomBanner === 'function') {
    window.hideCustomBanner();
  }

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

    fylCatalogDbg(`🔄 Intentando cargar categoría "${cat}" desde Supabase...`);
    fylCatalogDbg(`🔧 Cliente Supabase disponible:`, supabase ? "SÍ" : "NO");
    
    data = await cargarDesdeSupabase(cat);
    fylCatalogDbg(`✅ Datos cargados desde Supabase: ${data.length} productos`);
    fylCatalogDbg(`📊 Fuente de datos: ${fuente}`);
    
    // Log detallado de los primeros productos
    if (data.length > 0) {
      fylCatalogDbg("📋 Primeros productos cargados:", data.slice(0, 3).map(p => ({
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
        fylCatalogDbg(`🔥 Se encontraron ${productosConOferta.length} variantes con ofertas activas`);
        fylCatalogDbg("📊 Ejemplos de ofertas:", productosConOferta.slice(0, 3).map(p => ({
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
      fylCatalogDbg("⚠️ No hay productos para mostrar en la categoría:", cat);
      return;
    }

    // Ordenar por fecha de ingreso
    data.sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });

    // Agrupar productos por artículo (función reutilizable)
    const gruposArray = agruparProductos(data);
    const grupos = gruposArray.reduce((acc, p) => {
      acc[p.Articulo] = p;
      return acc;
    }, {});

    // (agrupación en agruparProductos)
    /*
          VariantePrincipal: i["Imagen Principal"],
          Oferta: i.Oferta || "",
          FechaIngreso: i.FechaIngreso || "",
          Categoria: i.Categoria || "",
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
        hex_color: i.ColorHex || null,
        ColorDisplayNumber: i.ColorDisplayNumber || null,
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

    */
    fylCatalogDbg(`📦 Productos agrupados: ${gruposArray.length}`);

    // Obtener ofertas activas con imágenes
    let offersCards = [];
    try {
      const { data: offers, error: offersError } = await supabase
        .rpc('get_active_offers_with_images');
      
      if (!offersError && offers && offers.length > 0) {
        fylCatalogDbg(`🔥 Se encontraron ${offers.length} campañas de ofertas con imágenes`);
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

    // Ordenar productos por fecha de ingreso
    let productosOrdenados = Object.values(grupos).sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });
    
    // Si es vista "all" (Inicio), aplicar intercalado de categorías
    if (cat === "all") {
      productosOrdenados = intercalarProductosPorCategoria(productosOrdenados);
    }
    
    // Almacenar todos los productos para paginación y recomendados PDP
    productosPendientes = productosOrdenados;
    window.__allProductsCache = productosOrdenados;
    productosRenderizados = 0;
    offersCardsPendientes = offersCards;
    setCatalogLoadMode("paged");
    
    // Limpiar contenedor
    cont.innerHTML = "";
    
    // Renderizar el primer bloque y conservar la cantidad real renderizada.
    const firstChunkRendered = await renderizarProductosPagina(
      productosPendientes,
      cont,
      offersCardsPendientes,
      0,
      PRODUCTOS_INICIALES
    );
    productosRenderizados = Number(firstChunkRendered) || 0;
    
    // Configurar eventos
    configurarEventos();
    
    // Mostrar botón "Ver más modelos" si hay más productos
    mostrarBotonVerMas();
    
    fylCatalogTrackViewItemList("category:" + (cat || "all"), productosPendientes, "category_grid");
    
    // Reiniciar verificación de carga de imágenes
    iniciarVerificacionCargaImagenes();

    if (cat === "all") {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const hashOk = location.hash !== "#/coleccion/fyl-originals";
      const hayBusquedaActiva = !!document.getElementById("searchInput")?.value?.trim();
      const hayFiltroActivo = !!document.querySelector('#filtroMenu input[type="checkbox"]:checked');
      const isBootingHome =
        typeof window !== "undefined" && window.__FYL_BOOT_SUPPRESS_ROUTE === true;

      const runHomeExtras = async ({ includeFylBanner = true } = {}) => {
        const paralelos = [];
        if (includeFylBanner && typeof window.loadAndShowFYLBanner === "function") {
          paralelos.push(Promise.resolve(window.loadAndShowFYLBanner()));
        }
        if (
          hashOk &&
          !hayBusquedaActiva &&
          !hayFiltroActivo &&
          fylPendingHomeCustomBanner &&
          typeof window.loadAndShowCustomBanner === "function"
        ) {
          fylPendingHomeCustomBanner = false;
          paralelos.push(Promise.resolve(window.loadAndShowCustomBanner()));
        } else {
          fylPendingHomeCustomBanner = false;
        }
        if (typeof window.loadBanner === "function") {
          paralelos.push(Promise.resolve(window.loadBanner()));
        }
        await Promise.allSettled(paralelos);
        if (typeof window.showPromotionalBanner === "function") {
          window.showPromotionalBanner();
        }
        syncInfoBannerVisibility();
      };

      const scheduleHomeExtrasPostBoot = (task, timeoutMs = 1200) => {
        const run = () => {
          Promise.resolve(task()).catch((error) => {
            console.warn("⚠️ No se pudieron cargar extras de Home:", error?.message || error);
          });
        };
        if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(run, { timeout: timeoutMs });
          return;
        }
        setTimeout(run, timeoutMs);
      };

      if (isBootingHome) {
        // En primer arranque esperamos solo FYL Originals (con tope) para que no aparezca “tarde”.
        if (typeof window.loadAndShowFYLBanner === "function") {
          try {
            await Promise.race([
              Promise.resolve(window.loadAndShowFYLBanner()),
              new Promise((resolve) => setTimeout(resolve, 1700)),
            ]);
          } catch (error) {
            console.warn("⚠️ No se pudo cargar FYL Originals en boot:", error?.message || error);
          }
        }
        // El resto de extras se mantiene en background para no alargar demasiado el boot.
        scheduleHomeExtrasPostBoot(() => runHomeExtras({ includeFylBanner: false }), 900);
      } else {
        // En interacciones posteriores mantener todo en background.
        scheduleHomeExtrasPostBoot(() => runHomeExtras(), 500);
      }
    } else {
      // Ocultar banners si no estamos en Inicio
      if (typeof window.hideFYLOriginalsBanner === "function") {
        window.hideFYLOriginalsBanner();
      }
      if (typeof window.hidePromotionalBanner === "function") {
        window.hidePromotionalBanner();
      }
      syncInfoBannerVisibility();
    }
    
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

// Función para formatear precios al formato $25.000 (ARS con separador de miles)
function formatPrice(precio) {
  return formatARS(precio);
}

// Helper ARS: siempre muestra $X.XXX con Intl.NumberFormat
function formatARS(n) {
  return formatARSValue(n);
}

function renderPriceWithOffer(producto) {
  const hasOffer = producto.OfertaActiva === true || producto.OfertaActiva === 'true';
  const hasPromo = producto.PromoActiva && producto.PromoActiva !== '';
  const originalPrice = producto.Precio || '';
  const offerPrice = producto.PrecioOferta || '';
  
  // Si hay promo, mostrar precio original con badge de promo (sin oferta)
  if (hasPromo) {
    return `
      <div class="price">${formatPrice(originalPrice)}</div>
    `;
  }
  
  // Si hay oferta, mostrar precio original tachado y precio de oferta
  if (hasOffer && offerPrice) {
    return `
      <div class="price">
        <span class="price-original">${formatPrice(originalPrice)}</span>
        <span class="price-offer">${formatPrice(offerPrice)}</span>
      </div>
    `;
  }
  
  // Precio normal
  return `<div class="price">${formatPrice(originalPrice)}</div>`;
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

// Variable global para rastrear la categoría actual
let categoriaActual = 'all';
window.__fylCategoriaActual = 'all';

/** Mostrar/ocultar #info-banner-top-container según categoriaActual === "all".
 *  Expuesto en window para que como-comprar.js lo llame al volver de #/como-comprar. */
function syncInfoBannerVisibility() {
  const el = document.getElementById("info-banner-top-container");
  if (!el) return;
  if (categoriaActual === "all") {
    el.classList.remove("is-hidden");
  } else {
    el.classList.add("is-hidden");
  }
}
if (typeof window !== "undefined") window.syncInfoBannerVisibility = syncInfoBannerVisibility;

// Función auxiliar para renderizar un conjunto de productos
// options.skipBanner: si true, no insertar el banner dinámico (solo debe mostrarse en index puro)
async function renderizarProductosPagina(productos, container, offersCards = [], startIndex = 0, count = null, options = {}) {
  if (productos.length === 0 && offersCards.length === 0) return 0;
  if (startIndex === 0) fylPendingHomeCustomBanner = false;
  
  // Enriquecer productos con stock (solo los que vamos a renderizar)
  const productosARenderizar = count !== null 
    ? productos.slice(startIndex, startIndex + count)
    : productos.slice(startIndex);
  
  if (productosARenderizar.length > 0) {
    await enrichProductsWithStock(productosARenderizar);
  }
  
  // Crear array combinado de productos y ofertas
  const allItems = [];
  
  // Agregar ofertas solo si es la primera página (startIndex === 0)
  if (startIndex === 0) {
    offersCards.forEach(offer => {
      allItems.push({ type: 'offer', data: offer });
    });
  }
  
  // Agregar productos a renderizar
  productosARenderizar.forEach((producto) => {
    allItems.push({ type: 'product', data: producto });
  });
  
  // Renderizar items
  let productosRenderizadosEnEstaPagina = 0;
  let bannerInsertado = false;
  allItems.forEach((item, index) => {
    if (item.type === 'offer') {
      const offerCardHTML = renderOfferCard(item.data);
      container.insertAdjacentHTML('beforeend', offerCardHTML);
    } else {
      const producto = item.data;
      productosRenderizadosEnEstaPagina++;
      const gal = renderizarGaleria(producto);
      const colores = renderizarColores(producto);
      const variants = renderizarVariantes(producto);
      
      // Obtener SKU por defecto para la card
      const skuDefecto = obtenerSKUDefecto(producto);
      const cardImageWidth =
        typeof window !== "undefined" && window.innerWidth <= 430 ? 480 : 800;
      const mainImageUrls = getMainImageFallbackUrls(producto, cardImageWidth);
      const mainSrc =
        mainImageUrls[0] || cloudinaryOptimized(producto.VariantePrincipal, cardImageWidth);
      const fallbackUrls = mainImageUrls.slice(1);
      const fallbackUrlsAttr = fallbackUrls.length
        ? JSON.stringify(fallbackUrls).replace(/"/g, "&quot;")
        : "";

      const productoHTML = `
        <div class="card producto"
             data-articulo="${producto.Articulo || ""}"
             data-filtro1="${producto.Filtro1 || ""}"
             data-filtro2="${producto.Filtro2 || ""}"
             data-filtro3="${producto.Filtro3 || ""}"
             data-sku="${skuDefecto || ''}"
             data-name="${(producto.name || producto.Articulo || '').toLowerCase()}">
          <div class="main-image-wrapper">
            <img class="main-image" loading="lazy" 
                 src="${mainSrc}" 
                 alt="${producto.Articulo}"
                 data-sku="${skuDefecto || ''}"
                 ${fallbackUrlsAttr ? `data-fallback-urls="${fallbackUrlsAttr}" onerror="window.mainImageFallback&&window.mainImageFallback(this)"` : ""}/>
            <div class="product-name-badge">${producto.Articulo || producto.Descripcion || 'Producto'}</div>
          </div>
          <div class="image-loader"><div class="spinner"></div></div>
          ${renderOfferAndPromoBadges(producto)}
          <div class="title-row">
            <h3>${renderOfferFireIcon(producto)}</h3>
          </div>
          <div class="card-footer">
            <div class="card-footer-top">
              <div class="card-price">
                ${renderPriceWithOffer(producto)}
                <div class="price-wholesale">Precio por mayor</div>
              </div>
            </div>
            <div class="colors-row">
              <div class="colors">${colores}</div>
            </div>
            <div class="card-footer-size" data-articulo="${producto.Articulo}" data-color-selected="${producto.DetalleColor?.[0]?.color || ''}">${obtenerSizeBadgeHTML(producto, producto.DetalleColor?.[0]?.color)}</div>
            ${window.__CATALOG_ONLY__ ? '' : `<button class="cart-icon-btn" 
                    data-articulo="${producto.Articulo}"
                    title="Agregar al carrito"
                    onclick="event.stopPropagation(); if(window.BottomSheet && window.productosActualesMap) { const producto = window.productosActualesMap.get('${producto.Articulo}'); if(producto) window.BottomSheet.open(producto); }">
              <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
                <circle cx='9' cy='21' r='1'></circle>
                <circle cx='20' cy='21' r='1'></circle>
                <path d='M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6'></path>
              </svg>
            </button>`}
          </div>
        </div>
      `;

      container.insertAdjacentHTML('beforeend', productoHTML);
      
      // Almacenar producto en productosActualesMap para Bottom Sheet
      productosActualesMap.set(producto.Articulo, producto);
      
      // Exponer productosActualesMap globalmente para el icono de carrito
      if (typeof window !== 'undefined') {
        window.productosActualesMap = productosActualesMap;
      }
      
      // Insertar banner personalizado después de la segunda fila (4 productos en desktop, 2 en mobile)
      // SOLO en index puro: categoría "all", sin búsqueda, sin filtros, sin oferta/colección
      const hayBusquedaActiva = !!document.getElementById("searchInput")?.value?.trim();
      const hayFiltroActivo = !!document.querySelector('#filtroMenu input[type="checkbox"]:checked');
      const debeOmitirBanner = options.skipBanner || hayBusquedaActiva || hayFiltroActivo;
      if (location.hash === "#/coleccion/fyl-originals") {
        // No insertar banners editables en vista colección
      } else if (!debeOmitirBanner && categoriaActual === "all" && startIndex === 0 && productosRenderizadosEnEstaPagina === 4 && !bannerInsertado && typeof window.loadAndShowCustomBanner === 'function') {
        bannerInsertado = true;
        // Insertar el banner después del cuarto producto dentro del contenedor del catálogo
        const productosCards = container.querySelectorAll('.card.producto');
        if (productosCards.length >= 4) {
          const cuartoProducto = productosCards[productosCards.length - 1];
          const bannerContainer = document.getElementById('custom-banner-container');
          if (bannerContainer && cuartoProducto.parentNode) {
            // Crear un wrapper para el banner que ocupe todo el ancho del grid
            const bannerWrapper = document.createElement('div');
            bannerWrapper.id = 'custom-banner-wrapper';
            bannerWrapper.className = 'custom-banner-wrapper';
            bannerWrapper.style.cssText = 'grid-column: 1 / -1; width: 100%; padding: 0; margin: 0;';
            
            // Clonar el banner y agregarlo al wrapper
            const clonedBanner = bannerContainer.cloneNode(true);
            clonedBanner.id = 'custom-banner-container-inline';
            clonedBanner.style.display = 'block';
            bannerWrapper.appendChild(clonedBanner);
            
            // Insertar el wrapper después del cuarto producto dentro del grid
            cuartoProducto.parentNode.insertBefore(bannerWrapper, cuartoProducto.nextSibling);
          }
        }
        fylPendingHomeCustomBanner = true;
      }
    }
  });
  
  // Agregar event listeners a los cards de oferta (solo para los nuevos)
  if (startIndex === 0 || allItems.some(item => item.type === 'offer')) {
    container.querySelectorAll('.offer-card').forEach(card => {
      if (!card.dataset.listenerAdded) {
        card.dataset.listenerAdded = 'true';
        card.addEventListener('click', () => {
          const campaignId = card.dataset.offerCampaignId;
          if (campaignId) {
            filterByOffer(campaignId);
          }
        });
      }
    });
  }

  return productosARenderizar.length;
}

// Función para crear/obtener el indicador de carga
function obtenerIndicadorCarga() {
  let loader = document.getElementById("infinite-scroll-loader");
  if (!loader) {
    loader = document.createElement("div");
    loader.id = "infinite-scroll-loader";
    loader.className = "infinite-scroll-loader";
    loader.innerHTML = `
      <div class="infinite-scroll-spinner">
        <div class="spinner-circle"></div>
        <div class="spinner-circle"></div>
        <div class="spinner-circle"></div>
      </div>
      <p class="infinite-scroll-text">Cargando más productos...</p>
    `;
  }
  return loader;
}

// Función para mostrar el indicador de carga (en el lugar del botón)
function mostrarIndicadorCarga() {
  const cont = document.getElementById("catalogo");
  if (!cont) return;
  
  const loader = obtenerIndicadorCarga();
  
  // Si el loader ya está en otro lugar, removerlo
  if (loader.parentNode && loader.parentNode !== cont) {
    loader.parentNode.removeChild(loader);
  }
  
  // Si el loader ya está en el contenedor, removerlo para reinsertarlo al final
  if (cont.contains(loader)) {
    cont.removeChild(loader);
  }
  
  // Agregar el loader al final del contenedor (en el lugar donde estaba el botón)
  cont.appendChild(loader);
  loader.style.visibility = "visible";
  loader.style.opacity = "1";
  loader.style.display = "flex";
  loader.classList.add("show");
}

// Función para ocultar el indicador de carga
function ocultarIndicadorCarga() {
  const loader = document.getElementById("infinite-scroll-loader");
  if (loader) {
    loader.style.display = "none";
    loader.classList.remove("show");
    // Asegurar que esté completamente oculto
    loader.style.visibility = "hidden";
    loader.style.opacity = "0";
  }
}

// Función auxiliar para verificar si estamos cerca del final de la página
function estaCercaDelFinal(threshold = 500) {
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const windowHeight = window.innerHeight;
  const documentHeight = document.documentElement.scrollHeight;
  return documentHeight - (scrollTop + windowHeight) < threshold;
}

function setCatalogLoadMode(mode = "paged") {
  catalogoLoadMode = mode === "full" ? "full" : "paged";
}

function isCatalogAutoloadActive() {
  return CATALOGO_AUTOLOAD_SCROLL && catalogoLoadMode === "paged";
}

function teardownCatalogAutoloadObserver() {
  if (catalogoAutoloadObserver) {
    try {
      catalogoAutoloadObserver.disconnect();
    } catch (_e) {}
    catalogoAutoloadObserver = null;
  }
  if (catalogoAutoloadSentinel?.parentNode) {
    try {
      catalogoAutoloadSentinel.parentNode.removeChild(catalogoAutoloadSentinel);
    } catch (_e) {}
  }
  catalogoAutoloadSentinel = null;
  catalogoAutoloadFallbackEnabled = false;
}

function ensureCatalogAutoloadSentinel(container) {
  if (!container) return null;
  let sentinel = container.querySelector(".catalog-autoload-sentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.className = "catalog-autoload-sentinel";
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText =
      "width:100%;height:1px;opacity:0;pointer-events:none;grid-column:1 / -1;";
  }
  container.appendChild(sentinel);
  catalogoAutoloadSentinel = sentinel;
  return sentinel;
}

function maybeTriggerCatalogAutoloadFallback() {
  if (!isCatalogAutoloadActive()) return;
  if (!catalogoAutoloadFallbackEnabled) return;
  if (isLoadingMore) return;
  if (productosRenderizados >= productosPendientes.length) return;
  if (estaCercaDelFinal(CATALOGO_AUTOLOAD_FALLBACK_THRESHOLD_PX)) {
    void cargarSiguienteBloque({ reason: "scroll-fallback" });
  }
}

function refreshCatalogAutoloadBinding() {
  teardownCatalogAutoloadObserver();
  const cont = document.getElementById("catalogo");
  if (!cont || !isCatalogAutoloadActive()) return;
  if (productosRenderizados >= productosPendientes.length) return;

  const sentinel = ensureCatalogAutoloadSentinel(cont);
  if (!sentinel) return;

  if (typeof window.IntersectionObserver === "function") {
    catalogoAutoloadObserver = new window.IntersectionObserver(
      (entries) => {
        const shouldLoad = entries.some((entry) => entry.isIntersecting);
        if (!shouldLoad) return;
        void cargarSiguienteBloque({ reason: "observer" });
      },
      {
        root: null,
        rootMargin: `0px 0px ${CATALOGO_AUTOLOAD_ROOT_MARGIN_PX}px 0px`,
        threshold: 0,
      }
    );
    catalogoAutoloadObserver.observe(sentinel);
    return;
  }

  catalogoAutoloadFallbackEnabled = true;
}

async function maybeReapplyCatalogSizeFilter() {
  if (typeof window.reapplyActiveSizeFilter !== "function") return;
  try {
    await window.reapplyActiveSizeFilter();
  } catch (error) {
    console.warn("⚠️ No se pudo reaplicar filtro de talles:", error?.message || error);
  }
}

async function cargarSiguienteBloque(options = {}) {
  if (isLoadingMore) return 0;
  if (productosRenderizados >= productosPendientes.length) {
    ensureLoadMoreButtonAtEnd();
    return 0;
  }

  const chunkSize = Math.max(
    1,
    Number(options.chunkSize || PRODUCTOS_POR_PAGINA) || PRODUCTOS_POR_PAGINA
  );
  const cont = document.getElementById("catalogo");
  if (!cont) return 0;

  isLoadingMore = true;

  const wrap = cont.querySelector(".load-more-wrap");
  if (wrap && wrap.parentNode) {
    wrap.parentNode.removeChild(wrap);
  }

  mostrarIndicadorCarga();

  try {
    const renderedCount = await renderizarProductosPagina(
      productosPendientes,
      cont,
      [],
      productosRenderizados,
      chunkSize
    );

    if (renderedCount > 0) {
      productosRenderizados += renderedCount;
      configurarEventos();
      iniciarVerificacionCargaImagenes();
      await maybeReapplyCatalogSizeFilter();
    }

    return renderedCount;
  } catch (error) {
    console.error("Error cargando siguiente bloque:", error);
    return 0;
  } finally {
    ocultarIndicadorCarga();
    ensureLoadMoreButtonAtEnd();
    isLoadingMore = false;
    setTimeout(() => {
      maybeTriggerCatalogAutoloadFallback();
    }, 60);
  }
}

// Función para asegurar que el botón "Ver más modelos" esté al final del listado (#catalogo),
// dentro del flujo (no flotante) y visible solo si hay más productos.
function ensureLoadMoreButtonAtEnd() {
  const cont = document.getElementById("catalogo");
  if (!cont) return;
  
  ocultarIndicadorCarga();
  
  const hayMas = productosRenderizados < productosPendientes.length;
  
  let wrap = cont.querySelector(".load-more-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "load-more-wrap";
    const boton = document.createElement("button");
    boton.id = "btn-ver-mas-modelos";
    boton.className = "btn-ver-mas-modelos";
    boton.textContent = "Ver más modelos";
    boton.addEventListener("click", cargarMasProductos);
    wrap.appendChild(boton);
  }

  let contactInfo = wrap.querySelector(".catalog-inline-contact");
  if (!contactInfo) {
    contactInfo = document.createElement("div");
    contactInfo.className = "catalog-inline-contact";
    contactInfo.innerHTML = `
      <p class="catalog-inline-contact__title">FYL Moda · Mayorista en indumentaria y calzado</p>
      <p class="catalog-inline-contact__address">Av. Alberdi 1099 · Resistencia, Chaco</p>
      <p class="catalog-inline-contact__links">
        <a href="https://www.instagram.com/fylmodaok/" target="_blank" rel="noopener">Instagram</a>
        <span aria-hidden="true">·</span>
        <a href="https://www.facebook.com/FyLcalzados1" target="_blank" rel="noopener">Facebook</a>
        <span aria-hidden="true">·</span>
        <a href="https://wa.me/5493624118637" target="_blank" rel="noopener">WhatsApp</a>
      </p>
    `;
    wrap.appendChild(contactInfo);
  }

  cont.appendChild(wrap);

  const boton = wrap.querySelector("#btn-ver-mas-modelos");
  if (boton) {
    boton.style.display = isCatalogAutoloadActive() ? "none" : "";
  }
  wrap.style.display = hayMas ? "flex" : "none";

  refreshCatalogAutoloadBinding();
}

// Función para mostrar el botón "Ver más modelos" (delega a ensureLoadMoreButtonAtEnd)
function mostrarBotonVerMas() {
  ensureLoadMoreButtonAtEnd();
}

// Función para ocultar el botón "Ver más modelos" (delega a ensureLoadMoreButtonAtEnd)
function ocultarBotonVerMas() {
  ensureLoadMoreButtonAtEnd();
}

// Obtención del botón (para compatibilidad)
function obtenerBotonVerMas() {
  const wrap = document.querySelector(".load-more-wrap");
  return wrap ? wrap.querySelector("#btn-ver-mas-modelos") : document.getElementById("btn-ver-mas-modelos");
}

// Función para cargar más productos cuando se hace clic en el botón
async function cargarMasProductos() {
  await cargarSiguienteBloque({ reason: "manual-click", chunkSize: PRODUCTOS_POR_PAGINA });
}

// Función para inicializar el sistema de paginación (ya no usa scroll infinito, usa botón)
function inicializarScrollInfinito(container) {
  // Compatibilidad: ahora el autoload lo maneja IntersectionObserver/fallback.
  refreshCatalogAutoloadBinding();
  ocultarIndicadorCarga();
}

// Función wrapper para renderizar productos (compatibilidad)
async function renderizarProductos(productos, container, offersCards = []) {
  // Ordenar productos por fecha de ingreso
  const productosOrdenados = productos.slice().sort((a, b) => {
    const fechaA = parseFecha(a.FechaIngreso);
    const fechaB = parseFecha(b.FechaIngreso);
    return fechaB - fechaA;
  });
  
  return await renderizarProductosPagina(productosOrdenados, container, offersCards, 0, null);
}

// Función para filtrar productos por oferta
async function filterByOffer(campaignId) {
  fylCatalogDbg('🔥 Filtrando productos por oferta:', campaignId);
  
  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");
  
  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";
  if (typeof window.hideCustomBanner === 'function') window.hideCustomBanner();
  
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
          hex_color: i.ColorHex || null,
          ColorDisplayNumber: i.ColorDisplayNumber || null,
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
    
    // Ordenar productos por fecha de ingreso
    const productosOrdenados = Object.values(grupos).sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });
    
    // Almacenar todos los productos para paginación y recomendados PDP
    productosPendientes = productosOrdenados;
    window.__allProductsCache = productosOrdenados;
    productosRenderizados = 0;
    offersCardsPendientes = [];
    setCatalogLoadMode("paged");
    
    // Limpiar contenedor y mostrar mensaje
    cont.innerHTML = messageHTML;
    
    // Renderizar primer bloque (sin banner dinámico) y usar el conteo real.
    const firstChunkRendered = await renderizarProductosPagina(
      productosPendientes,
      cont,
      [],
      0,
      PRODUCTOS_INICIALES,
      { skipBanner: true }
    );
    productosRenderizados = Number(firstChunkRendered) || 0;
    
    // Configurar eventos
    configurarEventos();
    
    // Mostrar botón "Ver más modelos" si hay más productos
    mostrarBotonVerMas();
    
    // Reiniciar verificación de carga de imágenes
    iniciarVerificacionCargaImagenes();
  } catch (error) {
    console.error('Error filtrando por oferta:', error);
    cont.innerHTML = '<div class="no-data">Error al cargar productos en oferta</div>';
  } finally {
    if (loader) loader.classList.remove("show");
  }
}

// Función para filtrar productos por proveedor FYL
// options.forCollectionView: si true, no muestra la card redundante y actualiza #collection-count
async function filterBySupplierFYL(options = {}) {
  const forCollectionView = !!options.forCollectionView;
  fylCatalogDbg('🏭 Filtrando productos por proveedor FYL', forCollectionView ? '(vista colección)' : '');
  
  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");
  
  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";
  if (typeof window.hideCustomBanner === 'function') window.hideCustomBanner();
  
  try {
    // Ocultar banners (incl. info-banner: en vista FYL no mostramos el banner mayorista)
    if (typeof window.hideFYLOriginalsBanner === 'function') {
      window.hideFYLOriginalsBanner();
    }
    if (typeof window.hidePromotionalBanner === 'function') {
      window.hidePromotionalBanner();
    }
    document.getElementById("info-banner-top-container")?.classList.add("is-hidden");

    // Cargar todos los productos desde Supabase
    const data = await cargarDesdeSupabase('all');
    
    // Filtrar solo productos del proveedor FYL
    const productosFYL = data.filter(p => 
      p.SupplierCode === "FYL" || p.SupplierCode === "fyl"
    );
    
    if (productosFYL.length === 0) {
      cont.innerHTML = '<div class="no-data">No hay productos disponibles del proveedor F&L Originals</div>';
      if (forCollectionView) {
        const countEl = document.getElementById("collection-count");
        if (countEl) countEl.textContent = "0";
      }
      return;
    }
    
    // Ordenar por fecha de ingreso
    productosFYL.sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });
    
    // Agrupar productos por artículo (igual que en cargarCategoria)
    const grupos = productosFYL.reduce((acc, i) => {
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
          ColorDisplayNumber: i.ColorDisplayNumber || null,
          talles: i.Numeracion?.split(",").map((t) => t.trim()).filter(Boolean) || ["Único"],
          images: [
            i["Imagen Principal"],
            i["Imagen 1"],
            i["Imagen 2"],
            i["Imagen 3"],
          ].filter(Boolean),
          OfertaActiva: i.OfertaActiva === true || i.OfertaActiva === 'true',
          PrecioOferta: i.PrecioOferta || '',
          PromoActiva: i.PromoActiva || '',
        });
      } else {
        // Si el color ya existe, agregar talles que no estén
        const talles = i.Numeracion?.split(",").map((t) => t.trim()).filter(Boolean) || [];
        talles.forEach(talle => {
          if (!colorExists.talles.includes(talle)) {
            colorExists.talles.push(talle);
          }
        });
      }

      return acc;
    }, {});
    
    const modelCount = Object.keys(grupos).length;
    
    // En vista colección: header compacto externo, sin card redundante
    if (forCollectionView) {
      const countEl = document.getElementById("collection-count");
      if (countEl) countEl.textContent = String(modelCount);
    } else {
      // Vista legacy: card lateral con mensaje
      const messageHTML = `
      <div style="background: #fff3e0; border-left: 4px solid #CD844D; padding: 16px; margin-bottom: 20px; border-radius: 8px;">
        <h3 style="margin: 0 0 8px; color: #CD844D; font-size: 18px;">F&L Originals</h3>
        <p style="margin: 0; color: #666;">Mostrando ${modelCount} producto${modelCount !== 1 ? 's' : ''} del proveedor F&L Originals</p>
        <button onclick="if(typeof window.cargarCategoria === 'function') window.cargarCategoria('all')" style="margin-top: 12px; padding: 8px 16px; background: #CD844D; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">Ver todos los productos</button>
      </div>
    `;
      cont.innerHTML = messageHTML;
    }
    
    // Ordenar productos por fecha de ingreso
    const productosOrdenados = Object.values(grupos).sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });
    
    // Almacenar todos los productos para paginación y recomendados PDP
    productosPendientes = productosOrdenados;
    window.__allProductsCache = productosOrdenados;
    productosRenderizados = 0;
    offersCardsPendientes = [];
    setCatalogLoadMode("paged");
    
    // Renderizar primer bloque (sin banner dinámico) y usar el conteo real.
    const firstChunkRendered = await renderizarProductosPagina(
      productosPendientes,
      cont,
      [],
      0,
      PRODUCTOS_INICIALES,
      { skipBanner: true }
    );
    productosRenderizados = Number(firstChunkRendered) || 0;
    
    // Configurar eventos
    configurarEventos();
    
    // Mostrar botón "Ver más modelos" si hay más productos
    mostrarBotonVerMas();
    
    // Reiniciar verificación de carga de imágenes
    iniciarVerificacionCargaImagenes();
  } catch (error) {
    console.error('Error filtrando por proveedor FYL:', error);
    cont.innerHTML = '<div class="no-data">Error al cargar productos del proveedor F&L Originals</div>';
  } finally {
    if (loader) loader.classList.remove("show");
  }
}

// Exportar función globalmente para que sea accesible desde otros scripts
if (typeof window !== 'undefined') {
  window.filterBySupplierFYL = filterBySupplierFYL;
}

// Funciones auxiliares de renderizado (igual que antes)
function renderizarGaleria(producto, mainImageSrc) {
  const images = producto.DetalleColor?.flatMap((v) => v.images) || [];
  return images
    .map((img, i) => {
      const thumb = getImgUrl(img, 200);
      const full = getImgUrl(img, 1200);
      const isActive = mainImageSrc ? (img === mainImageSrc) : i === 0;
      if (!thumb) return '';
      return `<img loading="lazy" src="${thumb}" data-full="${full}" alt="Miniatura de producto" class="miniatura${isActive ? ' active' : ''}">`;
    })
    .join("");
}

/**
 * Obtiene la galería HTML y la URL de la imagen principal para el PDP.
 * Retorna { gal, mainImgUrl } donde mainImgUrl es la URL 1200px de la imagen a mostrar.
 * Fallback mainImgUrl: (1) full del color seleccionado, (2) primera full válida, (3) VariantePrincipal.
 */
function obtenerGaleriaYImagenPrincipal(producto, colorSeleccionado) {
  const images = producto.DetalleColor?.flatMap((v) => v.images) || [];
  let mainImgUrl = '';
  const detalleColor = producto.DetalleColor?.find(d =>
    (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase()
  ) || producto.DetalleColor?.[0];
  const preferida = detalleColor?.images?.[0];

  const gal = images
    .map((img, i) => {
      const thumb = getImgUrl(img, 200);
      if (!thumb) return '';

      const full = getImgUrl(img, 1200);
      const isActive = preferida ? (img === preferida) : i === 0;

      if (full) {
        if (!mainImgUrl) mainImgUrl = full;
        if (isActive) mainImgUrl = full;
      }

      return `<img loading="lazy" src="${thumb}" data-full="${full || thumb}" alt="Miniatura" class="miniatura pdp-thumb${isActive ? ' active' : ''}">`;
    })
    .join("");

  if (!mainImgUrl) mainImgUrl = getImgUrl(producto.VariantePrincipal || '', 1200);
  return { gal, mainImgUrl };
}

async function enrichProductsWithStock(productos = [], { mergeSkuIndex = false } = {}) {
  try {
    // Por defecto se limpia el índice (render de página). Deep link / PDP: merge sin borrar lo ya indexado.
    if (!mergeSkuIndex) {
      skuIndex.clear();
    }
    
    const nombres = [
      ...new Set(
        productos
          .map((p) => (p.Articulo || "").trim())
          .filter((nombre) => nombre.length > 0)
      ),
    ];

    if (!nombres.length) return;

    // IMPORTANTE: No consultar product_variants.size (deprecado). Los talles están en variant_sizes
    const { data, error } = await supabase
      .from("products")
      .select(
        "name, product_variants(id, color, reserved_qty, active, sku)"
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

    // [PERF] Warehouses + variant_sizes en paralelo (antes eran secuenciales)
    let generalWarehouseId = null;
    let ventaPublicoWarehouseId = null;
    const variantSizesMap = new Map();

    if (allVariantIds.length > 0) {
      const warehousePromise = supabase
        .from("warehouses")
        .select("id, code")
        .in("code", ["general", "venta-publico"])
        .then(({ data: warehouses, error: warehousesError }) => {
          if (warehousesError) {
            console.warn("\u26a0\ufe0f Error obteniendo warehouses:", warehousesError);
          } else if (warehouses && warehouses.length > 0) {
            const warehouseMap = new Map();
            warehouses.forEach(w => warehouseMap.set(w.code, w.id));
            generalWarehouseId = warehouseMap.get("general");
            ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
            fylCatalogDbg(`\ud83d\udce6 Warehouses obtenidos: general=${generalWarehouseId}, venta-publico=${ventaPublicoWarehouseId}`);
          } else {
            console.warn("\u26a0\ufe0f No se encontraron warehouses 'general' o 'venta-publico'.");
          }
        })
        .catch(e => { console.warn("\u26a0\ufe0f Excepci\u00f3n obteniendo warehouses:", e); });

      const sizesPromise = supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty")
        .in("variant_id", allVariantIds)
        .then(({ data: sizesData, error: sizesError }) => {
          if (!sizesError && sizesData) {
            sizesData.forEach(sizeRow => {
              const normalizedSize = normalizeSize(sizeRow.size);
              if (!normalizedSize) return;
              if (!variantSizesMap.has(sizeRow.variant_id)) {
                variantSizesMap.set(sizeRow.variant_id, []);
              }
              variantSizesMap.get(sizeRow.variant_id).push({
                size: normalizedSize,
                stock_qty: sizeRow.stock_qty || 0
              });
            });
            fylCatalogDbg(`\ud83d\udcca Se obtuvieron ${sizesData.length} registros de variant_sizes para ${allVariantIds.length} variantes. Variantes con talles: ${variantSizesMap.size}`);
          } else if (sizesError) {
            console.error("\u274c Error obteniendo talles desde variant_sizes:", sizesError);
          }
        })
        .catch(e => { console.warn("\u26a0\ufe0f Error obteniendo talles desde variant_sizes:", e); });

      await Promise.all([warehousePromise, sizesPromise]);
    }

    // Obtener stock por talle desde variant_size_warehouse_stock (DISTRIBUCIÓN POR WAREHOUSE)
    // IMPORTANTE: Stock por talle específico, no stock total por variante
    // IMPORTANTE: Normalizar todos los tamaños al crear el mapa para asegurar consistencia
    const sizeStockMap = new Map(); // key: `${variant_id}_${normalizedSize}_${warehouse_id}` -> stock_qty
    if (allVariantIds.length > 0 && generalWarehouseId && ventaPublicoWarehouseId) {
      try {
        fylCatalogDbg(`📊 Consultando variant_size_warehouse_stock para ${allVariantIds.length} variantes...`);
        const { data: sizeWarehouseStocks, error: sizeStockError } = await supabase
          .from("variant_size_warehouse_stock")
          .select("variant_id, size, warehouse_id, stock_qty")
          .in("variant_id", allVariantIds)
          .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

        if (sizeStockError) {
          console.error("❌ Error obteniendo stock desde variant_size_warehouse_stock:", sizeStockError);
          console.error("   Detalles:", sizeStockError.message, sizeStockError.hint);
        } else if (sizeWarehouseStocks) {
          sizeWarehouseStocks.forEach(sws => {
            // CRÍTICO: Normalizar el tamaño antes de crear la clave del mapa
            const normalizedSize = normalizeSize(sws.size);
            if (!normalizedSize) return; // Saltar tamaños vacíos

            const key = `${sws.variant_id}_${normalizedSize}_${sws.warehouse_id}`;
            // Si ya existe una entrada para esta clave, sumar (aunque no debería haber duplicados)
            const existingStock = sizeStockMap.get(key) || 0;
            sizeStockMap.set(key, existingStock + (sws.stock_qty || 0));
          });
          fylCatalogDbg(`✅ Se obtuvieron ${sizeWarehouseStocks.length} registros de variant_size_warehouse_stock`);
        } else {
          console.warn("⚠️ variant_size_warehouse_stock retornó null o undefined");
        }
      } catch (e) {
        console.error("❌ Excepción obteniendo stock por talle desde variant_size_warehouse_stock:", e);
        console.error("   Stack:", e.stack);
      }
    } else {
      if (allVariantIds.length === 0) {
        console.warn("⚠️ No hay variantIds para consultar variant_size_warehouse_stock");
      } else {
        console.warn(`⚠️ Warehouses no disponibles (general=${generalWarehouseId}, venta-publico=${ventaPublicoWarehouseId}). Continuando sin stock por warehouse.`);
      }
    }

    productos.forEach((producto) => {
      const clave = (producto.Articulo || "").trim().toLowerCase();
      const variantes = variantesPorProducto.get(clave);
      if (!variantes) {
        console.warn(`⚠️ No se encontraron variantes para producto: ${producto.Articulo}`);
        return;
      }

      producto.DetalleColor = (producto.DetalleColor || []).map((detalle) => {
        // Buscar variante solo por color (NO por size, ya que los talles están en variant_sizes)
        const colorBuscado = (detalle.color || "").trim().toLowerCase();
        const variante = variantes.find((v) => {
          const colorVar = (v.color || "").trim().toLowerCase();
          return colorVar === colorBuscado;
        });

        if (!variante || !variante.id) {
          // Si no hay variante para este color, retornar detalle con variantDetails pero sin stock
          // IMPORTANTE: Mostrar los talles aunque no haya variante, para que el usuario pueda verlos
          console.warn(`⚠️ No se encontró variante para producto: ${producto.Articulo}, color: ${detalle.color}. Colores disponibles: ${variantes.map(v => v.color).join(', ')}`);
          return {
            ...detalle,
            variantDetails: (detalle.talles || []).map(talle => {
              const normalizedTalle = normalizeSize(talle) || talle;
              return {
                talle: normalizedTalle,
                stock: null,
                reserved: null,
                available: null, // null = disponibilidad por confirmar (no "sin stock", no tachado)
                variant_id: null,
                sku: null,
              };
            })
          };
        }

        const isActive = variante.active !== false;
        const variantId = variante.id;
        const reserved = isActive ? Number(variante.reserved_qty ?? 0) : 0;

        // Obtener talles para esta variante desde variantSizesMap
        const variantSizes = variantSizesMap.get(variantId) || [];
        const variantSizesBySize = new Map();
        variantSizes.forEach(vs => {
          variantSizesBySize.set(vs.size, vs.stock_qty);
        });
        
        // DEBUG: Si variantSizesBySize está vacío pero hay talles en detalle.talles, puede ser un problema
        // Usar console.debug en lugar de console.warn para reducir ruido en la consola
        if (variantSizes.length === 0 && (detalle.talles || []).length > 0) {
          console.debug(`🔍 [DEBUG] No se encontraron talles en variant_sizes para producto ${producto.Articulo}, color ${detalle.color}, variantId ${variantId}, pero catalog_public_view muestra talles: ${detalle.talles.join(', ')}. Esto puede indicar una inconsistencia de datos o un problema de RLS.`);
        }

        // Para cada talle del producto, obtener stock específico.
        // IMPORTANTE: catalog_public_view.Numeracion puede ocultar talles en 0,
        // por eso unimos con los talles de variant_sizes para renderizar también los agotados.
        const tallesDesdeVista = (detalle.talles || [])
          .map((t) => normalizeSize(t) || t)
          .filter(Boolean);
        const tallesDesdeVariantSizes = Array.from(variantSizesBySize.keys()).filter(Boolean);
        const tallesUnicosSet = new Set([...tallesDesdeVista, ...tallesDesdeVariantSizes]);
        const tallesParaRender = Array.from(tallesUnicosSet).sort((a, b) => {
          const na = parseInt(a, 10);
          const nb = parseInt(b, 10);
          const aNum = !Number.isNaN(na);
          const bNum = !Number.isNaN(nb);
          if (aNum && bNum) return na - nb;
          if (aNum) return -1;
          if (bNum) return 1;
          return String(a).localeCompare(String(b), 'es', { sensitivity: 'base' });
        });

        const variantDetails = tallesParaRender.map((talle) => {
          const normalizedSize = normalizeSize(talle);
          if (!normalizedSize) {
            // Si no se puede normalizar, retornar con available: null (disponibilidad por confirmar)
            // Usar console.debug en lugar de console.warn para reducir ruido
            console.debug(`🔍 [DEBUG] No se pudo normalizar talle "${talle}" para producto ${producto.Articulo}, color ${detalle.color}`);
            return {
              talle: talle, // Mantener original si no se puede normalizar
              stock: null,
              reserved: null,
              available: null, // null = disponibilidad por confirmar
              variant_id: null,
              sku: null,
            };
          }

          // Verificar si este talle existe en variant_sizes para esta variante
          // IMPORTANTE: Si el talle viene de catalog_public_view.Numeracion, significa que tiene stock > 0 según la vista
          const sizeStockQty = variantSizesBySize.get(normalizedSize) || 0;
          
          // Obtener stock por talle desde variant_size_warehouse_stock
          let stockGeneral = 0;
          let stockVentaPublico = 0;

          if (isActive && generalWarehouseId && ventaPublicoWarehouseId) {
            const generalKey = `${variantId}_${normalizedSize}_${generalWarehouseId}`;
            const ventaPublicoKey = `${variantId}_${normalizedSize}_${ventaPublicoWarehouseId}`;

            stockGeneral = sizeStockMap.get(generalKey) || 0;
            stockVentaPublico = sizeStockMap.get(ventaPublicoKey) || 0;
          }

          // FALLBACK CRÍTICO: Si no hay stock en warehouses pero hay en variant_sizes, usar variant_sizes.stock_qty
          // Este es el mismo patrón que usa admin/stock.js (líneas 554-560) y admin/order-creator.js
          if (stockGeneral === 0 && stockVentaPublico === 0 && sizeStockQty > 0) {
            // Si hay stock en variant_sizes pero no en variant_size_warehouse_stock,
            // poner todo en general como fallback (esto es lo que hace admin/stock.js)
            stockGeneral = sizeStockQty;
          }
          
          const stockTotal = stockGeneral + stockVentaPublico;
          const hasTalleInVariantSizes = variantSizesBySize.has(normalizedSize);
          
          // IMPORTANTE: Calcular available correctamente
          // PRIORIDAD 1: Si el talle está en variant_sizes, usar el stock real (puede ser 0 para tachar)
          // PRIORIDAD 2: Si tiene stock en warehouses, usar ese stock
          // PRIORIDAD 3: Si no está en variant_sizes pero está en catalog_public_view.Numeracion, usar null (inconsistencia)
          let available;
          if (hasTalleInVariantSizes) {
            // El talle está en variant_sizes - usar el stock real (puede ser 0 para mostrar tachado)
            available = Math.max(0, stockTotal - reserved);
          } else if (stockTotal > 0) {
            // Tiene stock en warehouses aunque no esté en variant_sizes (raro pero posible)
            available = Math.max(0, stockTotal - reserved);
          } else if (stockTotal === 0 && sizeStockQty === 0 && !hasTalleInVariantSizes && variantSizes.length === 0) {
            // Si variantSizesBySize está completamente vacío (no se encontraron talles para esta variante),
            // pero el talle está en catalog_public_view.Numeracion, es una inconsistencia de datos.
            // Mostrar como "disponibilidad por confirmar" (available: null) en lugar de "sin stock" (available: 0)
            available = null;
            console.debug(`🔍 [DEBUG] Talle "${normalizedSize}" está en catalog_public_view.Numeracion para ${producto.Articulo} ${detalle.color} pero no se encontraron talles en variant_sizes para variantId ${variantId}. Mostrando como "disponibilidad por confirmar".`);
          } else if (stockTotal === 0 && sizeStockQty === 0 && !hasTalleInVariantSizes) {
            // Si el talle específico no se encontró en variantSizesBySize, pero hay otros talles para esta variante,
            // puede ser un problema de normalización. Usar null para "disponibilidad por confirmar"
            available = null;
            console.debug(`🔍 [DEBUG] Talle "${normalizedSize}" (original: "${talle}") no encontrado en variantSizesBySize para producto ${producto.Articulo}, color ${detalle.color}, variantId ${variantId}. Talles disponibles: ${Array.from(variantSizesBySize.keys()).join(', ') || 'ninguno'}.`);
          } else {
            // Fallback: calcular available normalmente (puede ser 0)
            available = Math.max(0, stockTotal - reserved);
          }

          // Construir skuIndex solo con variantes activas que tengan SKU
          // IMPORTANTE: El SKU puede estar en el nivel de variante, no por talle específico
          if (isActive && variante.sku && variante.sku.trim()) {
            const sku = variante.sku.trim();
            // Verificar si ya existe en skuIndex, si no existe o el talle tiene mejor stock, actualizar
            const existingEntry = skuIndex.get(sku);
            if (!existingEntry || (available > 0 && (existingEntry.available === null || existingEntry.available <= 0))) {
              const detalleColor = producto.DetalleColor.find(d => 
                (d.color || "").trim().toLowerCase() === (variante.color || "").trim().toLowerCase()
              );
              const image = detalleColor?.images?.[0] || producto.VariantePrincipal || '';
              
              skuIndex.set(sku, {
                producto,
                color: detalleColor?.color || variante.color || "",
                talle: normalizedSize,
                variant_id: variantId,
                available,
                image
              });
            }
          }

          return {
            talle: normalizedSize, // Usar tamaño normalizado
            stock: available === null ? null : stockTotal, // Si available es null, stock también debe ser null
            reserved: available === null ? null : reserved, // Si available es null, reserved también debe ser null
            available: available, // Puede ser null (disponibilidad por confirmar) o un número
            variant_id: isActive ? variantId : null,
            sku: isActive && variante.sku ? variante.sku.trim() : null,
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
    // 1. Primero intentar buscar por SKU completo en variant_sizes (SKU con talle específico)
    const { data: sizeData, error: sizeError } = await supabase
      .from("variant_sizes")
      .select("variant_id, size, stock_qty")
      .eq("sku", sku.trim())
      .limit(1)
      .maybeSingle();
    
    let variantId = null;
    let talle = null;
    let sizeStockQty = 0;
    
    if (!sizeError && sizeData) {
      // SKU encontrado en variant_sizes (SKU con talle específico)
      variantId = sizeData.variant_id;
      talle = normalizeSize(sizeData.size);
      sizeStockQty = sizeData.stock_qty || 0;
    }
    
    // 2. Si no se encontró en variant_sizes, buscar por SKU base en product_variants (SKU sin talle)
    if (!variantId) {
      const { data: variantData, error: variantError } = await supabase
        .from("product_variants")
        .select("id, color, reserved_qty, product_id")
        .eq("sku", sku.trim())
        .eq("active", true)
        .limit(1)
        .maybeSingle();
      
      if (variantError || !variantData) {
        return null;
      }
      
      variantId = variantData.id;
      
      // Si no hay talle específico, usar el primer talle disponible de la variante
      const { data: firstSize, error: firstSizeError } = await supabase
        .from("variant_sizes")
        .select("size, stock_qty")
        .eq("variant_id", variantId)
        .limit(1)
        .maybeSingle();
      
      if (!firstSizeError && firstSize) {
        talle = normalizeSize(firstSize.size);
        sizeStockQty = firstSize.stock_qty || 0;
      }
    }
    
    if (!variantId) {
      return null;
    }
    
    // 3. Obtener información completa de la variante
    const { data: variantData, error: variantError } = await supabase
      .from("product_variants")
      .select("id, color, reserved_qty, product_id, products!inner(name, description)")
      .eq("id", variantId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    
    if (variantError || !variantData) {
      return null;
    }
    
    const variant = variantData;
    const productId = variant.product_id;
    const articulo = (variant.products?.name || '').trim();

    // 3b. Mismo shape que el catálogo: filas de la vista por artículo → agrupar + enrich (precio, colores, talles)
    if (articulo && supabase) {
      try {
        let catRows = null;
        const rCat = await supabase
          .from('catalog_public_view')
          .select('*')
          .eq('Articulo', articulo);
        if (!rCat.error && rCat.data?.length) {
          catRows = rCat.data;
        } else if (!rCat.error) {
          const rCatI = await supabase
            .from('catalog_public_view')
            .select('*')
            .ilike('Articulo', articulo);
          if (!rCatI.error && rCatI.data?.length) catRows = rCatI.data;
        }
        if (catRows && catRows.length > 0) {
          const grouped = agruparProductos(catRows);
          const productoFull = grouped[0];
          if (productoFull) {
            await enrichProductsWithStock([productoFull], { mergeSkuIndex: true });
            const hit = buscarPorSKU(sku.trim());
            if (hit) {
              return {
                producto: hit.producto,
                color: hit.color,
                talle: hit.talle,
                variant_id: hit.variant_id,
                available: hit.available,
                image: hit.image,
              };
            }
            return {
              producto: productoFull,
              color: variant.color || '',
              talle: talle || '',
              variant_id: variantId,
              sku: sku.trim(),
              available: null,
              image: productoFull.VariantePrincipal || '',
            };
          }
        }
      } catch (e) {
        console.warn('⚠️ catalog_public_view por artículo (PDP deep link):', e);
      }
    }

    // 4. Obtener warehouses "general" y "venta-publico"
    const { data: warehouses } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);
    
    const warehouseMap = new Map();
    let generalWarehouseId = null;
    let ventaPublicoWarehouseId = null;
    
    if (warehouses && warehouses.length > 0) {
      warehouses.forEach(w => warehouseMap.set(w.code, w.id));
      generalWarehouseId = warehouseMap.get("general");
      ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
    }
    
    // 5. Consultar stock por talle desde variant_size_warehouse_stock (DISTRIBUCIÓN POR WAREHOUSE)
    let stockGeneral = 0;
    let stockVentaPublico = 0;
    
    if (talle && generalWarehouseId && ventaPublicoWarehouseId) {
      const { data: sizeWarehouseStocks, error: sizeStockError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", variantId)
        .eq("size", talle)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
      
      if (!sizeStockError && sizeWarehouseStocks) {
        sizeWarehouseStocks.forEach(sws => {
          if (sws.warehouse_id === generalWarehouseId) {
            stockGeneral = sws.stock_qty || 0;
          } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
            stockVentaPublico = sws.stock_qty || 0;
          }
        });
      }
    }
    
    // FALLBACK CRÍTICO: Si no hay stock en warehouses pero hay en variant_sizes, usar variant_sizes.stock_qty
    // Este es el mismo patrón que usa admin/stock.js (líneas 554-560) y admin/order-creator.js
    if (stockGeneral === 0 && stockVentaPublico === 0 && sizeStockQty > 0) {
      // Si hay stock en variant_sizes pero no en variant_size_warehouse_stock,
      // poner todo en general como fallback (esto es lo que hace admin/stock.js)
      stockGeneral = sizeStockQty;
    }
    
    const stockTotal = stockGeneral + stockVentaPublico;
    const reserved = Number(variant.reserved_qty || 0);
    const available = Math.max(0, stockTotal - reserved);
    
    // 6. Usar datos del producto desde la relación (ya obtenidos en variant)
    const productoData = {
      name: variant.products?.name || '',
      description: variant.products?.description || '',
      VariantePrincipal: '' // Se obtendrá de variant_images
    };
    
    // 7. Determinar image (preferir imagen del color si existe; fallback a VariantePrincipal)
    let image = '';
    
    // Intentar obtener imagen del color desde variant_images
    // La tabla tiene columna "url" (no "image_url"); secure_url es alternativa Cloudinary
    const { data: variantImages, error: imgError } = await supabase
      .from("variant_images")
      .select("url, secure_url")
      .eq("variant_id", variantId)
      .order("position", { ascending: true })
      .limit(1);
    
    if (!imgError && variantImages && variantImages.length > 0) {
      const vi = variantImages[0];
      image = vi.url || vi.secure_url || '';
    }
    
    // 8. Construir "producto mínimo compatible"
    const producto = {
      Articulo: productoData.name || productoData.Articulo || '',
      Descripcion: productoData.description || productoData.Descripcion || '',
      VariantePrincipal: image,
      DetalleColor: [{
        color: variant.color || '',
        images: [image].filter(Boolean),
        variantDetails: [{
          talle: talle || '',
          sku: sku.trim(),
          variant_id: variantId,
          available: available,
          stock: stockTotal,
          reserved: reserved
        }]
      }]
    };
    
    // 9. Retornar resultado
    return {
      producto,
      color: variant.color || '',
      talle: talle || '',
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

// PDP historial (botón Atrás del celular)
function buildPdpUrl(sku) {
  const base = location.pathname + (location.search || '');
  return base + '#/pdp/' + encodeURIComponent(sku);
}

function parsePdpFromUrl() {
  const hash = location.hash || '';
  const m = hash.match(/^#\/pdp\/(.+)$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('sku');
}

function pushPdpState(sku) {
  const newUrl = buildPdpUrl(sku);
  if (history.state?.pdp) {
    history.replaceState({ pdp: true, sku }, '', newUrl);
  } else {
    history.pushState({ pdp: true, sku }, '', newUrl);
  }
}

function replacePdpState(sku) {
  history.replaceState({ pdp: true, sku }, '', buildPdpUrl(sku));
}

// Funciones de modal
function updateSKUEnURL(sku) {
  const modal = document.getElementById('product-modal');
  if (modal?.classList.contains('active') && history.state?.pdp) {
    replacePdpState(sku);
  } else {
    updateURL({ tab: undefined, sku }, { mode: 'replace' });
  }
}

/** Obtener cache de productos "all" agrupados. Si no existe, carga desde Supabase y agrupa. */
async function ensureAllCacheLoadedGrouped() {
  if (window.__allProductsCache && Array.isArray(window.__allProductsCache) && window.__allProductsCache.length > 0) {
    return window.__allProductsCache;
  }
  const rows = await cargarDesdeSupabase('all');
  const gruposArray = agruparProductos(rows);
  let productosOrdenados = gruposArray.sort((a, b) => {
    const fechaA = parseFecha(a.FechaIngreso);
    const fechaB = parseFecha(b.FechaIngreso);
    return fechaB - fechaA;
  });
  productosOrdenados = intercalarProductosPorCategoria(productosOrdenados);
  window.__allProductsCache = productosOrdenados;
  return productosOrdenados;
}

/** Filtrar productos agrupados por tag (Filtro1, Filtro2, Filtro3). F1/F2: includes. F3: exacto por tag. */
function filterProductsByTag(allGrouped, tagValue) {
  const q = (tagValue || '').toLowerCase().trim();
  if (!q) return allGrouped;
  return allGrouped.filter((p) => {
    const f1 = (p.Filtro1 || '').toLowerCase().trim();
    const f2 = (p.Filtro2 || '').toLowerCase().trim();
    const f3 = (p.Filtro3 || '').toLowerCase();
    const f3Tags = f3.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    return (f1 && f1.includes(q)) || (f2 && f2.includes(q)) || f3Tags.includes(q);
  });
}

/** Mostrar barra de filtro arriba del grid. type: 'tag' (hash) o 'search' (buscador). */
function renderTagFilterBar(tagValue, { type = 'tag', sizeFilters = [] } = {}) {
  const cont = document.getElementById('catalogo');
  if (!cont) return;
  let bar = document.getElementById('tag-filter-bar');
  const safeSizes = (Array.isArray(sizeFilters) ? sizeFilters : [])
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const hasSizeFilter = safeSizes.length > 0;
  const label = type === 'search' ? 'Buscando' : type === 'size' ? 'Talles' : 'Filtrado';
  const safeVal = (tagValue || '').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const safeSizesText = safeSizes.join(", ").replace(/</g, '&lt;').replace(/"/g, '&quot;');
  let textHtml = '';
  if (type === 'search') {
    textHtml = `Buscando: <strong class="tag-filter-value">${safeVal}</strong>`;
    if (hasSizeFilter) {
      textHtml += ` <span class="tag-filter-sep">•</span> Talles: <strong class="tag-filter-size-value">${safeSizesText}</strong>`;
    }
  } else if (type === 'size') {
    textHtml = `Talles: <strong class="tag-filter-size-value">${safeSizesText}</strong>`;
  } else {
    textHtml = `${label}: <strong class="tag-filter-value">${safeVal}</strong>`;
  }
  if (bar) {
    const textEl = bar.querySelector('.tag-filter-text');
    const valEl = bar.querySelector('.tag-filter-value');
    if (textEl) textEl.innerHTML = textHtml;
    else if (valEl) valEl.textContent = tagValue || '';
    bar.dataset.filterType = type;
    bar.dataset.hasSizeFilter = hasSizeFilter ? 'true' : 'false';
    return;
  }
  const html = `
    <div id="tag-filter-bar" class="tag-filter-bar" data-filter-type="${type}">
      <span class="tag-filter-text">${textHtml}</span>
      <button type="button" class="tag-filter-clear" aria-label="Quitar filtros">✕</button>
    </div>
  `;
  cont.insertAdjacentHTML('afterbegin', html);
  bar = document.getElementById('tag-filter-bar');
  if (bar) bar.dataset.hasSizeFilter = hasSizeFilter ? 'true' : 'false';
}

/** Ocultar barra de filtro por tag. */
function clearTagFilterBar() {
  const bar = document.getElementById('tag-filter-bar');
  if (bar) bar.remove();
}

function initTagFilterClearDelegation() {
  if (window.__tagFilterDelegationInit) return;
  window.__tagFilterDelegationInit = true;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.tag-filter-clear');
    if (!btn) return;
    const bar = document.getElementById('tag-filter-bar');
    const isSearch = bar?.dataset?.filterType === 'search';
    const isSize = bar?.dataset?.filterType === 'size';
    const hasSizeFilter = bar?.dataset?.hasSizeFilter === 'true';
    if (isSearch || isSize || hasSizeFilter) {
      if (typeof window.clearAllCatalogFilters === 'function') {
        window.clearAllCatalogFilters();
        return;
      }
      const input = document.getElementById('searchInput') || document.getElementById('search-bar-mobile');
      if (input) input.value = '';
      clearTagFilterBar();
      if (typeof window.buscarProductosEnTodos === 'function') window.buscarProductosEnTodos('');
    } else {
      location.hash = '#/';
    }
  });
}

function getCurrentSearchTerm() {
  const desktopTerm = document.getElementById('searchInput')?.value?.trim() || '';
  const mobileTerm = document.getElementById('search-bar-mobile')?.value?.trim() || '';
  return desktopTerm || mobileTerm;
}

function getActiveSizeFilters() {
  const raw = window.__fylActiveSizeFilters;
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

function refreshCatalogFilterBar() {
  const searchTerm = getCurrentSearchTerm();
  const sizeFilters = getActiveSizeFilters();
  if (searchTerm) {
    renderTagFilterBar(searchTerm, { type: 'search', sizeFilters });
    return;
  }
  if (sizeFilters.length > 0) {
    renderTagFilterBar(sizeFilters.join(", "), { type: 'size', sizeFilters });
    return;
  }
  clearTagFilterBar();
}

async function clearAllCatalogFilters() {
  const inputDesktop = document.getElementById('searchInput');
  const inputMobile = document.getElementById('search-bar-mobile');
  if (inputDesktop) inputDesktop.value = '';
  if (inputMobile) inputMobile.value = '';
  if (typeof window.clearSizeFilter === 'function') {
    window.clearSizeFilter();
  }
  clearTagFilterBar();
  if (typeof window.buscarProductosEnTodos === 'function') {
    await window.buscarProductosEnTodos('');
  }
}

/** Click en .tag-chip o .pdp-tag-chip: llenar buscador y filtrar como si tipearas (sin cambiar hash). */
function initTagToSearch() {
  if (window.__tagToSearchInit) return;
  window.__tagToSearchInit = true;
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip, .pdp-tag-chip');
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const tag = (chip.dataset.tag || chip.textContent || '').trim();
    if (!tag) return;
    const fromPdp = chip.classList.contains('pdp-tag-chip');
    if (fromPdp) {
      window.__tagSearchFromPdp = true;
      cerrarModal(true);
    }
    const input = document.getElementById('searchInput') || document.getElementById('search-bar-mobile');
    if (input) input.value = tag;
    if (typeof window.buscarProductosEnTodos === 'function') {
      window.buscarProductosEnTodos(tag);
    } else if (input) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (fromPdp) {
      const u = new URL(location.href);
      if (u.hash.match(/^#\/pdp\//)) {
        u.hash = '#/';
        history.replaceState(history.state || {}, '', u);
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, true);
}

/** Aplicar filtro por tag y renderizar catálogo. Oculta banners de Home. */
async function applyTagFilterAndRender(tagValue, { pushHash = true } = {}) {
  const cont = document.getElementById('catalogo');
  if (!cont) return;
  const all = await ensureAllCacheLoadedGrouped();
  const filtrados = filterProductsByTag(all, tagValue);
  productosPendientes = filtrados;
  productosRenderizados = 0;
  offersCardsPendientes = [];
  setCatalogLoadMode("paged");
  if (typeof window.hideFYLOriginalsBanner === 'function') window.hideFYLOriginalsBanner();
  if (typeof window.hideCustomBanner === 'function') window.hideCustomBanner();
  if (typeof window.hidePromotionalBanner === 'function') window.hidePromotionalBanner();
  document.querySelectorAll('#filtroMenu input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';
  cont.innerHTML = '';
  initTagFilterClearDelegation();
  renderTagFilterBar(tagValue);
  if (filtrados.length === 0) {
    cont.insertAdjacentHTML('beforeend', '<div class="no-data" style="text-align:center;padding:2rem;color:#666;">No hay productos con el tag seleccionado</div>');
    ocultarBotonVerMas();
    if (pushHash) {
      try { location.hash = '#/tag/' + encodeURIComponent(tagValue); } catch (_) {}
    }
    return;
  }
  const firstChunkRendered = await renderizarProductosPagina(
    productosPendientes,
    cont,
    [],
    0,
    PRODUCTOS_INICIALES,
    { skipBanner: true }
  );
  productosRenderizados = Number(firstChunkRendered) || 0;
  configurarEventos();
  mostrarBotonVerMas();
  iniciarVerificacionCargaImagenes();
  fylCatalogTrackViewItemList("tag:" + tagValue, productosPendientes, "tag_filter");
  if (pushHash) {
    try { location.hash = '#/tag/' + encodeURIComponent(tagValue); } catch (_) {}
  }
}

// Tags clickeables: navegar a #/tag/<value> para que onNavChange dispare el render
window.setQuickFilter = function(level, value) {
  if (!value) return;
  window.__quickFilter = { level, value };
  try { location.hash = '#/tag/' + encodeURIComponent(value); } catch (_) {}
};

function abrirModalPorSKU(sku, { pushState = true } = {}) {
  if (!sku) return false;
  
  const resultado = buscarPorSKU(sku);
  if (!resultado) return false;
  
  productoActualEnModal = resultado.producto;
  const modal = document.getElementById('product-modal');
  if (!modal) return false;
  
  modal.dataset.sku = sku;
  renderizarModalProducto(resultado.producto, resultado.color, resultado.talle);
  
  if (pushState) pushPdpState(sku);
  
  modal.classList.add('active');
  document.body.classList.add('modal-open');

  // Scroll al área de la imagen (parte superior del PDP)
  const modalBody = document.getElementById('product-modal-body');
  if (modalBody) modalBody.scrollTop = 0;

  if (typeof window.updateFloatingCartCta === 'function') window.updateFloatingCartCta();
  fylCatalogViewItemForProducto(resultado.producto, sku);
  trackMetaViewContent(resultado.producto, sku);
  fylCatalogPdpSurface();
  return true;
}

function abrirModalConResultado(resultado, { pushState = true } = {}) {
  if (!resultado || !resultado.producto) return false;
  
  productoActualEnModal = resultado.producto;
  const modal = document.getElementById('product-modal');
  if (!modal) return false;
  
  // SKU: explícito en resultado, o del color/talle seleccionado, o primer disponible
  let sku = resultado.sku || '';
  if (!sku && resultado.color) {
    const r = obtenerPrimerSkuConStock(resultado.producto, resultado.color);
    sku = r?.sku || '';
  }
  if (!sku) {
    sku = resultado.producto.DetalleColor?.[0]?.variantDetails?.[0]?.sku || '';
  }
  
  if (sku) modal.dataset.sku = sku;
  
  renderizarModalProducto(resultado.producto, resultado.color, resultado.talle);
  
  if (sku && pushState) pushPdpState(sku);
  
  modal.classList.add('active');
  document.body.classList.add('modal-open');

  // Scroll al área de la imagen (parte superior del PDP)
  const modalBody = document.getElementById('product-modal-body');
  if (modalBody) modalBody.scrollTop = 0;

  if (typeof window.updateFloatingCartCta === 'function') window.updateFloatingCartCta();
  fylCatalogViewItemForProducto(resultado.producto, sku);
  trackMetaViewContent(resultado.producto, sku);
  fylCatalogPdpSurface();
  return true;
}

/** Abre PDP por SKU: índice de página actual, o carga completa vía Supabase (deep link / Ver más). */
async function abrirPdpPorSkuIfPossible(sku, { pushState = true } = {}) {
  if (!sku) return false;
  if (abrirModalPorSKU(sku, { pushState })) return true;
  const resultado = await buscarPorSKUEnSupabase(sku);
  if (resultado && abrirModalConResultado(resultado, { pushState })) return true;
  return false;
}

function cerrarModal(skipHistory = false) {
  const modal = document.getElementById('product-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.classList.remove('pdp-checkout-bar-visible');
    modal.dataset.sku = '';
  }
  document.getElementById('product-modal-footer')?.classList.remove('pdp-footer-bar-hidden');
  document.body.classList.remove('modal-open');
  productoActualEnModal = null;

  if (typeof window.updateFloatingCartCta === 'function') window.updateFloatingCartCta();
  try {
    if (fylAnalytics.isReady()) fylAnalytics.syncCatalogSurface({ emit: true });
  } catch (_e) {}

  if (skipHistory) return;
  if (history.state?.pdp) {
    history.back();
  } else {
    const u = new URL(location.href);
    if (u.hash.match(/^#\/pdp\//)) u.hash = '#/';
    u.searchParams.delete('sku');
    history.replaceState(history.state || {}, '', u);
  }
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
  const sku = parsePdpFromUrl();
  if (!sku) return;

  const opened = await abrirPdpPorSkuIfPossible(sku, { pushState: false });
  if (opened) return;

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

// Recomendados: fuente robusta (__allProductsCache > productosPendientes > Supabase)
async function getRecoCandidates(productoActual, limit = 8) {
  const artActual = productoActual?.Articulo || '';
  const f1 = (productoActual?.Filtro1 || '').trim();
  const f2 = (productoActual?.Filtro2 || '').trim();
  const f3Raw = (productoActual?.Filtro3 || '').trim();
  const f3Parts = f3Raw ? f3Raw.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean) : [];

  let candidates = [];
  if (window.__allProductsCache && Array.isArray(window.__allProductsCache) && window.__allProductsCache.length > 0) {
    candidates = window.__allProductsCache;
  } else if (productosPendientes && productosPendientes.length > 0) {
    candidates = productosPendientes;
  } else if (supabase && (f1 || f2)) {
    try {
      const parts = [];
      if (f1) parts.push(`Filtro1.eq.${JSON.stringify(f1)}`);
      if (f2) parts.push(`Filtro2.eq.${JSON.stringify(f2)}`);
      const { data, error } = await supabase
        .from('catalog_public_view')
        .select('*')
        .or(parts.join(','))
        .limit(20);
      if (!error && data) candidates = data;
    } catch (e) { console.warn('getRecoCandidates Supabase:', e); }
  }

  const scored = candidates
    .filter(p => (p?.Articulo || '') !== artActual)
    .map(p => {
      let score = 0;
      const pf1 = (p?.Filtro1 || '').trim();
      const pf2 = (p?.Filtro2 || '').trim();
      const pf3Raw = (p?.Filtro3 || '').trim();
      if (f1 && pf1 && pf1.toLowerCase() === f1.toLowerCase()) score += 3;
      if (f2 && pf2 && pf2.toLowerCase() === f2.toLowerCase()) score += 2;
      if (f3Parts.length && pf3Raw) {
        const pp = pf3Raw.split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
        if (pp.some(ppv => f3Parts.includes(ppv))) score += 1;
      }
      return { producto: p, score, fecha: p?.FechaIngreso || '' };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || String(b.fecha).localeCompare(String(a.fecha)))
    .slice(0, limit)
    .map(x => x.producto);

  return scored;
}

// Funciones de renderizado del modal
function renderizarModalProducto(producto, colorSeleccionado, talleSeleccionado) {
  const modalBody = document.getElementById('product-modal-body');
  const modal = document.getElementById('product-modal');
  if (!modalBody || !modal) return;
  
  const detalleColor = producto.DetalleColor?.find(d => 
    (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase()
  ) || producto.DetalleColor?.[0];

  // Galería e imagen principal desde la misma fuente
  const { gal, mainImgUrl } = obtenerGaleriaYImagenPrincipal(producto, colorSeleccionado);
  const colores = renderizarColoresModal(producto, colorSeleccionado);
  const variantes = renderizarVariantesModal(producto, colorSeleccionado, talleSeleccionado);
  const tags = renderizarTags(producto);
  // Filtro3 puede contener varios tags separados por coma o punto y coma
  const tagChips = [
    producto.Filtro1 && { level: 'filtro1', tag: String(producto.Filtro1).trim() },
    producto.Filtro2 && { level: 'filtro2', tag: String(producto.Filtro2).trim() },
    ...(producto.Filtro3
      ? String(producto.Filtro3)
          .split(/[,;]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .map((tag) => ({ level: 'filtro3', tag }))
      : []),
  ].filter(Boolean);
  
  // Obtener SKU actual del modal o calcularlo
  let skuActual = modal.dataset.sku || '';
  if (!skuActual) {
    const resultadoSKU = obtenerPrimerSkuConStock(producto, colorSeleccionado);
    skuActual = resultadoSKU?.sku || '';
    // Si encontramos un SKU, guardarlo en el dataset del modal
    if (skuActual) {
      modal.dataset.sku = skuActual;
    }
  }
  
  // Si aún no hay SKU, intentar obtenerlo del primer variant detail disponible
  if (!skuActual && detalleColor?.variantDetails && detalleColor.variantDetails.length > 0) {
    const primerVariant = detalleColor.variantDetails.find(vd => vd.sku) || detalleColor.variantDetails[0];
    skuActual = primerVariant?.sku || '';
  }
  
  const variantesPDP = renderizarVariantesModalPDP(producto, colorSeleccionado, detalleColor?.color || '');
  const featuresHtml = renderizarCaracteristicasPDP(producto);
  const hasOffer = producto.OfertaActiva === true || producto.OfertaActiva === 'true';
  const offerPrice = producto.PrecioOferta || '';
  const precioUnidad = hasOffer && offerPrice
    ? parseARSNumber(offerPrice)
    : parseARSNumber(producto.Precio || 0);

  const modalFooter = document.getElementById('product-modal-footer');

  modalBody.innerHTML = `
    <div class="pdp-header product-modal-header">
      <div class="pdp-header__row1">
        <button class="pdp-back product-modal-back" aria-label="Volver">←</button>
        <div class="pdp-title product-modal-title"><span class="pdp-title__name">${(producto.Articulo || '').replace(/</g, '&lt;')}</span>${detalleColor?.color ? `<span class="pdp-title__sep">•</span><span class="pdp-title__color">${(detalleColor.color || '').replace(/</g, '&lt;')}</span>` : ''}</div>
        <div class="pdp-price product-modal-price-container">${renderPriceWithOffer(producto)}</div>
        <button class="pdp-close product-modal-close-inner" aria-label="Cerrar">✕</button>
      </div>
      <div class="pdp-header__row2">
        <div class="pdp-header__tags">${tagChips.map(t => `<button type="button" class="pdp-chip pdp-tag-chip" data-tag-level="${t.level}" data-tag="${t.tag.replace(/"/g, '&quot;')}">${t.tag}</button>`).join('')}</div>
        <div class="pdp-header-actions">
          <button type="button" class="pdp-action-btn pdp-download" aria-label="Descargar imagen"><svg width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Descargar</button>
          <button type="button" class="pdp-action-btn pdp-share" aria-label="Compartir imagen"><svg width="14" height="14" stroke="currentColor" stroke-width="1.8" fill="none" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>Compartir</button>
        </div>
      </div>
    </div>
    <div class="product-modal-main-content">
      <div class="pdp-media">
        <div class="pdp-main-image-wrap">
          <img class="product-modal-main-image" 
               src="${mainImgUrl}" 
               alt="${producto.Articulo}"
               loading="eager"/>
        </div>
        <div class="pdp-thumbs">${gal}</div>
      </div>
      <div class="product-modal-info">
        <div class="product-modal-section product-modal-colors-section">
          <div class="product-modal-colors-row">
            <span class="product-modal-color-label">Color: <strong>${detalleColor?.color || ''}</strong></span>
            <div class="product-modal-colors">${colores}</div>
          </div>
        </div>
        <div class="product-modal-section product-modal-sizes-section">
          <div class="pdp-size-flow">
            <div class="product-modal-section-label">TALLES</div>
            <div class="product-modal-variants pdp-size-section">${variantesPDP}</div>
          </div>
        </div>
        ${featuresHtml}
      </div>
      <div class="pdp-reco">
        <div class="pdp-reco-head">
          <h3>Recomendados</h3>
          <button class="pdp-reco-more" type="button" data-action="go-reco-filter">Ver más</button>
        </div>
        <div class="pdp-reco-row" id="pdp-reco-row"></div>
      </div>
    </div>`;

  if (modalFooter) {
    if (window.__CATALOG_ONLY__) {
      modalFooter.classList.remove("pdp-footer-bar-hidden");
      modal.classList.remove("pdp-checkout-bar-visible");
      const waText = encodeURIComponent(`Hola, consulto por: ${producto.Articulo || ''}${detalleColor?.color ? ' - ' + detalleColor.color : ''}`);
      const waUrl = `https://wa.me/5493624118637?text=${waText}`;
      modalFooter.innerHTML = `
        <a class="pdp-whatsapp-cta" href="${waUrl}" target="_blank" rel="noopener" data-action="wa">Consultar por WhatsApp</a>`;
    } else {
      modalFooter.innerHTML = `
        <div class="product-modal-cta" data-precio-unidad="${precioUnidad}">
          <div class="product-modal-cta-summary">
            <div class="product-modal-cta-pairs">Seleccioná talles para agregar</div>
            <div class="product-modal-cta-total">$0</div>
          </div>
          <button class="product-modal-cta-btn reserve-btn pdp-add-btn is-empty" 
                  data-articulo="${producto.Articulo}" 
                  data-color="${detalleColor?.color || ''}">Agregar al carrito</button>
        </div>`;
      updateModalPDPTotal(modal);
    }
  }

  // La imagen principal debe usar la MISMA URL que las miniaturas (que sí cargan).
  const mainImg = modalBody.querySelector('.product-modal-main-image');
  const miniatura = modalBody.querySelector('.pdp-thumbs .miniatura.active') || modalBody.querySelector('.pdp-thumbs .miniatura');
  if (mainImg) {
    const url = miniatura?.getAttribute('data-full') || miniatura?.getAttribute('src') || mainImgUrl;
    if (url) mainImg.src = url;
  }

  // PDP IMG DIAG: diagnóstico automático (onload/onerror + rects + elementsFromPoint)
  if (mainImg) {
    const wrap = modalBody.querySelector('.pdp-main-image-wrap');
    let logged = false;
    const logDiag = (ev) => {
      if (logged) return;
      logged = true;
      const rect = wrap?.getBoundingClientRect();
      const cx = rect ? rect.left + rect.width / 2 : 0;
      const cy = rect ? rect.top + rect.height / 2 : 0;
      const els = (document.elementsFromPoint && document.elementsFromPoint(cx, cy) || []).slice(0, 6).map(e => ({ tag: e.tagName, class: e.className, id: e.id }));
      fylCatalogDbg('PDP IMG DIAG', {
        event: ev,
        srcAttr: mainImg.getAttribute('src'),
        srcResolved: mainImg.src,
        complete: mainImg.complete,
        naturalWidth: mainImg.naturalWidth,
        naturalHeight: mainImg.naturalHeight,
        mainRect: mainImg.getBoundingClientRect(),
        wrapRect: wrap?.getBoundingClientRect(),
        elementsAtCenter: els,
      });
    };
    mainImg.onload = () => logDiag('load');
    mainImg.onerror = () => logDiag('error');
    if (mainImg.complete) logDiag('cached');
  }

  // Popular recomendados (async)
  (async () => {
    const row = document.getElementById('pdp-reco-row');
    if (!row) return;
    const recos = await getRecoCandidates(producto, 8);
    row.innerHTML = recos.map((p, idx) => {
      const sku = obtenerSKUDefecto(p) || '';
      const img = p?.DetalleColor?.[0]?.images?.[0] || p?.VariantePrincipal || '';
      const nombre = p?.Articulo || '';
      const precio = renderPriceWithOffer(p);
      const articulo = (p?.Articulo || '').replace(/"/g, '&quot;');
      return `<div class="pdp-reco-card" data-sku="${sku}" data-reco-index="${idx}" data-articulo="${articulo}"><img src="${cloudinaryOptimized(img, 400)}" alt="${nombre}"/><div class="pdp-reco-name">${nombre}</div><div class="pdp-reco-price">${precio}</div></div>`;
    }).join('');
    row.querySelectorAll('.pdp-reco-card').forEach((el, idx) => {
      el.addEventListener('click', () => {
        const sku = el.dataset.sku;
        if (sku && abrirModalPorSKU(sku)) return;
        // Fallback: abrir por producto cuando no hay SKU en skuIndex
        const p = recos[idx];
        if (p) {
          const color = p.DetalleColor?.[0]?.color;
          const r = obtenerPrimerSkuConStock(p, color);
          const resultado = r ? { producto: p, color, sku: r.sku, talle: r.talle } : { producto: p, color };
          abrirModalConResultado(resultado);
        }
      });
    });
  })();

  // "Ver más" y tags: delegado en initModalEvents
}

function renderizarColoresModal(producto, colorSeleccionado) {
  if (!producto.DetalleColor) return '';
  
  return producto.DetalleColor.map((detalle) => {
    const resultado = obtenerPrimerSkuConStock(producto, detalle.color);
    const sku = resultado?.sku || null;
    const imagen = detalle.images?.[0] || '';
    const selected = (detalle.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase() ? 'selected' : '';
    const hexColor = detalle.hex_color || "#CD844D"; // Color por defecto si no hay hex_color
    const displayNumber = detalle.ColorDisplayNumber || detalle.display_number;
    // Calcular si el color es claro u oscuro para ajustar el color del texto
    const rgb = hexToRgb(hexColor);
    const brightness = rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : 128;
    const textColor = brightness > 128 ? "#000000" : "#FFFFFF";
    const borderColor = selected ? "#fff" : hexColor;
    const borderWidth = selected ? "2px" : "1px";
    
    // Agregar el número si existe
    const numberHtml = displayNumber 
      ? `<span class="color-number" style="color: ${textColor}; font-weight: bold; font-size: 0.85em; pointer-events: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);">${displayNumber}</span>` 
      : "";
    
    const imgUrl = getImgUrl(imagen, 1200);
    return `<button class="color-btn ${selected}" 
                    data-color="${detalle.color}" 
                    data-src="${imgUrl}" 
                    data-sku="${sku || ''}"
                    data-number="${displayNumber || ''}"
                    style="background-color: ${hexColor}; color: ${textColor}; border: ${borderWidth} solid ${borderColor}; position: relative; display: flex; align-items: center; justify-content: center;">${numberHtml}</button>`;
  }).join('');
}

/** Texto de talle en UI: igual que en datos (p. ej. 39/40, no 39–40). */
function formatTalleDisplay(talle) {
  return String(talle || "").trim();
}

function normalizeCartStockKeyPart(value) {
  return String(value || "").trim().toLowerCase();
}

function getCartQtyByProductColorSize() {
  const qtyMap = new Map();
  try {
    const rawCart = localStorage.getItem("fyl_cart");
    const parsed = rawCart ? JSON.parse(rawCart) : [];
    if (!Array.isArray(parsed)) return qtyMap;

    parsed.forEach((item) => {
      const articulo = normalizeCartStockKeyPart(item.articulo ?? item.product_name ?? "");
      const color = normalizeCartStockKeyPart(item.color ?? "Único");
      const rawTalle = item.talle ?? item.size ?? "";
      const talle = normalizeCartStockKeyPart(normalizeSize(rawTalle) || rawTalle);
      const cantidad = Number(item.cantidad ?? item.quantity ?? item.qty ?? 0) || 0;
      if (!articulo || !color || !talle || cantidad <= 0) return;
      const key = `${articulo}__${color}__${talle}`;
      qtyMap.set(key, (qtyMap.get(key) || 0) + cantidad);
    });
  } catch (error) {
    console.warn("⚠️ No se pudo leer fyl_cart para stock visual:", error?.message || error);
  }
  return qtyMap;
}

function getVisualAvailableFromCart(vd, productArticulo, colorActual, qtyMap = null) {
  if (!vd || vd.available === null || vd.available === undefined) return vd?.available ?? null;
  const articulo = normalizeCartStockKeyPart(productArticulo);
  const color = normalizeCartStockKeyPart(colorActual);
  const talle = normalizeCartStockKeyPart(normalizeSize(vd.talle) || vd.talle);
  if (!articulo || !color || !talle) return vd.available;
  const key = `${articulo}__${color}__${talle}`;
  const sourceMap = qtyMap || getCartQtyByProductColorSize();
  const qtyInCart = sourceMap.get(key) || 0;
  return Math.max(0, Number(vd.available) - qtyInCart);
}

/**
 * Parsea Descripcion en bullets para el bloque Características.
 * Soporta: newlines, pipes (|), guiones al inicio.
 * Si no hay contenido, retorna '' (bloque oculto).
 */
function renderizarCaracteristicasPDP(producto) {
  const raw = (producto.Descripcion || '').trim();
  if (!raw) return '';

  const items = raw
    .split(/\n|(?:\s*\|\s*)/)
    .map(s => s.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  if (items.length === 0) return '';

  const listHtml = items.map(i => `<li>${i.replace(/</g, '&lt;')}</li>`).join('');
  return `
    <div class="pdp-features product-modal-section">
      <button type="button" class="pdp-features-toggle" aria-expanded="true" aria-controls="pdp-features-list">
        <span class="pdp-features-title">Características</span>
        <span class="pdp-features-icon" aria-hidden="true">▼</span>
      </button>
      <ul id="pdp-features-list" class="pdp-features-list">${listHtml}</ul>
    </div>`;
}

function renderizarVariantesModalPDP(producto, colorSeleccionado, colorActual) {
  const detalleColor = producto.DetalleColor?.find(d =>
    (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase()
  ) || producto.DetalleColor?.[0];
  if (!detalleColor) return '';

  const variantDetails = detalleColor.variantDetails || [];
  const cartQtyMap = getCartQtyByProductColorSize();
  const chips = variantDetails.map((vd) => {
    const key = `${colorActual}_${vd.talle}`;
    const availableVisual = getVisualAvailableFromCart(vd, producto?.Articulo, colorActual, cartQtyMap);
    const sinStock = availableVisual !== null && availableVisual <= 0;
    const max = availableVisual !== null ? availableVisual : 999;
    const stockUnknown = availableVisual === null;
    const sizeDisplay = formatTalleDisplay(vd.talle);
    const titleHint = sinStock
      ? "Sin stock"
      : stockUnknown
        ? "Disponibilidad por confirmar"
        : `Disponibles: ${availableVisual}`;

    if (sinStock) {
      return `
        <button type="button" class="size-chip size-chip--disabled" disabled data-key="${key}" data-size="${sizeDisplay}" data-max="0" data-qty="0" data-stock-unknown="0" title="${titleHint.replace(/"/g, "&quot;")}" aria-disabled="true">
          <span class="size-chip__size">${sizeDisplay}</span>
        </button>`;
    }
    return `
      <button type="button" class="size-chip" data-key="${key}" data-size="${sizeDisplay}" data-max="${max}" data-qty="0" data-stock-unknown="${stockUnknown ? "1" : "0"}" title="${titleHint.replace(/"/g, "&quot;")}" aria-disabled="false">
        <span class="size-chip__size">${sizeDisplay}</span>
      </button>`;
  });

  /* Una sola grilla: 2 columnas ≤360px, 3 columnas >360px (CSS en styles.css) */
  const layoutHtml = `
    <div class="pdp-size-layout">
      <div class="pdp-size-layout-grid" role="group" aria-label="Talles disponibles">
        ${chips.join('')}
      </div>
    </div>
  `;

  return `${layoutHtml}<div class="size-stepper-panel is-hidden" id="pdp-size-stepper"></div>`;
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
  
  return `
    <div class="variant">
      <strong>${detalleColor.color}:</strong>
      <div class="talles">${chips}</div>
    </div>
  `;
}

function renderizarColores(producto) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) return "";
  const MAX_VISIBLE = 4;
  const colores = producto.DetalleColor;

  const swatchHtml = (v, hidden = false) => {
    const hexColor = v.hex_color || "#CD844D";
    const displayNumber = v.ColorDisplayNumber || v.display_number;
    const rgb = hexToRgb(hexColor);
    let textColor = "#000000";
    if (rgb) {
      const brightness = (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000;
      textColor = brightness > 128 ? "#000000" : "#FFFFFF";
    }
    const numberHtml = displayNumber 
      ? `<span class="color-number" style="color: ${textColor}; font-weight: bold; font-size: 0.85em; pointer-events: none;">${displayNumber}</span>` 
      : "";
    const hiddenClass = hidden ? " color-btn-hidden" : "";
    return `<button class='color-btn${hiddenClass}' 
                    data-src="${v.images[0] || ""}"
                    data-color="${v.color || ''}"
                    data-number="${displayNumber || ''}"
                    title="${v.color || ''}"
                    style="background-color: ${hexColor}; border: 1.5px solid rgba(0, 0, 0, 0.1); position: relative; display: flex; align-items: center; justify-content: center;">${numberHtml}</button>`;
  };

  const visibles = colores.slice(0, MAX_VISIBLE).map(v => swatchHtml(v));
  const ocultos = colores.slice(MAX_VISIBLE).map(v => swatchHtml(v, true));
  const restantes = ocultos.length;
  const moreChip = restantes > 0
    ? `<span class="color-more-chip" title="Ver ${restantes} colores más" role="button" tabindex="0">+${restantes}</span>`
    : "";
  return visibles.join("") + ocultos.join("") + moreChip;
}

// Función auxiliar para convertir hex a RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Formato compacto de talles para la card (progressive disclosure)
function formatSizeRange(sizes) {
  if (!sizes || sizes.length === 0) return "";
  const raw = sizes.map(s => String(s).trim()).filter(Boolean);
  const uniq = [...new Set(raw)];
  if (uniq.length === 0) return "";

  const allNums = [];
  for (const s of uniq) {
    const matches = s.match(/\d+/g);
    if (matches) matches.forEach(m => allNums.push(parseInt(m, 10)));
  }

  if (allNums.length > 0) {
    const min = Math.min(...allNums);
    const max = Math.max(...allNums);
    return min === max ? `${min}` : `${min}\u2013${max}`;
  }

  if (uniq.length === 1) return uniq[0];
  return `${uniq.length} talles`;
}

function obtenerSizeBadgeHTML(producto, colorSeleccionado = null) {
  const text = formatearSizeBadgeParaCard(producto, colorSeleccionado);
  if (!text) return "";
  return `<span class="card-size-badge">${text}</span>`;
}

/** Texto para chip de talle en card: Único (solo si se llama así) | 36 | 36–40 | Talles + */
function formatearSizeBadgeParaCard(producto, colorSeleccionado = null) {
  const raw = obtenerTallesSetParaCard(producto, colorSeleccionado);
  const talles = [...raw];
  if (talles.length === 0) return "";
  if (talles.length === 1) {
    const talle = String(talles[0]).trim();
    return /^unico$/i.test(talle) ? "Único" : talle;
  }
  const allNums = [];
  for (const s of talles) {
    const m = String(s).match(/\d+/g);
    if (m) m.forEach(n => allNums.push(parseInt(n, 10)));
  }
  if (allNums.length > 0) {
    const min = Math.min(...allNums);
    const max = Math.max(...allNums);
    return min === max ? `${min}` : `${min}\u2013${max}`;
  }
  return "Talles +";
}

function obtenerTallesSetParaCard(producto, colorSeleccionado = null) {
  if (!producto?.DetalleColor?.length) return new Set();
  const coloresAFiltrar = colorSeleccionado
    ? producto.DetalleColor.filter(d => (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase())
    : producto.DetalleColor;
  if (coloresAFiltrar.length === 0) return new Set();
  const tallesSet = new Set();
  coloresAFiltrar.forEach(detalle => {
    if (detalle.variantDetails?.length) detalle.variantDetails.forEach(vd => { if (vd.talle) tallesSet.add(vd.talle); });
    else if (detalle.talles?.length) detalle.talles.forEach(t => tallesSet.add(t));
  });
  return tallesSet;
}

function obtenerSizesCompactoParaCard(producto, colorSeleccionado = null) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) return "";
  const coloresAFiltrar = colorSeleccionado
    ? producto.DetalleColor.filter(d => (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase())
    : producto.DetalleColor;
  if (coloresAFiltrar.length === 0) return "";

  const tallesSet = new Set();
  coloresAFiltrar.forEach(detalle => {
    if (detalle.variantDetails && detalle.variantDetails.length > 0) {
      detalle.variantDetails.forEach(vd => { if (vd.talle) tallesSet.add(vd.talle); });
    } else if (detalle.talles && detalle.talles.length > 0) {
      detalle.talles.forEach(t => tallesSet.add(t));
    }
  });
  return formatSizeRange([...tallesSet]);
}

// Función para obtener todos los talles disponibles con su estado de stock
function obtenerRangoTalles(producto, colorSeleccionado = null) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) {
    return '';
  }
  
  // Si se especifica un color, filtrar solo ese color; si no, usar todos los colores
  const coloresAFiltrar = colorSeleccionado 
    ? producto.DetalleColor.filter(d => (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase())
    : producto.DetalleColor;
  
  if (coloresAFiltrar.length === 0) {
    return '';
  }
  
  // Obtener todos los talles con su información de stock
  const tallesConStock = [];
  coloresAFiltrar.forEach(detalle => {
    if (detalle.variantDetails && detalle.variantDetails.length > 0) {
      detalle.variantDetails.forEach(vd => {
        if (vd.talle) {
          // Verificar si ya existe este talle (puede estar en múltiples colores)
          const existente = tallesConStock.find(t => t.talle === vd.talle);
          if (!existente) {
            tallesConStock.push({
              talle: vd.talle,
              available: vd.available !== null && vd.available !== undefined ? vd.available : null
            });
          } else {
            // Si ya existe, actualizar el stock si este tiene más disponibilidad
            if (vd.available !== null && vd.available !== undefined) {
              if (existente.available === null || vd.available > existente.available) {
                existente.available = vd.available;
              }
            }
          }
        }
      });
    } else if (detalle.talles && detalle.talles.length > 0) {
      detalle.talles.forEach(talle => {
        const existente = tallesConStock.find(t => t.talle === talle);
        if (!existente) {
          tallesConStock.push({
            talle: talle,
            available: null // Disponibilidad por confirmar
          });
        }
      });
    }
  });
  
  if (tallesConStock.length === 0) {
    return '';
  }
  
  // Normalizar talles y convertir a números para ordenar
  const tallesNumericos = tallesConStock
    .map(t => {
      const num = parseInt(t.talle);
      if (!isNaN(num)) {
        return { ...t, num };
      }
      // Si normalizeSize existe, intentar normalizar
      if (typeof normalizeSize === 'function') {
        const normalized = normalizeSize(t.talle);
        const numNormalized = parseInt(normalized);
        if (!isNaN(numNormalized)) {
          return { ...t, num: numNormalized };
        }
      }
      return { ...t, num: Infinity }; // Colocar al final si no es numérico
    })
    .sort((a, b) => a.num - b.num);
  
  // Renderizar cada talle con su estado
  return tallesNumericos.map(({ talle, available }) => {
    const sinStock = available !== null && available <= 0;
    const clase = sinStock ? 'size-item size-out' : 'size-item';
    return `<span class="${clase}">${talle}</span>`;
  }).join(',');
}

function renderizarVariantes(producto) {
  // Solo mostrar talles del primer color por defecto
  const primerDetalleColor = producto.DetalleColor?.[0];
  if (!primerDetalleColor) {
    return '';
  }

  // IMPORTANTE: Usar variantDetails si existe (viene de enrichProductsWithStock)
  // Si no existe, crear variantDetails desde talles con available: null (disponibilidad por confirmar)
  const detalles =
    primerDetalleColor.variantDetails && primerDetalleColor.variantDetails.length > 0
      ? primerDetalleColor.variantDetails
      : (primerDetalleColor.talles || []).map((talle) => ({
          talle: normalizeSize(talle) || talle, // Normalizar talle
          stock: null,
          reserved: null,
          available: null, // null = disponibilidad por confirmar (no "sin stock")
          variant_id: null,
          sku: null,
        }));

  // Renderizar talles como chips (solo visualización)
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

  return `
    <div class="variant-info">
      <div class="talles-display">${chips}</div>
    </div>
  `;
}

function renderizarTags(producto) {
  const tags = [];
  if (producto.Filtro1?.trim()) tags.push(producto.Filtro1.trim());
  if (producto.Filtro2?.trim()) tags.push(producto.Filtro2.trim());
  if (producto.Filtro3?.trim()) {
    producto.Filtro3.split(/[,;]/).forEach((part) => {
      const t = part.trim();
      if (t) tags.push(t);
    });
  }
  const tagList = tags;

  return tagList.length
    ? `
    <div class="tags">${tagList
      .map((t) => `<div class="talle tag-chip" data-tag="${t}">${t}</div>`)
      .join("")}</div>
  `
    : "";
}

/** Quita estado "Agregado" (verde) cuando el usuario cambia selección en el PDP */
function clearPdpAddAddedState(modal) {
  const addBtn = modal?.querySelector?.('.pdp-add-btn');
  if (!addBtn || !addBtn.classList.contains('pdp-add-btn--added')) return;
  addBtn.classList.remove('pdp-add-btn--added');
  addBtn.style.background = '';
  addBtn.textContent = 'Agregar al carrito';
}

function updateModalPDPTotal(modal) {
  if (!modal) return;
  const footer = document.getElementById("product-modal-footer");
  if (window.__CATALOG_ONLY__) {
    footer?.classList.remove("pdp-footer-bar-hidden");
    modal.classList.remove("pdp-checkout-bar-visible");
    return;
  }
  let total = 0;
  const chips = modal.querySelectorAll('.size-chip[data-size][data-max]:not(.size-chip--disabled)');
  chips.forEach((chip) => {
    const qty = parseInt(chip.dataset.qty || '0', 10) || 0;
    total += qty;
  });
  const cta = modal.querySelector('.product-modal-cta');
  const precioUnidad = parseFloat(cta?.dataset.precioUnidad || '0') || 0;
  const totalPrecio = total * precioUnidad;
  const pairsEl = modal.querySelector('.product-modal-cta-pairs');
  const totalEl = modal.querySelector('.product-modal-cta-total');
  if (!cta) {
    footer?.classList.remove("pdp-footer-bar-hidden");
    modal.classList.remove("pdp-checkout-bar-visible");
    return;
  }
  if (pairsEl) {
    pairsEl.innerHTML = total === 0
      ? 'Seleccioná talles para agregar'
      : `<span class="pdp-cta-count">${total}</span> pares seleccionados`;
  }
  if (totalEl) totalEl.textContent = formatPrice(totalPrecio);
  const addBtn = modal.querySelector('.pdp-add-btn');
  if (addBtn) addBtn.classList.toggle('is-empty', total === 0);
  const showCheckoutBar = total > 0;
  footer?.classList.toggle("pdp-footer-bar-hidden", !showCheckoutBar);
  modal.classList.toggle("pdp-checkout-bar-visible", showCheckoutBar);
}

// Inicialización de eventos del modal (UNA sola vez)
function initModalEvents() {
  if (modalEventsInitialized) return;
  modalEventsInitialized = true;
  
  const modal = document.getElementById('product-modal');
  if (!modal) return;
  
  // CTA WhatsApp en modo catálogo: interceptar en capture para no disparar carrito/bottom-sheet
  if (!window.__pdpWaClickInit) {
    window.__pdpWaClickInit = true;
    document.addEventListener('click', (e) => {
      const wa = e.target.closest('.pdp-whatsapp-cta');
      if (wa) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try {
          if (fylAnalytics.isReady()) fylAnalytics.event("whatsapp_click", { surface: "pdp" });
        } catch (_e) {}
        window.open(wa.href, '_blank', 'noopener');
        return;
      }
    }, true);
  }
  
  modal.addEventListener('click', (e) => {
    // CTA WhatsApp (modo catálogo): evitar que el resto del handler toque carrito
    if (e.target.closest('.pdp-whatsapp-cta')) return;
    // Click en backdrop (el modal mismo)
    if (e.target === modal) {
      cerrarModal();
      return;
    }
    
    // Click en botón cerrar (externo o interno)
    if (e.target.classList.contains('product-modal-close') || e.target.classList.contains('product-modal-close-inner')) {
      cerrarModal();
      return;
    }
    
    // Click en botón volver
    if (e.target.classList.contains('product-modal-back')) {
      cerrarModal();
      return;
    }

    // Tags clickeables
    const tagChip = e.target.closest('.pdp-tag-chip');
    if (tagChip) {
      const level = tagChip.dataset.tagLevel;
      const tag = tagChip.dataset.tag;
      if (!tag) return;
      // Modo solo catálogo: usar buscador en lugar de #/tag y setQuickFilter
      if (window.__CATALOG_ONLY__) {
        const tagValue = (tag || '').trim();
        if (tagValue) {
          cerrarModal(true);
          const input = document.getElementById('searchInput') || document.querySelector('#searchInput');
          if (input) {
            input.value = tagValue;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const catalogo = document.getElementById('catalogo');
          if (catalogo) catalogo.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      if (level && tag) {
        cerrarModal();
        window.setQuickFilter?.(level, tag);
      }
      return;
    }

    // Ver más recomendados
    const recoMore = e.target.closest('[data-action="go-reco-filter"]');
    if (recoMore && productoActualEnModal) {
      const f1 = (productoActualEnModal.Filtro1 || '').trim();
      try { if (fylAnalytics.isReady()) fylAnalytics.event("related_product_click", { tag: f1 || "" }); } catch (_e) {}
      cerrarModal();
      if (f1) window.setQuickFilter?.('filtro1', f1);
      return;
    }

    // Botones descargar/compartir PDP
    const pdpDownload = e.target.closest('.pdp-download');
    if (pdpDownload) {
      e.preventDefault();
      const imgUrl = modal.querySelector('.product-modal-main-image')?.src;
      if (imgUrl) {
        try { if (fylAnalytics.isReady()) fylAnalytics.event("download_product_image", { surface: "pdp" }); } catch (_e) {}
        downloadImageFromUrl(imgUrl);
      }
      return;
    }
    const pdpShare = e.target.closest('.pdp-share');
    if (pdpShare) {
      e.preventDefault();
      const imgUrl = modal.querySelector('.product-modal-main-image')?.src;
      if (imgUrl) {
        try { if (fylAnalytics.isReady()) fylAnalytics.event("share_product", { surface: "pdp" }); } catch (_e) {}
        shareImageUrl(imgUrl);
      }
      return;
    }

    // Botones descargar/compartir (delegación con data-action, fallback)
    const actionBtn = e.target.closest('.pm-action-btn');
    if (actionBtn) {
      const action = actionBtn.dataset.action;
      const imgUrl = modal.querySelector('.product-modal-main-image')?.src;
      if (imgUrl && action === 'pm-download') {
        e.preventDefault();
        try { if (fylAnalytics.isReady()) fylAnalytics.event("download_product_image", { surface: "pdp_header" }); } catch (_e) {}
        downloadImageFromUrl(imgUrl);
        return;
      }
      if (imgUrl && action === 'pm-share') {
        e.preventDefault();
        try { if (fylAnalytics.isReady()) fylAnalytics.event("share_product", { surface: "pdp_header" }); } catch (_e) {}
        shareImageUrl(imgUrl);
        return;
      }
    }
    
    // Click en botón de color
    if (e.target.classList.contains('color-btn')) {
      const btn = e.target;
      const color = btn.dataset.color;
      if (!productoActualEnModal || !color) return;
      
      const resultado = obtenerPrimerSkuConStock(productoActualEnModal, color);
      const sku = resultado?.sku || '';
      
      const mainImage = modal.querySelector('.product-modal-main-image');
      if (mainImage && btn.dataset.src) {
        mainImage.src = btn.dataset.src;
      }
      
      const detalleColor = productoActualEnModal.DetalleColor?.find(d =>
        (d.color || "").trim().toLowerCase() === (color || "").trim().toLowerCase()
      );
      if (detalleColor) {
        try {
          if (fylAnalytics.isReady() && productoActualEnModal && color) {
            fylAnalytics.event("select_item_variant", {
              item_id: String(productoActualEnModal.Articulo || ""),
              item_variant: String(color),
            });
          }
        } catch (_e) {}
        const variantesHTML = renderizarVariantesModalPDP(productoActualEnModal, color, color);
        const variantsContainer = modal.querySelector('.product-modal-variants');
        if (variantsContainer) variantsContainer.innerHTML = variantesHTML;
        const titleEl = modal.querySelector('.pdp-title') || modal.querySelector('.product-modal-title');
        if (titleEl) {
          const nameEl = titleEl.querySelector('.pdp-title__name');
          const sepEl = titleEl.querySelector('.pdp-title__sep');
          const colorEl = titleEl.querySelector('.pdp-title__color');
          if (nameEl) nameEl.textContent = productoActualEnModal.Articulo || '';
          if (color) {
            if (!sepEl) {
              const sep = document.createElement('span');
              sep.className = 'pdp-title__sep';
              sep.textContent = '•';
              nameEl?.after(sep);
            }
            if (!colorEl) {
              const col = document.createElement('span');
              col.className = 'pdp-title__color';
              col.textContent = color;
              titleEl.querySelector('.pdp-title__sep')?.after(col);
            } else colorEl.textContent = color;
          } else {
            sepEl?.remove();
            colorEl?.remove();
          }
        }
        const colorLabelEl = modal.querySelector('.product-modal-color-label strong');
        if (colorLabelEl) colorLabelEl.textContent = color;
        const addBtn = modal.querySelector('.pdp-add-btn');
        if (addBtn) addBtn.dataset.color = color;
        clearPdpAddAddedState(modal);
        updateModalPDPTotal(modal);
      }
      
      // Si no encontramos SKU con stock, igual mostramos talles para que el usuario pueda elegir.
      // Solo tocamos URL/dataset si tenemos un SKU válido.
      if (sku) {
        updateSKUEnURL(sku);
        modal.dataset.sku = sku;
      }
      modal.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      return;
    }
    
    /* Panel stepper: +/- actualiza chip activo */
    const stepperPanel = e.target.closest('.size-stepper-panel');
    if (stepperPanel && !stepperPanel.classList.contains('is-hidden')) {
      const btn = e.target.closest('.size-stepper-btn');
      if (!btn || btn.disabled) return;

      e.preventDefault();
      const sizeGrid = modal.querySelector('.size-grid') || modal.querySelector('.pdp-size-layout');
      const activeChip = sizeGrid?.querySelector('.size-chip.is-active');
      if (!activeChip) return;

      let qty = parseInt(activeChip.dataset.qty || '0', 10) || 0;
      const max = parseInt(activeChip.dataset.max || '0', 10) || 999;
      const action = btn.dataset.action;

      if (action === 'dec') qty = Math.max(qty - 1, 0);
      else if (action === 'inc') qty = Math.min(qty + 1, max);

      activeChip.dataset.qty = String(qty);
      activeChip.classList.toggle('size-chip--active', qty > 0);

      const qtyEl = stepperPanel.querySelector('.size-stepper-qty');
      if (qtyEl) qtyEl.textContent = qty;

      const decBtn = stepperPanel.querySelector('.size-stepper-btn[data-action="dec"]');
      const incBtn = stepperPanel.querySelector('.size-stepper-btn[data-action="inc"]');
      if (decBtn) decBtn.disabled = qty <= 0;
      if (incBtn) incBtn.disabled = qty >= max;

      clearPdpAddAddedState(modal);
      updateModalPDPTotal(modal);
      return;
    }

    /* Size chips: tap marca activo y muestra panel (.size-grid legacy o .pdp-size-layout actual) */
    const sizeGrid = e.target.closest('.size-grid') || e.target.closest('.pdp-size-layout');
    if (sizeGrid) {
      const chip = e.target.closest('.size-chip');
      if (!chip || chip.classList.contains('size-chip--disabled')) return;

      e.preventDefault();
      const sizeDisplay = chip.dataset.size || '';
      const max = parseInt(chip.dataset.max || '0', 10) || 999;
      const stockUnknown = chip.dataset.stockUnknown === '1';
      let qty = parseInt(chip.dataset.qty || '0', 10) || 0;

      /* Si ya está activo, no hacer nada */
      if (chip.classList.contains('is-active')) return;

      clearPdpAddAddedState(modal);
      sizeGrid.querySelectorAll('.size-chip').forEach(c => c.classList.remove('is-active'));
      chip.classList.add('is-active');

      const panel = modal.querySelector('#pdp-size-stepper') || modal.querySelector('.size-stepper-panel');
      if (panel) {
        const safeSize = (sizeDisplay || '').replace(/</g, '&lt;');
        const stockSuffix = stockUnknown
          ? '(stock a confirmar)'
          : `(${max} disp.)`;
        panel.classList.remove('is-hidden');
        panel.innerHTML = `
          <div class="size-stepper-label"><span class="size-stepper-label-talle">${safeSize}</span><span class="size-stepper-label-stock">${stockSuffix}</span></div>
          <div class="size-stepper-controls">
            <button type="button" class="size-stepper-btn" data-action="dec" aria-label="Menos" ${qty <= 0 ? 'disabled' : ''}>−</button>
            <div class="size-stepper-qty">${qty}</div>
            <button type="button" class="size-stepper-btn" data-action="inc" aria-label="Más" ${qty >= max ? 'disabled' : ''}>+</button>
          </div>`;

        // Asegurar que el selector de cantidades quede expuesto al usuario
        // (scroll suave dentro del contenedor scrollable del modal).
        setTimeout(() => {
          const modalBody = document.getElementById('product-modal-body');
          if (!modalBody) return;

          // block: 'center' + scroll-margin-bottom en CSS: el stepper no queda bajo el footer fijo del PDP.
          panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 50);
      }
      return;
    }

    // Accordion Características
    if (e.target.closest('.pdp-features-toggle')) {
      const toggle = e.target.closest('.pdp-features-toggle');
      const list = document.getElementById('pdp-features-list');
      if (!toggle || !list) return;
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', !expanded);
      list.classList.toggle('is-collapsed', expanded);
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
      modal.querySelectorAll('.pdp-thumbs .miniatura').forEach(m => m.classList.remove('active'));
      img.classList.add('active');
      return;
    }
    
    // Click en botón agregar PDP (múltiples talles con +/-)
    if (e.target.classList.contains('pdp-add-btn')) {
      if (window.__CATALOG_ONLY__) return;
      const btn = e.target;
      if (btn.disabled) return;
      const articulo = btn.dataset.articulo;
      const color = btn.dataset.color;
      if (!articulo || !color || !window.addToCart) return;

      btn.disabled = true;
      (async () => {
        try {
        const countAntes = window.getCartCount?.() ?? 0;
        const precioStr = modal.querySelector('.product-modal-price-container .price')?.textContent || modal.querySelector('.product-modal-price-container')?.textContent || '0';
        const precio = parseARSNumber(precioStr);
        const imagen = modal.querySelector('.product-modal-main-image')?.src || '';
        const descripcion = (modal.querySelector('.pdp-title') || modal.querySelector('.product-modal-title'))?.textContent || '';

        const detalleColor = productoActualEnModal?.DetalleColor?.find(d =>
          (d.color || "").trim().toLowerCase() === (color || "").trim().toLowerCase()
        );
        const variantDetails = detalleColor?.variantDetails || [];

        const itemsToAdd = [];
        const chips = modal.querySelectorAll('.size-chip[data-size][data-max]:not(.size-chip--disabled)');
        chips.forEach((chip) => {
          const qty = parseInt(chip.dataset.qty || '0', 10) || 0;
          if (qty <= 0) return;
          const talle = chip.dataset.size?.trim();
          const key = chip.dataset.key;
          if (!talle || !key) return;
          itemsToAdd.push({ talle, key, qty });
        });

        let rowsAdded = 0;
        let pairsAdded = 0;
        for (const { talle, key, qty } of itemsToAdd) {
          const vd = variantDetails.find(v => `${color}_${v.talle}` === key);
          const productData = {
            articulo,
            color,
            talle,
            cantidad: qty,
            precio,
            imagen: detalleColor?.images?.[0] || imagen,
            descripcion,
            variant_id: vd?.variant_id || null,
          };
          const ok = await window.addToCart(productData, { suppressNotification: true });
          if (ok) {
            rowsAdded++;
            pairsAdded += qty;
          }
        }

        if (rowsAdded > 0) {
          try {
            if (fylAnalytics.isReady() && productoActualEnModal) {
              const lineItems = [];
              for (const row of itemsToAdd) {
                const vd = variantDetails.find(v => `${color}_${v.talle}` === row.key);
                lineItems.push({
                  articulo,
                  color,
                  talle: row.talle,
                  cantidad: row.qty,
                  precio,
                  variant_id: vd?.variant_id,
                });
              }
              const gaItems = fylAnalytics.buildCartItemsFromLines(lineItems);
              const val = gaItems.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
              fylAnalytics.ecommerceEvent("add_to_cart", { currency: "ARS", value: val, items: gaItems });
            }
          } catch (_e) {}
          btn.textContent = 'Agregado';
          btn.classList.add('pdp-add-btn--added');
          btn.style.background = '';
          const variantsContainer = modal.querySelector('.product-modal-variants');
          if (variantsContainer && productoActualEnModal) {
            variantsContainer.innerHTML = renderizarVariantesModalPDP(productoActualEnModal, color, color);
          }
          const stepperPanel = modal.querySelector('#pdp-size-stepper') || modal.querySelector('.size-stepper-panel');
          if (stepperPanel) {
            stepperPanel.classList.add('is-hidden');
            stepperPanel.innerHTML = '';
          }
          updateModalPDPTotal(modal);
        }

          const countDespues = window.getCartCount?.() ?? 0;
          if (pairsAdded > 0 && typeof window.showToast === 'function') {
            const paresLabel = pairsAdded === 1 ? '1 par' : `${pairsAdded} pares`;
            if (countAntes === 0 && countDespues > 0) {
              window.showToast({
                message: `Agregado al carrito (${paresLabel})`,
                primaryLabel: 'Ver carrito',
                onPrimary: () => {
                  if (typeof window.cerrarModal === 'function') window.cerrarModal();
                  if (typeof window.goToCart === 'function') window.goToCart();
                },
                secondaryLabel: 'Seguir agregando',
                onSecondary: () => {},
                autoCloseMs: 5000,
              });
            } else {
              window.showToast({ message: `Agregado (${paresLabel})`, autoCloseMs: 2000 });
            }
          }
        } finally {
          btn.disabled = false;
        }
      })();
      return;
    }
  });
  
  // Change en select de talles (compatibilidad con controles antiguos)
  modal.addEventListener('change', (e) => {
    if (e.target.classList.contains('res-size')) {
      const select = e.target;
      const selectedOption = select.options[select.selectedIndex];
      if (!selectedOption || selectedOption.disabled) return;
      
      const sku = selectedOption.dataset.sku;
      const size = select.value;
      
      if (!sku) return;
      
      updateSKUEnURL(sku);
      modal.dataset.sku = sku;
      try {
        if (fylAnalytics.isReady() && productoActualEnModal) {
          fylAnalytics.event("select_item_variant", {
            item_id: String(productoActualEnModal.Articulo || ""),
            item_variant: String(size || ""),
          });
        }
      } catch (_e) {}
      
      const variantContainer = select.closest('.variant');
      if (variantContainer) {
        variantContainer.querySelectorAll('.talle').forEach(chip => {
          chip.classList.remove('selected');
          if (chip.dataset.size === size) {
            chip.classList.add('selected');
          }
        });
      }
    }
  });
}

function initGridEvents() {
  if (gridEventsInitialized) return;
  gridEventsInitialized = true;
  
  const catalogo = document.getElementById('catalogo');
  if (!catalogo) return;
  
  catalogo.addEventListener('click', (e) => {
    // Expandir colores ocultos al clicar en chip +N
    if (e.target.closest('.color-more-chip')) {
      e.preventDefault();
      e.stopPropagation();
      const colorsDiv = e.target.closest('.colors');
      if (colorsDiv) colorsDiv.classList.add('expanded');
      return;
    }
    // Feedback háptico al tocar carrito (PWA)
    if (e.target.closest('.cart-icon-btn')) {
      navigator.vibrate?.(10);
      return;
    }
    // Ignorar clicks en botones, controles de reserva, botones de color
    if (e.target.tagName === 'BUTTON' || 
        e.target.closest('.reserve-controls') ||
        e.target.closest('.color-btn')) {
      return;
    }
    
    // Encontrar .card.producto más cercana
    const card = e.target.closest('.card.producto');
    if (!card) return;
    
    let sku = (card.dataset.sku || card.querySelector('.main-image')?.dataset.sku || '').trim();
    
    // 1) SKU en skuIndex → abrir al instante con URL
    if (sku && abrirModalPorSKU(sku)) {
      try {
        if (fylAnalytics.isReady() && window.productosActualesMap) {
          const art = card.querySelector('[data-articulo]')?.dataset?.articulo;
          const p = art ? window.productosActualesMap.get(art) : null;
          if (p) {
            const items = fylAnalytics.buildItemsFromGroupedProducts([p], 1);
            if (items.length) {
              items[0].item_variant = String(sku);
              fylAnalytics.ecommerceEvent("select_item", { items, item_list_name: "catalog_grid", currency: "ARS" });
            }
          }
        }
      } catch (_e) {}
      return;
    }
    
    // 2) Producto en página → usar datos completos (colores, imágenes), rápido
    const articulo = card.querySelector('[data-articulo]')?.dataset?.articulo;
    if (articulo && window.productosActualesMap) {
      const producto = window.productosActualesMap.get(articulo);
      if (producto) {
        let color = null, talle = null;
        if (sku) {
          for (const d of producto.DetalleColor || []) {
            const vd = d.variantDetails?.find(v => v.sku === sku);
            if (vd) { color = d.color; talle = vd.talle; break; }
          }
        }
        if (!color) {
          const d0 = producto.DetalleColor?.[0];
          color = d0?.color; talle = d0?.variantDetails?.[0]?.talle;
        }
        try {
          if (fylAnalytics.isReady()) {
            const items = fylAnalytics.buildItemsFromGroupedProducts([producto], 1);
            if (items.length) {
              items[0].item_variant = String(sku || color || "");
              fylAnalytics.ecommerceEvent("select_item", { items, item_list_name: "catalog_grid", currency: "ARS" });
            }
          }
        } catch (_e) {}
        abrirModalConResultado({
          producto,
          color,
          talle,
          sku: sku || obtenerSKUDefecto(producto)
        }, { pushState: true });
        return;
      }
    }
    
    // 3) Solo si no está en página → buscar en Supabase (lento, datos mínimos)
    if (sku) {
      buscarPorSKUEnSupabase(sku).then(resultado => {
        if (resultado) abrirModalConResultado(resultado, { pushState: true });
      });
    }
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

// Handler popstate + hashchange: back nativo cierra PDP sin salir de la web
async function resetHomeState() {
  // Estado actual de filtros
  const hasTagBar = !!document.getElementById('tag-filter-bar');
  const hasQuickFilter = !!window.__quickFilter;
  const isAlreadyAll = (categoriaActual || 'all') === 'all' && !hasTagBar && !hasQuickFilter;

  // Siempre limpiar filtros visibles/flags (aunque ya estemos en all)
  window.__quickFilter = null;
  clearTagFilterBar();
  // Desmarcar acciones rápidas (si el usuario venía desde una categoría/tag)
  document.querySelectorAll(".quick-action-btn").forEach((btn) => btn.classList.remove("active"));

  // Evitar recargar desde Supabase si ya estamos en "all" y no había filtros activos
  if (!isAlreadyAll) {
    await cambiarCategoria('all');
  } else {
    // Asegurar que el menú desktop no marque ninguna categoría específica
    document.querySelectorAll(".menu button").forEach((btn) => btn.classList.remove("active"));
  }

  // Forzar URL limpia para que no se "reaplique" categoría al volver a buscar/filtar
  updateURL({ tab: '', sku: '' }, { mode: 'replace' });
}

async function onNavChange() {
  const modal = document.getElementById('product-modal');
  const isPdpOpen = modal?.classList.contains('active');

  if (isPdpOpen) {
    cerrarModal(true);
    return;
  }

  const hash = location.hash || '#/';
  const tagMatch = hash.match(/^#\/tag\/(.+)$/);
  if (tagMatch) {
    const tagValue = decodeURIComponent(tagMatch[1]);
    await applyTagFilterAndRender(tagValue, { pushHash: false });
    return;
  }

  const isHomeHash = hash === '#/' || hash === '#/all' || hash === '';
  if (isHomeHash && !location.hash?.match(/^#\/coleccion\/fyl-originals$/)) {
    if (window.__tagSearchFromPdp) {
      window.__tagSearchFromPdp = false;
      return;
    }
    await resetHomeState();
    return;
  }

  const sku = parsePdpFromUrl();
  const tabSlug = getTabFromURL();

  if (tabSlug !== ultimoTabSlug) {
    ultimoTabSlug = tabSlug;
    if (tabSlug && slugToCategoria(tabSlug)) {
      await cargarCategoria(slugToCategoria(tabSlug));
    }
  }

  if (sku && !isPdpOpen) {
    await abrirPdpPorSkuIfPossible(sku, { pushState: false });
  }
}

window.addEventListener('popstate', onNavChange);
window.addEventListener('hashchange', onNavChange);

// Resetear estado si el usuario "vuelve al inicio" tocando un link a "#/".
// Importante: si el hash ya es "#/", el navegador no dispara "hashchange"
// y por eso había que forzar el reset desde el click.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href');
  if (href !== '#/' && href !== '#/all') return;

  // Solo tocar si estamos en el mismo documento (evita comportamientos raros con links externos)
  // y si existe el handler (para no romper en carga parcial).
  if (typeof resetHomeState === 'function') {
    resetHomeState().catch((err) => console.error('resetHomeState:', err));
  }
});


// Configurar eventos (igual que antes)
// Función para crear/obtener el indicador de carga inferior
function obtenerIndicadorCargaInferior() {
  let indicator = document.getElementById("bottom-loading-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "bottom-loading-indicator";
    indicator.className = "bottom-loading-indicator";
    indicator.innerHTML = `
      <div class="bottom-loading-spinner">
        <div class="spinner-circle"></div>
        <div class="spinner-circle"></div>
        <div class="spinner-circle"></div>
      </div>
    `;
    document.body.appendChild(indicator);
  }
  return indicator;
}

// Timeout para ocultar el indicador inferior si las imágenes no completan (evitar carga infinita)
let bottomIndicatorTimeoutId = null;
const BOTTOM_INDICATOR_MAX_MS = 10000;

// Función para mostrar el indicador de carga inferior
function mostrarIndicadorCargaInferior() {
  if (bottomIndicatorTimeoutId) {
    clearTimeout(bottomIndicatorTimeoutId);
    bottomIndicatorTimeoutId = null;
  }
  const indicator = obtenerIndicadorCargaInferior();
  indicator.style.display = "flex";
  indicator.classList.add("show");
  bottomIndicatorTimeoutId = setTimeout(() => {
    bottomIndicatorTimeoutId = null;
    ocultarIndicadorCargaInferior();
    indicadorCargaActivo = false;
    bottomIndicatorGaveUp = true;
  }, BOTTOM_INDICATOR_MAX_MS);
}

// Función para ocultar el indicador de carga inferior
function ocultarIndicadorCargaInferior() {
  if (bottomIndicatorTimeoutId) {
    clearTimeout(bottomIndicatorTimeoutId);
    bottomIndicatorTimeoutId = null;
  }
  const indicator = document.getElementById("bottom-loading-indicator");
  if (indicator) {
    indicator.style.display = "none";
    indicator.classList.remove("show");
  }
}

// Función para detectar si hay imágenes lazy cargándose en el viewport
function detectarImagenesCargando() {
  const images = document.querySelectorAll(".main-image[loading='lazy']");
  let hayImagenesCargando = false;
  
  images.forEach((img) => {
    // Verificar si la imagen está en el viewport
    const rect = img.getBoundingClientRect();
    const isInViewport = rect.top < window.innerHeight && rect.bottom > 0;
    
    if (isInViewport) {
      // Verificar si la imagen está cargándose
      // Una imagen está cargando si no está completa o si no tiene dimensiones naturales
      if (!img.complete || img.naturalWidth === 0) {
        hayImagenesCargando = true;
      }
    }
  });
  
  return hayImagenesCargando;
}

// Variable para rastrear el estado del indicador
let indicadorCargaActivo = false;
let checkLoadingInterval = null;
// Si se ocultó por tiempo máximo, no volver a mostrar hasta la siguiente carga de categoría
let bottomIndicatorGaveUp = false;
let catalogoGlobalScrollInicializado = false;
let catalogoScrollDebounceTimeout = null;

function onMainImageLoadStateChange() {
  // Dejar que el navegador procese el estado de la imagen antes de re-evaluar
  setTimeout(() => {
    const hayCargando = detectarImagenesCargando();
    if (!hayCargando && indicadorCargaActivo) {
      ocultarIndicadorCargaInferior();
      indicadorCargaActivo = false;
    }
  }, 100);
}

// Función para iniciar la verificación de carga de imágenes
function iniciarVerificacionCargaImagenes() {
  bottomIndicatorGaveUp = false;
  
  // Mantener un único intervalo global durante la sesión
  if (!checkLoadingInterval) {
    // Verificar cada 200ms si hay imágenes cargándose
    checkLoadingInterval = setInterval(() => {
      if (bottomIndicatorGaveUp) return;
      const hayCargando = detectarImagenesCargando();
      
      if (hayCargando && !indicadorCargaActivo) {
        mostrarIndicadorCargaInferior();
        indicadorCargaActivo = true;
      } else if (!hayCargando && indicadorCargaActivo) {
        ocultarIndicadorCargaInferior();
        indicadorCargaActivo = false;
      }
    }, 200);
  }
  
  // También verificar cuando las imágenes terminan de cargar
  document.querySelectorAll(".main-image[loading='lazy']").forEach((img) => {
    if (!img.hasAttribute('data-load-listener')) {
      img.setAttribute('data-load-listener', 'true');
      img.addEventListener('load', onMainImageLoadStateChange);
      img.addEventListener('error', onMainImageLoadStateChange);
    }
  });
}

function configurarEventos() {
  // Galería de imágenes
  document.querySelectorAll(".card .gallery .miniatura").forEach((img) => {
    if (img.dataset.fylMiniaturaBound === "1") return;
    img.dataset.fylMiniaturaBound = "1";
    img.addEventListener("click", function () {
      const main = this.closest(".card").querySelector(".main-image");
      if (main) main.src = this.getAttribute("data-full");
    });
  });

  // Botones de color
  document.querySelectorAll(".card .color-btn").forEach((btn) => {
    if (btn.dataset.fylColorBtnBound === "1") return;
    btn.dataset.fylColorBtnBound = "1";
    btn.addEventListener("click", function () {
      const card = this.closest(".card.producto");
      if (!card) return;
      
      // Cambiar imagen principal
      const main = card.querySelector(".main-image");
      if (main) main.src = this.dataset.src;
      
      // Actualizar badge de talle según el color seleccionado
      const colorSeleccionado = this.dataset.color;
      const sizeContainer = card.querySelector(".card-footer-size");
      
      if (sizeContainer && window.productosActualesMap) {
        const articulo = sizeContainer.dataset.articulo;
        if (articulo) {
          const producto = window.productosActualesMap.get(articulo);
          if (producto) {
            sizeContainer.innerHTML = obtenerSizeBadgeHTML(producto, colorSeleccionado);
            sizeContainer.dataset.colorSelected = colorSeleccionado || '';
          }
        }
      }
    });
  });


  // Tags: manejado por initTagToSearch() (delegación en document)

  // Botón "Agregar al carrito" - Abre Bottom Sheet
  document.querySelectorAll(".card .add-to-cart-btn").forEach((btn) => {
    if (btn.dataset.fylAddToCartBound === "1") return;
    btn.dataset.fylAddToCartBound = "1";
    btn.addEventListener("click", function () {
      const card = this.closest(".card");
      const articulo = card.querySelector(".article-box")?.textContent;
      
      if (articulo && window.BottomSheet) {
        const producto = productosActualesMap.get(articulo);
        if (producto) {
          window.BottomSheet.open(producto);
        } else {
          console.error("Producto no encontrado en productosActualesMap:", articulo);
        }
      }
    });
  });
  
  // Iniciar verificación de carga de imágenes lazy
  iniciarVerificacionCargaImagenes();
  
  // También verificar al hacer scroll
  if (!catalogoGlobalScrollInicializado) {
    catalogoGlobalScrollInicializado = true;
    window.addEventListener('scroll', () => {
      clearTimeout(catalogoScrollDebounceTimeout);
      catalogoScrollDebounceTimeout = setTimeout(() => {
        iniciarVerificacionCargaImagenes();
        maybeTriggerCatalogAutoloadFallback();
      }, 100);
    }, { passive: true });
  }
}

// Función para cambiar categoría
async function cambiarCategoria(cat) {
  fylCatalogDbg("🔄 Cambiando a categoría:", cat);

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

// Descargar imagen desde URL (reutilizable desde card o modal)
async function downloadImageFromUrl(imgUrl) {
  if (!imgUrl) return;
  const filename = imgUrl
    .split("/")
    .pop()
    .split("?")[0]
    .replace(/\.\w+$/, ".jpg");

  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imgUrl;

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
    console.error("Error descargando imagen (canvas CORS?):", error);
    const a = document.createElement("a");
    a.href = imgUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

async function shareImageUrl(imgUrl) {
  if (!imgUrl) return;
  try {
    const resp = await fetch(imgUrl, { mode: 'cors' });
    const blob = await resp.blob();
    const file = new File([blob], 'producto.jpg', { type: blob.type || 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Producto FYL' });
      return;
    }
  } catch (e) {
    // continuar fallback silencioso
  }
  if (navigator.share) {
    try { await navigator.share({ url: imgUrl, title: 'Producto FYL' }); return; } catch (e) {}
  }
  try {
    await navigator.clipboard.writeText(imgUrl);
    if (typeof showToast === 'function') showToast('Link de imagen copiado', 'success');
    else alert('Link copiado');
  } catch (e) {
    alert('Copiá este link: ' + imgUrl);
  }
}

// Función legacy para card (mantener por si se usa desde otro lado)
async function downloadImage(btn) {
  const card = btn?.closest(".card");
  const src = card?.querySelector(".main-image")?.src;
  if (src) await downloadImageFromUrl(src);
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

async function existeOfertas() {
  try {
    if (!supabase) {
      console.warn("⚠️ Cliente de Supabase no disponible para verificar ofertas");
      return false;
    }

    const { data, error } = await supabase
      .from("catalog_public_view")
      .select("Oferta, Mostrar")
      .limit(4000);

    if (error) throw error;

    return (data || []).some((item) => {
      const mostrar = item?.Mostrar;
      const oferta = item?.Oferta;
      const mostrarOk = mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
      const ofertaOk = oferta === "TRUE" || oferta === true || oferta === "true" || oferta === 1;
      return mostrarOk && ofertaOk;
    });
  } catch (error) {
    console.error("Error verificando ofertas:", error);
    return false;
  }
}

// Función de diagnóstico
function ejecutarDiagnostico() {
  fylCatalogDbg("🔍 DIAGNÓSTICO RÁPIDO - CATÁLOGO FYL (SUPABASE)");
  fylCatalogDbg("================================================");

  // 1. Verificar configuración
  fylCatalogDbg("\n1. 📋 CONFIGURACIÓN:");
  fylCatalogDbg("USE_SUPABASE:", USE_SUPABASE);
  fylCatalogDbg(
    "USE_OPEN_SHEET_FALLBACK:",
    USE_OPEN_SHEET_FALLBACK,
    "(DESHABILITADO - Solo Supabase)"
  );
  fylCatalogDbg("SUPABASE_URL:", SUPABASE_URL);
  fylCatalogDbg(
    "SUPABASE_ANON_KEY:",
    SUPABASE_ANON_KEY ? "Configurada" : "NO CONFIGURADA"
  );

  // 2. Verificar cliente de Supabase
  fylCatalogDbg("\n2. 🗄️ CLIENTE SUPABASE:");
  fylCatalogDbg("Cliente disponible:", supabase ? "SÍ" : "NO");
  fylCatalogDbg(
    "Estado de conexión:",
    supabase ? "Inicializado" : "No inicializado"
  );

  // 3. Verificar funciones disponibles
  fylCatalogDbg("\n3. 🔧 FUNCIONES DISPONIBLES:");
  fylCatalogDbg("cargarCategoria:", typeof window.cargarCategoria);
  fylCatalogDbg("cambiarCategoria:", typeof window.cambiarCategoria);
  fylCatalogDbg("downloadImage:", typeof window.downloadImage);

  // 4. Verificar estado del catálogo
  fylCatalogDbg("\n4. 🎯 ESTADO DEL CATÁLOGO:");
  const catalogo = document.getElementById("catalogo");
  const loader = document.getElementById("loader");
  fylCatalogDbg("Elemento catálogo:", catalogo ? "Encontrado" : "NO ENCONTRADO");
  fylCatalogDbg("Elemento loader:", loader ? "Encontrado" : "NO ENCONTRADO");
  fylCatalogDbg(
    "Contenido del catálogo:",
    catalogo?.innerHTML?.substring(0, 100) + "..."
  );

  fylCatalogDbg("\n================================================");
  fylCatalogDbg("🔍 DIAGNÓSTICO COMPLETADO");
}

// Inicialización
async function inicializarCatalogo() {
  window.__FYL_BOOT_SUPPRESS_ROUTE = true;
  globalThis.markBootStage?.("catalog.init.start");
  try {
    fylCatalogDbg("🚀 Inicializando catálogo con Supabase...");

    // Inicializar Supabase
    const supabaseInicializado = await inicializarSupabase();
    globalThis.markBootStage?.("catalog.supabase.verify", {
      ok: !!supabaseInicializado,
    });

    if (!supabaseInicializado) {
      console.error("❌ No se pudo inicializar Supabase. El catálogo no funcionará correctamente.");
      const fail = globalThis.__FYL_SUPABASE_INIT_FAIL__ || {};
      const code = fail.code || "unknown";
      const hint = fail.hint
        ? String(fail.hint).replace(/</g, "&lt;").replace(/>/g, "&gt;")
        : "";
      const cont = document.getElementById("catalogo");
      if (cont) {
        cont.innerHTML = `
        <div class="error-message" style="text-align: center; padding: 40px; color: #666; background: #f8f9fa; border-radius: 8px; margin: 20px;">
          <h3>❌ No se pudo iniciar el catálogo</h3>
          <p style="margin-bottom: 12px;">No pudimos conectar con la base de datos. Esto no suele deberse a un archivo en tu teléfono.</p>
          ${
            hint
              ? `<p style="color:#555;font-size:14px;margin:12px 0;"><strong>Detalle:</strong> ${hint}</p>`
              : ""
          }
          <p style="font-size:12px;color:#888;margin-bottom:8px;">Código: <code>${code}</code></p>
          <ul style="text-align: left; margin: 20px 0; max-width: 600px; margin-left: auto; margin-right: auto; font-size: 14px;">
            <li>Proba <strong>Recargar</strong>, usar <strong>otra red</strong> (Wi‑Fi o datos) o una <strong>ventana privada</strong> (especialmente en Safari/iPhone).</li>
            <li>En el sitio publicado debe existir <code>/config.prod.js</code> (deploy con variables de entorno). Si falta, el servidor puede devolver HTML en su lugar.</li>
            <li>Si sos desarrollador en tu PC: entonces sí podés usar <code>scripts/config.local.js</code> como override.</li>
            <li>En consola buscá mensajes <code>[FYL boot]</code>, <code>[FYL config]</code> y <code>[FYL supabase]</code>. Con <code>?debug_boot=1</code> en la URL ves un panel de diagnóstico.</li>
          </ul>
          <button onclick="location.reload()" style="background: #CD844D; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 15px;">Reintentar</button>
        </div>
      `;
      }
      globalThis.markBootStage?.("catalog.aborted", { reason: "supabase_verify_failed" });
      hideCatalogBootOverlay();
      return;
    }

    // Ejecutar diagnóstico
    ejecutarDiagnostico();

    try {
    // La conectividad ya fue validada en inicializarSupabase(); evitamos sonda duplicada aquí.
    globalThis.markBootStage?.("catalog.view.probe.skipped", {
      reason: "already_validated_in_supabase_init",
    });
    
    // Inicializar eventos del modal
    initGridEvents();
    initModalEvents();
    initEscClose();
    initTagToSearch();
    
    // Resolver categoría inicial por ?tab=, ?banner=, ?similares=1&articulo=&talle= o #/coleccion/fyl-originals
    // NO pisar hash si ya viene seteado (deep link a colección)
    const urlParams = new URLSearchParams(window.location.search);
    const tabSlug = getTabFromURL();
    const bannerParam = urlParams.get('banner');
    const similaresParam = urlParams.get('similares');
    const articuloParam = urlParams.get('articulo');
    const talleParam = urlParams.get('talle');
    const isCollectionFYL = location.hash === "#/coleccion/fyl-originals";
    let categoriaInicial;
    let similaresFirstTag = null; // tag para filtrar cuando viene de "Ver similares"

    fylCatalogDbg(`🔍 URL actual: ${window.location.href}`);
    fylCatalogDbg(`🔍 Tab slug desde URL: ${tabSlug || '(ninguno)'}`);
    fylCatalogDbg(`🔍 Banner param desde URL: ${bannerParam || '(ninguno)'}`);

    // "Ver similares": obtener tags del producto para filtrar por similares
    if (similaresParam === '1' && articuloParam && articuloParam.trim()) {
      try {
        const { data: productoData } = await supabase
          .from("catalog_public_view")
          .select("Filtro1, Filtro2, Filtro3")
          .eq("Articulo", articuloParam.trim())
          .maybeSingle();
        if (productoData) {
          const tags = [];
          if (productoData.Filtro1) tags.push(productoData.Filtro1);
          if (productoData.Filtro2) tags.push(productoData.Filtro2);
          if (productoData.Filtro3) tags.push(productoData.Filtro3);
          if (tags.length > 0) similaresFirstTag = tags[0];
        }
      } catch (e) {
        console.warn("⚠️ No se pudieron obtener tags del producto para similares:", e?.message || e);
      }
    }

    // Si hay parámetro banner, cargar productos de "Otros" filtrados por ese tag
    if (bannerParam) {
      const bannerTag = bannerParam.trim().toLowerCase();
      fylCatalogDbg(`📋 Detectado parámetro banner: "${bannerTag}"`);
      
      // Verificar si es un tag de "Otros" (buscar en Filtro1, Filtro2, Filtro3)
      try {
        const { data: otrosTags, error: tagsError } = await supabase
          .from("catalog_public_view")
          .select("Filtro1, Filtro2, Filtro3")
          .eq("Categoria", "Otros");
        
        if (!tagsError && otrosTags && otrosTags.length > 0) {
          // Recolectar todos los tags únicos de todos los filtros
          const allTags = new Set();
          otrosTags.forEach(item => {
            if (item.Filtro1) allTags.add(item.Filtro1.trim().toLowerCase());
            if (item.Filtro2) allTags.add(item.Filtro2.trim().toLowerCase());
            if (item.Filtro3) {
              item.Filtro3.split(',').forEach(tag => {
                const trimmedTag = tag.trim().toLowerCase();
                if (trimmedTag) allTags.add(trimmedTag);
              });
            }
          });
          
          const uniqueTags = Array.from(allTags);
          fylCatalogDbg(`📋 Tags únicos encontrados en "Otros":`, uniqueTags);
          
          // Buscar el tag que coincida
          const matchingTag = uniqueTags.find(tag => 
            tag === bannerTag || 
            tag.replace(/\s+/g, '-') === bannerTag ||
            tag.replace(/\s+/g, '') === bannerTag
          );
          
          if (matchingTag) {
            // Usar el tag como categoría (el sistema ya lo maneja en cargarDesdeSupabase)
            categoriaInicial = matchingTag.charAt(0).toUpperCase() + matchingTag.slice(1);
            fylCatalogDbg(`✅ Cargando productos de "Otros" con tag: ${matchingTag}`);
            fylCatalogDbg(`🎯 Tag seleccionado: "${matchingTag}" -> categoriaInicial: "${categoriaInicial}"`);
          } else {
            categoriaInicial = "all";
            fylCatalogDbg(`⚠️ Tag no encontrado en "Otros", usando "all" (Inicio)`);
            fylCatalogDbg(`📋 Tags disponibles:`, uniqueTags);
            fylCatalogDbg(`🔍 Tag buscado: "${bannerTag}"`);
          }
        } else {
          categoriaInicial = "all";
        }
      } catch (error) {
        console.error("❌ Error verificando tags de Otros:", error);
        categoriaInicial = "all";
      }
    } else if (tabSlug) {
      const categoria = slugToCategoria(tabSlug);
      if (categoria) {
        categoriaInicial = categoria;
        fylCatalogDbg(`✅ Categoría encontrada desde slug: ${categoria}`);
      } else {
        // Slug inválido, usar "Inicio" (all)
        categoriaInicial = "all";
        fylCatalogDbg(`⚠️ Slug inválido, usando "all" (Inicio)`);
      }
    } else {
      // No hay tab ni banner en URL, usar "Inicio" por defecto
      categoriaInicial = "all";
      fylCatalogDbg(`🏠 No hay tab/banner en URL, usando "all" (Inicio) por defecto`);
    }
    
    // Si el hash apunta a colección FYL, NO cargar Home (el router en como-comprar.js lo maneja)
    if (isCollectionFYL) {
      fylCatalogDbg(`📂 Deep link a colección FYL detectado: no cargar categoría inicial`);
      // Saltar cargarCategoria; applyHashRoute (como-comprar) aplicará filterBySupplierFYL
    } else if (similaresParam === '1' && articuloParam?.trim()) {
      if (similaresFirstTag) {
        fylCatalogDbg(`📋 Ver similares: filtrando por tag "${similaresFirstTag}"`);
        await applyTagFilterAndRender(similaresFirstTag, { pushHash: false });
      } else {
        fylCatalogDbg(`📋 Ver similares: sin tags del producto, cargando Inicio`);
        await cargarCategoria('all');
      }
      if (talleParam && typeof window.applySizeFilterFromURL === 'function') {
        setTimeout(() => window.applySizeFilterFromURL(talleParam), 200);
      }
    } else {
      const tagMatch = (location.hash || '').match(/^#\/tag\/(.+)$/);
      if (tagMatch) {
        const tagValue = decodeURIComponent(tagMatch[1]);
        fylCatalogDbg(`📋 Deep link a filtro por tag: "${tagValue}"`);
        await applyTagFilterAndRender(tagValue, { pushHash: false });
      } else {
        fylCatalogDbg(`📦 Cargando categoría inicial: ${categoriaInicial}`);
        await cargarCategoria(categoriaInicial);
      }
    }

    globalThis.markBootStage?.("catalog.first_load.done", {
      isCollectionFYL,
      categoriaInicial: categoriaInicial ?? null,
    });
    
    if (isCollectionFYL) {
      window.__CATALOG_READY__ = true;
      const collHeader = document.getElementById("collection-header");
      const alreadyShown = collHeader && !collHeader.classList.contains("is-hidden");
      window.__FYL_BOOT_SUPPRESS_ROUTE = false;
      if (!alreadyShown && typeof window.applyHashRoute === "function") {
        await window.applyHashRoute();
      }
    }
    
    // Si estamos filtrando por banner, ocultar el banner dinámico para evitar redundancia
    if (bannerParam) {
      if (typeof window.hideCustomBanner === "function") {
        window.hideCustomBanner();
      }
    }
    
    // Actualizar botón activo en menú desktop (si existe)
    document.querySelectorAll(".menu button").forEach((btn) => {
      btn.classList.remove("active");
      if (categoriaInicial === "all") {
        // En "Inicio", no activar ningún botón del menú desktop
        return;
      }
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
    
    // Activar botón "Inicio" en quick actions si no hay categoría específica
    // Usar setTimeout para asegurar que los quick actions ya se renderizaron
    if (categoriaInicial === "all") {
      setTimeout(() => {
        const inicioBtn = document.getElementById("quick-action-inicio");
        if (inicioBtn) {
          // Remover active de todos primero
          document.querySelectorAll(".quick-action-btn").forEach((btn) => {
            btn.classList.remove("active");
          });
          inicioBtn.classList.add("active");
        }
      }, 100);
    }
    
    // Actualizar URL con tab (sin sku, solo para restaurar UI)
    if (tabSlug) {
      updateURL({ tab: categoriaInicial, sku: undefined }, { mode: 'replace' });
    } else if (categoriaInicial === "all") {
      // Limpiar URL para que muestre la vista de Inicio
      updateURL({ tab: '', sku: undefined }, { mode: 'replace' });
    }
    
    // Inicializar tab slug para popstate (usar slug actual de URL o convertir categoría)
    ultimoTabSlug = tabSlug || null;
    
    // Ahora inicializar modal desde URL (skuIndex ya está construido)
    // SKU manda - siempre abre modal si existe
    await inicializarModalDesdeURL();

    // Resolver botones auxiliares en background para no retrasar el arranque inicial.
    setTimeout(async () => {
      try {
        const btnNovedades = document.getElementById("btn-novedades");
        if (btnNovedades && !(await existeNovedades())) {
          btnNovedades.style.display = "none";
        }

        // Mostrar/ocultar y priorizar botón de ofertas en menú desktop.
        const btnOfertas = document.getElementById("btn-ofertas");
        if (btnOfertas) {
          const hayOfertas = await existeOfertas();
          if (!hayOfertas) {
            btnOfertas.style.display = "none";
          } else {
            btnOfertas.style.display = "";
            const menuDesktop = btnOfertas.parentElement;
            if (menuDesktop && menuDesktop.firstElementChild !== btnOfertas) {
              menuDesktop.insertBefore(btnOfertas, menuDesktop.firstElementChild);
            }
          }
        }
      } catch (err) {
        console.warn("⚠️ No se pudieron actualizar botones auxiliares:", err?.message || err);
      }
    }, 0);

    if (!isCollectionFYL) {
      window.__CATALOG_READY__ = true;
    }
    // En vista Inicio (#/), forzar scroll al inicio tras cargar para evitar que la página quede scrolleada
    if (categoriaInicial === "all" && (location.hash === "#/" || location.hash === "")) {
      setTimeout(() => {
        if (location.hash === "#/" || location.hash === "") {
          window.scrollTo(0, 0);
        }
      }, 350);
    }
    fylCatalogDbg("✅ Catálogo inicializado correctamente");
    fylCatalogDbg("📊 Fuente de datos: Supabase (ÚNICA FUENTE)");
    fylCatalogDbg("🚫 Google Sheets: DESHABILITADO");
    globalThis.markBootStage?.("catalog.ready", { ok: true });
    } catch (error) {
      console.error("❌ Error inicializando catálogo:", error);
      console.error("Stack:", error.stack);
      globalThis.markBootStage?.("catalog.init.error", {
        name: error?.name,
        message: error?.message ? String(error.message).slice(0, 240) : String(error),
      });
      const cont = document.getElementById("catalogo");
      const safeMsg = (error?.message ? String(error.message) : String(error))
        .slice(0, 220)
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      if (cont && !cont.querySelector(".error-message")) {
        cont.innerHTML = `
          <div class="error-message" style="text-align:center;padding:40px 20px;color:#666;background:#f8f9fa;border-radius:8px;margin:20px;">
            <h3>No se pudo completar la carga</h3>
            <p style="color:#c0392b;font-weight:bold;margin:12px 0;">${safeMsg}</p>
            <p style="font-size:14px;">Si estás en el celular, probá recargar o cambiar entre Wi‑Fi y datos.</p>
            <button type="button" onclick="location.reload()" style="background:#CD844D;color:#fff;border:none;padding:10px 20px;border-radius:5px;margin-top:16px;cursor:pointer;">Reintentar</button>
          </div>`;
      }
    }
  } finally {
    window.__FYL_BOOT_SUPPRESS_ROUTE = false;
    hideCatalogBootOverlay();
    globalThis.markBootStage?.("catalog.boot.finished");
  }
}

// Ejecutar inicialización cuando el DOM esté listo o si ya está listo
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", inicializarCatalogo);
} else {
  // El DOM ya está listo, ejecutar inmediatamente
  inicializarCatalogo();
}

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
      mensajeArticulo: producto.articulo,
      mensajeTalle: producto.talle,
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
        fylCatalogDbg("Modal de alternativas cerrado");
      },
    });
  } catch (error) {
    console.error("❌ Error mostrando alternativas:", error);
    alert(
      `Este producto no tiene stock en el talle ${producto.talle}. Por favor selecciona otro talle.`
    );
  }
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenizeSearchText(value) {
  return normalizeSearchText(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function getMaxTypoDistance(tokenLength) {
  if (tokenLength >= 8) return 2;
  if (tokenLength >= 5) return 1;
  return 0;
}

function levenshteinDistanceBounded(a, b, maxDistance) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    for (let j = 0; j <= b.length; j++) {
      prev[j] = curr[j];
    }
  }

  return prev[b.length];
}

function hasApproximateTokenMatch(searchToken, candidateText) {
  if (!searchToken || !candidateText) return false;
  if (candidateText.includes(searchToken)) return true;

  const maxDistance = getMaxTypoDistance(searchToken.length);
  if (maxDistance === 0) return false;

  const candidateTokens = candidateText.split(/[^a-z0-9]+/);
  for (const token of candidateTokens) {
    if (!token) continue;
    if (Math.abs(token.length - searchToken.length) > maxDistance) continue;

    const distance = levenshteinDistanceBounded(searchToken, token, maxDistance);
    if (distance <= maxDistance) return true;
  }

  return false;
}

function matchesSearchWithTolerance(searchTerm, searchableText) {
  if (!searchTerm) return true;
  if (!searchableText) return false;

  if (searchableText.includes(searchTerm)) return true;

  const searchTokens = tokenizeSearchText(searchTerm);
  if (searchTokens.length === 0) return false;

  return searchTokens.every((token) =>
    hasApproximateTokenMatch(token, searchableText)
  );
}

function scoreTextMatch(searchTerm, searchableText) {
  if (!searchTerm || !searchableText) return 0;

  if (searchableText === searchTerm) return 100;
  if (searchableText.startsWith(searchTerm)) return 70;
  if (searchableText.includes(searchTerm)) return 40;
  if (matchesSearchWithTolerance(searchTerm, searchableText)) return 25;

  return 0;
}

function scoreTokenMatch(searchTerm, searchableText) {
  if (!searchTerm || !searchableText) return 0;

  const tokens = tokenizeSearchText(searchableText);
  if (tokens.length === 0) return scoreTextMatch(searchTerm, searchableText);

  if (tokens.includes(searchTerm)) return 100;
  if (tokens.some((token) => token.startsWith(searchTerm))) return 70;
  if (tokens.some((token) => token.includes(searchTerm))) return 40;
  if (tokens.some((token) => hasApproximateTokenMatch(searchTerm, token))) return 25;

  return 0;
}

function getSearchRelevanceScore(producto, searchTerm) {
  const art = normalizeSearchText(producto.Articulo || "");
  const descripcion = normalizeSearchText(producto.Descripcion || "");
  const nombre = normalizeSearchText((producto.name || producto.Articulo) || "");
  const filtros = [
    normalizeSearchText(producto.Filtro1 || ""),
    normalizeSearchText(producto.Filtro2 || ""),
    normalizeSearchText(producto.Filtro3 || "")
  ].join(" ");

  const exactScore = Math.max(
    scoreTokenMatch(searchTerm, art),
    scoreTokenMatch(searchTerm, nombre)
  );
  const startsScore = Math.max(
    scoreTextMatch(searchTerm, art),
    scoreTextMatch(searchTerm, nombre)
  );
  const descriptionScore = scoreTextMatch(searchTerm, descripcion);
  const tagScore = scoreTextMatch(searchTerm, filtros) > 0 ? 10 : 0;

  return Math.max(exactScore, startsScore) + Math.min(descriptionScore, 40) + tagScore;
}

function normalizeCatalogCategoryName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function mapProductToCatalogCategory(producto) {
  const categoria = normalizeCatalogCategoryName(producto?.Categoria);
  const filtro1 = normalizeCatalogCategoryName(producto?.Filtro1);

  if (categoria === "calzado") return "Calzado";
  if (categoria === "ropa") return "Ropa";
  if (categoria === "lenceria") return "Lenceria";
  if (categoria === "marroquineria") return "Marroquineria";

  if (categoria === "otros") {
    if (filtro1 === "lenceria") return "Lenceria";
    if (filtro1 === "marroquineria") return "Marroquineria";
  }

  return null;
}

function inferSearchCategoryFromProducts(productos) {
  if (!Array.isArray(productos) || productos.length === 0) return null;

  const counts = new Map();
  productos.forEach((producto) => {
    const mapped = mapProductToCatalogCategory(producto);
    if (!mapped) return;
    counts.set(mapped, (counts.get(mapped) || 0) + 1);
  });

  if (counts.size === 0) return null;

  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 1) return ranked[0][0];

  // Si una categoría domina claramente, usarla automáticamente.
  if (ranked[0][1] >= ranked[1][1] * 2) return ranked[0][0];

  return null;
}

// Función para buscar productos en todos los productos pendientes
async function buscarProductosEnTodos(term) {
  if (!term || term.trim() === '') {
    window.__fylSearchDerivedCategory = null;
    setCatalogLoadMode("paged");
    // Si no hay término, restaurar vista paginada normal y mostrar banners
    const cont = document.getElementById("catalogo");
    if (cont) {
      cont.innerHTML = "";
      productosRenderizados = 0;
      const firstChunkRendered = await renderizarProductosPagina(
        productosPendientes,
        cont,
        offersCardsPendientes,
        0,
        PRODUCTOS_INICIALES
      );
      productosRenderizados = Number(firstChunkRendered) || 0;
      configurarEventos();
      mostrarBotonVerMas();
      if (categoriaActual === 'all') {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const paralelos = [];
        if (typeof window.loadAndShowFYLBanner === 'function') paralelos.push(window.loadAndShowFYLBanner());
        if (
          fylPendingHomeCustomBanner &&
          typeof window.loadAndShowCustomBanner === 'function'
        ) {
          fylPendingHomeCustomBanner = false;
          paralelos.push(window.loadAndShowCustomBanner());
        } else {
          fylPendingHomeCustomBanner = false;
        }
        if (typeof window.loadBanner === 'function') paralelos.push(window.loadBanner());
        await Promise.all(paralelos);
        if (typeof window.showPromotionalBanner === 'function') window.showPromotionalBanner();
        syncInfoBannerVisibility();
      }
    }
    refreshCatalogFilterBar();
    fylCatalogTrackViewItemList("category:" + (typeof categoriaActual !== "undefined" ? categoriaActual : "all"), productosPendientes, "category_grid");
    return;
  }

  const termLower = normalizeSearchText(term.trim());
  setCatalogLoadMode("full");
  teardownCatalogAutoloadObserver();
  const cont = document.getElementById("catalogo");
  if (!cont || !productosPendientes || productosPendientes.length === 0) {
    return;
  }

  // Filtrar y rankear productos por relevancia
  const productosRankeados = productosPendientes.map((producto) => {
    const art = normalizeSearchText(producto.Articulo || "");
    const descripcion = normalizeSearchText(producto.Descripcion || "");
    const nombre = normalizeSearchText((producto.name || producto.Articulo) || "");
    const filtros = [
      normalizeSearchText(producto.Filtro1 || ""),
      normalizeSearchText(producto.Filtro2 || ""),
      normalizeSearchText(producto.Filtro3 || "")
    ].join(" ");

    const isMatch = (
      matchesSearchWithTolerance(termLower, art) ||
      matchesSearchWithTolerance(termLower, descripcion) ||
      matchesSearchWithTolerance(termLower, nombre) ||
      matchesSearchWithTolerance(termLower, filtros)
    );
    if (!isMatch) return null;

    return {
      producto,
      score: getSearchRelevanceScore(producto, termLower),
    };
  }).filter(Boolean);

  productosRankeados.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return parseFecha(b.producto.FechaIngreso) - parseFecha(a.producto.FechaIngreso);
  });

  const productosFiltrados = productosRankeados.map((item) => item.producto);
  window.__fylSearchDerivedCategory = inferSearchCategoryFromProducts(productosFiltrados);

  // Limpiar contenedor y ocultar banners cuando hay filtro de búsqueda
  cont.innerHTML = "";
  if (typeof window.hideFYLOriginalsBanner === 'function') window.hideFYLOriginalsBanner();
  if (typeof window.hideCustomBanner === 'function') window.hideCustomBanner();
  if (typeof window.hidePromotionalBanner === 'function') window.hidePromotionalBanner();
  document.getElementById("info-banner-top-container")?.classList.add("is-hidden");
  if (productosFiltrados.length > 0) {
    await renderizarProductosPagina(productosFiltrados, cont, [], 0, null, { skipBanner: true });
    configurarEventos();
  } else {
    cont.insertAdjacentHTML('beforeend', '<div class="no-results" style="text-align: center; padding: 2rem; color: #666;">No se encontraron productos</div>');
  }
  initTagFilterClearDelegation();
  refreshCatalogFilterBar();
  fylCatalogTrackViewItemList("search:" + termLower, productosFiltrados, "search_results");
}

// Exportar funciones globales
window.cargarCategoria = cargarCategoria;
window.cambiarCategoria = cambiarCategoria;
window.cargarDesdeSupabase = cargarDesdeSupabase;
window.downloadImage = downloadImage;
window.downloadImageFromUrl = downloadImageFromUrl;
window.shareImageUrl = shareImageUrl;
window.existeNovedades = existeNovedades;
window.existeOfertas = existeOfertas;
window.parseFecha = parseFecha;
window.cloudinaryOptimized = cloudinaryOptimized;
window.getImgThumb = getImgThumb;
window.getImgFull = getImgFull;
window.mostrarAlternativasParaTalleSinStock = mostrarAlternativasParaTalleSinStock;
window.cerrarModal = cerrarModal;
window.abrirModalPorSKU = abrirModalPorSKU;
window.abrirPdpPorSkuIfPossible = abrirPdpPorSkuIfPossible;
window.abrirModalConResultado = abrirModalConResultado;
window.enrichProductsWithStock = enrichProductsWithStock;
window.formatPrice = formatPrice;
window.formatARS = formatARS;
window.buscarProductosEnTodos = buscarProductosEnTodos;
window.refreshCatalogFilterBar = refreshCatalogFilterBar;
window.clearAllCatalogFilters = clearAllCatalogFilters;
window.showCatalogBootOverlay = showCatalogBootOverlay;
window.hideCatalogBootOverlay = hideCatalogBootOverlay;
window.renderizarProductosPagina = renderizarProductosPagina;
window.configurarEventos = configurarEventos;
window.mainImageFallback = mainImageFallback;

// Exponer productosPendientes para acceso desde otros módulos (solo lectura)
Object.defineProperty(window, 'productosPendientes', {
  get: function() { return productosPendientes; },
  enumerable: true,
  configurable: false
});