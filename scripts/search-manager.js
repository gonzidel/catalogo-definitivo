// scripts/search-manager.js

// Search functionality
const searchInput = document.getElementById("searchInput");
const searchBarMobile = document.getElementById("search-bar-mobile");

// Variables para autocompletado
let autocompleteSuggestions = new Set();
let suggestionTypes = new Map(); // Guarda el tipo de cada sugerencia: 'product' o 'tag'
let currentSuggestions = [];
let selectedSuggestionIndex = -1;
let autocompleteDropdown = null;
let isAutocompleteVisible = false;

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

// Función para convertir texto a Title Case (primera letra mayúscula)
function toTitleCase(str) {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// Función para extraer todas las palabras de los productos para autocompletado
function extractSuggestionsFromProducts() {
  const suggestions = new Set();
  suggestionTypes.clear();
  
  // Obtener todos los productos disponibles
  const productos = window.productosPendientes || [];
  
  if (productos.length === 0) return;
  
  productos.forEach(producto => {
    // Extraer palabras de nombre/artículo (tipo: 'product' - mayúsculas)
    if (producto.name || producto.Articulo) {
      const nombre = ((producto.name || producto.Articulo) || '').toLowerCase();
      nombre.split(/\s+/).forEach(palabra => {
        if (palabra.length >= 3) {
          suggestions.add(palabra);
          suggestionTypes.set(palabra, 'product');
        }
      });
    }
    
    // Extraer palabras de descripción (tipo: 'product' - mayúsculas)
    if (producto.Descripcion) {
      const desc = producto.Descripcion.toLowerCase();
      desc.split(/\s+/).forEach(palabra => {
        if (palabra.length >= 3) {
          suggestions.add(palabra);
          suggestionTypes.set(palabra, 'product');
        }
      });
    }
    
    // Agregar filtros como sugerencias (tipo: 'tag' - Title Case)
    // Filtro1 y Filtro2 son tags únicos. Filtro3 puede tener varios separados por coma o punto y coma.
    const addTag = (f) => {
      const t = f.trim().toLowerCase();
      if (t.length >= 2) { suggestions.add(t); suggestionTypes.set(t, 'tag'); }
    };
    if (producto.Filtro1) addTag(producto.Filtro1);
    if (producto.Filtro2) addTag(producto.Filtro2);
    if (producto.Filtro3) {
      producto.Filtro3.split(/[,;]/).forEach(part => {
        if (part && part.trim()) addTag(part);
      });
    }
  });
  
  autocompleteSuggestions = suggestions;
}

// Función para obtener sugerencias filtradas
function getFilteredSuggestions(term) {
  if (!term || term.length < 2) return [];
  
  const termLower = term.toLowerCase();
  return Array.from(autocompleteSuggestions)
    .filter(suggestion => suggestion.includes(termLower))
    .slice(0, 8) // Máximo 8 sugerencias
    .sort((a, b) => {
      // Priorizar sugerencias que son exactamente iguales al término
      const aExact = a === termLower;
      const bExact = b === termLower;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      
      // Luego priorizar sugerencias que empiezan con el término
      const aStarts = a.startsWith(termLower);
      const bStarts = b.startsWith(termLower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      
      return a.localeCompare(b);
    });
}

// Crear el menú desplegable de autocompletado
function createAutocompleteDropdown(inputElement) {
  if (autocompleteDropdown) {
    autocompleteDropdown.remove();
  }
  
  autocompleteDropdown = document.createElement('div');
  autocompleteDropdown.className = 'search-autocomplete';
  autocompleteDropdown.id = inputElement === searchInput ? 'autocomplete-desktop' : 'autocomplete-mobile';
  
  // Insertar después del contenedor del input
  const container = inputElement.parentElement;
  if (container) {
    container.style.position = 'relative';
    container.appendChild(autocompleteDropdown);
  }
  
  return autocompleteDropdown;
}

// Mostrar sugerencias de autocompletado
function showAutocompleteSuggestions(suggestions, inputElement) {
  if (!autocompleteDropdown) {
    createAutocompleteDropdown(inputElement);
  }
  
  if (suggestions.length === 0) {
    hideAutocomplete();
    return;
  }
  
  currentSuggestions = suggestions;
  selectedSuggestionIndex = -1;
  
  const termLower = inputElement.value.toLowerCase();
  
  autocompleteDropdown.innerHTML = suggestions
    .map((suggestion, index) => {
      // Determinar el tipo de sugerencia
      const suggestionType = suggestionTypes.get(suggestion) || 'product';
      
      // Formatear según el tipo
      let formattedSuggestion;
      if (suggestionType === 'tag') {
        // Tags: Title Case (primera letra mayúscula, resto minúscula)
        formattedSuggestion = toTitleCase(suggestion);
      } else {
        // Productos: todo en mayúsculas
        formattedSuggestion = suggestion.toUpperCase();
      }
      
      // Resaltar el término buscado
      const highlighted = formattedSuggestion.replace(
        new RegExp(`(${termLower})`, 'gi'),
        (match) => {
          // Mantener el formato original del término resaltado
          if (suggestionType === 'tag') {
            return `<strong>${match.charAt(0).toUpperCase() + match.slice(1).toLowerCase()}</strong>`;
          } else {
            return `<strong>${match.toUpperCase()}</strong>`;
          }
        }
      );
      
      return `<div class="autocomplete-item" data-index="${index}">${highlighted}</div>`;
    })
    .join('');
  
  autocompleteDropdown.style.display = 'block';
  isAutocompleteVisible = true;
  
  // Agregar event listeners a los items
  autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach((item, index) => {
    item.addEventListener('click', () => {
      selectSuggestion(suggestions[index], inputElement);
    });
    
    item.addEventListener('mouseenter', () => {
      selectedSuggestionIndex = index;
      updateHighlightedItem();
    });
  });
}

// Ocultar autocompletado
function hideAutocomplete() {
  if (autocompleteDropdown) {
    autocompleteDropdown.style.display = 'none';
  }
  isAutocompleteVisible = false;
  selectedSuggestionIndex = -1;
}

// Actualizar item destacado
function updateHighlightedItem() {
  if (!autocompleteDropdown) return;
  
  autocompleteDropdown.querySelectorAll('.autocomplete-item').forEach((item, index) => {
    if (index === selectedSuggestionIndex) {
      item.classList.add('highlighted');
    } else {
      item.classList.remove('highlighted');
    }
  });
}

// Seleccionar una sugerencia
function selectSuggestion(suggestion, inputElement) {
  inputElement.value = suggestion;
  hideAutocomplete();
  performSearch(suggestion);
  
  // Track
  if (typeof gtag === "function") {
    gtag("event", "autocomplete_selected", {
      event_category: "busqueda",
      event_label: suggestion,
    });
  }
}

// Manejar navegación con teclado
function handleAutocompleteKeyboard(e, inputElement) {
  // Enter o "Buscar"/"Go" del teclado móvil: ejecutar búsqueda siempre
  if (e.key === 'Enter') {
    e.preventDefault();
    if (isAutocompleteVisible && selectedSuggestionIndex >= 0 && selectedSuggestionIndex < currentSuggestions.length) {
      selectSuggestion(currentSuggestions[selectedSuggestionIndex], inputElement);
    } else {
      const term = (inputElement.value || '').trim().toLowerCase();
      performSearch(term);
      hideAutocomplete();
    }
    return;
  }

  if (!isAutocompleteVisible || currentSuggestions.length === 0) {
    if (e.key === 'ArrowDown' && currentSuggestions.length > 0) {
      e.preventDefault();
      selectedSuggestionIndex = 0;
      showAutocompleteSuggestions(currentSuggestions, inputElement);
      updateHighlightedItem();
    }
    return;
  }
  
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      selectedSuggestionIndex = Math.min(
        selectedSuggestionIndex + 1,
        currentSuggestions.length - 1
      );
      updateHighlightedItem();
      break;
      
    case 'ArrowUp':
      e.preventDefault();
      selectedSuggestionIndex = Math.max(selectedSuggestionIndex - 1, -1);
      if (selectedSuggestionIndex === -1) {
        inputElement.focus();
      } else {
        updateHighlightedItem();
      }
      break;
      
    case 'Escape':
      hideAutocomplete();
      inputElement.blur();
      break;
  }
}

// Search function - busca en todos los productos, no solo en los renderizados
const performSearch = debounce(async (term) => {
  // Si hay una función global para buscar en todos los productos, usarla
  if (typeof window.buscarProductosEnTodos === 'function') {
    await window.buscarProductosEnTodos(term);
    
    // Track search
    if (typeof gtag === "function") {
      gtag("event", "buscar", {
        event_category: "busqueda",
        event_label: term,
      });
    }
    return;
  }

  // Fallback: buscar solo en productos renderizados (comportamiento anterior)
  const cards = document.querySelectorAll(".card");
  let visibleCount = 0;

  cards.forEach((card) => {
    // Si el filtro de talles está activo, respetar ese filtro primero
    const isFilteredBySize = card.hasAttribute('data-filtered-by-size');
    
    const art =
      card.querySelector(".article-box")?.textContent?.toLowerCase() || "";
    const descripcion =
      card.querySelector(".description")?.textContent?.toLowerCase() || "";
    const nombre = card.dataset.name?.toLowerCase() || "";
    const filtros = [
      card.dataset.filtro1?.toLowerCase() || "",
      card.dataset.filtro2?.toLowerCase() || "",
      card.dataset.filtro3?.toLowerCase() || "",
    ].join(" ");

    // Buscar en artículo, descripción, nombre del producto y filtros
    const matchesSearch = art.includes(term) || 
                         descripcion.includes(term) || 
                         nombre.includes(term) ||
                         filtros.includes(term);
    const isVisible = matchesSearch && (!isFilteredBySize || card.style.display !== 'none');
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
  if (typeof gtag === "function") {
    gtag("event", "buscar", {
      event_category: "busqueda",
      event_label: term,
    });
  }
}, 300);

// Sincronizar ambos inputs de búsqueda
function syncSearchInputs(sourceInput, targetInput) {
  if (targetInput && sourceInput.value !== targetInput.value) {
    targetInput.value = sourceInput.value;
  }
}

// Función para manejar input de búsqueda (solo autocompletado, NO busca al tipear)
function handleSearchInput(e, inputElement) {
  const term = e.target.value.trim();
  
  // Actualizar sugerencias si hay productos disponibles
  if (window.productosPendientes && window.productosPendientes.length > 0) {
    if (autocompleteSuggestions.size === 0) {
      extractSuggestionsFromProducts();
    }
    
    if (term.length >= 2) {
      const suggestions = getFilteredSuggestions(term);
      showAutocompleteSuggestions(suggestions, inputElement);
    } else {
      hideAutocomplete();
    }
  }
  
  // NO realizar búsqueda al tipear: solo al Enter, lupa/buscar del teclado, o clic en sugerencia
  
  // Sincronizar inputs
  if (inputElement === searchInput && searchBarMobile) {
    syncSearchInputs(searchInput, searchBarMobile);
  } else if (inputElement === searchBarMobile && searchInput) {
    syncSearchInputs(searchBarMobile, searchInput);
  }
}

// Search input event listener - desktop
if (searchInput) {
  searchInput.addEventListener("input", (e) => handleSearchInput(e, searchInput));
  searchInput.addEventListener("keydown", (e) => handleAutocompleteKeyboard(e, searchInput));
  searchInput.addEventListener("blur", () => {
    // Ocultar después de un pequeño delay para permitir clicks en items
    setTimeout(() => hideAutocomplete(), 200);
  });
  searchInput.addEventListener("focus", (e) => {
    const term = e.target.value.trim();
    if (term.length >= 2 && currentSuggestions.length > 0) {
      showAutocompleteSuggestions(currentSuggestions, searchInput);
    }
  });
}

// Search input event listener - mobile
if (searchBarMobile) {
  searchBarMobile.addEventListener("input", (e) => handleSearchInput(e, searchBarMobile));
  searchBarMobile.addEventListener("keydown", (e) => handleAutocompleteKeyboard(e, searchBarMobile));
  // Evento "search": se dispara al tocar "Buscar"/"Search" en el teclado móvil (input type="search")
  searchBarMobile.addEventListener("search", (e) => {
    e.preventDefault();
    const term = (searchBarMobile.value || '').trim().toLowerCase();
    performSearch(term);
    hideAutocomplete();
  });
  searchBarMobile.addEventListener("blur", () => {
    setTimeout(() => hideAutocomplete(), 200);
  });
  searchBarMobile.addEventListener("focus", (e) => {
    const term = e.target.value.trim();
    if (term.length >= 2 && currentSuggestions.length > 0) {
      showAutocompleteSuggestions(currentSuggestions, searchBarMobile);
    }
  });
}

// Actualizar sugerencias cuando se cargan nuevos productos
if (typeof window !== 'undefined') {
  const originalCargarCategoria = window.cargarCategoria;
  if (originalCargarCategoria) {
    window.cargarCategoria = async function(...args) {
      const result = await originalCargarCategoria.apply(this, args);
      // Esperar un momento para que los productos se carguen
      setTimeout(() => {
        extractSuggestionsFromProducts();
      }, 500);
      return result;
    };
  }
}

// Clear search - restaurar vista paginada normal
async function clearSearch() {
  if (searchInput) {
    searchInput.value = "";
  }
  if (searchBarMobile) {
    searchBarMobile.value = "";
  }
  
  // Ocultar autocompletado
  hideAutocomplete();
  
  // Si hay una función global para buscar en todos los productos, usarla para limpiar
  if (typeof window.buscarProductosEnTodos === 'function') {
    await window.buscarProductosEnTodos('');
    return;
  }
  
  // Fallback: comportamiento anterior
  document.querySelectorAll(".card").forEach((card) => {
    card.style.display = "block";
  });
  const noResults = document.querySelector(".no-results");
  if (noResults) noResults.remove();
}

// Export functions
export { clearSearch, performSearch };

// Make performSearch available globally for quick actions and banner
if (typeof window !== 'undefined') {
  window.performSearch = performSearch;
}
