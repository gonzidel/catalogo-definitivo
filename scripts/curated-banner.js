// scripts/curated-banner.js — Banner curado por variant_id (Fase 3–4)
// Legacy custom-banner.js: carga física condicional (fyl-legacy-banner-loader.js).

import { supabase } from "./supabase-client.js";
import {
  CATALOG_AVAILABLE_VIEW,
  getCatalogAvailableSource,
} from "./catalog-source.js";
import { isPostgrestSchemaColumnError } from "./net/fyl-fetch.js?v=m260523";

const LEGACY_TAG_PLACEHOLDER = "__curated__";
const CURATED_CATALOG_SELECT =
  'variant_id,Articulo,Descripcion,Color,Precio,"Imagen Principal",OfertaActiva,PrecioOferta';
const CACHE_TTL_MS = 60_000;
const PDP_OPEN_DEBOUNCE_MS = 450;
const SKELETON_CARD_COUNT = 4;

let activeScrollCleanup = null;
let activeCardHandler = null;
/** @type {{ config: object, cards: object[] } | null} */
let activeRoute = null;
let routeLoadPromise = null;
let lastPdpOpenAt = 0;
let lastPdpSku = "";

/** @type {Map<string, { at: number, config?: object, cards?: object[] }>} */
const shortCache = new Map();

function fylCuratedBannerDebugEnabled() {
  if (typeof window === "undefined") return false;
  if (window.FYL_DEBUG_CATALOG === true || window.FYL_DEBUG_CURATED_BANNER === true) {
    return true;
  }
  try {
    return /(?:^|[&?])debug=(?:catalog|banner)(?:&|$)/.test(window.location.search || "");
  } catch {
    return false;
  }
}

function logCuratedDebug(step, detail = null) {
  if (!fylCuratedBannerDebugEnabled()) return;
  if (detail != null) console.info("[FYL Curated Banner]", step, detail);
  else console.info("[FYL Curated Banner]", step);
}

/** URL ?curated_banner=1|0 o localStorage; por defecto ON (banner home = __curated__). */
export function resolveCuratedBannerV1Flag() {
  if (typeof window === "undefined") return true;
  try {
    if (window.FYL_CURATED_BANNER_V1 === true) return true;
    if (window.FYL_CURATED_BANNER_V1 === false) return false;
    const q = window.location.search || "";
    if (/(?:^|[&?])curated_banner=0(?:&|$)/.test(q)) return false;
    if (/(?:^|[&?])curated_banner=1(?:&|$)/.test(q)) return true;
    if (localStorage.getItem("FYL_CURATED_BANNER_V1") === "0") return false;
    if (localStorage.getItem("FYL_CURATED_BANNER_V1") === "1") return true;
  } catch (_e) {}
  return true;
}

export function isCuratedBannerV1Enabled() {
  return typeof window !== "undefined" && window.FYL_CURATED_BANNER_V1 === true;
}

export function parseHashBannerSlug(hashOrLocation) {
  let hash = "";
  if (typeof hashOrLocation === "string") {
    hash = hashOrLocation.startsWith("#") ? hashOrLocation : `#${hashOrLocation}`;
  } else if (hashOrLocation?.hash) {
    hash = hashOrLocation.hash;
  } else if (typeof location !== "undefined") {
    hash = location.hash || "";
  }
  const match = hash.match(/^#\/banner\/([^/?#]+)$/i);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return String(match[1] || "").trim();
  }
}

export function buildBannerHash(slug) {
  const s = String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s) return "#/";
  return `#/banner/${encodeURIComponent(s)}`;
}

function cacheKeyForConfig(slug) {
  return slug ? `slug:${slug.trim().toLowerCase()}` : "home";
}

function readCache(key) {
  const hit = shortCache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit;
}

function writeCache(key, partial) {
  const prev = shortCache.get(key) || { at: 0 };
  shortCache.set(key, { ...prev, ...partial, at: Date.now() });
}

