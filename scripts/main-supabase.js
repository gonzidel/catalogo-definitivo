// scripts/main-supabase.js - Versión que prioriza Supabase con fallback a Google Sheets
// Esta versión carga productos desde Supabase primero, y si falla, usa Google Sheets

import {
  SUPABASE_URL as CONFIG_SUPABASE_URL,
  SUPABASE_ANON_KEY as CONFIG_SUPABASE_ANON_KEY,
  USE_SUPABASE as CONFIG_USE_SUPABASE,
  USE_OPEN_SHEET_FALLBACK as CONFIG_USE_OPEN_SHEET_FALLBACK,
  configReady,
} from "./config.js";
import { supabase as supabaseClient } from "./supabase-client.js?v=m260527";
import { normalizeSize } from "./utils/size-normalizer.js";
import { fylAnalytics } from "./analytics.js";
import { formatARS as formatARSValue, parseARSNumber } from "./utils/price.js";
import { createScreenScope } from "./net/screen-scope.js";
import {
  wrapSupabase,
  createAbortScope,
  FYL_ERROR_KIND,
  classifyError,
  isPostgrestSchemaColumnError,
} from "./net/fyl-fetch.js?v=m260527";
import {
  showFylErrorState,
  hideFylErrorState,
  renderFylInlineError,
  showFylToastError,
  isFylOfflineDeepCheck,
  watchFylConnectivity,
} from "./fyl-error-state.js";
import { getCatalogAvailableSource } from "./catalog-source.js";
import { enrichCatalogRowsWithDetallesSimilitud } from "./commercial-tags.js";
import { fylPerf } from "./fyl-perf.js";
import {
  canonicalTagKey,
  groupedProductMatchesAnyCommercialTag,
  groupedProductMatchesCommercialTag,
  mergeProductRowCommercialTags,
  mergeProductRowFilterTags,
  parseTagSelectorValues,
  productRowMatchesAnyCommercialTag,
  productRowMatchesCommercialTag,
} from "./tag-normalize.js";
import {
  buildTagComboAnalyticsKey,
  buildTagsHash,
  dedupeTagsByCanonical,
  navigateToTagsHash,
  parseHashTags,
  trackTagFilterConversion,
  trackTagsFilterOpen,
} from "./tag-routing.js";
import { fylScheduleIdle } from "./fyl-scheduler.js";

await configReady;

function fylIsCuratedBannerEnabled() {
  return typeof window !== "undefined" && window.FYL_CURATED_BANNER_V1 === true;
}

async function fylEnsureCuratedBannerModule() {
  if (!fylIsCuratedBannerEnabled()) return false;
  try {
    const ready = window.__fylCuratedBannerReady;
    if (ready && typeof ready.then === "function") {
      const ok = await ready;
      if (ok === false) return false;
    }
  } catch (_) {
    return false;
  }
  return typeof window.loadAndShowCuratedBanner === "function";
}

function fylParseHashBannerSlug(hash) {
  if (typeof window.parseHashBannerSlug === "function") {
    return window.parseHashBannerSlug(hash);
  }
  const h = hash || (typeof location !== "undefined" ? location.hash : "") || "";
  const match = h.match(/^#\/banner\/([^/?#]+)$/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim().toLowerCase();
  } catch {
    return String(match[1] || "").trim().toLowerCase();
  }
}

async function fylLoadHomeProductBanner(options = {}) {
  if (fylIsCuratedBannerEnabled()) {
    if (!(await fylEnsureCuratedBannerModule())) return;
    if (typeof window.loadAndShowCuratedBanner === "function") {
      return window.loadAndShowCuratedBanner({
        preferInline: options.preferInline,
        waitForInline: options.waitForInline,
      });
    }
    return;
  }
  if (typeof window.loadAndShowCustomBanner === "function") {
    return window.loadAndShowCustomBanner();
  }
}

function fylHideProductBanner() {
  if (fylIsCuratedBannerEnabled()) {
    if (typeof window.destroyCuratedBanner === "function") {
      window.destroyCuratedBanner();
    }
    return;
  }
  if (typeof window.hideCustomBanner === "function") {
    window.hideCustomBanner();
  }
}

/** Sin DetallesSimilitud hasta migración 219 en prod — bridge en commercial-tags.js */
const CATALOG_PUBLIC_SELECT = '"Categoria", "Articulo", "Descripcion", "Color", "Numeracion", "FechaIngreso", "FechaPublicacion", "Mostrar", "Oferta", "Precio", "Imagen Principal", "Imagen 1", "Imagen 2", "Imagen 3", "Filtro1", "Filtro2", "Filtro3", "OfertaActiva", "PrecioOferta", "PromoActiva", "OfferCampaignId", "OfferImageUrl", "OfferTitle", "ColorHex", "ColorDisplayNumber", "SupplierCode"';

function resolveCatalogFailurePreset(error, offline) {
  if (isPostgrestSchemaColumnError(error)) return "catalog";
  const kind = error?.kind || classifyError(error);
  if (offline || kind === FYL_ERROR_KIND.NETWORK) return "offline";
  return "catalog";
}

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

function trackMetaCustom(eventName, payload = {}) {
  if (!eventName) return;
  const send = () => {
    if (typeof fbq === "function") {
      fbq("trackCustom", eventName, payload);
      return true;
    }
    return false;
  };
  if (send()) return;
  setTimeout(() => {
    send();
  }, 300);
}

let _lastPdpEntryKey = "";
let _lastPdpEntryTs = 0;

