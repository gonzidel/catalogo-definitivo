// scripts/search-manager.js

// Search functionality
const searchInput = document.getElementById("searchInput");

// Debounce function to limit search frequency
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Search function
const performSearch = debounce((term) => {
  const cards = document.querySelectorAll(".card");
  let visibleCount = 0;

  cards.forEach((card) => {
    const art =
      card.querySelector(".article-box")?.textContent?.toLowerCase() || "";
    const filtros = [
      card.dataset.filtro1?.toLowerCase() || "",
      card.dataset.filtro2?.toLowerCase() || "",
      card.dataset.filtro3?.toLowerCase() || "",
    ].join(" ");

    const isVisible = art.includes(term) || filtros.includes(term);
    card.style.display = isVisible ? "block" : "none";
    if (isVisible) visibleCount++;
  });

  // Show no results message if needed
  const noResults = document.querySelector(".no-results");
  if (visibleCount === 0 && !noResults) {
    const message = document.createElement("div");
    message.className = "no-results";
    message.textContent = "No se encontraron productos";
    document.getElementById("catalogo").appendChild(message);
  } else if (visibleCount > 0 && noResults) {
    noResults.remove();
  }

  // Track search
  gtag("event", "buscar", {
    event_category: "busqueda",
    event_label: term,
  });
}, 300);

// Search input event listener
searchInput.addEventListener("input", (e) => {
  const term = e.target.value.trim().toLowerCase();
  performSearch(term);
});

// Clear search
function clearSearch() {
  searchInput.value = "";
  document.querySelectorAll(".card").forEach((card) => {
    card.style.display = "block";
  });
  const noResults = document.querySelector(".no-results");
  if (noResults) noResults.remove();
}

// Export functions
export { clearSearch };