export async function loadCuratedBannerConfig({ slug = null } = {}) {
  const key = cacheKeyForConfig(slug);
  const cached = readCache(key);
  if (cached?.config) return slug ? cached.config : [cached.config];

  let query = supabase
    .from("custom_product_banners")
    .select(
      `id, title, slug, description, enabled, sort_order, tag_value,
       custom_product_banner_items ( product_variant_id, position )`
    )
    .eq("enabled", true)
    .order("position", {
      foreignTable: "custom_product_banner_items",
      ascending: true,
    });

  if (slug) {
    const normalized = String(slug).trim().toLowerCase();
    query = query
      .eq("slug", normalized)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle();
  } else {
    query = query
      .eq("tag_value", LEGACY_TAG_PLACEHOLDER)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  }

  const { data, error } = await query;
  if (error) {
    if (error.code === "PGRST116") {
      logCuratedDebug("loadCuratedBannerConfig:empty", { slug: slug || "home" });
      return slug ? null : [];
    }
    console.error("[curated-banner] loadCuratedBannerConfig:", error);
    logCuratedDebug("loadCuratedBannerConfig:error", error);
    return slug ? null : [];
  }

  const config = pickCuratedConfigFromRow(data);
  logCuratedDebug("loadCuratedBannerConfig:row", {
    slug: slug || "home",
    found: Boolean(config),
    sample: config
      ? {
          id: config.id,
          slug: config.slug,
          sort_order: config.sort_order,
          tag_value: config.tag_value,
          items: config.items.length,
        }
      : null,
  });

  if (slug) {
    if (config) writeCache(key, { config });
    return config;
  }

  if (config) writeCache(key, { config });
  return config ? [config] : [];
}

/** Primer banner curated válido desde fila PostgREST (0 o 1 fila vía maybeSingle). */
function pickCuratedConfigFromRow(row) {
  if (!row) return null;
  const cfg = normalizeBannerConfig(row);
  if (cfg.items.length === 0) return null;
  if (cfg.tag_value !== LEGACY_TAG_PLACEHOLDER) return null;
  return cfg;
}

function normalizeBannerConfig(row) {
  const items = (row?.custom_product_banner_items || [])
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return {
    id: row.id,
    title: row.title || row.name || "Destacados",
    slug: row.slug || "",
    description: row.description || "",
    enabled: row.enabled !== false,
    sort_order: row.sort_order ?? 0,
    tag_value: row.tag_value || "",
    items,
  };
}

export async function fetchCuratedBannerCards(config) {
  if (!config?.items?.length) return [];

  const cacheKey = `${cacheKeyForConfig(config.slug)}:cards`;
  const cached = readCache(cacheKey);
  if (cached?.cards) return cached.cards;

  const orderedVariantIds = config.items.map((i) => i.product_variant_id).filter(Boolean);
  if (!orderedVariantIds.length) return [];

  const primarySource = getCatalogAvailableSource();
  let catalogRows = null;
  let catErr = null;

  const primary = await supabase
    .from(primarySource)
    .select(CURATED_CATALOG_SELECT)
    .in("variant_id", orderedVariantIds);
  catalogRows = primary.data;
  catErr = primary.error;

  if (
    catErr &&
    isPostgrestSchemaColumnError(catErr) &&
    primarySource !== CATALOG_AVAILABLE_VIEW
  ) {
    logCuratedDebug("fetchCuratedBannerCards:fallback_view", {
      from: primarySource,
      to: CATALOG_AVAILABLE_VIEW,
    });
    const fallback = await supabase
      .from(CATALOG_AVAILABLE_VIEW)
      .select(CURATED_CATALOG_SELECT)
      .in("variant_id", orderedVariantIds);
    catalogRows = fallback.data;
    catErr = fallback.error;
  }

  const { data: variants, error: varErr } = await supabase
    .from("product_variants")
    .select("id, sku")
    .in("id", orderedVariantIds);

  if (catErr) throw catErr;
  if (varErr) throw varErr;

  logCuratedDebug("fetchCuratedBannerCards:catalog", {
    source: primarySource,
    requested: orderedVariantIds.length,
    matched: (catalogRows || []).length,
  });

  const catalogByVariant = new Map((catalogRows || []).map((r) => [r.variant_id, r]));
  const skuByVariant = new Map((variants || []).map((v) => [v.id, v.sku || ""]));

  const cards = [];
  for (const item of config.items) {
    const vid = item.product_variant_id;
    const row = catalogByVariant.get(vid);
    if (!row || !row["Imagen Principal"]) continue;
    cards.push({
      ...row,
      representative_sku: skuByVariant.get(vid) || "",
      product_variant_id: vid,
    });
  }

  writeCache(cacheKey, { cards });
  return cards;
}

