// scripts/catalogo-publico.js
// Comportamiento aislado para /catalogo publico.

import { supabase } from "./supabase-client.js";

const WHATSAPP_NUMBER = "5493625172874";
const publicFylSkuCache = new Map();

window.__CATALOG_ONLY__ = true;
window.__PUBLIC_CATALOG__ = true;
window.__FYL_PUBLIC_CATALOG__ = true;
document.documentElement.classList.add("catalog-only", "public-catalog");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getProductUrl(sku) {
  const url = new URL(window.location.href);
  url.searchParams.delete("sku");
  url.hash = sku ? `#/pdp/${encodeURIComponent(sku)}` : "#/";
  return url.toString();
}

function getSelectedPdpSize(modal) {
  const selected = modal?.querySelector(
    ".size-chip.is-active[data-size]:not(.size-chip--disabled), .size-chip.selected[data-size]:not(.size-chip--disabled)"
  );
  return cleanText(selected?.dataset?.size || selected?.textContent || "");
}

function buildWhatsappMessage({ model, sku, color, size, link }) {
  const identifier = cleanText([model, sku && sku !== model ? sku : ""].filter(Boolean).join(" / "));
  const lines = [`Hola, quiero consultar por este modelo: ${identifier || "producto FYL"}.`];
  if (link) lines.push(`Link: ${link}`);
  if (color) lines.push(`Color: ${color}`);
  if (size) lines.push(`Talle: ${size}`);
  return lines.join("\n");
}

function trackMetaWhatsappLead() {
  const payload = { content_name: "WhatsApp Click", content_category: "public_catalog" };
  if (typeof fbq === "function") {
    fbq("track", "Lead", payload);
    return;
  }
  setTimeout(() => {
    if (typeof fbq === "function") {
      fbq("track", "Lead", payload);
    }
  }, 300);
}

