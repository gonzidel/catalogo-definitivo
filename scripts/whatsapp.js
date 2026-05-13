if (!window.__fbWaLeadDelegationInit) {
  window.__fbWaLeadDelegationInit = true;
  document.addEventListener("click", (e) => {
    const link = e.target?.closest?.('a[href*="wa.me"]');
    if (!link) return;
    // Deduplicación: si otro listener (catalogo-publico.js para .public-consult-btn
    // o .pdp-whatsapp-cta) ya disparó Meta Lead en este mismo click, NO lo
    // dupliquemos. Evita inflado del CPL en Meta Ads Manager.
    if (e.__fylWaLeadTracked) return;
    e.__fylWaLeadTracked = true;

    const payload =
      link.id === "wa-toggle"
        ? { content_name: "WhatsApp Click", content_category: "public_catalog" }
        : { content_name: "WhatsApp Click" };
    if (typeof fbq === "function") {
      fbq("track", "Lead", payload);
      return;
    }

    // Delay corto defensivo para casos de carga tardía del pixel.
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
  if (waToggle && waMenu && !document.documentElement.classList.contains("public-catalog")) {
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