function trackCuratedBannerClick({ slug, articulo, sku, surface }) {
  const payload = {
    banner: String(slug || "curated"),
    articulo: String(articulo || ""),
    sku: String(sku || ""),
    surface: String(surface || "carousel"),
  };
  try {
    if (window.fylAnalytics?.isReady?.()) {
      window.fylAnalytics.event("curated_banner_product_click", payload);
    }
  } catch (_e) {}
  try {
    if (typeof fbq === "function") {
      fbq("trackCustom", "CuratedBannerProductClick", payload);
    }
  } catch (_e) {}
}

export function openBannerProductPdp(sku, hint = {}) {
  const safe = String(sku || "").trim();
  if (!safe) return false;

  const now = Date.now();
  if (safe === lastPdpSku && now - lastPdpOpenAt < PDP_OPEN_DEBOUNCE_MS) {
    return false;
  }
  lastPdpSku = safe;
  lastPdpOpenAt = now;

  const cardHint = {
    imagen: hint.imagen || "",
    nombre: hint.nombre || "",
    color: hint.color || "",
  };

  if (typeof window.abrirPdpPorSkuIfPossible === "function") {
    window.abrirPdpPorSkuIfPossible(safe, { pushState: true, hint: cardHint }).catch((err) => {
      console.warn("[curated-banner] PDP:", err?.message || err);
    });
    return true;
  }
  if (typeof window.abrirModalPorSKU === "function") {
    return window.abrirModalPorSKU(safe, { pushState: true }) !== false;
  }
  const href = `#/pdp/${encodeURIComponent(safe)}`;
  if (location.hash !== href) location.hash = href;
  return true;
}

function getOrCreateCuratedBannerTopTitleEl() {
  let el = document.getElementById("curated-banner-top-title");
  if (el) return el;
  const info = document.getElementById("info-banner-top-container");
  if (!info?.parentElement) return null;
  el = document.createElement("div");
  el.id = "curated-banner-top-title";
  el.className = "curated-banner-top-title is-hidden";
  el.setAttribute("aria-live", "polite");
  info.insertAdjacentElement("afterend", el);
  return el;
}

/** En «Ver todo»: oculta guía de compra y muestra título editado del banner curado. */
function setCuratedBannerTopChrome(config, visible) {
  const info = document.getElementById("info-banner-top-container");
  if (info) info.classList.toggle("is-hidden", Boolean(visible));

  const top = getOrCreateCuratedBannerTopTitleEl();
  if (!top) return;

  if (!visible || !config) {
    top.classList.add("is-hidden");
    top.innerHTML = "";
    if (typeof window.syncInfoBannerVisibility === "function") {
      window.syncInfoBannerVisibility();
    }
    return;
  }

  top.classList.remove("is-hidden");
  top.innerHTML = `
    <div class="curated-banner-top-title__inner">
      <a href="#/" class="curated-banner-back">&larr; Inicio</a>
      <h1 class="curated-banner-top-title__text">${escapeHtml(config.title || config.name || "Destacados")}</h1>
    </div>
  `;
}

export function destroyCuratedBanner() {
  if (typeof activeScrollCleanup === "function") {
    activeScrollCleanup();
    activeScrollCleanup = null;
  }
  if (activeCardHandler) {
    const scroll = getScrollContainer();
    scroll?.removeEventListener("click", activeCardHandler);
    activeCardHandler = null;
  }

  const banner = document.getElementById("custom-banner-container");
  if (banner) banner.style.display = "none";
  const inline = document.getElementById("custom-banner-container-inline");
  if (inline) inline.style.display = "none";
  const wrapper = document.getElementById("custom-banner-wrapper");
  const homeSlot = document.getElementById("home-custom-banner-slot");
  if (wrapper && !(homeSlot && homeSlot.contains(wrapper))) {
    wrapper.remove();
  } else if (homeSlot) {
    homeSlot.hidden = true;
    homeSlot.setAttribute("aria-hidden", "true");
  }

  const fullpage = document.getElementById("curated-banner-fullpage");
  if (fullpage) fullpage.remove();
  document.querySelector(".curated-banner-fullpage-header")?.remove();
  setCuratedBannerTopChrome(null, false);

  activeRoute = null;
  if (typeof window !== "undefined") {
    window.__fylCuratedBannerCatalogOverride = false;
  }
  restoreDefaultPageTitle();
}

