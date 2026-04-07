/**
 * FYL Analytics (GA4). Solo catalog y client. Admin no se mide.
 * Legado no instrumentado (no cargar en produccion): scripts/main.js, scripts/main-optimized.js,
 * scripts/index2.html, scripts/pwa.js, scripts/image-manager.js (usan gtag directo si se incluyen).
 */
import { parseARSNumber } from "./utils/price.js";

const DEFAULT_MEASUREMENT_ID = "G-2JDYZW1KD6";
const VALID_APP_AREAS = new Set(["catalog", "client"]);
const PAGE_VIEW_DEBOUNCE_MS = 400;
const MAX_VIEW_ITEM_LIST_ITEMS = 30;
let _ready = false, _appArea = null, _pageType = "other", _userRole = "guest";
let _measurementId = DEFAULT_MEASUREMENT_ID, _debug = false, _spaInstalled = false;
let _lastPageKey = "", _lastPageTs = 0, _lastListContextKey = null;
function _hostname() { return typeof location !== "undefined" ? location.hostname || "" : ""; }
function _isLocalHost() { const h = _hostname(); return h === "localhost" || h === "127.0.0.1" || h === "[::1]"; }
function _env() { return _isLocalHost() ? "local" : "production"; }
function _isDebugMode() { return _debug || _isLocalHost(); }
function _warn(msg, d) { if (_isDebugMode()) console.warn("[fylAnalytics]", msg, d !== undefined ? d : ""); }
function _globals(x) { x = x || {}; return { app_area: _appArea || undefined, page_type: _pageType, user_role: _userRole, environment: _env(), ...x }; }
function _gtag() { return typeof gtag === "function" ? gtag : null; }
function _ensureReady() { return _ready && !!_gtag(); }
function _inferCatalogPageType() {
  if (typeof document === "undefined" || typeof location === "undefined") return "home";
  const modal = document.getElementById("product-modal");
  if (modal && modal.classList.contains("active")) return "pdp";
  const hash = location.hash || "";
  if (hash.indexOf("#/pdp/") === 0) return "pdp";
  if (hash.indexOf("#/tag/") === 0) return "tag_filter";
  if (hash.indexOf("coleccion") >= 0 || hash.indexOf("#/coleccion/") === 0) return "collection";
  const bar = document.getElementById("tag-filter-bar");
  if (bar && bar.dataset && bar.dataset.filterType === "search") return "search_results";
  const tab = new URLSearchParams(location.search).get("tab");
  if (tab && String(tab).trim() !== "") return "category";
  return "home";
}
function _applyCatalogSurfacePageType() {
  if (_appArea !== "catalog") return;
  const inferred = _inferCatalogPageType();
  if (inferred !== _pageType) _pageType = inferred;
}
function _emitPageviewFromLocation(o) {
  if (!_ensureReady() || _appArea !== "catalog") return;
  o = o || {};
  _applyCatalogSurfacePageType();
  const title = o.page_title != null ? o.page_title : document.title;
  const loc = o.page_location != null ? o.page_location : location.href;
  const path = o.page_path != null ? o.page_path : location.pathname + location.search + location.hash;
  pageview({ page_title: title, page_location: loc, page_path: path, page_type: o.page_type });
}
function _patchHistory() {
  if (_spaInstalled || typeof history === "undefined") return;
  _spaInstalled = true;
  const op = history.pushState.bind(history), or = history.replaceState.bind(history);
  history.pushState = function () {
    const r = op.apply(history, arguments);
    queueMicrotask(function () { _emitPageviewFromLocation(); });
    return r;
  };
  history.replaceState = function () {
    const r = or.apply(history, arguments);
    queueMicrotask(function () { _emitPageviewFromLocation(); });
    return r;
  };
  window.addEventListener("hashchange", function () { _emitPageviewFromLocation(); });
  window.addEventListener("popstate", function () { _emitPageviewFromLocation(); });
}
function init(options) {
  options = options || {};
  const area = options.app_area;
  if (!VALID_APP_AREAS.has(area)) {
    _warn("init omitido app_area invalido", area);
    _ready = false;
    _appArea = null;
    return;
  }
  _appArea = area;
  _pageType = options.page_type || (area === "catalog" ? _inferCatalogPageType() : "other");
  _userRole = options.user_role || "guest";
  _measurementId = options.measurement_id || DEFAULT_MEASUREMENT_ID;
  _debug = options.debug === true;
  _ready = true;
  const g = _gtag();
  if (!g) _warn("sin gtag");
  else {
    const cfg = { send_page_view: false };
    if (_isDebugMode()) cfg.debug_mode = true;
    g("config", _measurementId, cfg);
  }
  if (area === "catalog" && options.enableSpaTracking !== false) {
    _patchHistory();
    queueMicrotask(function () { _emitPageviewFromLocation(); });
  } else if (area === "client") {
    queueMicrotask(function () {
      pageview({
        page_title: document.title,
        page_location: location.href,
        page_path: location.pathname + location.search + location.hash,
      });
    });
  }
}
function setPageType(pt) { if (pt && typeof pt === "string") _pageType = pt; }
function setUserRole(role) { if (role === "guest" || role === "customer") _userRole = role; }
function pageview(data) {
  data = data || {};
  if (!_ensureReady()) return;
  if (_appArea === "catalog") {
    if (data.page_type) _pageType = data.page_type;
    else _applyCatalogSurfacePageType();
  } else if (data.page_type) _pageType = data.page_type;
  const pt = data.page_title != null ? data.page_title : document.title;
  const pl = data.page_location != null ? data.page_location : location.href;
  const pp = data.page_path != null ? data.page_path : location.pathname + location.search + location.hash;
  const sep = "\x7c";
  const key = pp + sep + pl;
  const now = Date.now();
  if (key === _lastPageKey && now - _lastPageTs < PAGE_VIEW_DEBOUNCE_MS) return;
  _lastPageKey = key;
  _lastPageTs = now;
  _gtag()("event", "page_view", { page_title: pt, page_location: pl, page_path: pp, ..._globals() });
}
function event(name, params) {
  params = params || {};
  if (!_ensureReady() || !name) return;
  _gtag()("event", name, { ..._globals(), ...params });
}
function ecommerceEvent(name, params) {
  params = params || {};
  if (!_ensureReady() || !name) return;
  _gtag()("event", name, { ..._globals(), ...params });
}
function identify(userData) {
  userData = userData || {};
  if (!_ensureReady()) return;
  const uid = userData.user_id;
  if (!uid || typeof uid !== "string") return;
  const safe = uid.trim();
  if (!safe || safe.length > 128) return;
  _gtag()("config", _measurementId, { user_id: safe });
}
/** INITIAL_SESSION: identify + rol. SIGNED_IN: lo mismo + login_success. SIGNED_OUT: guest. */
function onSupabaseAuthEvent(authEvent, session) {
  if (!_ensureReady()) return;
  if (authEvent === "SIGNED_OUT" || !session?.user) {
    setUserRole("guest");
    return;
  }
  const user = session.user;
  const method = user.app_metadata?.provider || (user.email ? "email" : "unknown");
  identify({ user_id: user.id });
  setUserRole("customer");
  if (authEvent === "SIGNED_IN") {
    _gtag()("event", "login_success", _globals({ method }));
  }
}
function trackViewItemListOnce(contextKey, params) {
  params = params || {};
  if (!_ensureReady() || _appArea !== "catalog") return;
  if (!contextKey || contextKey === _lastListContextKey) return;
  _lastListContextKey = contextKey;
  ecommerceEvent("view_item_list", { ...params, ..._globals() });
}
function resetViewItemListContext() { _lastListContextKey = null; }
function purchase() { _warn("purchase reservado"); }
function buildItemsFromGroupedProducts(products, maxItems) {
  maxItems = maxItems == null ? MAX_VIEW_ITEM_LIST_ITEMS : maxItems;
  const out = [];
  const slice = (products || []).slice(0, maxItems);
  for (let i = 0; i < slice.length; i++) {
    const p = slice[i];
    if (!p || p.type === "offer") continue;
    const art = p.Articulo || p.articulo || "";
    if (!art) continue;
    const dc = Array.isArray(p.DetalleColor) && p.DetalleColor[0];
    const variantLabel = dc && dc.color ? dc.color : "";
    const priceNum = parsePriceNumberFromProduct(p);
    out.push({ item_id: String(art), item_name: String(art), item_category: p.Categoria || "", item_variant: variantLabel, price: priceNum, quantity: 1 });
  }
  return out;
}
function parsePriceNumberFromProduct(producto) {
  if (!producto) return 0;
  const hasOffer = producto.OfertaActiva === true || producto.OfertaActiva === "true";
  const raw = hasOffer && producto.PrecioOferta ? producto.PrecioOferta : producto.Precio || producto.precio || "";
  return parseARSNumber(raw);
}
function buildCartItemsFromLines(lines, maxItems) {
  maxItems = maxItems == null ? 50 : maxItems;
  const out = [];
  const arr = Array.isArray(lines) ? lines : [];
  for (let i = 0; i < Math.min(arr.length, maxItems); i++) {
    const line = arr[i];
    const qty = Number(line.cantidad != null ? line.cantidad : line.quantity != null ? line.quantity : line.qty != null ? line.qty : 1) || 1;
    const name = line.articulo || line.product_name || "";
    const price = parsePriceNumberFromLine(line);
    const iv = [line.color, line.talle || line.size].filter(Boolean).join(" / ");
    out.push({ item_id: String(name || line.id || "item"), item_name: String(name || "item"), item_variant: iv, price: price, quantity: qty });
  }
  return out;
}
function parsePriceNumberFromLine(line) {
  if (!line) return 0;
  const raw = line.precio != null ? line.precio : line.price_snapshot != null ? line.price_snapshot : line.price != null ? line.price : "";
  return parseARSNumber(raw);
}
export const fylAnalytics = {
  init: init,
  setPageType: setPageType,
  setUserRole: setUserRole,
  pageview: pageview,
  event: event,
  ecommerceEvent: ecommerceEvent,
  identify: identify,
  onSupabaseAuthEvent: onSupabaseAuthEvent,
  trackViewItemListOnce: trackViewItemListOnce,
  resetViewItemListContext: resetViewItemListContext,
  purchase: purchase,
  buildItemsFromGroupedProducts: buildItemsFromGroupedProducts,
  buildCartItemsFromLines: buildCartItemsFromLines,
  parsePriceNumberFromProduct: parsePriceNumberFromProduct,
  syncCatalogSurface: function (extra) {
    if (!_ready || _appArea !== "catalog") return;
    _applyCatalogSurfacePageType();
    if (!extra || extra.emit !== false) _emitPageviewFromLocation(extra);
  },
  getPageType: function () { return _pageType; },
  isReady: function () { return _ready; },
};
if (typeof window !== "undefined") window.fylAnalytics = fylAnalytics;