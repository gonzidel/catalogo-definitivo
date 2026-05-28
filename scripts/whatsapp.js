function isExcludedGeneralWhatsappLink(link) {
  if (!link) return true;
  if (link.closest("#wa-popup, #wa-menu")) return true;
  if (link.id === "wa-toggle") return true;
  if (link.classList.contains("public-catalog-wa-link")) return true;
  return false;
}

function isProductWhatsappConsultLink(link) {
  return !!link?.closest?.(".public-consult-btn, .pdp-whatsapp-cta");
}

if (!window.__fbWaLeadDelegationInit) {
  window.__fbWaLeadDelegationInit = true;
  document.addEventListener("click", (e) => {
    const link = e.target?.closest?.('a[href*="wa.me"]');
    if (!link) return;

    // Catálogo público: pixel solo en catalogo-publico.js (card/PDP). FAB, menú, footer: nada.
    if (document.documentElement.classList.contains("public-catalog")) return;
    if (isExcludedGeneralWhatsappLink(link) || isProductWhatsappConsultLink(link)) return;

    if (e.__fylWaLeadTracked) return;
    e.__fylWaLeadTracked = true;

    const payload = { content_name: "WhatsApp Click" };
    if (typeof fbq === "function") {
      fbq("track", "Lead", payload);
      return;
    }

    setTimeout(() => {
      if (typeof fbq === "function") {
        fbq("track", "Lead", payload);
      }
    }, 300);
  });
}

const WHATSAPP_ENVIOS_HREF = "https://wa.me/5493625172874";

function normalizePublicCatalogWhatsappLinks() {
  if (!document.documentElement.classList.contains("public-catalog")) return;
  document.querySelectorAll('a[href*="wa.me"]').forEach((link) => {
    if (!(link instanceof HTMLAnchorElement)) return;
    link.href = WHATSAPP_ENVIOS_HREF;
  });
}

function initWhatsappPopup() {
  if (window.__fylWhatsappPopupInit) return;
  window.__fylWhatsappPopupInit = true;

  const waToggle = document.getElementById("wa-toggle");
  const waMenu = document.getElementById("wa-menu");

  normalizePublicCatalogWhatsappLinks();

  // Catálogo público: el FAB es <a href="wa.me"> sin listeners JS.
  // Evitamos stopPropagation en el click (en Safari iOS puede bloquear la navegación del enlace).
  // Lead Meta: listener delegado arriba con content_category si id === wa-toggle.
  if (
    waToggle &&
    waMenu &&
    !document.documentElement.classList.contains("public-catalog") &&
    !window.__fylHeaderEarlyInit
  ) {
    waToggle.addEventListener("click", (e) => {
      e.preventDefault();
      waMenu.classList.toggle("open");
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initWhatsappPopup, { once: true });
} else {
  initWhatsappPopup();
}