function getScrollContainer() {
  const inline = document.getElementById("custom-banner-container-inline");
  if (inline) return inline.querySelector("#custom-banner-scroll");
  return document.getElementById("custom-banner-scroll");
}

function getBannerShell() {
  let banner = document.getElementById("custom-banner-container-inline");
  let scrollContainer = banner?.querySelector("#custom-banner-scroll") || null;
  let headerTitle = banner?.querySelector("#custom-banner-title") || null;
  let headerContainer = banner?.querySelector(".custom-banner-header") || null;

  if (!banner) {
    banner = document.getElementById("custom-banner-container");
    scrollContainer = document.getElementById("custom-banner-scroll");
    headerTitle = document.getElementById("custom-banner-title");
    headerContainer = banner?.querySelector(".custom-banner-header") || null;
  }
  return { banner, scrollContainer, headerTitle, headerContainer };
}

function formatPrice(value) {
  const n = parseARSNumber(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0) return String(value || "");
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n);
}

function parseARSNumber(text) {
  const cleaned = String(text || "").replace(/[^\d.,]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function cloudinaryOptimized(url, width) {
  if (!url) return "";
  if (url.includes("cloudinary.com")) {
    return url.replace(/\/upload\//, `/upload/w_${width},q_auto,f_auto/`);
  }
  return url;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCardHtml(card) {
  const precio =
    card.OfertaActiva && card.PrecioOferta ? card.PrecioOferta : card.Precio;
  const nombre = card.Articulo || card.Descripcion || "Producto";
  const sku = card.representative_sku || "";
  const disabled = !sku;
  return `
    <div class="custom-banner-card${disabled ? " custom-banner-card--disabled" : ""}"
         data-representative-sku="${escapeHtml(sku)}"
         data-articulo="${escapeHtml(card.Articulo || "")}"
         data-variant-id="${escapeHtml(card.variant_id || card.product_variant_id || "")}"
         ${disabled ? 'aria-disabled="true"' : ""}>
      <div class="custom-banner-badge">${escapeHtml(nombre)}</div>
      <img class="custom-banner-card-image"
           src="${escapeHtml(cloudinaryOptimized(card["Imagen Principal"], 400))}"
           alt="${escapeHtml(nombre)}"
           width="110"
           height="110"
           loading="lazy"
           decoding="async">
      <div class="custom-banner-card-content">
        <div class="custom-banner-card-price">${escapeHtml(formatPrice(precio))}</div>
      </div>
    </div>
  `;
}

function renderBannerSkeletonHtml(count = SKELETON_CARD_COUNT) {
  return Array.from({ length: count }, () => `
    <div class="custom-banner-card custom-banner-card--skeleton" aria-hidden="true">
      <div class="custom-banner-card-image"></div>
      <div class="custom-banner-card-content">
        <div class="custom-banner-card-price" style="height:14px;background:#eee;border-radius:4px;"></div>
      </div>
    </div>
  `).join("");
}

function showBannerSkeleton() {
  const { banner, scrollContainer, headerTitle } = getBannerShell();
  if (!banner || !scrollContainer) return;
  if (headerTitle) headerTitle.textContent = "Destacados";
  scrollContainer.innerHTML = renderBannerSkeletonHtml();
  banner.style.display = "block";
}

function bindCarouselInteractions(scrollContainer, config) {
  if (!scrollContainer) return;

  if (activeCardHandler) {
    scrollContainer.removeEventListener("click", activeCardHandler);
  }

  activeCardHandler = (event) => {
    const card = event.target.closest(".custom-banner-card");
    if (!card || !scrollContainer.contains(card) || card.classList.contains("custom-banner-card--skeleton")) {
      return;
    }
    const sku = card.getAttribute("data-representative-sku");
    if (!sku) return;
    const surface = scrollContainer.closest("#curated-banner-fullpage") ? "fullpage" : "carousel";
    trackCuratedBannerClick({
      slug: config?.slug,
      articulo: card.getAttribute("data-articulo") || "",
      sku,
      surface,
    });
    const img = card.querySelector(".custom-banner-card-image");
    const badge = card.querySelector(".custom-banner-badge");
    openBannerProductPdp(sku, {
      imagen: img?.src || "",
      nombre: badge?.textContent?.trim() || "",
      color: card.getAttribute("data-color") || "",
    });
  };
  scrollContainer.addEventListener("click", activeCardHandler);
}

function updateVerTodoLink(headerContainer, config) {
  if (!headerContainer || !config?.slug) return;
  let btn = headerContainer.querySelector(".custom-banner-ver-todo-btn");
  const href = buildBannerHash(config.slug);
  if (!btn) {
    btn = document.createElement("a");
    btn.className = "custom-banner-ver-todo-btn";
    btn.style.cssText =
      "display:flex;align-items:center;gap:4px;color:#CD844D;text-decoration:none;font-size:0.9rem;font-weight:500;min-height:44px;padding:4px 0;";
    headerContainer.appendChild(btn);
  }
  btn.href = href;
  btn.innerHTML =
    'Ver todo <svg class="custom-banner-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><polyline points="9 18 15 12 9 6"></polyline></svg>';
  btn.onclick = (e) => {
    e.preventDefault();
    if (location.hash !== href) {
      location.hash = href;
    } else {
      applyCuratedBannerHashRoute(config.slug);
    }
  };
}

let defaultDocumentTitle = "";

function updateCuratedBannerPageMeta(config) {
  defaultDocumentTitle = defaultDocumentTitle || document.title || "Catálogo FYL";
  const title = config?.title ? `${config.title} | FYL` : "Destacados | FYL";
  document.title = title;
  try {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" in window ? "instant" : "auto" });
  } catch {
    window.scrollTo(0, 0);
  }
  try {
    if (window.fylAnalytics?.setPageContext) {
      window.fylAnalytics.setPageContext({ page_type: "curated_banner", item_list_name: config?.slug || "" });
    }
  } catch (_e) {}
}

function restoreDefaultPageTitle() {
  if (defaultDocumentTitle) document.title = defaultDocumentTitle;
}

export function renderCuratedBannerCarousel(cards, config) {
  const { banner, scrollContainer, headerTitle, headerContainer } = getBannerShell();
  if (!banner || !scrollContainer) return false;

  const fullpage = document.getElementById("curated-banner-fullpage");
  if (fullpage) fullpage.remove();

  if (!cards?.length) {
    banner.style.display = "none";
    return false;
  }

  if (headerTitle) headerTitle.textContent = config?.title || "Destacados";
  updateVerTodoLink(headerContainer, config);

  scrollContainer.innerHTML = cards.map((c) => renderCardHtml(c)).join("");
  bindCarouselInteractions(scrollContainer, config);
  banner.style.display = "block";

  const topBanner = document.getElementById("custom-banner-container");
  const isInline = banner.id === "custom-banner-container-inline";
  if (isInline && topBanner) {
    topBanner.style.display = "none";
  } else if (!isInline && topBanner) {
    topBanner.style.display = "block";
  }

  logCuratedDebug("renderCuratedBannerCarousel:ok", {
    target: banner.id,
    cards: cards.length,
  });
  return true;
}

function collectArticulosInBannerOrder(cards) {
  const ordered = [];
  const seen = new Set();
  for (const card of cards || []) {
    const art = String(card.Articulo || "").trim();
    if (!art || seen.has(art)) continue;
    seen.add(art);
    ordered.push(art);
  }
  return ordered;
}

export async function renderCuratedBannerFullPage(cards, config) {
  destroyCuratedBanner();

  const catalogo = document.getElementById("catalogo");
  if (!catalogo) return false;

  if (typeof window.hideFYLOriginalsBanner === "function") {
    window.hideFYLOriginalsBanner();
  }
  if (typeof window.hidePromotionalBanner === "function") {
    window.hidePromotionalBanner();
  }

  updateCuratedBannerPageMeta(config);
  ensureFullPageStyles();
  setCuratedBannerTopChrome(config, true);
  return renderCuratedBannerFullPageCatalogGrid(catalogo, cards, config);
}

async function renderCuratedBannerFullPageCatalogGrid(catalogo, cards, config) {
  const articulos = collectArticulosInBannerOrder(cards);
  let products = [];
  try {
    if (typeof window.fylResolveGroupedProductsByArticulos === "function") {
      products = await window.fylResolveGroupedProductsByArticulos(articulos);
    }
  } catch (err) {
    console.error("[curated-banner] renderCuratedBannerFullPage:", err);
    logCuratedDebug("fullpage:resolve_error", err);
  }

    if (!products.length) {
    catalogo.innerHTML =
      '<div class="no-data" style="grid-column:1/-1;text-align:center;padding:2rem;color:#666;">No hay productos visibles en este banner</div>';
    return false;
  }

  catalogo.innerHTML = "";

  if (typeof window.renderizarProductosPagina === "function") {
    await window.renderizarProductosPagina(products, catalogo, [], 0, null, {
      skipBanner: true,
    });
  }
  if (typeof window.configurarEventos === "function") {
    window.configurarEventos();
  }
  if (typeof window.refreshCatalogFilterBar === "function") {
    window.refreshCatalogFilterBar();
  }

  activeRoute = { config, cards, products };
  if (typeof window !== "undefined") {
    window.__fylCuratedBannerCatalogOverride = true;
  }
  if (typeof window.ocultarBotonVerMas === "function") window.ocultarBotonVerMas();
  logCuratedDebug("renderCuratedBannerFullPage:ok", { products: products.length });
  return true;
}

function ensureFullPageStyles() {
  const styleId = "curated-banner-fullpage-style";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = `
    .curated-banner-top-title {
      padding: 10px 12px 8px;
    }
    .curated-banner-top-title.is-hidden {
      display: none !important;
    }
    .curated-banner-top-title__inner {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 10px 12px;
      min-height: 44px;
    }
    .curated-banner-top-title .curated-banner-back {
      flex: 0 0 auto;
      color: #CD844D;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      padding: 4px 0;
    }
    .curated-banner-top-title__text {
      flex: 1 1 auto;
      min-width: 0;
      margin: 0;
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #1a1a1a;
      line-height: 1.2;
    }
    @media (min-width: 390px) {
      .curated-banner-top-title__text {
        font-size: 1.35rem;
      }
    }
  `;
}

export async function applyCuratedBannerHashRoute(slug) {
  if (!isCuratedBannerV1Enabled()) return false;
  const normalized = String(slug || "").trim();
  if (!normalized) return false;

  if (
    activeRoute?.config?.slug?.toLowerCase() === normalized.toLowerCase() &&
    document.getElementById("curated-banner-top-title") &&
      !document.getElementById("curated-banner-top-title")?.classList.contains("is-hidden")
  ) {
    updateCuratedBannerPageMeta(activeRoute.config);
    setCuratedBannerTopChrome(activeRoute.config, true);
    return true;
  }

  if (routeLoadPromise) {
    return routeLoadPromise;
  }

  routeLoadPromise = (async () => {
    try {
      const config = await loadCuratedBannerConfig({ slug: normalized });
      if (!config) {
        const catalogo = document.getElementById("catalogo");
        if (catalogo) {
          catalogo.innerHTML =
            '<div class="no-data" style="text-align:center;padding:2rem;color:#666;">Banner no encontrado</div>';
        }
        return false;
      }
      const cards = await fetchCuratedBannerCards(config);
      if (!cards.length) {
        const catalogo = document.getElementById("catalogo");
        if (catalogo) {
          catalogo.innerHTML =
            '<div class="no-data" style="text-align:center;padding:2rem;color:#666;">Este banner no tiene productos visibles</div>';
        }
        return false;
      }
      return await renderCuratedBannerFullPage(cards, config);
    } finally {
      routeLoadPromise = null;
    }
  })();

  return routeLoadPromise;
}

export async function loadAndShowCuratedBanner(options = {}) {
  if (!isCuratedBannerV1Enabled()) {
    logCuratedDebug("loadAndShow:skipped", { reason: "FYL_CURATED_BANNER_V1 false" });
    return false;
  }

  if (location.hash === "#/coleccion/fyl-originals") {
    destroyCuratedBanner();
    return false;
  }

  if (parseHashBannerSlug(location.hash)) {
    logCuratedDebug("loadAndShow:skipped", { reason: "banner hash route" });
    return false;
  }

  const preferInline = options.preferInline !== false;
  const hasInline = Boolean(document.getElementById("custom-banner-container-inline"));
  if (preferInline && !hasInline && options.waitForInline) {
    logCuratedDebug("loadAndShow:deferred", { reason: "waiting for inline slot" });
    return false;
  }

  showBannerSkeleton();

  const configs = await loadCuratedBannerConfig();
  const config = Array.isArray(configs) ? configs[0] : configs;
  if (!config) {
    logCuratedDebug("loadAndShow:no_config", {
      hint: "tag_value=__curated__, enabled=true, items>0",
    });
    destroyCuratedBanner();
    return false;
  }

  try {
    const cards = await fetchCuratedBannerCards(config);
    if (!cards.length) {
      logCuratedDebug("loadAndShow:no_cards", {
        hint: "variant_id en catalog_public_available_view/snapshot con Imagen Principal",
        catalogSource: getCatalogAvailableSource(),
      });
      destroyCuratedBanner();
      return false;
    }
    const ok = renderCuratedBannerCarousel(cards, config) === true;
    if (ok && typeof window !== "undefined") {
      window.__fylPendingHomeCustomBanner = false;
      window.dispatchEvent(new CustomEvent("fyl-curated-banner-ready"));
    }
    return ok;
  } catch (err) {
    console.error("[curated-banner] loadAndShowCuratedBanner:", err);
    logCuratedDebug("loadAndShow:error", err);
    destroyCuratedBanner();
    return false;
  }
}

/** Diagnóstico en consola (staging). */
export async function fylAuditCuratedBanner() {
  const report = {
    flag: {
      FYL_CURATED_BANNER_V1: window.FYL_CURATED_BANNER_V1,
      resolved: resolveCuratedBannerV1Flag(),
      enabled: isCuratedBannerV1Enabled(),
      tip: "Activar: ?curated_banner=1 o localStorage.FYL_CURATED_BANNER_V1='1'",
    },
    route: {
      hash: location.hash,
      bannerSlug: parseHashBannerSlug(location.hash),
    },
    dom: {
      top: Boolean(document.getElementById("custom-banner-container")),
      inline: Boolean(document.getElementById("custom-banner-container-inline")),
    },
    catalogSource: getCatalogAvailableSource(),
  };

  try {
    const configs = await loadCuratedBannerConfig();
    const config = Array.isArray(configs) ? configs[0] : configs;
    report.config = config
      ? {
          id: config.id,
          slug: config.slug,
          tag_value: config.tag_value,
          items: config.items.length,
        }
      : null;
    if (config) {
      const cards = await fetchCuratedBannerCards(config);
      report.cards = cards.length;
    }
  } catch (err) {
    report.error = String(err?.message || err);
  }

  console.table(report.flag);
  console.log("[FYL Curated Banner audit]", report);
  return report;
}

function resolveHomeBannerLoader() {
  if (isCuratedBannerV1Enabled()) return loadAndShowCuratedBanner;
  if (typeof window.loadAndShowCustomBanner === "function") {
    return () => window.loadAndShowCustomBanner();
  }
  return null;
}

if (typeof window !== "undefined") {
  window.FYL_CURATED_BANNER_V1 = resolveCuratedBannerV1Flag();
  window.loadCuratedBannerConfig = loadCuratedBannerConfig;
  window.fetchCuratedBannerCards = fetchCuratedBannerCards;
  window.renderCuratedBannerCarousel = renderCuratedBannerCarousel;
  window.renderCuratedBannerFullPage = renderCuratedBannerFullPage;
  window.openBannerProductPdp = openBannerProductPdp;
  window.destroyCuratedBanner = destroyCuratedBanner;
  window.hideCuratedBanner = destroyCuratedBanner;
  window.loadAndShowCuratedBanner = loadAndShowCuratedBanner;
  window.applyCuratedBannerHashRoute = applyCuratedBannerHashRoute;
  window.parseHashBannerSlug = parseHashBannerSlug;
  window.buildBannerHash = buildBannerHash;
  window.isCuratedBannerV1Enabled = isCuratedBannerV1Enabled;
  window.resolveCuratedBannerV1Flag = resolveCuratedBannerV1Flag;
  window.fylAuditCuratedBanner = fylAuditCuratedBanner;
  window.__fylLoadHomeProductBanner = resolveHomeBannerLoader();
  logCuratedDebug("init", {
    enabled: window.FYL_CURATED_BANNER_V1,
    catalogSource: getCatalogAvailableSource(),
  });
}