function buildWhatsappUrl(payload) {
  const text = encodeURIComponent(buildWhatsappMessage(payload));
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${text}`;
}

/**
 * Legacy: úselo SOLO desde código sin acceso a un <a target="_blank">.
 * En WebView Meta/Instagram/Samsung/Safari iOS, window.open desde un handler
 * delegado después de preventDefault() pierde el user gesture y queda
 * bloqueado como popup ⇒ dead click. Preferí navegación natural del <a>.
 */
function openWhatsapp(payload) {
  trackMetaWhatsappLead();
  window.open(buildWhatsappUrl(payload), "_blank", "noopener");
}

function getCardPayload(card) {
  const model = cleanText(card?.dataset?.articulo || card?.querySelector(".product-art-badge")?.textContent?.replace(/^Art\.\s*/i, ""));
  const sku = cleanText(card?.dataset?.sku || card?.querySelector(".main-image, .fyl-originals-card-image")?.dataset?.sku || "");
  const color = cleanText(card?.querySelector(".card-footer-size")?.dataset?.colorSelected || "");
  return {
    model,
    sku,
    color,
    link: getProductUrl(sku),
  };
}

function findPublicCatalogProductByArticle(articulo) {
  const article = cleanText(articulo);
  if (!article) return null;

  const fromMap = window.productosActualesMap?.get?.(article);
  if (fromMap) return fromMap;

  return (window.productosPendientes || []).find((product) => cleanText(product?.Articulo) === article) || null;
}

function getFirstPublicSku(product) {
  for (const detalleColor of product?.DetalleColor || []) {
    const details = detalleColor?.variantDetails || [];
    const inStock = details.find((detail) => detail?.sku && (detail.available === null || detail.available > 0));
    if (inStock?.sku) return inStock.sku;

    const firstSku = details.find((detail) => detail?.sku);
    if (firstSku?.sku) return firstSku.sku;
  }

  return "";
}

function getPublicPdpSelection(product, sku) {
  let color = "";
  let size = "";

  if (sku) {
    for (const detalleColor of product?.DetalleColor || []) {
      const variant = detalleColor?.variantDetails?.find((detail) => detail?.sku === sku);
      if (variant) {
        color = detalleColor.color || "";
        size = variant.talle || "";
        break;
      }
    }
  }

  if (!color) {
    const firstColor = product?.DetalleColor?.[0];
    const firstVariant = firstColor?.variantDetails?.[0];
    color = firstColor?.color || "";
    size = firstVariant?.talle || "";
  }

  return { color, size };
}

function normalizePublicPdpSoon() {
  const schedule = window.requestAnimationFrame || window.setTimeout;
  schedule(() => normalizePdpCta());
}

async function fetchPublicFylOriginalSku(articulo) {
  const article = cleanText(articulo);
  if (!article) return "";
  if (publicFylSkuCache.has(article)) return publicFylSkuCache.get(article);

  const { data, error } = await supabase
    .from("products")
    .select("name, product_variants(sku, active)")
    .eq("name", article)
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[public-catalog] No se pudo resolver SKU FYL Originals:", error.message);
    publicFylSkuCache.set(article, "");
    return "";
  }

  const variants = data?.product_variants || [];
  const sku = cleanText(variants.find((variant) => variant?.sku && variant.active !== false)?.sku || variants.find((variant) => variant?.sku)?.sku || "");
  publicFylSkuCache.set(article, sku);
  return sku;
}

async function openPublicFylOriginalPdp(card) {
  if (!card) return false;

  const skuFromCard = cleanText(card.dataset.sku || card.querySelector("[data-sku]")?.dataset?.sku || "");
  const articulo = cleanText(card.dataset.articulo);
  const product = findPublicCatalogProductByArticle(articulo);
  const sku = skuFromCard || getFirstPublicSku(product) || await fetchPublicFylOriginalSku(articulo);
  const hint = {
    imagen: card.querySelector(".fyl-originals-card-image")?.src || "",
    nombre: articulo,
  };

  if (product && typeof window.abrirModalConResultado === "function") {
    const selection = getPublicPdpSelection(product, sku);
    const opened = window.abrirModalConResultado(
      {
        producto: product,
        color: selection.color,
        talle: selection.size,
        sku,
      },
      { pushState: true }
    ) !== false;
    if (opened) normalizePublicPdpSoon();
    return opened;
  }

  if (sku && typeof window.abrirPdpPorSkuIfPossible === "function") {
    try {
      const opened = await window.abrirPdpPorSkuIfPossible(sku, { pushState: true, hint });
      if (opened) normalizePublicPdpSoon();
      return opened !== false;
    } catch (error) {
      console.warn("[public-catalog] No se pudo abrir FYL Originals por SKU:", error);
      return false;
    }
  }

  if (sku && typeof window.abrirModalPorSKU === "function") {
    const opened = window.abrirModalPorSKU(sku, { pushState: true }) !== false;
    if (opened) normalizePublicPdpSoon();
    return opened;
  }

  return false;
}

function ensureCardConsultButton(card) {
  if (!card || !card.matches?.(".card.producto")) return;
  if (card.querySelector(".public-consult-btn")) return;

  const footer = card.querySelector(".card-footer");
  if (!footer) return;

  // <a target="_blank"> en vez de <button>: la navegación natural funciona en
  // WebView de Meta/Samsung/Safari iOS, donde window.open queda bloqueado.
  // El href se actualiza dinámicamente al hacer click (por si cambió la
  // selección de color/talle en la card).
  const link = document.createElement("a");
  link.className = "public-consult-btn";
  link.textContent = "Consultar";
  link.setAttribute("aria-label", "Consultar este modelo por WhatsApp");
  link.target = "_blank";
  link.rel = "noopener";
  try {
    link.href = buildWhatsappUrl(getCardPayload(card));
  } catch (_) {
    link.href = `https://wa.me/${WHATSAPP_NUMBER}`;
  }
  footer.appendChild(link);
}

function ensureCardConsultButtons(root = document) {
  if (root.matches?.(".card.producto")) {
    ensureCardConsultButton(root);
    return;
  }

  root.querySelectorAll?.(".card.producto").forEach(ensureCardConsultButton);
}

