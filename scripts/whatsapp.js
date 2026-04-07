if (!window.__fbWaLeadDelegationInit) {
  window.__fbWaLeadDelegationInit = true;
  document.addEventListener("click", (e) => {
    const link = e.target?.closest?.('a[href*="wa.me"]');
    if (!link) return;

    const payload = { content_name: "WhatsApp Click" };
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

document.addEventListener("DOMContentLoaded", () => {
  const waToggle = document.getElementById("wa-toggle");
  const waMenu = document.getElementById("wa-menu");

  if (waToggle && waMenu) {
    waToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      waMenu.classList.toggle("open");
    });

    // Cerrar el menú si se hace clic fuera
    document.addEventListener("click", (e) => {
      if (!waMenu.contains(e.target) && e.target !== waToggle) {
        waMenu.classList.remove("open");
      }
    });
  }
});