function getPdpSkuFromLocation() {
  const hash = String(location.hash || "");
  const hashMatch = hash.match(/^#\/pdp\/(.+)$/);
  if (hashMatch?.[1]) {
    try {
      return decodeURIComponent(hashMatch[1]).trim();
    } catch (_e) {
      return String(hashMatch[1] || "").trim();
    }
  }
  return String(new URLSearchParams(location.search).get("sku") || "").trim();
}

function resolvePdpEntrySource(sku, pushState) {
  if (pushState) return "internal_navigation";
  const requestedSku = getPdpSkuFromLocation();
  if (requestedSku && requestedSku === String(sku || "").trim()) return "deep_link";
  return "restore_or_programmatic";
}

function trackPdpEntry(producto, sku, { pushState = true } = {}) {
  const safeSku = String(sku || "").trim();
  if (!safeSku) return;
  const source = resolvePdpEntrySource(safeSku, pushState);
  const articulo = String(producto?.Articulo || producto?.Descripcion || "").trim();
  const dedupeKey = `${safeSku}|${source}`;
  const now = Date.now();
  if (dedupeKey === _lastPdpEntryKey && now - _lastPdpEntryTs < 1200) return;
  _lastPdpEntryKey = dedupeKey;
  _lastPdpEntryTs = now;

  try {
    if (fylAnalytics.isReady()) {
      fylAnalytics.event("pdp_entry", {
        sku: safeSku,
        articulo,
        source,
      });
    }
  } catch (_e) {}

  trackMetaCustom("PdpEntry", {
    content_ids: [safeSku],
    content_type: "product",
    articulo,
    source,
  });
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
let searchIndex = []; // Índice textual derivado de productosPendientes
let searchRenderSeq = 0;
let productosRenderizados = 0; // Cantidad de productos ya renderizados
let offersCardsPendientes = []; // Ofertas pendientes de renderizar
/** Tras insertar el banner destacado inline (4.ª card en Inicio), se dispara carga al finalizar el render. */
let fylPendingHomeCustomBanner = false;
let isLoadingMore = false; // Flag para evitar múltiples cargas simultáneas
const PRODUCTOS_INICIALES = 14; // Cantidad de productos en la primera carga
const PRODUCTOS_POR_PAGINA = 14; // Cantidad de productos a cargar por página con el botón

/** Ancho Cloudinary para cards del grid (mobile <=430px: w_400, desktop: w_600). */
function fylCardImageWidth() {
  return typeof window !== "undefined" && window.innerWidth <= 430 ? 400 : 600;
}
/** Primera página de datos en boot (resto en background para cat "all"). */
const CATALOG_BOOT_INITIAL_ROWS = 120;
let _lcpPreloadUrl = "";
let _lazyImageObserver = null;
const CATALOGO_AUTOLOAD_SCROLL = true;
const CATALOGO_AUTOLOAD_ROOT_MARGIN_PX = 900;
const CATALOGO_AUTOLOAD_FALLBACK_THRESHOLD_PX = 900;
let catalogoLoadMode = "paged"; // paged | full
let catalogoAutoloadObserver = null;
let catalogoAutoloadSentinel = null;
let catalogoAutoloadFallbackEnabled = false;

function setProductosPendientes(nextProductos) {
  productosPendientes = Array.isArray(nextProductos) ? nextProductos : [];
  rebuildSearchIndex();
}

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

// Guard para que fyl-catalog-boot-done se emita exactamente una vez por carga
// de página, aunque hideCatalogBootOverlay sea llamado por el scope (first paint)
// y luego de nuevo por el finally de inicializarCatalogo como safety net.
let _bootDoneDispatched = false;
/** Solo transiciones internas (showCatalogBootOverlay); cold load = 0. */
const CATALOG_BOOT_MIN_VISIBLE_MS = 380;
const CATALOG_BOOT_SPINNER_DELAY_MS = 1500;
let _bootSpinnerTimeoutId = null;
const _catalogBootShownAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function fylEnsureCatalogContainer() {
  const catalogo = document.getElementById("catalogo");
  if (!catalogo) return null;
  let grid = document.getElementById("catalog-container");
  if (!grid) {
    grid = document.createElement("div");
    grid.id = "catalog-container";
    catalogo.appendChild(grid);
  }
  return grid;
}

/** Grid donde se pintan skeletons y cards (siempre #catalog-container). */
function fylGetCatalogRenderRoot() {
  return fylEnsureCatalogContainer();
}

function scheduleCatalogBootSpinner() {
  if (_bootSpinnerTimeoutId != null) {
    clearTimeout(_bootSpinnerTimeoutId);
    _bootSpinnerTimeoutId = null;
  }
  const el = document.getElementById("catalog-boot-overlay");
  if (!el || el.classList.contains("catalog-boot-overlay--hidden")) return;
  _bootSpinnerTimeoutId = setTimeout(() => {
    _bootSpinnerTimeoutId = null;
    const ov = document.getElementById("catalog-boot-overlay");
    if (!ov || ov.classList.contains("catalog-boot-overlay--hidden")) return;
    ov.classList.add("catalog-boot-overlay--visible");
    ov.setAttribute("aria-busy", "true");
    ov.setAttribute("aria-hidden", "false");
  }, CATALOG_BOOT_SPINNER_DELAY_MS);
}

function clearCatalogBootSpinnerSchedule() {
  if (_bootSpinnerTimeoutId != null) {
    clearTimeout(_bootSpinnerTimeoutId);
    _bootSpinnerTimeoutId = null;
  }
  const el = document.getElementById("catalog-boot-overlay");
  if (el) {
    el.classList.remove("catalog-boot-overlay--visible");
    el.setAttribute("aria-busy", "false");
    el.setAttribute("aria-hidden", "true");
  }
}

/** Oculta el overlay de arranque (index2) y restaura scroll del body. */
function hideCatalogBootOverlay() {
  clearCatalogBootSpinnerSchedule();
  const minVisibleMs =
    typeof window !== "undefined" && window.__FYL_BOOT_SUPPRESS_ROUTE === true
      ? 0
      : CATALOG_BOOT_MIN_VISIBLE_MS;
  const now =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const visibleFor = now - _catalogBootShownAt;
  if (visibleFor < minVisibleMs) {
    setTimeout(hideCatalogBootOverlay, Math.ceil(minVisibleMs - visibleFor));
    return;
  }

  const el = document.getElementById("catalog-boot-overlay");
  if (el) {
    el.classList.remove("catalog-boot-overlay--visible");
    el.classList.add("catalog-boot-overlay--hidden");
    el.setAttribute("aria-busy", "false");
    el.setAttribute("aria-hidden", "true");
    el.style.display = "none";
  }
  document.body.classList.remove("catalog-boot-active");
  if (!_bootDoneDispatched) {
    _bootDoneDispatched = true;
    window.dispatchEvent(new CustomEvent("fyl-catalog-boot-done"));
  }
}

/**
 * Scope del catálogo: gestiona el estado "usable" de /index.html.
 *
 * shouldRun: solo actúa durante el boot inicial (__FYL_BOOT_SUPPRESS_ROUTE = true).
 * Durante navegaciones internas (cambiarCategoria, quick-actions) el overlay se
 * gestiona por showCatalogBootOverlay/hideCatalogBootOverlay directamente; el
 * scope detecta esto con el guard y es no-op para el callback, pero emite el
 * evento screen:first-paint para observabilidad.
 *
 * onFirstPaint: oculta el overlay del boot (si sigue visible).
 * onReady: safety net — si el overlay sigue visible al final del init completo,
 * lo cierra. Esto cubre edge cases donde cargarCategoria no llegó al punto usable.
 */
const catalogScope = createScreenScope("catalog", {
  shouldRun: () =>
    typeof window !== "undefined" &&
    window.__FYL_BOOT_SUPPRESS_ROUTE === true,
  onFirstPaint: () => {
    const el = document.getElementById("catalog-boot-overlay");
    if (!el || el.classList.contains("catalog-boot-overlay--hidden")) return;
    hideCatalogBootOverlay();
  },
  onReady: () => {
    // Safety net: el finally de inicializarCatalogo llama markReady; si el
    // overlay sigue visible por algún edge case, cerrarlo aquí como último recurso.
    const el = document.getElementById("catalog-boot-overlay");
    if (el && !el.classList.contains("catalog-boot-overlay--hidden")) {
      hideCatalogBootOverlay();
    }
  },
});

/**
 * Delega al catalogScope. Mantiene el nombre original para compatibilidad
 * con todos los call sites existentes en cargarCategoria, filterByOffer, etc.
 *
 * Solo actúa durante boot (__FYL_BOOT_SUPPRESS_ROUTE = true); idempotente.
 */
function releaseBootOverlayOnFirstPaint(reason) {
  catalogScope.markFirstPaint(reason || "first_chunk_rendered");
}

/** Transiciones pesadas: spinner visible de inmediato (no aplica al cold load inicial). */
function showCatalogBootOverlay() {
  clearCatalogBootSpinnerSchedule();
  const el = document.getElementById("catalog-boot-overlay");
  if (el) {
    el.style.display = "";
    el.classList.remove("catalog-boot-overlay--hidden");
    el.classList.add("catalog-boot-overlay--visible");
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

/** ISO timestamptz desde admin/publications (last_published_at). */
function parseFechaPublicacion(value) {
  if (value == null || value === "") return 0;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

/** Orden catálogo: lo más reciente entre publicación (admin) y alta del producto activo. */
function fylCatalogRecencyMs(item) {
  const pub = parseFechaPublicacion(item?.FechaPublicacion);
  const created = parseFecha(item?.FechaIngreso || "").getTime();
  return Math.max(pub, created);
}

function compareCatalogRecency(a, b) {
  return fylCatalogRecencyMs(b) - fylCatalogRecencyMs(a);
}

function isCatalogItemRecent(item, sinceDate) {
  return fylCatalogRecencyMs(item) >= sinceDate.getTime();
}

function cloudinaryOptimized(url, w) {
  if (!url || typeof url !== "string") return url || "";
  url = url.startsWith("http://") ? url.replace("http://", "https://") : url;
  return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${w}/`);
}

function getPdpHeroWidth() {
  return typeof window !== "undefined" && window.innerWidth <= 430 ? 800 : 1200;
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
  // Priorizar color principal de la card (DetalleColor ya viene ordenado).
  (producto.DetalleColor || []).forEach((d) => (d.images || []).forEach(add));
  add(producto.VariantePrincipal);
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

/** Texto seguro para insertar en HTML (badge, spans). */
function fylEscapeHtmlText(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Identificador único del header del PDP: "Art. {codigo}" si hay artículo;
 * si no, una sola línea corta (sin descripción larga en el header).
 */
function formatPdpHeaderIdentifier(producto) {
  const articulo = String(producto?.Articulo || "").trim();
  if (articulo) {
    return {
      innerHtml: `Art. ${fylEscapeHtmlText(articulo)}`,
      plainAlt: articulo,
    };
  }
  const raw = String(producto?.Nombre || producto?.name || "")
    .trim()
    .replace(/\s+/g, " ");
  const max = 28;
  let compact = raw;
  if (compact.length > max) {
    compact = `${compact.slice(0, max - 1)}\u2026`;
  }
  const display = compact || "Producto";
  return {
    innerHtml: fylEscapeHtmlText(display),
    plainAlt: display,
  };
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

    if (!supabase || typeof supabase.from !== "function") {
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

async function fetchAllCatalogPublicRows(createQuery, pageSize = 1000) {
  const allRows = [];
  let from = 0;
  let catalogRequests = 0;
  let nextPagePromise = null;

  while (true) {
    catalogRequests += 1;
    const to = from + pageSize - 1;
    const pagePromise = nextPagePromise || createQuery().range(from, to);
    nextPagePromise = null;
    const { data, error } = await pagePromise;
    if (error) return { data: null, error };

    const rows = Array.isArray(data) ? data : [];
    allRows.push(...rows);

    if (rows.length < pageSize) break;
    from += pageSize;
    const nextTo = from + pageSize - 1;
    nextPagePromise = createQuery().range(from, nextTo);
  }

  fylPerf("catalog_requests", {
    requests: catalogRequests,
    rows: allRows.length,
    source: getCatalogAvailableSource(),
  });

  const enriched = await enrichCatalogRowsWithDetallesSimilitud(allRows);
  return { data: enriched, error: null };
}

function fylFilterMostrarCatalogRows(items = []) {
  return items.filter((i) => {
    const mostrar = i.Mostrar;
    return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
  });
}

function fylCatalogRowVariantKey(row) {
  return `${String(row?.Articulo || "").trim()}|${getCatalogColorKey(row?.Color)}|${String(row?.Numeracion || "").trim()}`;
}

function fylMergeCatalogRowsByVariantKey(rows = []) {
  const merged = new Map();
  rows.forEach((row) => {
    if (!row) return;
    merged.set(fylCatalogRowVariantKey(row), row);
  });
  return Array.from(merged.values());
}

/** Todas las filas de variantes para los artículos del boot (evita cards con un solo color). */
async function fylFetchCatalogRowsForArticulos(createQuery, articulos = []) {
  const unique = [...new Set(articulos.map((a) => String(a || "").trim()).filter(Boolean))];
  if (!unique.length) return [];
  const BATCH = 80;
  const allRows = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const { data, error } = await createQuery().in("Articulo", chunk);
    if (error) {
      console.warn("[FYL] Error completando variantes boot:", error.message || error);
      continue;
    }
    if (Array.isArray(data)) allRows.push(...data);
  }
  return allRows;
}

/** Primera página acotada para boot Home (PERF-001 / HI-2). */
async function fetchCatalogPublicRowsBoot(createQuery, limit = CATALOG_BOOT_INITIAL_ROWS) {
  const cap = Math.max(1, Number(limit) || CATALOG_BOOT_INITIAL_ROWS);
  const { data, error } = await createQuery().range(0, cap - 1);
  if (error) return { data: null, error };
  const bootRows = Array.isArray(data) ? data : [];
  let rows = bootRows;
  const articulosBoot = bootRows.map((row) => row?.Articulo).filter(Boolean);
  if (articulosBoot.length > 0) {
    const completeRows = await fylFetchCatalogRowsForArticulos(createQuery, articulosBoot);
    if (completeRows.length > 0) {
      rows = fylMergeCatalogRowsByVariantKey([...bootRows, ...completeRows]);
    }
  }
  const enriched = await enrichCatalogRowsWithDetallesSimilitud(rows);
  fylPerf("catalog_boot_rows", {
    rows: enriched.length,
    limit: cap,
    articulos: new Set(articulosBoot.map((a) => String(a).trim())).size,
  });
  return { data: enriched, error: null };
}

let _catalogFullFetchInflight = null;

function scheduleFullCatalogBackgroundFetch(createCatalogQuery) {
  if (_catalogFullFetchInflight) return;
  _catalogFullFetchInflight = true;
  fylScheduleIdle(() => {
    fetchAllCatalogPublicRows(createCatalogQuery)
      .then(({ data, error }) => {
        if (error || !data?.length) return;
        fylApplyFullCatalogBackground(data);
      })
      .catch((err) => {
        console.warn("[FYL] Full catalog background fetch:", err?.message || err);
      })
      .finally(() => {
        _catalogFullFetchInflight = null;
      });
  }, 400);
}

function fylPatchRenderedCardsAfterFullCatalog(productosCompletos = []) {
  if (!Array.isArray(productosCompletos) || productosCompletos.length === 0) return;
  if (typeof getCurrentSearchTerm === "function" && getCurrentSearchTerm()) return;
  if (catalogoLoadMode !== "paged") return;

  const byArticulo = new Map();
  productosCompletos.forEach((producto) => {
    const art = String(producto?.Articulo || "").trim();
    if (art) byArticulo.set(art, producto);
  });

  const toEnrich = [];
  let patched = 0;
  document.querySelectorAll(".card.producto[data-articulo]").forEach((card) => {
    const articulo = String(card.dataset.articulo || "").trim();
    if (!articulo) return;
    const producto = byArticulo.get(articulo);
    if (!producto) return;

    productosActualesMap.set(articulo, producto);
    const colorsEl = card.querySelector(".colors");
    if (colorsEl) {
      colorsEl.innerHTML = renderizarColores(producto);
      patched += 1;
    }
    toEnrich.push(producto);
  });

  if (typeof window !== "undefined") {
    window.productosActualesMap = productosActualesMap;
  }

  if (patched > 0) {
    fylCatalogDbg(`🎨 Cards actualizadas con variantes completas: ${patched}`);
    fylScheduleIdle(async () => {
      await enrichProductsWithStock(toEnrich);
      refreshSizeBadgesForProducts(toEnrich);
      fylRebuildCatalogSizeIndex();
    }, 120);
    mostrarBotonVerMas();
  }
}

function fylApplyFullCatalogBackground(rawRows) {
  if (categoriaActual !== "all") return;
  const filtered = fylFilterMostrarCatalogRows(rawRows);
  window.__allCatalogRawRows = filtered;
  const sorted = filtered.slice().sort(compareCatalogRecency);
  let productosOrdenados = agruparProductos(sorted);
  productosOrdenados = intercalarProductosPorCategoria(productosOrdenados);
  setProductosPendientes(productosOrdenados);
  window.__allProductsCache = productosOrdenados;
  fylRebuildCatalogSizeIndex();
  fylPatchRenderedCardsAfterFullCatalog(productosOrdenados);
  window.__FYL_CATALOG_FULL_READY = true;
  try {
    window.dispatchEvent(
      new CustomEvent("fyl-catalog-full-ready", { detail: { count: productosOrdenados.length } })
    );
  } catch (_e) {}
  fylCatalogDbg(`📦 Catálogo completo en background: ${productosOrdenados.length} productos`);
}

/** Carga full-catalog (all / Novedades / Ofertas). */
async function cargarDesdeSupabaseAllLike(cat, createCatalogQuery) {
  fylCatalogDbg(`📦 Cargando todas las categorías para: ${cat}`);

  if (cat === "all") {
    const { data: bootData, error: bootError } = await fetchCatalogPublicRowsBoot(createCatalogQuery);
    if (bootError) {
      console.error("❌ Error en consulta boot:", bootError);
      throw bootError;
    }
    fylCatalogDbg(`📊 Registros boot (home): ${bootData?.length || 0}`);
    const items = fylFilterMostrarCatalogRows(bootData || []);
    scheduleFullCatalogBackgroundFetch(createCatalogQuery);
    return items;
  }

  const { data, error } = await fetchAllCatalogPublicRows(createCatalogQuery);
  if (error) {
    console.error("❌ Error en consulta:", error);
    throw error;
  }

  fylCatalogDbg(`📊 Total de registros obtenidos: ${data?.length || 0}`);
  let items = data || [];

  if (cat === "Novedades") {
    const hoy = new Date();
    const hace7 = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 7);
    items = items.filter((i) => {
      const mostrar = i.Mostrar;
      const mostrarOk =
        mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
      return mostrarOk && isCatalogItemRecent(i, hace7);
    });
    fylCatalogDbg(`🆕 Productos de novedades (últimos 7 días): ${items.length}`);
  }

  if (cat === "Ofertas") {
    items = items.filter((i) => {
      const mostrar = i.Mostrar;
      const oferta = i.Oferta;
      const mostrarOk =
        mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
      const ofertaOk =
        oferta === "TRUE" || oferta === true || oferta === "true" || oferta === 1;
      return mostrarOk && ofertaOk;
    });
    fylCatalogDbg(`🔥 Productos en ofertas: ${items.length}`);
  }

  if (cat === "all") {
    items = fylFilterMostrarCatalogRows(items);
    fylCatalogDbg(`📦 Productos en "all" (filtrados por Mostrar): ${items.length}`);
    window.__allCatalogRawRows = items;
  }

  return items;
}

// Cargar datos desde Supabase
async function cargarDesdeSupabase(cat) {
  if (!supabase) {
    throw new Error("Cliente de Supabase no disponible");
  }

  try {
    fylCatalogDbg(`🗄️ Cargando desde Supabase: ${cat}`);

    // [PERF] Query de validacion de categorias eliminada (era solo diagnostico).

    const createCatalogQuery = () => supabase.from(getCatalogAvailableSource()).select(CATALOG_PUBLIC_SELECT);

    if (cat === "all") {
      if (window.__FYL_CATALOG_ALL_INFLIGHT) {
        return window.__FYL_CATALOG_ALL_INFLIGHT;
      }
      window.__FYL_CATALOG_ALL_INFLIGHT = cargarDesdeSupabaseAllLike(cat, createCatalogQuery).finally(
        () => {
          window.__FYL_CATALOG_ALL_INFLIGHT = null;
        }
      );
      return window.__FYL_CATALOG_ALL_INFLIGHT;
    }

    if (cat === "Novedades" || cat === "Ofertas") {
      return cargarDesdeSupabaseAllLike(cat, createCatalogQuery);
    }

    {
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
            .from(getCatalogAvailableSource())
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
        const { data: todosProductos, error: errorProductos } = await fetchAllCatalogPublicRows(createCatalogQuery);
        
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
        
        const tagFilters = parseTagSelectorValues(tagValue);
        const dataFiltrada = (todosProductos || []).filter((i) => {
          const match =
            tagFilters.length <= 1
              ? productRowMatchesCommercialTag(i, tagFilters[0])
              : productRowMatchesAnyCommercialTag(i, tagFilters);
          if (match) {
            fylCatalogDbg(
              `✓ INCLUIDO: ${i.Articulo} - detalles:"${i.DetallesSimilitud || ""}" F3 técnico:"${i.Filtro3 || ""}"`
            );
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
      const { data, error } = await fetchAllCatalogPublicRows(() => createCatalogQuery().eq("Categoria", cat));
      
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
        (i) => isCatalogItemRecent(i, hace7)
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
    .sort(compareCatalogRecency);
  
  const ropa = productos
    .filter(p => (p.Categoria || "").trim().toLowerCase() === "ropa")
    .sort(compareCatalogRecency);
  
  const otrosMarroquineria = productos
    .filter(p => 
      (p.Categoria || "").trim().toLowerCase() === "otros" && 
      (p.Filtro1 || "").trim().toLowerCase() === "marroquineria"
    )
    .sort(compareCatalogRecency);
  
  const otrosLenceria = productos
    .filter(p => 
      (p.Categoria || "").trim().toLowerCase() === "otros" && 
      (p.Filtro1 || "").trim().toLowerCase() === "lenceria"
    )
    .sort(compareCatalogRecency);
  
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
function getCatalogColorKey(color) {
  return String(color || "Sin color").trim().toLowerCase();
}

function mergeCatalogColorDetail(target, source) {
  if (!target || !source) return;

  (source.talles || []).forEach((talle) => {
    if (talle && !target.talles.includes(talle)) target.talles.push(talle);
  });

  (source.images || []).forEach((image) => {
    if (image && !target.images.includes(image)) target.images.push(image);
  });

  target.OfertaActiva = target.OfertaActiva || source.OfertaActiva;
  if (!target.PrecioOferta && source.PrecioOferta) target.PrecioOferta = source.PrecioOferta;
  if (!target.PromoActiva && source.PromoActiva) target.PromoActiva = source.PromoActiva;
}

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
        FechaPublicacion: i.FechaPublicacion || "",
        Categoria: i.Categoria || "",
        Filtro1: i.Filtro1 || "",
        Filtro2: i.Filtro2 || "",
        Filtro3: i.Filtro3 || "",
        DetallesSimilitud: i.DetallesSimilitud || "",
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

    const detalleColor = {
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
    };

    const colorKey = getCatalogColorKey(detalleColor.color);
    const colorExistente = acc[art].DetalleColor.find((detalle) => getCatalogColorKey(detalle.color) === colorKey);
    if (colorExistente) {
      mergeCatalogColorDetail(colorExistente, detalleColor);
    } else {
      acc[art].DetalleColor.push(detalleColor);
    }
    mergeProductRowFilterTags(acc[art], i);
    mergeProductRowCommercialTags(acc[art], i);
    const incomingPub = parseFechaPublicacion(i.FechaPublicacion);
    const currentPub = parseFechaPublicacion(acc[art].FechaPublicacion);
    if (incomingPub > currentPub) {
      acc[art].FechaPublicacion = i.FechaPublicacion;
    }
    const incomingIngreso = parseFecha(i.FechaIngreso || "").getTime();
    const currentIngreso = parseFecha(acc[art].FechaIngreso || "").getTime();
    if (incomingIngreso > currentIngreso) {
      acc[art].FechaIngreso = i.FechaIngreso;
    }
    return acc;
  }, {});
  return Object.values(grupos);
}

const CATALOG_BOOT_SKELETON_COUNT = 4;

function renderCatalogSkeletonCards(count = CATALOG_BOOT_SKELETON_COUNT) {
  const grid = fylGetCatalogRenderRoot();
  if (!grid) return;
  const safeCount = Math.max(4, Math.min(8, Number(count) || CATALOG_BOOT_SKELETON_COUNT));
  grid.innerHTML = Array.from(
    { length: safeCount },
    () => `
    <article class="card producto card--skeleton" aria-hidden="true">
      <div class="main-image-wrapper skeleton-shimmer"></div>
      <div class="card-info">
        <div class="skeleton-line skeleton-shimmer" style="width:60%;height:14px"></div>
        <div class="skeleton-line skeleton-shimmer" style="width:40%;height:18px;margin-top:6px"></div>
      </div>
    </article>
  `
  ).join("");
}

// Función principal de carga de categoría
async function cargarCategoria(cat) {
  fylCatalogDbg("🔄 Cargando categoría:", cat);

  fylOfferCardsLoadGen += 1;

  // Actualizar categoría actual
  categoriaActual = cat || 'all';
  // Sincronizar con el filtro de talles (misma categoría que ve el usuario; incluye Lencería/Otros por tag)
  window.__fylCategoriaActual = categoriaActual;

  const loader = document.getElementById("loader");
  const cont = fylGetCatalogRenderRoot();
  if (!cont) return;

  // Ocultar indicador de scroll infinito al cambiar de categoría
  ocultarIndicadorCarga();
  
  // Ocultar indicador de carga inferior al cambiar de categoría
  ocultarIndicadorCargaInferior();
  indicadorCargaActivo = false;

  if (loader) loader.classList.toggle("show", cat !== "all");
  renderCatalogSkeletonCards();
  
  // Ocultar banner dinámico si no estamos en inicio (solo se muestra en index puro)
  if (cat !== "all") {
    fylHideProductBanner();
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
      // UI ya es usable (mensaje "sin productos"): liberamos el overlay del boot.
      releaseBootOverlayOnFirstPaint("empty_category");
      return;
    }

    // Ordenar por fecha de publicación (admin) o ingreso
    data.sort(compareCatalogRecency);

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

    // PERF-009: ofertas se cargan tras el primer paint (fylLoadOfferCardsAfterFirstPaint).

    // Ordenar productos por fecha de publicación (admin) o ingreso
    let productosOrdenados = Object.values(grupos).sort(compareCatalogRecency);
    
    // Si es vista "all" (Inicio), aplicar intercalado de categorías
    if (cat === "all") {
      productosOrdenados = intercalarProductosPorCategoria(productosOrdenados);
    }
    
    // Almacenar todos los productos para paginación y recomendados PDP
    setProductosPendientes(productosOrdenados);
    window.__allProductsCache = productosOrdenados;
    productosRenderizados = 0;
    offersCardsPendientes = [];
    setCatalogLoadMode("paged");
    
    // Limpiar contenedor
    cont.innerHTML = "";
    syncHomeTopSlotState({ pending: cat === "all" });
    
    // Renderizar el primer bloque y conservar la cantidad real renderizada.
    const firstChunkRendered = await renderizarProductosPagina(
      productosPendientes,
      cont,
      [],
      0,
      PRODUCTOS_INICIALES,
      { deferEnrich: true }
    );
    productosRenderizados = Number(firstChunkRendered) || 0;

    // Primer paint listo: liberar el overlay del boot ahora mismo. Todo lo que
    // sigue (configurarEventos, FYL banner, banners auxiliares, modal desde URL,
    // lazy-load de imágenes) corre en background y no debe tapar la home.
    releaseBootOverlayOnFirstPaint("first_chunk_rendered");
    void fylLoadOfferCardsAfterFirstPaint(cat, cont);

    initCatalogCardDelegation();
    configurarEventos();
    
    // Mostrar botón "Ver más modelos" si hay más productos
    mostrarBotonVerMas();
    
    fylCatalogTrackViewItemList("category:" + (cat || "all"), productosPendientes, "category_grid");
    
    // Reiniciar verificación de carga de imágenes
    iniciarVerificacionCargaImagenes();

    if (cat === "all") {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const hashOk = location.hash !== "#/coleccion/fyl-originals";
      const hayBusquedaActiva = !!getCurrentSearchTerm();
      const hayFiltroActivo = !!document.querySelector('#filtroMenu input[type="checkbox"]:checked');
      const isBootingHome =
        typeof window !== "undefined" && window.__FYL_BOOT_SUPPRESS_ROUTE === true;

      const runHomeExtras = async ({ includeFylBanner = true } = {}) => {
        try {
          const hashHasTagFilter = parseHashTags(location.hash || "").length > 0;
          const hashHasBannerRoute = !!fylParseHashBannerSlug(location.hash || "");
          const paralelos = [];
          if (includeFylBanner && typeof window.loadAndShowFYLBanner === "function") {
            paralelos.push(Promise.resolve(window.loadAndShowFYLBanner()));
          }
          if (
            hashOk &&
            !hayBusquedaActiva &&
            !hayFiltroActivo &&
            !hashHasTagFilter &&
            !hashHasBannerRoute
          ) {
            if (fylIsCuratedBannerEnabled()) {
              fylPendingHomeCustomBanner = true;
            } else {
              fylPendingHomeCustomBanner = false;
              paralelos.push(Promise.resolve(fylLoadHomeProductBanner()));
            }
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
        } finally {
          // Siempre liberar pending aunque falle un extra; si no, el loader local queda visible (mobile).
          syncHomeTopSlotState({ pending: false });
        }
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
          } finally {
            syncHomeTopSlotState({ pending: false });
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
      syncHomeTopSlotState({ pending: false });
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

    void (async () => {
      let offline = false;
      try {
        offline = await isFylOfflineDeepCheck();
      } catch (_) {}
      const preset = resolveCatalogFailurePreset(error, offline);
      const retryCat = cat;
      showFylErrorState({
        preset,
        retry: () => {
          hideFylErrorState();
          void cargarCategoria(retryCat);
        },
      });
    })();
    releaseBootOverlayOnFirstPaint("category_error");
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
/** Evita insertar ofertas obsoletas si el usuario cambió de categoría durante el fetch. */
let fylOfferCardsLoadGen = 0;

function mapActiveOffersRpcToCards(offers) {
  return (offers || []).map((offer) => ({
    campaignId: offer.offer_campaign_id,
    imageUrl: offer.offer_image_url,
    title: offer.offer_title,
    productCount: offer.product_count,
    startDate: offer.start_date,
    endDate: offer.end_date,
  }));
}

function fylBindOfferCardListeners(container) {
  if (!container) return;
  container.querySelectorAll(".offer-card").forEach((card) => {
    if (card.dataset.listenerAdded) return;
    card.dataset.listenerAdded = "true";
    card.addEventListener("click", () => {
      const campaignId = card.dataset.offerCampaignId;
      if (campaignId) filterByOffer(campaignId);
    });
  });
}

/** PERF-009: RPC de ofertas después del primer paint (no bloquea LCP). */
async function fylLoadOfferCardsAfterFirstPaint(cat, container) {
  if (!supabase || !container) return;
  const gen = ++fylOfferCardsLoadGen;

  try {
    const { data: offers, error: offersError } = await supabase.rpc(
      "get_active_offers_with_images"
    );
    if (gen !== fylOfferCardsLoadGen) return;
    if (categoriaActual !== cat) return;
    if (offersError || !offers?.length) return;
    if (container.querySelector(".offer-card")) return;

    const offersCards = mapActiveOffersRpcToCards(offers);
    offersCardsPendientes = offersCards;
    fylCatalogDbg(`🔥 Ofertas post-paint: ${offersCards.length} campañas`);

    const tpl = document.createElement("template");
    tpl.innerHTML = offersCards.map((offer) => renderOfferCard(offer)).join("");
    container.insertBefore(tpl.content, container.firstChild);
    fylBindOfferCardListeners(container);
  } catch (error) {
    console.warn("Error obteniendo ofertas con imágenes (post-paint):", error);
  }
}

function renderOfferCard(offer) {
  const title = offer.title || 'Oferta Especial';
  const productCount = offer.productCount || 0;

  return `
    <div class="card offer-card" data-offer-campaign-id="${offer.campaignId}" style="cursor: pointer; border: 3px solid #ff9800; position: relative; overflow: hidden;">
      <div style="position: relative; width: 100%; padding-top: 100%; background: #fff;">
        <img src="${offer.imageUrl}" alt="${title}"
             width="400" height="400"
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
function fylIsCuratedBannerHashActive() {
  if (!fylIsCuratedBannerEnabled()) return false;
  return Boolean(fylParseHashBannerSlug(location.hash || ""));
}

function syncInfoBannerVisibility() {
  const el = document.getElementById("info-banner-top-container");
  if (!el) return;
  if (categoriaActual === "all" && !fylIsCuratedBannerHashActive()) {
    el.classList.remove("is-hidden");
  } else {
    el.classList.add("is-hidden");
  }
}
if (typeof window !== "undefined") window.syncInfoBannerVisibility = syncInfoBannerVisibility;

function syncHomeTopSlotState({ pending = false } = {}) {
  const slot = document.getElementById("home-top-dynamic-slot");
  if (!slot) return;
  const activeHome = categoriaActual === "all";
  const shouldShow = activeHome && pending;
  /* Reservar altura solo mientras carga; si no, queda un bloque vacío ~240px. */
  slot.classList.toggle("home-top-dynamic-slot--home", shouldShow);
  slot.classList.toggle("home-top-dynamic-slot--pending", shouldShow);
  const localLoader = document.getElementById("home-top-dynamic-loader");
  if (localLoader) {
    if (shouldShow) {
      localLoader.removeAttribute("hidden");
      localLoader.setAttribute("aria-hidden", "false");
      localLoader.setAttribute("aria-busy", "true");
    } else {
      localLoader.setAttribute("hidden", "");
      localLoader.setAttribute("aria-hidden", "true");
      localLoader.setAttribute("aria-busy", "false");
    }
  }
}

function fylPreloadLcpImage(url) {
  const href = String(url || "").trim();
  if (!href || href === _lcpPreloadUrl) return;
  _lcpPreloadUrl = href;
  let link = document.querySelector('link[data-fyl-lcp-preload="1"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.setAttribute("data-fyl-lcp-preload", "1");
    document.head.appendChild(link);
  }
  link.href = href;
}

const HOME_CUSTOM_BANNER_AFTER_PRODUCTS = 4;

function fylEnsureHomeCustomBannerSlot() {
  let slot = document.getElementById("home-custom-banner-slot");
  if (!slot) {
    slot = document.createElement("div");
    slot.id = "home-custom-banner-slot";
    slot.className = "home-custom-banner-slot";
    slot.hidden = true;
    slot.setAttribute("aria-hidden", "true");
  }
  return slot;
}

/** Banner editable en el grid del catálogo (tras la 4.ª card), no arriba de FYL Originals. */
function fylRepositionHomeCustomBannerInCatalog() {
  const catalogo = document.getElementById("catalogo");
  const slot = fylEnsureHomeCustomBannerSlot();
  if (!catalogo || !slot || categoriaActual !== "all") return;

  const productCards = catalogo.querySelectorAll(".card.producto");
  const anchorIndex = HOME_CUSTOM_BANNER_AFTER_PRODUCTS - 1;
  if (productCards.length > anchorIndex) {
    productCards[anchorIndex].after(slot);
    return;
  }
  if (productCards.length > 0) {
    productCards[productCards.length - 1].after(slot);
    return;
  }
  catalogo.appendChild(slot);
}

function fylMountHomeCustomBannerInSlot() {
  fylRepositionHomeCustomBannerInCatalog();
  const slot = fylEnsureHomeCustomBannerSlot();
  const bannerContainer = document.getElementById("custom-banner-container");
  if (!slot || !bannerContainer) return false;

  let wrapper = document.getElementById("custom-banner-wrapper");
  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id = "custom-banner-wrapper";
    wrapper.className = "custom-banner-wrapper";
    slot.appendChild(wrapper);
  }

  let inline = document.getElementById("custom-banner-container-inline");
  if (!inline) {
    inline = bannerContainer.cloneNode(true);
    inline.id = "custom-banner-container-inline";
    inline.style.display = "block";
    wrapper.appendChild(inline);
  }

  slot.hidden = false;
  slot.removeAttribute("hidden");
  slot.setAttribute("aria-hidden", "false");
  return true;
}

function fylScheduleHomeCustomBanner(options = {}) {
  const hayBusquedaActiva = !!document.getElementById("searchInput")?.value?.trim();
  const hayFiltroActivo = !!document.querySelector('#filtroMenu input[type="checkbox"]:checked');
  if (options.skipBanner || hayBusquedaActiva || hayFiltroActivo) return;
  if (location.hash === "#/coleccion/fyl-originals") return;
  if (categoriaActual !== "all") return;
  if (!(typeof window.loadAndShowCustomBanner === "function" || fylIsCuratedBannerEnabled())) return;

  fylMountHomeCustomBannerInSlot();
  fylPendingHomeCustomBanner = true;
  fylScheduleIdle(() => {
    Promise.resolve(
      fylLoadHomeProductBanner({ preferInline: true, waitForInline: false })
    ).catch((err) => {
      console.warn("[FYL Banner] Error cargando banner home:", err?.message || err);
    });
  }, 1500);
}

/** Tras cerrar el PDP: `destroyCuratedBanner` deja el slot/inline ocultos; volvemos a montar y recargar en Inicio. */
function fylTryRestoreHomeProductBannerAfterPdpClose() {
  if ((categoriaActual || "") !== "all") return;
  if (location.hash === "#/coleccion/fyl-originals") return;
  if (fylParseHashBannerSlug(location.hash || "")) return;
  if (parseHashTags(location.hash || "").length) return;
  const si = document.getElementById("searchInput");
  const sb = document.getElementById("search-bar-mobile");
  if ((si?.value || "").trim() || (sb?.value || "").trim()) return;
  if (document.querySelector('#filtroMenu input[type="checkbox"]:checked')) return;
  if (!(typeof window.loadAndShowCustomBanner === "function" || fylIsCuratedBannerEnabled())) return;

  fylRepositionHomeCustomBannerInCatalog();
  fylMountHomeCustomBannerInSlot();
  fylScheduleIdle(() => {
    Promise.resolve(
      fylLoadHomeProductBanner({ preferInline: true, waitForInline: false })
    ).catch((err) => {
      console.warn("[FYL Banner] Error restaurando banner tras PDP:", err?.message || err);
    });
  }, 200);
}

function buildProductCardHTML(producto, meta = {}) {
  const skuDefecto = meta.skuDefecto ?? obtenerSKUDefecto(producto);
  const cardImageWidth = meta.cardImageWidth ?? fylCardImageWidth();
  const cardImageHeight = Math.round((cardImageWidth * 5) / 4);
  const mainImageUrls = meta.mainImageUrls ?? getMainImageFallbackUrls(producto, cardImageWidth);
  const mainSrc =
    mainImageUrls[0] || cloudinaryOptimized(producto.VariantePrincipal, cardImageWidth);
  const fallbackUrls = mainImageUrls.slice(1);
  const fallbackUrlsAttr = fallbackUrls.length
    ? JSON.stringify(fallbackUrls).replace(/"/g, "&quot;")
    : "";
  const imageLoading = meta.imageLoading || "lazy";
  const imageFetchPriority = meta.imageFetchPriority || "";
  const articuloBadgeCode = String(producto.Articulo || "").trim();
  const catalogArtBadgeHtml = articuloBadgeCode
    ? `Art. ${fylEscapeHtmlText(articuloBadgeCode)}`
    : "";
  const deferSizeBadge = meta.deferSizeBadge === true;
  const sizeBadgeHtml = deferSizeBadge
    ? ""
    : obtenerSizeBadgeHTML(producto, producto.DetalleColor?.[0]?.color);

  return `
        <div class="card producto"
             data-articulo="${producto.Articulo || ""}"
             data-filtro1="${producto.Filtro1 || ""}"
             data-filtro2="${producto.Filtro2 || ""}"
             data-filtro3="${producto.Filtro3 || ""}"
             data-sku="${skuDefecto || ""}"
             data-name="${(producto.name || producto.Articulo || "").toLowerCase()}">
          <div class="main-image-wrapper">
            <img class="main-image" loading="${imageLoading}" decoding="async"${imageFetchPriority}
                 src="${mainSrc}"
                 alt="${producto.Articulo}"
                 width="${cardImageWidth}" height="${cardImageHeight}"
                 data-sku="${skuDefecto || ""}"
                 ${fallbackUrlsAttr ? `data-fallback-urls="${fallbackUrlsAttr}" onerror="window.mainImageFallback&&window.mainImageFallback(this)"` : ""}/>
            ${catalogArtBadgeHtml ? `<div class="product-name-badge product-art-badge">${catalogArtBadgeHtml}</div>` : ""}
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
              <div class="colors">${renderizarColores(producto)}</div>
            </div>
            <div class="card-footer-size" data-articulo="${producto.Articulo}" data-color-selected="${producto.DetalleColor?.[0]?.color || ""}">${sizeBadgeHtml}</div>
            ${window.__CATALOG_ONLY__ ? "" : `<button class="cart-icon-btn" 
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
}

function refreshSizeBadgesForProducts(productos = []) {
  productos.forEach((producto) => {
    const articulo = producto?.Articulo;
    if (!articulo) return;
    const card = document.querySelector(`.card.producto[data-articulo="${CSS.escape(articulo)}"]`);
    if (!card) return;
    const sizeContainer = card.querySelector(".card-footer-size");
    if (!sizeContainer) return;
    const color = sizeContainer.dataset.colorSelected || producto.DetalleColor?.[0]?.color || "";
    sizeContainer.innerHTML = obtenerSizeBadgeHTML(producto, color);
  });
}

function fylAfterCatalogChunkRendered({ startIndex = 0, firstLcpSrc = "" } = {}) {
  if (firstLcpSrc) fylPreloadLcpImage(firstLcpSrc);
  if (typeof window.construirMenuFiltros === "function") {
    window.construirMenuFiltros();
  }
  if (startIndex === 0 && categoriaActual === "all") {
    fylRepositionHomeCustomBannerInCatalog();
    fylScheduleHomeCustomBanner();
  }
}

// Función auxiliar para renderizar un conjunto de productos
// options.skipBanner: si true, no insertar el banner dinámico (solo debe mostrarse en index puro)
// options.deferEnrich: pintar antes y enriquecer stock en idle (PERF-001)
async function renderizarProductosPagina(productos, container, offersCards = [], startIndex = 0, count = null, options = {}) {
  if (productos.length === 0 && offersCards.length === 0) return 0;
  if (startIndex === 0) fylPendingHomeCustomBanner = false;
  
  // Enriquecer productos con stock (solo los que vamos a renderizar)
  const productosARenderizar = count !== null 
    ? productos.slice(startIndex, startIndex + count)
    : productos.slice(startIndex);
  
  const deferEnrich = options.deferEnrich === true;

  if (productosARenderizar.length > 0 && !deferEnrich) {
    await enrichProductsWithStock(productosARenderizar);
  }

  if (typeof options.shouldRender === "function" && !options.shouldRender()) {
    return 0;
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
  
  const cardImageWidth = fylCardImageWidth();
  const htmlParts = [];
  let productosRenderizadosEnEstaPagina = 0;
  let firstLcpSrc = "";

  allItems.forEach((item) => {
    if (item.type === "offer") {
      htmlParts.push(renderOfferCard(item.data));
      return;
    }
    const producto = item.data;
    productosRenderizadosEnEstaPagina++;
    const skuDefecto = obtenerSKUDefecto(producto);
    const mainImageUrls = getMainImageFallbackUrls(producto, cardImageWidth);
    const mainSrc =
      mainImageUrls[0] || cloudinaryOptimized(producto.VariantePrincipal, cardImageWidth);
    if (!firstLcpSrc && mainSrc) firstLcpSrc = mainSrc;

    const isFirstChunk = startIndex === 0;
    const isAboveFoldCard = isFirstChunk && productosRenderizadosEnEstaPagina <= 4;
    const imageLoading = isAboveFoldCard ? "eager" : "lazy";
    const imageFetchPriority = isAboveFoldCard ? ' fetchpriority="high"' : "";

    htmlParts.push(
      buildProductCardHTML(producto, {
        skuDefecto,
        cardImageWidth,
        mainImageUrls,
        imageLoading,
        imageFetchPriority,
        deferSizeBadge: deferEnrich,
      })
    );

    productosActualesMap.set(producto.Articulo, producto);
    if (typeof window !== "undefined") {
      window.productosActualesMap = productosActualesMap;
    }
  });

  if (htmlParts.length) {
    const tpl = document.createElement("template");
    tpl.innerHTML = htmlParts.join("");
    container.appendChild(tpl.content);
  }

  if (deferEnrich && productosARenderizar.length > 0) {
    const batch = productosARenderizar;
    fylScheduleIdle(async () => {
      await enrichProductsWithStock(batch);
      refreshSizeBadgesForProducts(batch);
      fylRebuildCatalogSizeIndex();
    }, 2200);
  } else if (productosARenderizar.length > 0) {
    fylRebuildCatalogSizeIndex();
  }

  if (startIndex === 0 || allItems.some((item) => item.type === "offer")) {
    fylBindOfferCardListeners(container);
  }

  fylBindLazyMainImageListeners(container);
  fylAfterCatalogChunkRendered({ startIndex, firstLcpSrc });

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
        <a href="https://wa.me/5493625172874" target="_blank" rel="noopener">WhatsApp</a>
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
  const productosOrdenados = productos.slice().sort(compareCatalogRecency);
  
  return await renderizarProductosPagina(productosOrdenados, container, offersCards, 0, null);
}

// Función para filtrar productos por oferta
async function filterByOffer(campaignId) {
  fylCatalogDbg('🔥 Filtrando productos por oferta:', campaignId);
  
  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");
  
  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";
  fylHideProductBanner();
  
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
    const productosOrdenados = Object.values(grupos).sort(compareCatalogRecency);
    
    // Almacenar todos los productos para paginación y recomendados PDP
    setProductosPendientes(productosOrdenados);
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
    
    initCatalogCardDelegation();
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
  fylHideProductBanner();
  
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
    productosFYL.sort(compareCatalogRecency);
    
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
          FechaPublicacion: i.FechaPublicacion || "",
          Filtro1: i.Filtro1 || "",
          Filtro2: i.Filtro2 || "",
          Filtro3: i.Filtro3 || "",
          OfertaActiva: false,
          PrecioOferta: '',
          PromoActiva: '',
          DetalleColor: [],
        };
      }

      const incomingPubFyl = parseFechaPublicacion(i.FechaPublicacion);
      const currentPubFyl = parseFechaPublicacion(acc[art].FechaPublicacion);
      if (incomingPubFyl > currentPubFyl) {
        acc[art].FechaPublicacion = i.FechaPublicacion;
      }
      const incomingIngresoFyl = parseFecha(i.FechaIngreso || "").getTime();
      const currentIngresoFyl = parseFecha(acc[art].FechaIngreso || "").getTime();
      if (incomingIngresoFyl > currentIngresoFyl) {
        acc[art].FechaIngreso = i.FechaIngreso;
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
    const productosOrdenados = Object.values(grupos).sort(compareCatalogRecency);
    
    // Almacenar todos los productos para paginación y recomendados PDP
    setProductosPendientes(productosOrdenados);
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
    
    initCatalogCardDelegation();
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
      return `<img loading="lazy" src="${thumb}" data-full="${full}" alt="Miniatura de producto" width="200" height="200" class="miniatura${isActive ? ' active' : ''}">`;
    })
    .join("");
}

/**
 * Obtiene la galería HTML y la URL de la imagen principal para el PDP.
 * Retorna { gal, mainImgUrl } donde mainImgUrl es la URL 1200px de la imagen a mostrar.
 * Fallback mainImgUrl: (1) full del color seleccionado, (2) primera full válida, (3) VariantePrincipal.
 *
 * IMPORTANTE: cada miniatura lleva data-color y data-color-norm con el color al
 * que pertenece. Esto habilita la sincronización "la imagen visible manda"
 * (syncPdpColorFromImage) desde thumbnails y lightbox. La iteración es por
 * DetalleColor (no flatMap) para preservar la relación imagen↔color.
 */
function obtenerGaleriaYImagenPrincipal(producto, colorSeleccionado) {
  const detalleColorSel = producto.DetalleColor?.find(d =>
    (d.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase()
  ) || producto.DetalleColor?.[0];
  const preferida = detalleColorSel?.images?.[0];

  let mainImgUrl = '';
  const parts = [];
  let activeMarked = false;
  let firstFull = '';

  (producto.DetalleColor || []).forEach((detalle) => {
    const colorName = detalle.color || '';
    const colorNorm = colorName.trim().toLowerCase();
    const colorAttr = colorName.replace(/"/g, '&quot;');
    (detalle.images || []).forEach((img) => {
      const thumb = getImgUrl(img, 200);
      if (!thumb) return;
      const pdpW = getPdpHeroWidth();
      const full = getImgUrl(img, pdpW);
      if (full && !firstFull) firstFull = full;

      const isActive = preferida
        ? (img === preferida && !activeMarked)
        : (!activeMarked);
      if (isActive) {
        activeMarked = true;
        if (full) mainImgUrl = full;
      }

      const altText = colorName ? `Miniatura ${colorAttr}` : 'Miniatura';
      parts.push(
        `<img loading="lazy" decoding="async" src="${thumb}" data-full="${full || thumb}" ` +
        `data-color="${colorAttr}" data-color-norm="${colorNorm}" ` +
        `alt="${altText}" class="miniatura pdp-thumb${isActive ? ' active' : ''}">`
      );
    });
  });

  if (!mainImgUrl) mainImgUrl = firstFull || getImgUrl(producto.VariantePrincipal || "", getPdpHeroWidth());
  return { gal: parts.join(''), mainImgUrl };
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
    const reservedBySizeMap = new Map(); // key: `${variant_id}_${normalizedSize}` -> reserved_qty

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

      const reservedPromise = supabase
        .rpc("rpc_get_variant_size_reserved", { p_variant_ids: allVariantIds })
        .then(({ data: reservedRows, error: reservedError }) => {
          if (reservedError) {
            console.warn("⚠️ Error obteniendo reservas por talle:", reservedError.message || reservedError);
            return;
          }
          (reservedRows || []).forEach((row) => {
            const normalizedSize = normalizeSize(row.size);
            if (!row?.variant_id || !normalizedSize) return;
            const key = `${row.variant_id}_${normalizedSize}`;
            const prev = reservedBySizeMap.get(key) || 0;
            reservedBySizeMap.set(key, prev + (Number(row.reserved_qty) || 0));
          });
        })
        .catch((e) => {
          console.warn("⚠️ Excepción obteniendo reservas por talle:", e);
        });

      await Promise.all([warehousePromise, sizesPromise, reservedPromise]);
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

          // Obtener stock por talle desde variant_size_warehouse_stock
          let stockGeneral = 0;
          let stockVentaPublico = 0;
          const sizeStockQty = variantSizesBySize.get(normalizedSize) || 0;

          if (isActive && generalWarehouseId && ventaPublicoWarehouseId) {
            const generalKey = `${variantId}_${normalizedSize}_${generalWarehouseId}`;
            const ventaPublicoKey = `${variantId}_${normalizedSize}_${ventaPublicoWarehouseId}`;

            stockGeneral = sizeStockMap.get(generalKey) || 0;
            stockVentaPublico = sizeStockMap.get(ventaPublicoKey) || 0;
          }

          const stockTotal = stockGeneral + stockVentaPublico;
          const hasTalleInVariantSizes = variantSizesBySize.has(normalizedSize);
          
          // IMPORTANTE: Calcular available correctamente
          // PRIORIDAD 1: Si el talle está en variant_sizes, usar el stock real (puede ser 0 para tachar)
          // PRIORIDAD 2: Si tiene stock en warehouses, usar ese stock
          // PRIORIDAD 3: Si no está en variant_sizes pero está en catalog_public_view.Numeracion, usar null (inconsistencia)
          let available;
          const reservedBySize = isActive
            ? (reservedBySizeMap.get(`${variantId}_${normalizedSize}`) || 0)
            : 0;
          if (hasTalleInVariantSizes) {
            // El talle está en variant_sizes - usar el stock real (puede ser 0 para mostrar tachado)
            available = Math.max(0, stockTotal - reservedBySize);
          } else if (stockTotal > 0) {
            // Tiene stock en warehouses aunque no esté en variant_sizes (raro pero posible)
            available = Math.max(0, stockTotal - reservedBySize);
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
            available = Math.max(0, stockTotal - reservedBySize);
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
            reserved: available === null ? null : reservedBySize, // Reserva agregada por talle (no variante completa)
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

// ── PDP: AbortScope + scope de pantalla ──────────────────────────────────────
//
// Un único AbortScope para toda la vida de la pestaña: se recrea en cada
// apertura de modal y se aborta al cerrar o al abrir otro producto.
// Esto garantiza que los fetches lentos de "otro producto" no pisen el actual.
let pdpFetchAbortScope = null;

/**
 * Abre el modal del PDP inmediatamente con un skeleton (sin esperar red) y
 * devuelve un screen-scope para que el caller marque cuándo los datos reales
 * llegaron. Reemplaza el patrón "esperar fetch → abrir modal".
 *
 * @param {string} sku   SKU del producto a abrir (puede no estar en cache aún).
 * @param {object} [hint]  Datos parciales de la card para pre-poblar el skeleton
 *   con información visual más rica: { nombre?, imagen?, color? }
 * @returns {import('./net/screen-scope.js').ScreenScope}
 */
function _abrirModalConSkeleton(sku, hint = {}) {
  // Abortar cualquier fetch anterior del PDP y crear uno nuevo.
  if (pdpFetchAbortScope) pdpFetchAbortScope.abort("new_product_opened");
  pdpFetchAbortScope = createAbortScope();

  const modal    = document.getElementById("product-modal");
  const modalBody = document.getElementById("product-modal-body");
  if (!modal || !modalBody) return null;

  // SKU en dataset para que cerrarModal y otros helpers lo puedan leer.
  modal.dataset.sku = sku;
  modal.classList.add("active");
  document.body.classList.add("modal-open");
  if (typeof window.updateFloatingCartCta === "function") window.updateFloatingCartCta();

  // Render del skeleton con datos parciales de la card si están disponibles.
  modalBody.innerHTML = _renderPdpSkeleton(sku, hint);

  // Scroll al inicio del modal para que el skeleton sea visible.
  modalBody.scrollTop = 0;

  // Screen-scope del PDP: markFirstPaint = skeleton visible, markReady = datos reales.
  const scope = createScreenScope("pdp", {
    onFirstPaint({ reason }) {
      globalThis.markBootStage?.("pdp.skeleton_shown", { sku, reason });
    },
    onReady({ reason }) {
      globalThis.markBootStage?.("pdp.data_loaded", { sku, reason });
    },
  });
  scope.markFirstPaint("skeleton_shown");
  return scope;
}

/**
 * Genera el HTML del skeleton del PDP con la información parcial disponible
 * en la card (nombre, imagen optimizada, color). Reutiliza la animación
 * skeletonShimmer ya definida en styles.css.
 *
 * @param {string} sku
 * @param {{ nombre?: string, imagen?: string, color?: string }} hint
 * @returns {string}
 */
function _renderPdpSkeleton(sku, hint = {}) {
  const nombre = (hint.nombre || "").replace(/</g, "&lt;");
  const color  = (hint.color  || "").replace(/</g, "&lt;");
  const imgUrl = hint.imagen || "";

  const imagenHtml = imgUrl
    ? `<img src="${imgUrl.replace(/"/g, "&quot;")}" alt="" style="width:100%;aspect-ratio:4/5;object-fit:cover;border-radius:10px;display:block;" loading="eager" decoding="async" />`
    : `<div class="card-skeleton__image" style="width:100%;aspect-ratio:4/5;border-radius:10px;"></div>`;

  const tituloHtml = nombre
    ? `<div style="font-size:17px;font-weight:700;margin:10px 0 4px;color:#1a1a1a;">${nombre}${color ? ` <span style="font-weight:400;color:#666;">· ${color}</span>` : ""}</div>`
    : `<div class="card-skeleton__line card-skeleton__line--title" style="margin:10px 0 4px;"></div>`;

  return `
    <div style="padding:14px 14px 80px;" data-pdp-skeleton="${sku}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <button class="pdp-back product-modal-back" aria-label="Volver" style="background:none;border:none;font-size:22px;cursor:pointer;padding:4px 8px;">←</button>
        <div class="card-skeleton__line" style="width:60px;height:12px;"></div>
      </div>
      ${imagenHtml}
      ${tituloHtml}
      <div class="card-skeleton__line card-skeleton__line--meta" style="margin-bottom:8px;"></div>
      <div style="margin:14px 0 10px;display:flex;gap:8px;">
        <div class="card-skeleton__chip" style="width:56px;height:24px;border-radius:6px;"></div>
        <div class="card-skeleton__chip" style="width:56px;height:24px;border-radius:6px;"></div>
        <div class="card-skeleton__chip" style="width:56px;height:24px;border-radius:6px;"></div>
      </div>
      <div class="card-skeleton__line" style="width:100%;height:48px;border-radius:10px;margin-bottom:8px;"></div>
    </div>`;
}

/**
 * Muestra un estado de error dentro del modal abierto (sin cerrarlo).
 * Preserva el botón de cerrar para que el usuario pueda salir.
 *
 * @param {string} kind   FYL_ERROR_KIND
 * @param {string} [sku]  Para retry con el mismo SKU.
 */
function _renderPdpError(kind, sku) {
  const modalBody = document.getElementById("product-modal-body");
  if (!modalBody) return;

  const safeSku = sku ? String(sku).trim() : "";
  const retryPdp = () => {
    if (safeSku && typeof window._pdpRetry === "function") window._pdpRetry(safeSku);
  };

  if (kind === FYL_ERROR_KIND.PERMISSION) {
    renderFylInlineError(modalBody, {
      preset: "product",
      buttonLabel: "Cerrar",
      retry: () => {
        try {
          cerrarModal();
        } catch (_) {}
      },
    });
    return;
  }

  if (kind === FYL_ERROR_KIND.NETWORK) {
    renderFylInlineError(modalBody, {
      preset: "offline",
      retry: retryPdp,
    });
    return;
  }

  renderFylInlineError(modalBody, {
    preset: "api",
    retry: safeSku ? retryPdp : undefined,
  });
}

// Retry público: lo invoca el botón de "Reintentar" dentro del modal.
// Debounce simple: si ya hay un fetch en vuelo (pdpFetchAbortScope no abortado),
// el abort lo gestiona _abrirModalConSkeleton; la bandera evita que un doble
// click dispare dos aperturas de skeleton en el mismo tick.
let _pdpRetryInFlight = false;
window._pdpRetry = function(sku) {
  if (!sku || _pdpRetryInFlight) return;
  _pdpRetryInFlight = true;
  abrirPdpPorSkuIfPossible(sku, { pushState: false })
    .catch(() => {})
    .finally(() => { _pdpRetryInFlight = false; });
};

async function buscarPorSKUEnSupabase(sku, { signal } = {}) {
  if (!sku || !supabase) return null;
  
  try {
    // 1. Primero intentar buscar por SKU completo en variant_sizes (SKU con talle específico)
    const { data: sizeData, error: sizeError, kind: sizeKind, aborted: sizeAborted } = await wrapSupabase(
      () => supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty")
        .eq("sku", sku.trim())
        .limit(1)
        .maybeSingle(),
      { retries: 1, signal, label: "pdp.variant_sizes" }
    );
    if (sizeAborted) return null;
    if (sizeError && sizeKind !== FYL_ERROR_KIND.PERMISSION) {
      // Propagar el error clasificado para que el caller decida la UX.
      const err = Object.assign(new Error(sizeError.message || "pdp_fetch_failed"), { kind: sizeKind });
      throw err;
    }
    
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
      const { data: variantData, error: variantError, aborted: vAborted } = await wrapSupabase(
        () => supabase
          .from("product_variants")
          .select("id, color, product_id")
          .eq("sku", sku.trim())
          .eq("active", true)
          .limit(1)
          .maybeSingle(),
        { retries: 1, signal, label: "pdp.product_variants" }
      );
      if (vAborted) return null;
      if (variantError || !variantData) return null;
      
      variantId = variantData.id;
      
      // Si no hay talle específico, usar el primer talle disponible de la variante
      const { data: firstSize, error: firstSizeError, aborted: fsAborted } = await wrapSupabase(
        () => supabase
          .from("variant_sizes")
          .select("size, stock_qty")
          .eq("variant_id", variantId)
          .limit(1)
          .maybeSingle(),
        { signal, label: "pdp.first_size" }
      );
      if (fsAborted) return null;
      if (!firstSizeError && firstSize) {
        talle = normalizeSize(firstSize.size);
        sizeStockQty = firstSize.stock_qty || 0;
      }
    }
    
    if (!variantId) {
      return null;
    }
    
    // 3. Obtener información completa de la variante
    const { data: variantData, error: variantError, aborted: varAborted } = await wrapSupabase(
      () => supabase
        .from("product_variants")
        .select("id, color, product_id, products!inner(name, description)")
        .eq("id", variantId)
        .eq("active", true)
        .limit(1)
        .maybeSingle(),
      { retries: 1, signal, label: "pdp.variant_full" }
    );
    if (varAborted) return null;
    if (variantError || !variantData) return null;
    
    const variant = variantData;
    const productId = variant.product_id;
    const articulo = (variant.products?.name || '').trim();

    // 3b. Mismo shape que el catálogo: filas de la vista por artículo → agrupar + enrich (precio, colores, talles)
    if (articulo && supabase) {
      try {
        let catRows = null;
        const rCat = await wrapSupabase(
          () => supabase.from(getCatalogAvailableSource()).select(CATALOG_PUBLIC_SELECT).eq("Articulo", articulo),
          { retries: 1, signal, label: "pdp.catalog_view_exact" }
        );
        if (!rCat.aborted && !rCat.error && rCat.data?.length) {
          catRows = rCat.data;
        } else if (!rCat.aborted && !rCat.error) {
          const rCatI = await wrapSupabase(
            () => supabase.from(getCatalogAvailableSource()).select(CATALOG_PUBLIC_SELECT).ilike("Articulo", articulo),
            { signal, label: "pdp.catalog_view_ilike" }
          );
          if (!rCatI.aborted && !rCatI.error && rCatI.data?.length) catRows = rCatI.data;
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
        console.warn("⚠️ catalog_public_view por artículo (PDP deep link):", e);
      }
    }

    // 4. Obtener warehouses "general" y "venta-publico"
    const { data: warehouses } = await wrapSupabase(
      () => supabase
        .from("warehouses")
        .select("id, code")
        .in("code", ["general", "venta-publico"]),
      { signal, label: "pdp.warehouses" }
    );
    
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
    
    const stockTotal = stockGeneral + stockVentaPublico;
    let reservedBySize = 0;
    if (talle && variantId) {
      const { data: reservedRows, error: reservedError, aborted: reservedAborted } = await wrapSupabase(
        () => supabase.rpc("rpc_get_variant_size_reserved", { p_variant_ids: [variantId] }),
        { signal, label: "pdp.reserved_by_size" }
      );
      if (!reservedAborted && !reservedError && Array.isArray(reservedRows)) {
        const normalizedTalle = normalizeSize(talle);
        const row = reservedRows.find((r) => normalizeSize(r.size) === normalizedTalle);
        reservedBySize = Number(row?.reserved_qty || 0) || 0;
      }
    }
    const available = Math.max(0, stockTotal - reservedBySize);
    
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
    const { data: variantImages, error: imgError, aborted: imgAborted } = await wrapSupabase(
      () => supabase
        .from("variant_images")
        .select("url, secure_url")
        .eq("variant_id", variantId)
        .order("position", { ascending: true })
        .limit(1),
      { signal, label: "pdp.variant_images" }
    );
    if (imgAborted) return null;
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
          reserved: reservedBySize
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
    // Si el error ya viene con `kind` (lo asignamos en pasos 1-3), re-lanzar
    // para que el caller (abrirPdpPorSkuIfPossible) lo maneje con UX correcta.
    if (error?.kind) throw error;
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
  const prevState = history.state && typeof history.state === "object" ? history.state : {};
  const state = {
    ...prevState,
    tab: url.searchParams.get('tab'),
    sku: url.searchParams.get('sku')
  };
  if (mode === 'push') {
    history.pushState(state, '', url);
  } else {
    history.replaceState(state, '', url);
  }
}

function runWithViewTransition(callback) {
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function") {
    return Promise.resolve(callback());
  }
  const transition = document.startViewTransition(() => callback());
  // View Transitions API expone 3 promises rechazables (ready, updateCallbackDone, finished).
  // Chrome reporta cada una como unhandledrejection por separado: hay que silenciar las 3
  // para evitar AbortError ("Transition was skipped") y TimeoutError ("Transition was aborted
  // because of timeout in DOM update") cuando el usuario toca rápido o la animación se interrumpe.
  try { transition.ready && transition.ready.catch(() => {}); } catch (_) {}
  try { transition.updateCallbackDone && transition.updateCallbackDone.catch(() => {}); } catch (_) {}
  return transition.finished.catch(() => {});
}

function persistCurrentScrollInHistory() {
  const currentState = history.state && typeof history.state === "object" ? history.state : {};
  history.replaceState(
    {
      ...currentState,
      fyScrollY: window.scrollY || 0,
    },
    "",
    window.location.href
  );
}

function restoreScrollFromHistoryState() {
  const y = Number(history.state?.fyScrollY);
  if (!Number.isFinite(y) || y < 0) return;
  requestAnimationFrame(() => {
    window.scrollTo({ top: y, behavior: "auto" });
  });
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
  persistCurrentScrollInHistory();
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
  let productosOrdenados = gruposArray.sort(compareCatalogRecency);
  productosOrdenados = intercalarProductosPorCategoria(productosOrdenados);
  window.__allProductsCache = productosOrdenados;
  return productosOrdenados;
}

/** Filtrar productos agrupados por tag(s) comercial(es) — OR (DetallesSimilitud). */
function filterProductsByTag(allGrouped, tagValue) {
  const tags = Array.isArray(tagValue)
    ? dedupeTagsByCanonical(tagValue)
    : dedupeTagsByCanonical(parseTagSelectorValues(tagValue));
  if (!tags.length) return allGrouped;
  if (tags.length === 1) {
    return allGrouped.filter((p) => groupedProductMatchesCommercialTag(p, tags[0]));
  }
  return allGrouped.filter((p) => groupedProductMatchesAnyCommercialTag(p, tags));
}

function escapeTagFilterHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function renderTagFilterChipsHtml(tags) {
  return tags
    .map((tag) => {
      const safe = escapeTagFilterHtml(tag);
      return `<button type="button" class="tag-filter-chip" data-tag="${safe}" aria-label="Quitar tag ${safe}">${safe}<span class="tag-filter-chip__remove" aria-hidden="true">×</span></button>`;
    })
    .join("");
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
  const safeSizesText = safeSizes.join(", ").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  let innerHtml = "";
  if (type === "search") {
    const safeVal = escapeTagFilterHtml(tagValue);
    let textHtml = `Buscando: <strong class="tag-filter-value">${safeVal}</strong>`;
    if (hasSizeFilter) {
      textHtml += ` <span class="tag-filter-sep">•</span> Talles: <strong class="tag-filter-size-value">${safeSizesText}</strong>`;
    }
    innerHtml = `<span class="tag-filter-text">${textHtml}</span>`;
  } else if (type === "size") {
    innerHtml = `<span class="tag-filter-text">Talles: <strong class="tag-filter-size-value">${safeSizesText}</strong></span>`;
  } else {
    const tags = Array.isArray(tagValue)
      ? dedupeTagsByCanonical(tagValue)
      : dedupeTagsByCanonical(parseTagSelectorValues(tagValue));
    window.__fylActiveTagFilters = tags;
    innerHtml = `
      <div class="tag-filter-chips-wrap">
        <span class="tag-filter-chips-label">Tags:</span>
        <div class="tag-filter-chips">${renderTagFilterChipsHtml(tags)}</div>
      </div>`;
  }
  if (bar) {
    const body = bar.querySelector(".tag-filter-body");
    if (body) body.innerHTML = innerHtml;
    else {
      const textEl = bar.querySelector(".tag-filter-text");
      if (textEl) textEl.outerHTML = `<div class="tag-filter-body">${innerHtml}</div>`;
    }
    bar.dataset.filterType = type;
    bar.dataset.hasSizeFilter = hasSizeFilter ? "true" : "false";
    return;
  }
  const html = `
    <div id="tag-filter-bar" class="tag-filter-bar" data-filter-type="${type}">
      <div class="tag-filter-body">${innerHtml}</div>
      <button type="button" class="tag-filter-clear" aria-label="Quitar todos los filtros">✕</button>
    </div>
  `;
  cont.insertAdjacentHTML("afterbegin", html);
  bar = document.getElementById("tag-filter-bar");
  if (bar) bar.dataset.hasSizeFilter = hasSizeFilter ? "true" : "false";
}

function removeOneActiveTagFilter(tag) {
  const active = Array.isArray(window.__fylActiveTagFilters)
    ? window.__fylActiveTagFilters
    : [];
  const key = canonicalTagKey(tag);
  const remaining = active.filter((t) => canonicalTagKey(t) !== key);
  if (!remaining.length) {
    location.hash = "#/";
    return;
  }
  navigateToTagsHash(remaining, { source: "chip_remove" });
}

/** Ocultar barra de filtro por tag. */
function clearTagFilterBar() {
  const bar = document.getElementById("tag-filter-bar");
  if (bar) bar.remove();
  window.__fylActiveTagFilters = [];
}

function initTagFilterClearDelegation() {
  if (window.__tagFilterDelegationInit) return;
  window.__tagFilterDelegationInit = true;
  document.addEventListener("click", (e) => {
    const chipBtn = e.target.closest(".tag-filter-chip");
    if (chipBtn) {
      e.preventDefault();
      removeOneActiveTagFilter(chipBtn.dataset.tag || chipBtn.textContent || "");
      return;
    }

    const btn = e.target.closest(".tag-filter-clear");
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
  const tagsFromHash = parseHashTags(location.hash || "");
  if (searchTerm) {
    renderTagFilterBar(searchTerm, { type: "search", sizeFilters });
  } else if (sizeFilters.length > 0) {
    renderTagFilterBar(sizeFilters.join(", "), { type: "size", sizeFilters });
  } else if (tagsFromHash.length) {
    renderTagFilterBar(tagsFromHash, { type: "tag" });
  } else {
    clearTagFilterBar();
  }
  if (typeof window.updateSizeFilterButtonsUI === 'function') {
    window.updateSizeFilterButtonsUI();
  }
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

/** Click en .tag-chip o .pdp-tag-chip → filtro por hash multi-tag. */
function initTagToSearch() {
  if (window.__tagToSearchInit) return;
  window.__tagToSearchInit = true;
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".tag-chip, .pdp-tag-chip");
    if (!chip) return;
    e.preventDefault();
    e.stopPropagation();
    const tag = (chip.dataset.tag || chip.textContent || "").trim();
    if (!tag) return;
    const fromPdp = chip.classList.contains("pdp-tag-chip");
    if (fromPdp) cerrarModal(true);
    navigateToTagsHash([tag], {
      source: fromPdp ? "pdp_tag_chip" : "catalog_tag_chip",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, true);
}

/** Aplicar filtro por tag(s) y renderizar catálogo. Oculta banners de Home. */
async function applyTagFilterAndRender(tagValue, { pushHash = true, navSource = "" } = {}) {
  const tags = Array.isArray(tagValue)
    ? dedupeTagsByCanonical(tagValue)
    : dedupeTagsByCanonical(parseTagSelectorValues(tagValue));
  if (!tags.length) return;

  if (pushHash) {
    const target = buildTagsHash(tags);
    if ((location.hash || "") !== target) {
      navigateToTagsHash(tags, {
        source: navSource || window.__fylTagNavSource || "push",
      });
      return;
    }
  }

  const cont = document.getElementById("catalogo");
  if (!cont) return;
  const all = await ensureAllCacheLoadedGrouped();
  const filtrados = filterProductsByTag(all, tags);
  setProductosPendientes(filtrados);
  productosRenderizados = 0;
  offersCardsPendientes = [];
  setCatalogLoadMode("paged");
  if (typeof window.hideFYLOriginalsBanner === 'function') window.hideFYLOriginalsBanner();
  fylHideProductBanner();
  if (typeof window.hidePromotionalBanner === 'function') window.hidePromotionalBanner();
  document.querySelectorAll('#filtroMenu input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  if (typeof window.clearSearch === "function") {
    await window.clearSearch({ skipCatalogReset: true });
  } else {
    const searchInput = document.getElementById('searchInput');
    const searchBarMobile = document.getElementById('search-bar-mobile');
    if (searchInput) searchInput.value = '';
    if (searchBarMobile) searchBarMobile.value = '';
    window.__fylSearchDerivedCategory = null;
  }
  cont.innerHTML = '';
  initTagFilterClearDelegation();
  renderTagFilterBar(tags, { type: "tag" });
  const navSourceResolved = navSource || window.__fylTagNavSource || "direct";
  trackTagsFilterOpen(tags, {
    productCount: filtrados.length,
    source: navSourceResolved,
  });
  window.__fylTagNavSource = "";
  if (filtrados.length === 0) {
    cont.insertAdjacentHTML('beforeend', '<div class="no-data" style="text-align:center;padding:2rem;color:#666;">No hay productos con los tags seleccionados</div>');
    ocultarBotonVerMas();
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
  fylCatalogTrackViewItemList(
    "tags:" + buildTagComboAnalyticsKey(tags),
    productosPendientes,
    "tag_filter"
  );
}

window.__fylOnTagsHashNav = (tags, opts) =>
  applyTagFilterAndRender(tags, { pushHash: false, navSource: window.__fylTagNavSource || "hash_replace" });

// Tags clickeables: navegar a hash multi-tag
window.setQuickFilter = function (level, value) {
  if (!value) return;
  persistCurrentScrollInHistory();
  window.__quickFilter = { level, value };
  navigateToTagsHash(value, { source: "quick_filter" });
};

function abrirModalPorSKU(sku, { pushState = true } = {}) {
  if (!sku) return false;
  
  const resultado = buscarPorSKU(sku);
  if (!resultado) return false;

  // Abortar cualquier fetch slow-path que pudiera seguir en vuelo.
  if (pdpFetchAbortScope) {
    pdpFetchAbortScope.abort("fast_path_override");
    pdpFetchAbortScope = null;
  }

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
  trackPdpEntry(resultado.producto, sku, { pushState });
  fylCatalogPdpSurface();
  return true;
}

function abrirModalConResultado(resultado, { pushState = true } = {}) {
  if (!resultado || !resultado.producto) return false;

  // Abortar cualquier fetch slow-path que pudiera seguir en vuelo.
  if (pdpFetchAbortScope) {
    pdpFetchAbortScope.abort("fast_path_override");
    pdpFetchAbortScope = null;
  }

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
  trackPdpEntry(resultado.producto, sku, { pushState });
  fylCatalogPdpSurface();
  return true;
}

/**
 * Abre PDP por SKU: índice de página actual (instantáneo) o fetch a Supabase
 * con skeleton-first (responde inmediatamente, datos llegan después).
 *
 * Flujo skeleton-first:
 *  1. Abre el modal con skeleton → markFirstPaint("skeleton_shown")
 *  2. Fetch en background con señal de abort
 *  3. Al llegar datos → render real + markReady("data_loaded")
 *  4. Si error → render de error dentro del modal (sin cerrar)
 *  5. Si abort (usuario cerró o abrió otro) → silencioso
 */
async function abrirPdpPorSkuIfPossible(sku, { pushState = true, hint = {} } = {}) {
  if (!sku) return false;

  // Camino rápido: SKU ya está en cache → abre sin red, sin skeleton.
  if (abrirModalPorSKU(sku, { pushState })) return true;

  // Camino lento: abrir skeleton de inmediato y fetchear en background.
  const pdpScope = _abrirModalConSkeleton(sku, hint);
  if (!pdpScope) return false;

  if (pushState) pushPdpState(sku);

  try {
    const signal = pdpFetchAbortScope?.signal;
    const resultado = await buscarPorSKUEnSupabase(sku, { signal });

    // Si el modal fue cerrado/reemplazado mientras fetcheábamos, no pintar.
    const modal = document.getElementById("product-modal");
    const esMismoSku = modal?.dataset.sku === sku && modal?.classList.contains("active");
    if (!esMismoSku) return true; // Abierto con skeleton, abortado limpiamente.

    if (resultado) {
      productoActualEnModal = resultado.producto;
      renderizarModalProducto(resultado.producto, resultado.color, resultado.talle);
      const modalBody = document.getElementById("product-modal-body");
      if (modalBody) modalBody.scrollTop = 0;
      if (typeof window.updateFloatingCartCta === "function") window.updateFloatingCartCta();
      fylCatalogViewItemForProducto(resultado.producto, sku);
      trackMetaViewContent(resultado.producto, sku);
      trackPdpEntry(resultado.producto, sku, { pushState });
      fylCatalogPdpSurface();
      pdpScope.markReady("data_loaded");
    } else {
      // SKU no encontrado (sin error): producto inexistente.
      _renderPdpError(FYL_ERROR_KIND.PERMISSION, null);
      pdpScope.markReady("not_found");
    }
    return true;

  } catch (err) {
    const kind = err?.kind || classifyError(err);

    // Si el modal fue cerrado mientras fetcheábamos, silencioso.
    const modal = document.getElementById("product-modal");
    if (!modal?.classList.contains("active") || modal?.dataset.sku !== sku) return true;

    if (kind === FYL_ERROR_KIND.AUTH) {
      // Sesión inválida confirmada por servidor → cerrar y redirigir.
      cerrarModal(true);
      window.location.href = window.location.pathname.includes("/admin/") ? "./index.html" : "/";
      return true;
    }

    // Network, server, unknown → mostrar error dentro del modal sin cerrarlo.
    _renderPdpError(kind, sku);
    pdpScope.markReady("error_shown");
    return true;
  }
}

function cerrarModal(skipHistory = false) {
  // Abortar fetch PDP pendiente (si se abrió con skeleton y el usuario cerró antes).
  if (pdpFetchAbortScope && !pdpFetchAbortScope.aborted) {
    pdpFetchAbortScope.abort("modal_closed");
    pdpFetchAbortScope = null;
  }

  const modal = document.getElementById('product-modal');
  const wasPdpOpen = Boolean(modal?.classList.contains("active"));
  const closingSku = String(modal?.dataset?.sku || "").trim();
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
  if (closingSku) {
    trackMetaCustom("PdpClose", {
      content_ids: [closingSku],
      content_type: "product",
      source: "catalog_modal",
    });
  }

  if (wasPdpOpen) {
    fylTryRestoreHomeProductBannerAfterPdpClose();
  }

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

function showToast(message, type = "error") {
  showFylToastError({
    message: String(message || ""),
    durationMs: type === "error" ? 3400 : 2600,
  });
}

async function inicializarModalDesdeURL() {
  const sku = parsePdpFromUrl();
  if (!sku) return;

  const opened = await abrirPdpPorSkuIfPossible(sku, { pushState: false });
  if (opened) return;

  const modal = document.getElementById("product-modal");
  const modalBody = document.getElementById("product-modal-body");
  if (modal && modalBody) {
    renderFylInlineError(modalBody, {
      preset: "product",
      buttonLabel: "Cerrar",
      retry: () => {
        try {
          window.cerrarModal?.();
        } catch (_) {}
      },
    });
    modal.classList.add("active");
    document.body.classList.add("modal-open");
  } else {
    showFylToastError({ preset: "product" });
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
        .select(CATALOG_PUBLIC_SELECT)
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

  const pdpHeaderId = formatPdpHeaderIdentifier(producto);

  const modalFooter = document.getElementById('product-modal-footer');

  modalBody.innerHTML = `
    <div class="pdp-header product-modal-header">
      <div class="pdp-header__row1">
        <button class="pdp-back product-modal-back" aria-label="Volver">←</button>
        <div class="pdp-header__title-col">
          <div class="pdp-article-code">${pdpHeaderId.innerHtml}</div>
        </div>
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
               alt="${String(pdpHeaderId.plainAlt).replace(/"/g, "&quot;")}"
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
      modal.classList.add("catalog-only-pdp");
      modalFooter.classList.remove("pdp-footer-bar-hidden");
      modal.classList.remove("pdp-checkout-bar-visible");
      const waText = encodeURIComponent(`Hola, consulto por: ${producto.Articulo || ''}${detalleColor?.color ? ' - ' + detalleColor.color : ''}`);
      const waUrl = `https://wa.me/5493625172874?text=${waText}`;
      modalFooter.innerHTML = `
        <a class="pdp-whatsapp-cta" href="${waUrl}" target="_blank" rel="noopener" data-action="wa">Consultar por WhatsApp</a>`;
    } else {
      modal.classList.remove("catalog-only-pdp");
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
    const isSelected = (detalle.color || "").trim().toLowerCase() === (colorSeleccionado || "").trim().toLowerCase();
    const selectedClass = isSelected ? 'selected' : '';
    const hexColor = detalle.hex_color || "#CD844D";
    const displayNumber = detalle.ColorDisplayNumber || detalle.display_number;
    const rgb = hexToRgb(hexColor);
    const brightness = rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : 128;
    const textColor = brightness > 128 ? "#000000" : "#FFFFFF";

    const numberHtml = displayNumber
      ? `<span class="color-number">${displayNumber}</span>`
      : "";

    const imgUrl = getImgUrl(imagen, 1200);
    const colorName = String(detalle.color || '').replace(/"/g, '&quot;');
    const aria = displayNumber
      ? `Color ${colorName} (${displayNumber})`
      : `Color ${colorName}`;

    // Estructura mobile-first robusta:
    //  - <button> 44x44 = hit area COMPLETA, sin clip-path ni overlays muertos.
    //  - <span.color-swatch-fill> = círculo visible 28x28 con pointer-events:none.
    //  - <span.color-number> = número opcional, también pointer-events:none.
    //  - --swatch-color y --swatch-text = colores vía CSS variable.
    //  - aria-label/aria-pressed para accesibilidad.
    return `<button type="button"
                    class="color-btn ${selectedClass}"
                    data-color="${detalle.color}"
                    data-src="${imgUrl}"
                    data-sku="${sku || ''}"
                    data-number="${displayNumber || ''}"
                    aria-label="${aria}"
                    aria-pressed="${isSelected ? 'true' : 'false'}"
                    style="--swatch-color: ${hexColor}; --swatch-text: ${textColor};"><span class="color-swatch-fill" aria-hidden="true"></span>${numberHtml}</button>`;
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
    // Tracking interno (fylAnalytics) sin tocar el flujo de navegación.
    // El <a target="_blank" href="wa.me/..."> abre solo de forma nativa.
    // Meta Lead se dispara en catalogo-publico.js (público) o en whatsapp.js
    // (resto), con deduplicación por el flag event.__fylWaLeadTracked para
    // evitar inflar CPL en Meta Ads Manager.
    document.addEventListener('click', (e) => {
      const wa = e.target.closest('.pdp-whatsapp-cta');
      if (!wa) return;
      try {
        if (fylAnalytics.isReady()) fylAnalytics.event("whatsapp_click", { surface: "pdp" });
      } catch (_e) {}
      // Sin preventDefault / stopPropagation: el navegador navega solo.
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

    // Tap sobre la imagen principal del PDP -> abrir lightbox fullscreen.
    // Fix: Clarity detectó >1000 dead clicks en .product-modal-main-image.
    // Recolectamos la galería completa desde las miniaturas para navegación swipe.
    const mainImageTap = e.target.closest('.product-modal-main-image');
    if (mainImageTap) {
      e.preventDefault();
      const src = mainImageTap.currentSrc || mainImageTap.src;
      if (src) {
        const alt = mainImageTap.getAttribute('alt') || '';
        // Tomar todas las URLs de las miniaturas (data-full o src), conservando
        // orden de la galería del PDP. Dedup para evitar duplicados.
        const seen = new Set();
        const galleryUrls = [];
        modal.querySelectorAll('.pdp-thumbs .miniatura').forEach((m) => {
          const url = m.getAttribute('data-full') || m.getAttribute('src') || '';
          if (url && !seen.has(url)) { seen.add(url); galleryUrls.push(url); }
        });
        // Asegurar que la imagen actual esté en la lista (si no, prepend).
        if (src && !seen.has(src)) { galleryUrls.unshift(src); }
        const startIdx = Math.max(0, galleryUrls.indexOf(src));
        try { if (fylAnalytics.isReady()) fylAnalytics.event("view_product_image_fullscreen", { surface: "pdp", gallery_size: galleryUrls.length }); } catch (_e) {}
        openPdpLightbox(galleryUrls.length ? galleryUrls : [src], startIdx, alt);
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
    
    // Click en botón de color del PDP.
    // closest() robusto: matchea aunque el target sea un hijo decorativo
    // (.color-swatch-fill o .color-number). Scope a .product-modal-colors
    // para no chocar con .card .color-btn de los recomendados.
    const btn = e.target.closest('.product-modal-colors .color-btn');
    if (btn) {
      const color = btn.dataset.color;
      if (!color) return;
      applyPdpColorSelection(color, { updateMainImage: true, source: 'swatch' });
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
    
    // Click en miniatura del PDP. closest() robusto + scope a .pdp-thumbs
    // para no chocar con .gallery .miniatura de cards de recomendados.
    const thumbEl = e.target.closest('.pdp-thumbs .miniatura');
    if (thumbEl) {
      const fullSrc = thumbEl.getAttribute('data-full') || thumbEl.src;
      const mainImage = modal.querySelector('.product-modal-main-image');
      if (mainImage) mainImage.src = fullSrc;
      modal.querySelectorAll('.pdp-thumbs .miniatura').forEach(m => m.classList.remove('active'));
      thumbEl.classList.add('active');
      // Regla "la imagen visible manda": si la thumb pertenece a otro color,
      // sincronizamos swatch/label/talles/SKU. Silencioso si ya está sync.
      syncPdpColorFromImage(thumbEl, 'thumbnail');
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
        const descripcion = modal.querySelector('.pdp-article-code')?.textContent?.trim() || articulo || '';

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
              trackTagFilterConversion({ surface: "pdp", articulo });
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
    // Ignorar clicks en botones, controles de reserva, botones de color,
    // o cualquier enlace interno (ej: .public-consult-btn que ahora es <a>
    // target=_blank para navegar nativo a wa.me sin abrir el PDP).
    if (e.target.tagName === 'BUTTON' ||
        e.target.closest('a[href]') ||
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
    
    // 3) Solo si no está en página → skeleton-first + fetch en background.
    if (sku) {
      // Extraer datos parciales de la card para pre-poblar el skeleton.
      const imgEl   = card.querySelector(".main-image");
      const nameEl  = card.querySelector(".card-title, [data-articulo], .product-name");
      const colorEl = card.querySelector(".card-color, [data-color]");
      const hint = {
        imagen: imgEl?.src || imgEl?.dataset.src || "",
        nombre: nameEl?.textContent?.trim() || nameEl?.dataset?.articulo || "",
        color:  colorEl?.textContent?.trim() || colorEl?.dataset?.color  || "",
      };
      abrirPdpPorSkuIfPossible(sku, { pushState: true, hint }).catch((err) => {
        console.warn("[pdp] abrirPdpPorSkuIfPossible error inesperado:", err);
      });
    }
  });
}

function initEscClose() {
  if (escInit) return;
  escInit = true;
  
  document.addEventListener('keydown', (e) => {
    // Navegación gallery dentro del lightbox: flechas izquierda/derecha.
    if (typeof isPdpLightboxOpen === 'function' && isPdpLightboxOpen()) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); pdpLightboxGo(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); pdpLightboxGo(1); return; }
    }
    if (e.key === 'Escape') {
      // Si el lightbox está abierto, cerrarlo primero (no tocar el PDP padre).
      if (typeof isPdpLightboxOpen === 'function' && isPdpLightboxOpen()) {
        closePdpLightbox();
        return;
      }
      const modal = document.getElementById('product-modal');
      if (modal && modal.classList.contains('active')) {
        cerrarModal();
      }
    }
  });
}

// Handler popstate + hashchange: back nativo cierra PDP sin salir de la web
async function resetHomeState() {
  const hadCuratedCatalogOverride = window.__fylCuratedBannerCatalogOverride === true;

  fylHideProductBanner();
  if (typeof window.clearSearch === "function") {
    await window.clearSearch({ skipCatalogReset: true });
  } else {
    const inputDesktop = document.getElementById("searchInput");
    const inputMobile = document.getElementById("search-bar-mobile");
    if (inputDesktop) inputDesktop.value = "";
    if (inputMobile) inputMobile.value = "";
    window.__fylSearchDerivedCategory = null;
    refreshCatalogFilterBar();
  }

  // Estado actual de filtros
  const hasTagBar = !!document.getElementById('tag-filter-bar');
  const hasQuickFilter = !!window.__quickFilter;
  const isAlreadyAll = (categoriaActual || 'all') === 'all' && !hasTagBar && !hasQuickFilter;

  // Siempre limpiar filtros visibles/flags (aunque ya estemos en all)
  window.__quickFilter = null;
  window.__fylActiveTagFilters = [];
  clearTagFilterBar();
  // Desmarcar acciones rápidas (si el usuario venía desde una categoría/tag)
  document.querySelectorAll(".quick-action-btn").forEach((btn) => btn.classList.remove("category-chip--active"));

  // Ver todo del banner curado deja productos filtrados en #catalogo aunque categoriaActual siga en "all".
  if (!isAlreadyAll || hadCuratedCatalogOverride) {
    await cambiarCategoria("all");
  } else {
    document.querySelectorAll(".menu button").forEach((btn) => btn.classList.remove("active"));
  }

  if (hadCuratedCatalogOverride) {
    syncInfoBannerVisibility();
    if (fylIsCuratedBannerEnabled()) {
      await fylLoadHomeProductBanner({ preferInline: true });
    }
  }

  updateURL({ tab: "", sku: "" }, { mode: "replace" });
  restoreScrollFromHistoryState();
}

if (typeof window !== "undefined") {
  window.fylResetHomeState = resetHomeState;
}

async function onNavChange() {
  // 1) Si nosotros disparamos history.back() para consumir nuestra propia
  //    entrada del lightbox, ignorar este popstate (no tocar el PDP padre).
  if (__pdpLightboxConsumingHistory) {
    __pdpLightboxConsumingHistory = false;
    return;
  }
  // 2) Back nativo con lightbox abierto: cerrar SOLO el lightbox y mantener
  //    el PDP. fromPopstate=true para no llamar history.back() recursivo.
  if (typeof isPdpLightboxOpen === 'function' && isPdpLightboxOpen()) {
    closePdpLightbox({ fromPopstate: true });
    return;
  }

  const modal = document.getElementById('product-modal');
  const isPdpOpen = modal?.classList.contains('active');

  if (isPdpOpen) {
    cerrarModal(true);
    return;
  }

  const hash = location.hash || "#/";
  const bannerSlug = fylParseHashBannerSlug(hash);
  if (bannerSlug && fylIsCuratedBannerEnabled()) {
    window.__fylTagNavSource = "";
    window.__fylActiveTagFilters = [];
    clearTagFilterBar();
    fylHideProductBanner();
    if (typeof window.hidePromotionalBanner === "function") {
      window.hidePromotionalBanner();
    }
    document.getElementById("info-banner-top-container")?.classList.add("is-hidden");
    if (await fylEnsureCuratedBannerModule() && typeof window.applyCuratedBannerHashRoute === "function") {
      await window.applyCuratedBannerHashRoute(bannerSlug);
    }
    return;
  }

  const tagsFromHash = parseHashTags(hash);
  if (tagsFromHash.length) {
    await applyTagFilterAndRender(tagsFromHash, {
      pushHash: false,
      navSource: window.__fylTagNavSource || "hash",
    });
    window.__fylTagNavSource = "";
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

// PERF-004: sin setInterval; lazy nativo + listeners por imagen
let indicadorCargaActivo = false;
let bottomIndicatorGaveUp = false;
let catalogoGlobalScrollInicializado = false;
let catalogoScrollDebounceTimeout = null;
let _catalogSizeIndex = new Map();

function fylRebuildCatalogSizeIndex() {
  _catalogSizeIndex = new Map();
  const source = productosPendientes?.length ? productosPendientes : [];
  source.forEach((producto) => {
    const art = String(producto?.Articulo || "").trim();
    if (!art) return;
    const sizes = new Set();
    (producto.DetalleColor || []).forEach((detalle) => {
      (detalle.variantDetails || []).forEach((vd) => {
        if (vd?.talle) sizes.add(String(vd.talle).trim());
      });
      (detalle.talles || []).forEach((t) => {
        if (t) sizes.add(String(t).trim());
      });
    });
    _catalogSizeIndex.set(art.toLowerCase(), sizes);
  });
  if (typeof window !== "undefined") {
    window.__fylCatalogSizeIndex = _catalogSizeIndex;
  }
}

function fylProductHasSizesInMemory(articulo, selectedSizesArray) {
  const key = String(articulo || "").trim().toLowerCase();
  const sizes = _catalogSizeIndex.get(key);
  if (!sizes || !sizes.size) return null;
  const wanted = (selectedSizesArray || []).map((x) => String(x).trim()).filter(Boolean);
  if (!wanted.length) return true;
  return wanted.some((w) => sizes.has(w));
}

function onMainImageLoadStateChange() {
  requestAnimationFrame(() => {
    if (bottomIndicatorGaveUp) return;
    const pending = document.querySelector(
      ".main-image[loading='lazy']:not([data-load-listener])"
    );
    if (!pending && indicadorCargaActivo) {
      ocultarIndicadorCargaInferior();
      indicadorCargaActivo = false;
    }
  });
}

function fylBindLazyMainImageListeners(root = document) {
  const scope = root?.querySelectorAll ? root : document;
  const images = scope.querySelectorAll
    ? scope.querySelectorAll(".main-image[loading='lazy']")
    : [];
  images.forEach((img) => {
    if (img.getAttribute("data-load-listener") === "1") return;
    img.setAttribute("data-load-listener", "1");
    img.addEventListener("load", onMainImageLoadStateChange, { passive: true });
    img.addEventListener("error", onMainImageLoadStateChange, { passive: true });
  });
}

function iniciarVerificacionCargaImagenes() {
  bottomIndicatorGaveUp = false;
  fylBindLazyMainImageListeners(document);

  if (!catalogoGlobalScrollInicializado) {
    catalogoGlobalScrollInicializado = true;
    window.addEventListener(
      "scroll",
      () => {
        clearTimeout(catalogoScrollDebounceTimeout);
        catalogoScrollDebounceTimeout = setTimeout(() => {
          maybeTriggerCatalogAutoloadFallback();
        }, 100);
      },
      { passive: true }
    );
  }
}

let _catalogCardDelegationReady = false;

function initCatalogCardDelegation() {
  if (_catalogCardDelegationReady) return;
  _catalogCardDelegationReady = true;
  const catalogo = document.getElementById("catalogo");
  if (!catalogo) return;

  catalogo.addEventListener("click", (e) => {
    const mini = e.target.closest(".card .gallery .miniatura");
    if (mini) {
      e.stopPropagation();
      const main = mini.closest(".card")?.querySelector(".main-image");
      if (main) main.src = mini.getAttribute("data-full") || main.src;
      return;
    }

    const colorBtn = e.target.closest(".card .color-btn");
    if (colorBtn) {
      e.stopPropagation();
      const card = colorBtn.closest(".card.producto");
      if (!card) return;
      const main = card.querySelector(".main-image");
      if (main && colorBtn.dataset.src) main.src = colorBtn.dataset.src;
      const colorSeleccionado = colorBtn.dataset.color;
      const sizeContainer = card.querySelector(".card-footer-size");
      if (sizeContainer && window.productosActualesMap) {
        const articulo = sizeContainer.dataset.articulo;
        const producto = articulo ? window.productosActualesMap.get(articulo) : null;
        if (producto) {
          sizeContainer.innerHTML = obtenerSizeBadgeHTML(producto, colorSeleccionado);
          sizeContainer.dataset.colorSelected = colorSeleccionado || "";
        }
      }
    }
  });
}

function configurarEventos() {
  iniciarVerificacionCargaImagenes();
  if (typeof window.construirMenuFiltros === "function") {
    window.construirMenuFiltros();
  }
}

// =====================================================================
// [FASE 1B-A · T1+T3] Feedback inmediato al cambiar categoría
//
// `cambiarCategoria()` es la única fuente de verdad del feedback visual:
// los callers (quick-actions, mobile-nav, banner, .menu) NO deben envolver
// con loaders propios; basta con llamar a `cambiarCategoria(cat)`.
//
// Capa 1: pressed/loading state en el botón target (.cat-btn--loading).
// Capa 2: top progress bar app-like, slim, no bloquea taps.
//
// Diseño en docs/FYL-Obsidian/FYL-Product/Roadmap/FASE-1B-A-Feedback-Categoria.md
// =====================================================================

let _categoryProgressBarEl = null;
let _categoryProgressHideTimer = null;

// [FASE 1B-A · T2] Lock anti re-entrada en cambiarCategoria.
// _categoryInFlight: string de la cat actualmente en vuelo (null si nada).
// _categoryRequestSeq: contador para last-wins en cambios rápidos a OTRA cat.
let _categoryInFlight = null;
let _categoryRequestSeq = 0;

function _matchesCategoryButton(buttonText, cat) {
  if (!cat || cat === "all") return false;
  if (cat === "Lenceria" && buttonText === "Lencería") return true;
  if (cat === "Marroquineria" && buttonText === "Accesorios") return true;
  return buttonText.includes(cat);
}

function _markCategoryButtonsLoading(cat) {
  if (typeof document === "undefined") return;
  // Limpiar previos (defensa: por si quedó un loading huérfano de un cambio anterior).
  document.querySelectorAll(".cat-btn--loading").forEach((b) => b.classList.remove("cat-btn--loading"));

  // .menu button: matching por texto (replica algoritmo de selección activa).
  document.querySelectorAll(".menu button").forEach((btn) => {
    const txt = (btn.textContent || "").trim();
    if (_matchesCategoryButton(txt, cat)) {
      btn.classList.add("cat-btn--loading");
    }
  });

  // .quick-action-btn: matching por data-action-value / data-action-type.
  document.querySelectorAll(".quick-action-btn").forEach((btn) => {
    const val = btn.dataset ? btn.dataset.actionValue : btn.getAttribute("data-action-value");
    const type = btn.dataset ? btn.dataset.actionType : btn.getAttribute("data-action-type");
    let match = false;
    if (cat === "all" && (type === "inicio" || val === "all")) match = true;
    else if (val && val === cat) match = true;
    if (match) btn.classList.add("cat-btn--loading");
  });
}

function _unmarkCategoryButtonsLoading() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(".cat-btn--loading").forEach((b) => b.classList.remove("cat-btn--loading"));
}

function _ensureCategoryProgressBarEl() {
  if (typeof document === "undefined") return null;
  if (_categoryProgressBarEl && document.body && document.body.contains(_categoryProgressBarEl)) {
    return _categoryProgressBarEl;
  }
  const el = document.createElement("div");
  el.id = "category-progress-bar";
  el.className = "category-progress-bar";
  el.setAttribute("role", "progressbar");
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  _categoryProgressBarEl = el;
  return el;
}

function _showCategoryProgressBar() {
  const el = _ensureCategoryProgressBarEl();
  if (!el) return;
  clearTimeout(_categoryProgressHideTimer);
  el.classList.remove("category-progress-bar--done");
  el.style.transform = "scaleX(0)";
  // Forzar reflow mínimo para que la transición arranque desde 0.
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth;
  el.classList.add("category-progress-bar--active");
  el.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    el.style.transform = "scaleX(0.8)";
  });
}

function _hideCategoryProgressBar() {
  const el = _categoryProgressBarEl;
  if (!el) return;
  el.style.transform = "scaleX(1)";
  el.setAttribute("aria-hidden", "true");
  clearTimeout(_categoryProgressHideTimer);
  _categoryProgressHideTimer = setTimeout(() => {
    el.classList.remove("category-progress-bar--active");
    el.classList.add("category-progress-bar--done");
  }, 180);
}

function showCategoryFeedback(cat) {
  _markCategoryButtonsLoading(cat);
  _showCategoryProgressBar();
}

function hideCategoryFeedback() {
  _unmarkCategoryButtonsLoading();
  _hideCategoryProgressBar();
}

// Función para cambiar categoría
async function cambiarCategoria(cat) {
  // [FASE 1B-A · T2] Lock anti re-entrada.
  // Si llega un tap exactamente sobre la MISMA cat ya en vuelo → se ignora
  // (evita doble render y dobles requests cuando la usuaria toca dos veces
  // por la sensación de "no respondió"). Si llega un tap sobre OTRA cat
  // distinta, se permite y last-wins: solo el más reciente limpia el feedback.
  if (_categoryInFlight === cat) {
    fylCatalogDbg("⛔ cambiarCategoria: tap repetido sobre cat en vuelo, ignorado:", cat);
    return;
  }
  const mySeq = ++_categoryRequestSeq;
  _categoryInFlight = cat;

  // [FASE 1B-A · T1+T3] Feedback inmediato síncrono ANTES de cualquier await.
  // Esto garantiza pressed state + barra de progreso visibles en el primer frame
  // tras el tap, sin importar qué caller invocó cambiarCategoria.
  showCategoryFeedback(cat);

  try {
    fylCatalogDbg("🔄 Cambiando a categoría:", cat);
    persistCurrentScrollInHistory();
    try {
      if (fylAnalytics.isReady()) {
        fylAnalytics.event("catalog_category_select", {
          category: String(cat || "all"),
          source: "catalog_ui",
        });
      }
    } catch (_e) {}
    trackMetaCustom("CatalogCategorySelect", {
      category: String(cat || "all"),
      source: "catalog_ui",
    });

    if (typeof window.clearSearch === "function") {
      await window.clearSearch({ skipCatalogReset: true });
    } else {
      const inputDesktop = document.getElementById("searchInput");
      const inputMobile = document.getElementById("search-bar-mobile");
      if (inputDesktop) inputDesktop.value = "";
      if (inputMobile) inputMobile.value = "";
      window.__fylSearchDerivedCategory = null;
      refreshCatalogFilterBar();
    }

    // [FASE 1B-A · T2] Guard de obsolescencia tras clearSearch: si otra cat tomó
    // el lock mientras esperábamos, abandonar antes de pintar nada del flujo viejo.
    if (_categoryRequestSeq !== mySeq) {
      fylCatalogDbg("⛔ cambiarCategoria: abandonada por request más reciente (pre-render):", cat);
      return;
    }

    // Inicio (all): la barra móvil usa .quick-action-btn + .category-chip--active, no .menu; limpiar selección visual.
    if (cat === "all") {
      document.querySelectorAll(".quick-action-btn").forEach((btn) => btn.classList.remove("category-chip--active"));
    }

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
    await runWithViewTransition(() => cargarCategoria(cat));

    // [FASE 1B-A · T2] Guard de obsolescencia tras render: si llegó otra cat
    // mientras pintábamos, NO escribimos URL ni cerramos feedback (el flujo
    // más reciente lo hará por nosotros). Evita "categoría escribió URL vieja"
    // cuando el usuario cambia de Calzado→Ropa antes de que Calzado termine.
    if (_categoryRequestSeq !== mySeq) {
      fylCatalogDbg("⛔ cambiarCategoria: abandonada por request más reciente (post-render):", cat);
      return;
    }

    // Actualizar URL con slug, preservando sku existente
    // NO cerrar modal si está abierto (productoActualEnModal ya se mantiene)
    updateURL({ tab: cat, sku: undefined }, { mode: 'replace' });
  } finally {
    // [FASE 1B-A · T2] Solo limpiamos si seguimos siendo la última request.
    // Si otra cat distinta tomó el lock mientras estábamos awaiteando, dejamos
    // que ese flujo (más reciente) sea el responsable de mostrar/ocultar feedback.
    if (_categoryRequestSeq === mySeq) {
      _categoryInFlight = null;
      // [FASE 1B-A · T1+T3] Limpieza de feedback siempre, incluso si algo lanzó.
      hideCategoryFeedback();
    }
  }
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
    showFylToastError({ message: "Link de imagen copiado" });
  } catch (e) {
    showFylToastError({
      message: "No pudimos copiar el link. Intentá de nuevo.",
    });
  }
}

/* ============================================================
 * PDP Lightbox — Visor fullscreen de la imagen principal del PDP.
 * Razón: Clarity detectó >1000 dead clicks sobre .product-modal-main-image
 * porque los usuarios esperan poder ampliar la foto.
 * Singleton DOM, reutiliza shareImageUrl()/downloadImageFromUrl(),
 * sin librerías externas, mobile-first.
 * ============================================================ */
let __pdpLightboxOpener = null;
let __pdpLightboxPrevOverflow = "";
let __pdpLightboxPushedState = false;
// Flag: cuando NOSOTROS llamamos history.back() para consumir nuestra propia
// entrada, evita que onNavChange interprete ese popstate como navegación real
// y termine cerrando el PDP padre.
let __pdpLightboxConsumingHistory = false;
/* ============================================================
 * Sincronización Imagen ↔ Color del PDP
 * Regla UX: "la imagen visible manda". Cuando el usuario cambia la
 * imagen por thumbnail, lightbox swipe o cualquier otro medio, el
 * color seleccionado se sincroniza automáticamente (sin loops).
 * ============================================================ */

// Guard anti-loop: true mientras un sync desde imagen está en curso, para
// evitar que applyPdpColorSelection re-dispare cambios de imagen circulares.
let __pdpSyncingColorFromImage = false;

/**
 * Aplica el cambio de color seleccionado en el PDP de forma centralizada.
 * Reusable desde el listener del swatch (updateMainImage:true) y desde
 * syncPdpColorFromImage (updateMainImage:false, porque la imagen ya cambió).
 *
 * @param {string} color  Nombre del color a seleccionar.
 * @param {object} opts
 *   - updateMainImage {boolean=true}  Si true, también cambia .product-modal-main-image
 *     y la thumbnail activa al primer src del color (modo swatch). Si false, asume
 *     que la imagen visible ya pertenece al nuevo color (modo image-driven).
 *   - source {string='swatch'} 'swatch' | 'thumbnail' | 'lightbox_swipe' | 'lightbox_close'
 * @returns {boolean} true si el color cambió, false si era igual o falló.
 */
function applyPdpColorSelection(color, opts = {}) {
  const { updateMainImage = true, source = 'swatch' } = opts;
  const modal = document.getElementById('product-modal');
  if (!modal || !productoActualEnModal || !color) return false;

  const colorNorm = String(color).trim().toLowerCase();
  if (!colorNorm) return false;

  // Detectar color actual desde el label visible (fuente de verdad).
  const currentColorEl = modal.querySelector('.product-modal-color-label strong');
  const previousColor = (currentColorEl?.textContent || '').trim();
  if (previousColor && previousColor.toLowerCase() === colorNorm) return false;

  // Encontrar el button del color (iteración robusta ante caracteres raros).
  const allBtns = modal.querySelectorAll('.product-modal-colors .color-btn');
  let btn = null;
  for (const b of allBtns) {
    if ((b.dataset.color || '').trim().toLowerCase() === colorNorm) { btn = b; break; }
  }

  const detalleColor = productoActualEnModal.DetalleColor?.find(d =>
    (d.color || '').trim().toLowerCase() === colorNorm
  );
  if (!detalleColor) return false;

  // 1) Imagen principal + thumbnail activa (solo si el cambio nace del swatch).
  if (updateMainImage && btn) {
    const mainImage = modal.querySelector('.product-modal-main-image');
    const targetSrc = btn.dataset.src;
    if (mainImage && targetSrc) mainImage.src = targetSrc;
    const thumbs = modal.querySelectorAll('.pdp-thumbs .miniatura');
    let matched = false;
    thumbs.forEach((t) => {
      const full = t.getAttribute('data-full') || t.getAttribute('src') || '';
      if (!matched && targetSrc && full === targetSrc) {
        thumbs.forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        matched = true;
      }
    });
    // Fallback: si no hay match exacto de URL, activar la primera thumb del
    // color (iteración para evitar dependencia de CSS.escape en WebViews viejos).
    if (!matched) {
      for (const t of thumbs) {
        if ((t.getAttribute('data-color-norm') || '') === colorNorm) {
          thumbs.forEach((x) => x.classList.remove('active'));
          t.classList.add('active');
          break;
        }
      }
    }
  }

  // 2) Variantes (talles) + label + addBtn + total.
  const variantesHTML = renderizarVariantesModalPDP(productoActualEnModal, color, color);
  const variantsContainer = modal.querySelector('.product-modal-variants');
  if (variantsContainer) variantsContainer.innerHTML = variantesHTML;
  if (currentColorEl) currentColorEl.textContent = color;
  const addBtn = modal.querySelector('.pdp-add-btn');
  if (addBtn) addBtn.dataset.color = color;
  try { clearPdpAddAddedState(modal); } catch (_) {}
  try { updateModalPDPTotal(modal); } catch (_) {}

  // 3) SKU en URL + dataset (solo si hay SKU con stock).
  const resultado = obtenerPrimerSkuConStock(productoActualEnModal, color);
  const sku = resultado?.sku || '';
  if (sku) {
    try { updateSKUEnURL(sku); } catch (_) {}
    modal.dataset.sku = sku;
  }

  // 4) Swatch selection (clases + aria-pressed).
  allBtns.forEach((b) => {
    b.classList.remove('selected');
    b.setAttribute('aria-pressed', 'false');
  });
  if (btn) {
    btn.classList.add('selected');
    btn.setAttribute('aria-pressed', 'true');
  }

  // 5) Analytics.
  try {
    if (fylAnalytics.isReady()) {
      const allColors = productoActualEnModal.DetalleColor || [];
      const itemId = String(productoActualEnModal.Articulo || '');
      fylAnalytics.event('select_item_variant', { item_id: itemId, item_variant: String(color) });
      fylAnalytics.event('change_product_color', {
        surface: 'pdp', item_id: itemId, color: String(color),
        color_count: allColors.length, source: source,
      });
      if (source !== 'swatch') {
        fylAnalytics.event('image_driven_color_change', {
          source: source, previous_color: String(previousColor || ''),
          new_color: String(color), item_id: itemId,
        });
      }
    }
  } catch (_) {}

  return true;
}

/**
 * Resuelve el color asociado a una imagen visible y sincroniza la UI del PDP
 * si difiere del color actual. Acepta:
 *   - HTMLImageElement con atributo data-color
 *   - URL string (busca la thumbnail correspondiente en .pdp-thumbs)
 *
 * Si la imagen no tiene color asociado (legacy o no encontrada), no cambia
 * nada (regla CASO D del usuario).
 *
 * @returns {boolean} true si el color cambió, false en caso contrario.
 */
function syncPdpColorFromImage(input, source = 'image') {
  if (__pdpSyncingColorFromImage) return false;
  const modal = document.getElementById('product-modal');
  if (!modal || !productoActualEnModal) return false;
  // Producto con un solo color: nada para sincronizar.
  if (!productoActualEnModal.DetalleColor || productoActualEnModal.DetalleColor.length <= 1) return false;

  let color = '';
  if (input && typeof input === 'object' && input.getAttribute) {
    color = input.getAttribute('data-color') || '';
  } else if (typeof input === 'string' && input) {
    const thumbs = modal.querySelectorAll('.pdp-thumbs .miniatura[data-color]');
    for (const m of thumbs) {
      const full = m.getAttribute('data-full') || m.getAttribute('src') || '';
      if (full === input || m.src === input) {
        color = m.getAttribute('data-color') || '';
        break;
      }
    }
  }
  if (!color) return false;

  __pdpSyncingColorFromImage = true;
  try {
    return applyPdpColorSelection(color, { updateMainImage: false, source });
  } finally {
    __pdpSyncingColorFromImage = false;
  }
}

// Estado de galería para navegación entre imágenes dentro del lightbox.
let __pdpLightboxImages = [];
let __pdpLightboxIndex = 0;
const __pdpLightboxPreloaded = new Set();
// Refs para listeners touch del swipe.
let __pdpLightboxTouchX0 = null;
let __pdpLightboxTouchY0 = null;
let __pdpLightboxTouchT0 = 0;

function ensurePdpLightboxRoot() {
  let root = document.getElementById('pdp-lightbox-root');
  if (root) return root;

  root = document.createElement('div');
  root.id = 'pdp-lightbox-root';
  root.className = 'pdp-lightbox';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Imagen ampliada del producto');
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="pdp-lightbox__backdrop" aria-hidden="true"></div>
    <div class="pdp-lightbox__toolbar" role="toolbar" aria-label="Acciones de imagen">
      <button type="button" class="pdp-lightbox-btn pdp-lightbox-btn--share" data-action="pdp-lightbox-share" aria-label="Compartir foto">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      </button>
      <button type="button" class="pdp-lightbox-btn pdp-lightbox-btn--download" data-action="pdp-lightbox-download" aria-label="Descargar foto">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button type="button" class="pdp-lightbox-btn pdp-lightbox-btn--close" data-action="pdp-lightbox-close" aria-label="Cerrar imagen">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <button type="button" class="pdp-lightbox-nav pdp-lightbox-nav--prev" data-action="pdp-lightbox-prev" aria-label="Imagen anterior" tabindex="-1" hidden>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <button type="button" class="pdp-lightbox-nav pdp-lightbox-nav--next" data-action="pdp-lightbox-next" aria-label="Imagen siguiente" tabindex="-1" hidden>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
    <div class="pdp-lightbox-stage">
      <img class="pdp-lightbox-image" alt="" decoding="async" draggable="false" />
    </div>
    <div class="pdp-lightbox-counter" aria-live="polite" hidden></div>
  `;
  document.body.appendChild(root);

  // ====== Listeners propios del overlay ======
  root.addEventListener('click', (ev) => {
    const target = ev.target;
    // Tap en la imagen: NO cerrar (requisito UX).
    if (target.closest('.pdp-lightbox-image')) {
      ev.stopPropagation();
      return;
    }
    const actionEl = target.closest('[data-action]');
    const action = actionEl ? actionEl.dataset.action : null;
    if (action === 'pdp-lightbox-close') {
      ev.preventDefault();
      closePdpLightbox();
      return;
    }
    if (action === 'pdp-lightbox-prev') {
      ev.preventDefault();
      ev.stopPropagation();
      pdpLightboxGo(-1);
      return;
    }
    if (action === 'pdp-lightbox-next') {
      ev.preventDefault();
      ev.stopPropagation();
      pdpLightboxGo(1);
      return;
    }
    if (action === 'pdp-lightbox-share') {
      ev.preventDefault();
      const src = root.querySelector('.pdp-lightbox-image')?.src;
      if (src) {
        try { if (fylAnalytics?.isReady?.()) fylAnalytics.event("share_product", { surface: "pdp_lightbox" }); } catch (_) {}
        shareImageUrl(src);
      }
      return;
    }
    if (action === 'pdp-lightbox-download') {
      ev.preventDefault();
      const src = root.querySelector('.pdp-lightbox-image')?.src;
      if (src) {
        try { if (fylAnalytics?.isReady?.()) fylAnalytics.event("download_product_image", { surface: "pdp_lightbox" }); } catch (_) {}
        downloadImageFromUrl(src);
      }
      return;
    }
    // Backdrop o cualquier área fuera (imagen/toolbar/nav/counter) -> cerrar.
    closePdpLightbox();
  });

  // ====== Swipe horizontal (mobile) sobre el stage ======
  const stage = root.querySelector('.pdp-lightbox-stage');
  if (stage) {
    stage.addEventListener('touchstart', (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      __pdpLightboxTouchX0 = t.clientX;
      __pdpLightboxTouchY0 = t.clientY;
      __pdpLightboxTouchT0 = Date.now();
    }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (__pdpLightboxTouchX0 == null) return;
      const t = e.changedTouches && e.changedTouches[0];
      const x0 = __pdpLightboxTouchX0;
      const y0 = __pdpLightboxTouchY0;
      const t0 = __pdpLightboxTouchT0;
      __pdpLightboxTouchX0 = null;
      __pdpLightboxTouchY0 = null;
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      const dt = Date.now() - t0;
      // Swipe horizontal claro: distancia > 50px, eje horizontal dominante, en <600ms.
      if (Math.abs(dx) > 50 && Math.abs(dy) < 60 && dt < 600) {
        pdpLightboxGo(dx < 0 ? 1 : -1);
      }
    }, { passive: true });
    stage.addEventListener('touchcancel', () => {
      __pdpLightboxTouchX0 = null;
      __pdpLightboxTouchY0 = null;
    }, { passive: true });
  }

  return root;
}

/** Renderiza la imagen del índice actual + indicadores + precarga vecinos. */
function renderPdpLightboxCurrent() {
  const root = document.getElementById('pdp-lightbox-root');
  if (!root) return;
  const total = __pdpLightboxImages.length;
  const idx = __pdpLightboxIndex;
  const img = root.querySelector('.pdp-lightbox-image');
  const counter = root.querySelector('.pdp-lightbox-counter');
  const prevBtn = root.querySelector('.pdp-lightbox-nav--prev');
  const nextBtn = root.querySelector('.pdp-lightbox-nav--next');

  const url = __pdpLightboxImages[idx] || '';
  const isAlreadyOpen = root.classList.contains('pdp-lightbox--open');
  if (img && url && img.src !== url) {
    // Anim sutil de fade SOLO si ya estaba abierto (navegación entre imágenes).
    // En la primera apertura, dejamos que la animación base de entrada se ocupe.
    if (isAlreadyOpen) {
      img.classList.add('is-swapping');
      img.onload = () => img.classList.remove('is-swapping');
      img.onerror = () => img.classList.remove('is-swapping');
    } else {
      img.onload = null;
      img.onerror = null;
    }
    img.src = url;
  }
  // Sync color del PDP padre con la imagen actual del lightbox.
  // SOLO al navegar dentro del lightbox (ya abierto); en el initial open el
  // PDP padre ya está sincronizado con el color de la imagen inicial.
  if (isAlreadyOpen && url) {
    try { syncPdpColorFromImage(url, 'lightbox_swipe'); } catch (_) {}
  }
  if (counter) {
    if (total > 1) {
      counter.textContent = `${idx + 1} / ${total}`;
      counter.hidden = false;
    } else {
      counter.hidden = true;
    }
  }
  const showNav = total > 1;
  if (prevBtn) {
    prevBtn.hidden = !showNav;
    prevBtn.tabIndex = showNav ? 0 : -1;
  }
  if (nextBtn) {
    nextBtn.hidden = !showNav;
    nextBtn.tabIndex = showNav ? 0 : -1;
  }
  preloadPdpLightboxNeighbors();
}

function pdpLightboxGo(delta) {
  const total = __pdpLightboxImages.length;
  if (total <= 1) return;
  __pdpLightboxIndex = (__pdpLightboxIndex + delta + total) % total;
  try { if (fylAnalytics?.isReady?.()) fylAnalytics.event("view_product_image_gallery", { surface: "pdp_lightbox", index: __pdpLightboxIndex }); } catch (_) {}
  renderPdpLightboxCurrent();
}

function preloadPdpLightboxNeighbors() {
  const total = __pdpLightboxImages.length;
  if (total <= 1) return;
  const i = __pdpLightboxIndex;
  const nextI = (i + 1) % total;
  const prevI = (i - 1 + total) % total;
  [nextI, prevI].forEach((k) => {
    const src = __pdpLightboxImages[k];
    if (!src || __pdpLightboxPreloaded.has(src)) return;
    const im = new Image();
    im.decoding = 'async';
    im.src = src;
    __pdpLightboxPreloaded.add(src);
  });
}

/** Sincroniza la imagen principal del PDP padre con la última imagen vista en
 *  el lightbox y activa la miniatura correspondiente. Llamado al cerrar. */
function syncPdpMainImageFromLightbox() {
  if (!__pdpLightboxImages.length) return;
  const modal = document.getElementById('product-modal');
  if (!modal) return;
  const finalUrl = __pdpLightboxImages[__pdpLightboxIndex];
  if (!finalUrl) return;
  const mainImage = modal.querySelector('.product-modal-main-image');
  if (mainImage && mainImage.src !== finalUrl) {
    mainImage.src = finalUrl;
  }
  // Marcar la miniatura activa que corresponda (si existe la URL en thumbs).
  const thumbs = modal.querySelectorAll('.pdp-thumbs .miniatura');
  let matched = false;
  thumbs.forEach((m) => {
    const full = m.getAttribute('data-full') || m.getAttribute('src') || '';
    if (!matched && full === finalUrl) {
      thumbs.forEach((x) => x.classList.remove('active'));
      m.classList.add('active');
      matched = true;
    }
  });
  // Defensa: si por algún motivo el sync no ocurrió durante el swipe (p.ej.
  // lightbox cerrado sin tocar siguiente/anterior), asegurarnos de que el
  // color del PDP refleje la imagen final. Idempotente: early return si ya
  // estaba sincronizado.
  try { syncPdpColorFromImage(finalUrl, 'lightbox_close'); } catch (_) {}
}

/**
 * Abre el lightbox.
 * Firma compatible:
 *  - openPdpLightbox(urlString, altText?)             -> 1 sola imagen
 *  - openPdpLightbox(urlsArray, startIndex, altText?) -> galería navegable
 */
function openPdpLightbox(arg1, arg2, arg3) {
  let images, startIndex, altText;
  if (Array.isArray(arg1)) {
    images = arg1.filter(Boolean);
    startIndex = (typeof arg2 === 'number' && isFinite(arg2)) ? arg2 : 0;
    altText = arg3 || '';
  } else {
    images = arg1 ? [String(arg1)] : [];
    startIndex = 0;
    altText = (typeof arg2 === 'string') ? arg2 : '';
  }
  if (!images.length) return false;

  const root = ensurePdpLightboxRoot();
  const img = root.querySelector('.pdp-lightbox-image');
  __pdpLightboxImages = images;
  __pdpLightboxIndex = Math.max(0, Math.min(startIndex, images.length - 1));
  if (img) {
    img.alt = altText || '';
  }
  renderPdpLightboxCurrent();

  try { __pdpLightboxOpener = document.activeElement; } catch (_) { __pdpLightboxOpener = null; }
  try {
    __pdpLightboxPrevOverflow = document.body.style.overflow || '';
    document.body.style.overflow = 'hidden';
  } catch (_) {}
  document.body.classList.add('pdp-lightbox-open');
  // Pushear entrada de historial para que el back nativo del browser/Android cierre
  // SOLO el lightbox sin descalzar el PDP padre. onNavChange detecta el lightbox
  // abierto y consume el popstate antes de tocar el modal.
  try {
    if (!__pdpLightboxPushedState) {
      const baseState = (history.state && typeof history.state === 'object') ? history.state : {};
      history.pushState({ ...baseState, pdpLightbox: true }, '', location.href);
      __pdpLightboxPushedState = true;
    }
  } catch (_) {}
  // Marcar hint como visto (oculta el chip "Tocar para ampliar" en siguientes PDPs).
  try {
    if (!localStorage.getItem('fyl_pdp_lightbox_hint_seen')) {
      localStorage.setItem('fyl_pdp_lightbox_hint_seen', '1');
    }
    document.body.dataset.pdpLightboxSeen = '1';
  } catch (_) {}
  root.classList.remove('pdp-lightbox--leave');
  // Doble RAF para garantizar que el navegador aplique el estado base antes de animar.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.classList.add('pdp-lightbox--open');
  }));
  root.setAttribute('aria-hidden', 'false');
  try { root.querySelector('.pdp-lightbox-btn--close')?.focus({ preventScroll: true }); } catch (_) {}
  return true;
}

function closePdpLightbox(opts) {
  const fromPopstate = !!(opts && opts.fromPopstate);
  const root = document.getElementById('pdp-lightbox-root');
  if (!root || !root.classList.contains('pdp-lightbox--open')) return false;
  // Sincronizar la imagen principal del PDP con la última imagen vista en el
  // lightbox (UX premium: el PDP refleja el resultado de la navegación).
  syncPdpMainImageFromLightbox();
  root.classList.remove('pdp-lightbox--open');
  root.classList.add('pdp-lightbox--leave');
  root.setAttribute('aria-hidden', 'true');
  try { document.body.style.overflow = __pdpLightboxPrevOverflow || ''; } catch (_) {}
  document.body.classList.remove('pdp-lightbox-open');
  // Consumir entrada de historial si nosotros la pusheamos y el cierre NO
  // viene de popstate (en ese caso el browser ya consumió la entrada).
  // CRÍTICO: marcar __pdpLightboxConsumingHistory para que el popstate que
  // disparará nuestro history.back() NO sea interpretado por onNavChange
  // como un back real (que terminaría cerrando el PDP padre).
  if (__pdpLightboxPushedState && !fromPopstate) {
    __pdpLightboxPushedState = false;
    __pdpLightboxConsumingHistory = true;
    try {
      history.back();
    } catch (_) {
      __pdpLightboxConsumingHistory = false;
    }
    // Safety: si por algún edge case raro el popstate no llega a dispararse,
    // liberamos el flag tras 1.2s para no dejar la navegación en estado pegado.
    // En el caso normal, onNavChange consume el flag antes que este timeout.
    setTimeout(() => { __pdpLightboxConsumingHistory = false; }, 1200);
  } else if (fromPopstate) {
    __pdpLightboxPushedState = false;
  }
  try {
    if (__pdpLightboxOpener && typeof __pdpLightboxOpener.focus === 'function') {
      __pdpLightboxOpener.focus({ preventScroll: true });
    }
  } catch (_) {}
  __pdpLightboxOpener = null;
  return true;
}

function isPdpLightboxOpen() {
  const root = document.getElementById('pdp-lightbox-root');
  return !!(root && root.classList.contains('pdp-lightbox--open'));
}

// Init temprano: si el usuario ya vio el hint en otra sesión, ocultarlo de entrada
// (evita el chip "Tocar para ampliar" en clientes recurrentes).
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('fyl_pdp_lightbox_hint_seen')) {
    document.body.dataset.pdpLightboxSeen = '1';
  }
} catch (_) {}

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
      .from(getCatalogAvailableSource())
      .select(CATALOG_PUBLIC_SELECT);

    if (error) throw error;

    // Filtrar por Mostrar (aceptar tanto booleano true como string "TRUE")
    const items = (data || []).filter((item) => {
      const mostrar = item.Mostrar;
      return mostrar === "TRUE" || mostrar === true || mostrar === "true" || mostrar === 1;
    });

    return items.some(
      (item) => isCatalogItemRecent(item, hace7)
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
      .from(getCatalogAvailableSource())
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
  renderCatalogSkeletonCards(CATALOG_BOOT_SKELETON_COUNT);
  scheduleCatalogBootSpinner();
  try {
    fylCatalogDbg("🚀 Inicializando catálogo con Supabase...");

    // Inicializar Supabase
    const supabaseInicializado = await inicializarSupabase();
    globalThis.markBootStage?.("catalog.supabase.verify", {
      ok: !!supabaseInicializado,
    });

    if (!supabaseInicializado) {
      console.error("❌ No se pudo inicializar Supabase. El catálogo no funcionará correctamente.");
      showFylErrorState({
        preset: "api",
        retry: () => {
          hideFylErrorState();
          void inicializarCatalogo();
        },
      });
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
    initCatalogCardDelegation();
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
          .from(getCatalogAvailableSource())
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

    if (bannerParam) {
      categoriaInicial = null;
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
    } else if (bannerParam) {
      const tagFromBanner = decodeURIComponent(bannerParam.trim());
      fylCatalogDbg(`📋 ?banner= → filtro por tag(s): "${tagFromBanner}"`);
      await applyTagFilterAndRender(tagFromBanner, {
        pushHash: true,
        navSource: "url_banner_param",
      });
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
      const bannerSlugBoot = fylParseHashBannerSlug(location.hash || "");
      const tagsFromHash = parseHashTags(location.hash || "");
      if (bannerSlugBoot && fylIsCuratedBannerEnabled()) {
        fylCatalogDbg(`📋 Deep link a banner curado: ${bannerSlugBoot}`);
        window.__fylActiveTagFilters = [];
        clearTagFilterBar();
        fylHideProductBanner();
        if (
          (await fylEnsureCuratedBannerModule()) &&
          typeof window.applyCuratedBannerHashRoute === "function"
        ) {
          await window.applyCuratedBannerHashRoute(bannerSlugBoot);
        }
      } else if (tagsFromHash.length) {
        fylCatalogDbg(`📋 Deep link a filtro por tag(s):`, tagsFromHash);
        await applyTagFilterAndRender(tagsFromHash, { pushHash: false, navSource: "boot_hash" });
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
      fylHideProductBanner();
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
            btn.classList.remove("category-chip--active");
          });
          inicioBtn.classList.add("category-chip--active");
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

    if (!window.__FYL_CONN_WATCH__) {
      window.__FYL_CONN_WATCH__ = true;
      watchFylConnectivity((offline) => {
        if (!offline) return;
        showFylErrorState({
          preset: "offline",
          retry: () => {
            hideFylErrorState();
            const cat =
              typeof categoriaActual !== "undefined" && categoriaActual
                ? categoriaActual
                : "all";
            void cargarCategoria(cat);
          },
        });
      });
    }
    } catch (error) {
      console.error("❌ Error inicializando catálogo:", error);
      console.error("Stack:", error.stack);
      globalThis.markBootStage?.("catalog.init.error", {
        name: error?.name,
        message: error?.message ? String(error.message).slice(0, 240) : String(error),
      });
      void (async () => {
        let offline = false;
        try {
          offline = await isFylOfflineDeepCheck();
        } catch (_) {}
        const preset = resolveCatalogFailurePreset(error, offline);
        showFylErrorState({
          preset,
          retry: () => {
            hideFylErrorState();
            void inicializarCatalogo();
          },
        });
      })();
    }
  } finally {
    // markReady garantiza: (1) que first paint ocurrió, (2) safety net de overlay,
    // (3) emisión de screen:ready. Se hace ANTES de limpiar __FYL_BOOT_SUPPRESS_ROUTE
    // para que shouldRun() del scope todavía pueda actuar si first paint no corrió.
    catalogScope.markReady("init_complete");
    window.__FYL_BOOT_SUPPRESS_ROUTE = false;
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
    clearBtn.addEventListener("click", async () => {
      if (typeof window.clearSearch === "function") {
        await window.clearSearch();
        return;
      }
      const inputDesktop = document.getElementById("searchInput");
      const inputMobile = document.getElementById("search-bar-mobile");
      if (inputDesktop) inputDesktop.value = "";
      if (inputMobile) inputMobile.value = "";
      document.querySelectorAll(".card").forEach((c) => (c.style.display = "block"));
    });
  }
});

window.fylRunViewTransition = runWithViewTransition;

// Función para mostrar alternativas cuando un talle está sin stock
async function mostrarAlternativasParaTalleSinStock(producto) {
  try {
    if (!window.buscarProductosAlternativos || !window.mostrarModalAlternativas) {
      showFylToastError({
        message:
          "Este producto no tiene stock en ese talle. Elegí otro talle o otro producto.",
      });
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
            <h2>Sin stock</h2>
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
          showFylToastError({
            message: `${productoSeleccionado.articulo} se agregó a tu bolsa`,
          });
        }
      },
      onCerrar: () => {
        fylCatalogDbg("Modal de alternativas cerrado");
      },
    });
  } catch (error) {
    console.error("❌ Error mostrando alternativas:", error);
    showFylToastError({
      message:
        "No pudimos mostrar alternativas ahora. Intentá de nuevo en unos segundos.",
    });
  }
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeTagListText(value) {
  return normalizeSearchText(String(value || "").replace(/[,;]+/g, " "));
}

// Construye un string normalizado con todos los campos buscables de un producto.
// Se usa como "haystack" único en buscarProductosEnTodos para que el match
// se evalúe contra nombre + descripción + categoría + tags (Filtro1/2/3) + color.
// Filtro3 puede contener varios tags separados por coma o punto y coma; se
// convierten a espacios para que cada tag quede como token independiente.
function buildProductSearchHaystack(producto) {
  if (!producto) return "";
  const filtro3Clean = String(producto.Filtro3 || "").replace(/[,;]+/g, " ");
  const parts = [
    producto.Articulo,
    producto.name,
    producto.Descripcion,
    producto.Categoria,
    producto.Filtro1,
    producto.Filtro2,
    filtro3Clean,
    producto.Color,
  ];
  return normalizeSearchText(parts.filter(Boolean).join(" "));
}

function buildSearchIndexEntry(producto) {
  const nombre = normalizeSearchText((producto?.name || producto?.Articulo) || "");
  const tag1 = normalizeSearchText(producto?.Filtro1 || "");
  const tag2 = normalizeSearchText(producto?.Filtro2 || "");
  const tags = normalizeTagListText(producto?.Filtro3 || "");
  const categoria = normalizeSearchText(producto?.Categoria || "");
  const color = normalizeSearchText(producto?.Color || "");
  const haystack = buildProductSearchHaystack(producto);

  return {
    producto,
    haystack,
    nombre,
    tag1,
    tag2,
    tags,
    categoria,
    color,
  };
}

function rebuildSearchIndex() {
  if (!Array.isArray(productosPendientes) || productosPendientes.length === 0) {
    searchIndex = [];
    return searchIndex;
  }
  searchIndex = productosPendientes.map((producto) => buildSearchIndexEntry(producto));
  return searchIndex;
}

function computeRelevanceScore(entry, term) {
  if (!entry || !term) return 0;
  let score = 0;
  const termToken = String(term || "").trim();

  // nombre: exact match -> +1000, incluye -> +150
  let nombreScore = 0;
  if (entry.nombre) {
    if (entry.nombre === termToken) {
      nombreScore = 1000;
    } else {
      const nombreTokens = tokenizeSearchText(entry.nombre);
      if (nombreTokens.includes(termToken)) {
        nombreScore = 150;
      }
    }
  }
  score += Math.min(nombreScore, 1000);

  // tag1/tag2: incluye -> +100
  let tag12Score = 0;
  if ((entry.tag1 && entry.tag1.includes(termToken)) || (entry.tag2 && entry.tag2.includes(termToken))) {
    tag12Score = 100;
  }
  score += Math.min(tag12Score, 100);

  // tags (Filtro3): incluye -> +80
  let tagsScore = 0;
  if (entry.tags && entry.tags.includes(termToken)) {
    tagsScore = 80;
  }
  score += Math.min(tagsScore, 80);

  // categoría: incluye -> +40
  let categoriaScore = 0;
  if (entry.categoria && entry.categoria.includes(termToken)) {
    categoriaScore = 40;
  }
  score += Math.min(categoriaScore, 40);

  // color: incluye -> +20
  let colorScore = 0;
  if (entry.color && entry.color.includes(termToken)) {
    colorScore = 20;
  }
  score += Math.min(colorScore, 20);

  return score;
}

function applyTextSearch(indexEntries, term) {
  if (!Array.isArray(indexEntries) || indexEntries.length === 0 || !term) return [];

  return indexEntries
    .map((entry) => {
      if (!matchesSearchWithTolerance(term, entry.haystack)) return null;
      return {
        producto: entry.producto,
        score: computeRelevanceScore(entry, term),
      };
    })
    .filter(Boolean);
}

function rankSearchResults(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  return [...matches].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return fylCatalogRecencyMs(b.producto) - fylCatalogRecencyMs(a.producto);
  });
}

async function renderSearchResults(productos, cont, requestId) {
  const isCurrentSearch = () => requestId == null || requestId === searchRenderSeq;
  if (!isCurrentSearch()) return false;

  // Limpiar contenedor y ocultar banners cuando hay filtro de búsqueda
  cont.innerHTML = "";
  if (typeof window.hideFYLOriginalsBanner === 'function') window.hideFYLOriginalsBanner();
  fylHideProductBanner();
  if (typeof window.hidePromotionalBanner === 'function') window.hidePromotionalBanner();
  document.getElementById("info-banner-top-container")?.classList.add("is-hidden");

  if (Array.isArray(productos) && productos.length > 0) {
    await renderizarProductosPagina(productos, cont, [], 0, null, {
      skipBanner: true,
      shouldRender: isCurrentSearch,
    });
    if (!isCurrentSearch()) return false;
    configurarEventos();
  } else {
    if (!isCurrentSearch()) return false;
    cont.insertAdjacentHTML('beforeend', '<div class="no-results" style="text-align: center; padding: 2rem; color: #666;">No se encontraron productos</div>');
  }

  if (!isCurrentSearch()) return false;
  initTagFilterClearDelegation();
  refreshCatalogFilterBar();
  return true;
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
  const requestId = ++searchRenderSeq;

  if (!term || term.trim() === '') {
    window.__fylSearchDerivedCategory = null;
    setCatalogLoadMode("paged");
    // Si no hay término, restaurar vista paginada normal y mostrar banners
    const cont = document.getElementById("catalogo");
    if (cont) {
      cont.innerHTML = "";
      productosRenderizados = 0;
      syncHomeTopSlotState({ pending: categoriaActual === "all" });
      const firstChunkRendered = await renderizarProductosPagina(
        productosPendientes,
        cont,
        offersCardsPendientes,
        0,
        PRODUCTOS_INICIALES,
        { deferEnrich: true }
      );
      productosRenderizados = Number(firstChunkRendered) || 0;
      initCatalogCardDelegation();
      configurarEventos();
      mostrarBotonVerMas();
      if (categoriaActual === 'all') {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const paralelos = [];
        if (typeof window.loadAndShowFYLBanner === 'function') paralelos.push(window.loadAndShowFYLBanner());
        if (
          !parseHashTags(location.hash || "").length &&
          !fylParseHashBannerSlug(location.hash || "")
        ) {
          const hasInline = Boolean(document.getElementById("custom-banner-container-inline"));
          if (fylIsCuratedBannerEnabled()) {
            fylPendingHomeCustomBanner = !hasInline;
            paralelos.push(
              fylLoadHomeProductBanner({
                preferInline: true,
                waitForInline: !hasInline,
              })
            );
          } else {
            fylPendingHomeCustomBanner = false;
            paralelos.push(fylLoadHomeProductBanner());
          }
        } else {
          fylPendingHomeCustomBanner = false;
        }
        if (typeof window.loadBanner === 'function') paralelos.push(window.loadBanner());
        await Promise.all(paralelos);
        if (typeof window.showPromotionalBanner === 'function') window.showPromotionalBanner();
        syncInfoBannerVisibility();
        syncHomeTopSlotState({ pending: false });
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

  if (searchIndex.length !== productosPendientes.length) {
    rebuildSearchIndex();
  }

  const productosRankeados = rankSearchResults(applyTextSearch(searchIndex, termLower));
  const productosFiltrados = productosRankeados.map((item) => item.producto);
  window.__fylSearchDerivedCategory = inferSearchCategoryFromProducts(productosFiltrados);

  const rendered = await renderSearchResults(productosFiltrados, cont, requestId);
  if (!rendered || requestId !== searchRenderSeq) return;
  fylCatalogTrackViewItemList("search:" + termLower, productosFiltrados, "search_results");
}

// Exportar funciones globales
window.cargarCategoria = cargarCategoria;
window.cambiarCategoria = cambiarCategoria;
window.cargarDesdeSupabase = cargarDesdeSupabase;
window.downloadImage = downloadImage;
window.downloadImageFromUrl = downloadImageFromUrl;
window.shareImageUrl = shareImageUrl;
window.openPdpLightbox = openPdpLightbox;
window.closePdpLightbox = closePdpLightbox;
window.isPdpLightboxOpen = isPdpLightboxOpen;
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
/** Productos agrupados por Articulo (orden preservado) para banner curado «Ver todo». */
async function fylResolveGroupedProductsByArticulos(articulosOrdered) {
  const uniqueOrdered = [];
  const seen = new Set();
  for (const raw of articulosOrdered || []) {
    const art = String(raw || "").trim();
    if (!art || seen.has(art)) continue;
    seen.add(art);
    uniqueOrdered.push(art);
  }
  if (!uniqueOrdered.length) return [];

  const byArt = new Map();
  const missing = [];
  const cache = window.__allProductsCache;

  for (const art of uniqueOrdered) {
    const hit = Array.isArray(cache)
      ? cache.find((p) => String(p.Articulo || "").trim() === art)
      : null;
    if (hit) byArt.set(art, hit);
    else missing.push(art);
  }

  if (missing.length) {
    const { data: rows, error } = await supabase
      .from(getCatalogAvailableSource())
      .select(CATALOG_PUBLIC_SELECT)
      .in("Articulo", missing);
    if (error) throw error;
    const grouped = agruparProductos(rows || []);
    if (grouped.length) {
      await enrichProductsWithStock(grouped);
    }
    for (const p of grouped) {
      byArt.set(String(p.Articulo || "").trim(), p);
    }
  }

  return uniqueOrdered.map((art) => byArt.get(art)).filter(Boolean);
}

window.renderizarProductosPagina = renderizarProductosPagina;
window.fylResolveGroupedProductsByArticulos = fylResolveGroupedProductsByArticulos;
window.configurarEventos = configurarEventos;
window.fylProductHasSizesInMemory = fylProductHasSizesInMemory;
window.fylRebuildCatalogSizeIndex = fylRebuildCatalogSizeIndex;
window.initCatalogCardDelegation = initCatalogCardDelegation;
window.fylApplyFullCatalogBackground = fylApplyFullCatalogBackground;
window.mainImageFallback = mainImageFallback;

// Exponer productosPendientes para acceso desde otros módulos (solo lectura)
Object.defineProperty(window, 'productosPendientes', {
  get: function() { return productosPendientes; },
  enumerable: true,
  configurable: false
});
