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