function getPdpPayload(modal) {
  const modelText = cleanText(modal?.querySelector(".pdp-article-code")?.textContent || "");
  const model = modelText.replace(/^Art\.\s*/i, "");
  const sku = cleanText(modal?.dataset?.sku || (window.location.hash.match(/^#\/pdp\/(.+)$/)?.[1] || ""));
  const color = cleanText(modal?.querySelector(".product-modal-color-label strong")?.textContent || "");
  const size = getSelectedPdpSize(modal);
  return {
    model,
    sku,
    color,
    size,
    link: getProductUrl(sku),
  };
}

function isPdpVisible() {
  return document.getElementById("product-modal")?.classList.contains("active") === true;
}

function installPublicPdpStyles() {
  if (document.getElementById("public-catalog-pdp-style")) return;

  const style = document.createElement("style");
  style.id = "public-catalog-pdp-style";
  style.textContent = `
    html.public-catalog #product-modal .size-stepper-panel,
    html.public-catalog #product-modal .size-stepper-controls,
    html.public-catalog #product-modal .size-stepper-btn,
    html.public-catalog #product-modal .size-stepper-qty {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

function hidePublicPdpQuantityControls(modal = document.getElementById("product-modal")) {
  if (!modal || !window.__PUBLIC_CATALOG__) return;

  modal.querySelectorAll("#pdp-size-stepper, .size-stepper-panel").forEach((panel) => {
    panel.classList.add("is-hidden");
    if (panel.innerHTML) panel.innerHTML = "";
  });

  modal.querySelectorAll(".size-chip[data-qty], .size-chip.size-chip--active").forEach((chip) => {
    chip.removeAttribute("data-qty");
    chip.classList.remove("size-chip--active");
  });
}

function selectPublicPdpSize(chip) {
  if (!chip || chip.classList.contains("size-chip--disabled")) return;

  const modal = chip.closest("#product-modal");
  const sizeGrid = chip.closest(".size-grid") || chip.closest(".pdp-size-layout");
  if (!modal || !sizeGrid) return;

  sizeGrid.querySelectorAll(".size-chip").forEach((item) => {
    item.classList.remove("is-active", "size-chip--active");
    item.removeAttribute("data-qty");
  });
  chip.classList.add("is-active");
  hidePublicPdpQuantityControls(modal);
}

function nodeContainsPdp(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  return !!(
    node.matches?.(".pdp-whatsapp-cta") ||
    node.querySelector?.(".pdp-whatsapp-cta")
  );
}

function normalizePdpCta() {
  if (window.__FYL_PUBLIC_CATALOG_DEBUG__) console.count("normalizePdpCta");

  const modal = document.getElementById("product-modal");
  if (!modal || !isPdpVisible()) return;

  const cta = modal.querySelector(".pdp-whatsapp-cta");
  if (!cta) return;

  const sku = cleanText(modal.dataset.sku || (window.location.hash.match(/^#\/pdp\/(.+)$/)?.[1] || ""));
  const alreadyNormalized =
    cta.dataset.publicCatalogNormalized === "true" &&
    modal.dataset.publicCatalogNormalizedSku === sku &&
    cleanText(cta.textContent) === "Consultar este modelo";

  if (alreadyNormalized) return;

  withObserverPaused(() => {
    hidePublicPdpQuantityControls(modal);
    cta.dataset.publicCatalogNormalized = "true";
    cta.dataset.publicCatalogNormalizedSku = sku;
    modal.dataset.publicCatalogNormalizedSku = sku;
    if (cleanText(cta.textContent) !== "Consultar este modelo") {
      cta.textContent = "Consultar este modelo";
    }
    cta.classList.add("public-pdp-consult-btn");
    cta.setAttribute("aria-label", "Consultar este modelo por WhatsApp");
  });
}

document.addEventListener(
  "click",
  (event) => {
    if (event.target.closest("#wa-popup")) return;

    // Card "Consultar" (catálogo público).
    // Caso normal: <a target="_blank"> con href ya armado → navegación nativa.
    // Caso legacy (caché viejo): <button> → fallback con openWhatsapp.
    const cardEl = event.target.closest(".public-consult-btn");
    if (cardEl) {
      const card = cardEl.closest(".card.producto, .fyl-originals-card");
      if (cardEl instanceof HTMLAnchorElement) {
        try { cardEl.href = buildWhatsappUrl(getCardPayload(card)); } catch (_) {}
        if (!event.__fylWaLeadTracked) {
          trackMetaWhatsappLead();
          event.__fylWaLeadTracked = true;
        }
        // NO preventDefault: el <a target="_blank"> navega solo.
        return;
      }
      // Fallback legacy <button>: comportamiento previo con window.open.
      event.preventDefault();
      event.stopPropagation();
      if (!event.__fylWaLeadTracked) {
        event.__fylWaLeadTracked = true;
      }
      openWhatsapp(getCardPayload(card));
      return;
    }

    if (window.__PUBLIC_CATALOG__) {
      const publicQuantityControl = event.target.closest(
        "#product-modal .size-stepper-panel, #product-modal .size-stepper-controls, #product-modal .size-stepper-btn"
      );
      if (publicQuantityControl) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        hidePublicPdpQuantityControls(document.getElementById("product-modal"));
        return;
      }

      const publicSizeChip = event.target.closest("#product-modal .size-chip");
      if (publicSizeChip) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        selectPublicPdpSize(publicSizeChip);
        normalizePdpCta();
        return;
      }
    }

    // CTA "Consultar por WhatsApp" del PDP.
    // El elemento ya es <a target="_blank"> con href armado por el render. Si
    // el usuario cambió color/talle en el PDP, refrescamos el href justo antes
    // de que el browser navegue. No tocamos default action.
    const pdpLink = event.target.closest(".pdp-whatsapp-cta");
    if (pdpLink && pdpLink instanceof HTMLAnchorElement) {
      try {
        const modal = document.getElementById("product-modal");
        pdpLink.href = buildWhatsappUrl(getPdpPayload(modal));
      } catch (_) { /* no romper navegación si falla el payload */ }
      if (!event.__fylWaLeadTracked) {
        trackMetaWhatsappLead();
        event.__fylWaLeadTracked = true;
      }
      // NO preventDefault, NO stopPropagation: navegación natural.
    }
  },
  true
);

const pendingCards = new Set();
let pendingDomSync = false;
let pendingPdpSync = false;
let observerPaused = false;
const observedRoots = [];

function observeRoot(root) {
  if (!root || observedRoots.includes(root)) return;
  observedRoots.push(root);
  observer.observe(root, { childList: true, subtree: true });
}

function disconnectObserver() {
  observer.disconnect();
}

function reconnectObserver() {
  observedRoots.forEach((root) => observer.observe(root, { childList: true, subtree: true }));
}

function withObserverPaused(fn) {
  observerPaused = true;
  disconnectObserver();
  try {
    fn();
  } finally {
    reconnectObserver();
    observerPaused = false;
  }
}

function schedulePublicCatalogDomSync() {
  if (pendingDomSync) return;
  pendingDomSync = true;

  const schedule = window.requestAnimationFrame || window.setTimeout;
  schedule(() => {
    pendingDomSync = false;
    pendingCards.forEach(ensureCardConsultButton);
    pendingCards.clear();

    if (pendingPdpSync) {
      pendingPdpSync = false;
      normalizePdpCta();
    }
  });
}

function collectAddedCards(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

  if (node.matches?.(".card.producto")) {
    pendingCards.add(node);
  }

  node.querySelectorAll?.(".card.producto").forEach((card) => {
    pendingCards.add(card);
  });
}

const observer = new MutationObserver((mutations) => {
  if (observerPaused) return;

  for (const mutation of mutations) {
    if (mutation.type !== "childList") continue;
    const targetIsPdp =
      mutation.target?.id === "product-modal" ||
      mutation.target?.closest?.("#product-modal");

    mutation.addedNodes.forEach((node) => {
      if (!targetIsPdp) collectAddedCards(node);
      if (nodeContainsPdp(node)) pendingPdpSync = true;
    });
  }

  if (pendingCards.size > 0 || pendingPdpSync) {
    schedulePublicCatalogDomSync();
  }
});

document.addEventListener("DOMContentLoaded", () => {
  installPublicPdpStyles();
  ensureCardConsultButtons();
  normalizePdpCta();
  const catalogRoot = document.getElementById("catalogo");
  const catalogContainer = document.getElementById("catalog-container");
  const productModal = document.getElementById("product-modal");

  observeRoot(catalogRoot);
  observeRoot(catalogContainer);
  observeRoot(productModal);
});

window.addEventListener(
  "fyl-catalog-boot-done",
  () => {
    ensureCardConsultButtons(document.getElementById("catalogo") || document);
    void handlePublicCuratedBannerHash();
  },
  { once: true }
);

async function handlePublicCuratedBannerHash() {
  if (typeof window === "undefined" || window.FYL_CURATED_BANNER_V1 !== true) {
    return;
  }
  try {
    const ready = window.__fylCuratedBannerReady;
    if (ready && typeof ready.then === "function") {
      const ok = await ready;
      if (ok === false) return;
    }
  } catch (_) {
    return;
  }
  if (typeof window.isCuratedBannerV1Enabled !== "function" || !window.isCuratedBannerV1Enabled()) {
    return;
  }
  const slug =
    typeof window.parseHashBannerSlug === "function"
      ? window.parseHashBannerSlug(location.hash || "")
      : "";
  if (!slug) return;
  if (typeof window.applyCuratedBannerHashRoute === "function") {
    window.applyCuratedBannerHashRoute(slug);
  }
}

window.addEventListener("hashchange", () => {
  void handlePublicCuratedBannerHash();
});
