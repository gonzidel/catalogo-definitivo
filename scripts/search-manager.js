// scripts/search-manager.js

import { fylAnalytics } from "./analytics.js?v=m260607";

// Search functionality
const searchInput = document.getElementById("searchInput");
const searchBarMobile = document.getElementById("search-bar-mobile");

// Variables para autocompletado
let autocompleteSuggestions = new Set();
let suggestionTypes = new Map(); // Guarda el tipo de cada sugerencia: 'product' o 'tag'
let suggestionSearchTerms = new Map(); // Sugerencia visible -> término canónico para buscar
let currentSuggestions = [];
let selectedSuggestionIndex = -1;

function trackMetaSearch(query) {
  const term = String(query || "").trim();
  if (!term) return;

  const send = () => {
    if (typeof fbq === "function") {
      fbq("track", "Search", {
        search_string: term,
      });
      return true;
    }
    return false;
  };

  if (send()) return;
  // Delay corto defensivo para casos de timing del pixel.
  setTimeout(() => {
    send();
  }, 300);
}
let autocompleteDropdown = null;
let isAutocompleteVisible = false;

function normalizeAutocompleteText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getSuggestionMaxTypoDistance(tokenLength) {
  if (tokenLength >= 8) return 2;
  if (tokenLength >= 5) return 1;
  return 0;
}

function levenshteinSuggestionBounded(a, b, maxDistance) {
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
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    if (rowMin > maxDistance) return maxDistance + 1;

    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }

  return prev[b.length];
}

function getSuggestionScore(termLower, suggestion) {
  const normalizedSuggestion = normalizeAutocompleteText(suggestion);
  if (!normalizedSuggestion) return 0;

  if (normalizedSuggestion === termLower) return 100;
  if (normalizedSuggestion.startsWith(termLower)) return 70;
  if (normalizedSuggestion.includes(termLower)) return 40;

  const maxDistance = getSuggestionMaxTypoDistance(termLower.length);
  if (maxDistance === 0) return 0;

  const distance = levenshteinSuggestionBounded(termLower, normalizedSuggestion, maxDistance);
  return distance <= maxDistance ? 25 : 0;
}

function getSuggestionMatchType(termLower, suggestion) {
  const normalizedSuggestion = normalizeAutocompleteText(suggestion);
  if (!normalizedSuggestion) return 99;

  if (normalizedSuggestion === termLower) return 0; // exacta
  if (normalizedSuggestion.startsWith(termLower)) return 1; // prefijo
  if (normalizedSuggestion.includes(termLower)) return 2; // contiene

  const maxDistance = getSuggestionMaxTypoDistance(termLower.length);
  if (maxDistance > 0) {
    const distance = levenshteinSuggestionBounded(termLower, normalizedSuggestion, maxDistance);
    if (distance <= maxDistance) return 3; // aproximada
  }

  return 99;
}

function singularizeSuggestionToken(token) {
  if (!token) return token;
  if (token.length >= 6 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length >= 5 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function hasStrongCommonPrefix(a, b) {
  const min = Math.min(a.length, b.length);
  let count = 0;
  while (count < min && a[count] === b[count]) count++;
  return count >= 3;
}

function shouldMergeSuggestionKeys(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (!hasStrongCommonPrefix(a, b)) return false;

  const maxDistance = 1;
  const distance = levenshteinSuggestionBounded(a, b, maxDistance);
  return distance <= maxDistance;
}

function pickClusterDisplayVariant(cluster) {
  if (!cluster || !cluster.variants || cluster.variants.size === 0) return "";

  let bestVariant = "";
  let bestCount = -1;
  for (const [variant, count] of cluster.variants.entries()) {
    if (count > bestCount) {
      bestVariant = variant;
      bestCount = count;
      continue;
    }
    if (count === bestCount) {
      const variantSingular = singularizeSuggestionToken(normalizeAutocompleteText(variant));
      const bestSingular = singularizeSuggestionToken(normalizeAutocompleteText(bestVariant));
      if (variantSingular === cluster.clusterKey && bestSingular !== cluster.clusterKey) {
        bestVariant = variant;
      } else if (variant.length < bestVariant.length) {
        bestVariant = variant;
      }
    }
  }

  return bestVariant;
}

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
  const clusters = new Map();
  const ensureCluster = (rawWord) => {
    const normalized = normalizeAutocompleteText(rawWord);
    const baseKey = singularizeSuggestionToken(normalized);
    if (!baseKey) return null;

    let matchedKey = null;
    for (const existingKey of clusters.keys()) {
      if (shouldMergeSuggestionKeys(baseKey, existingKey)) {
        matchedKey = existingKey;
        break;
      }
    }

    const clusterKey = matchedKey || baseKey;
    if (!clusters.has(clusterKey)) {
      clusters.set(clusterKey, {
        clusterKey,
        variants: new Map(),
        typeCounts: { product: 0, tag: 0 },
      });
    }
    return clusters.get(clusterKey);
  };

  const registerSuggestion = (rawWord, type) => {
    const cleaned = String(rawWord || "").trim().toLowerCase();
    if (cleaned.length < 2) return;

    const cluster = ensureCluster(cleaned);
    if (!cluster) return;

    cluster.variants.set(cleaned, (cluster.variants.get(cleaned) || 0) + 1);
    if (type === "tag") cluster.typeCounts.tag += 1;
    else cluster.typeCounts.product += 1;
  };

  const suggestions = new Set();
  suggestionTypes.clear();
  suggestionSearchTerms.clear();
  
  // Obtener todos los productos disponibles
  const productos = window.productosPendientes || [];
  
  if (productos.length === 0) return;
  
  productos.forEach(producto => {
    // Extraer palabras de nombre/artículo (tipo: 'product' - mayúsculas)
    if (producto.name || producto.Articulo) {
      const nombre = ((producto.name || producto.Articulo) || '').toLowerCase();
      nombre.split(/\s+/).forEach(palabra => {
        if (palabra.length >= 3) {
          registerSuggestion(palabra, 'product');
        }
      });
    }
    
    // Extraer palabras de descripción (tipo: 'product' - mayúsculas)
    if (producto.Descripcion) {
      const desc = producto.Descripcion.toLowerCase();
      desc.split(/\s+/).forEach(palabra => {
        if (palabra.length >= 3) {
          registerSuggestion(palabra, 'product');
        }
      });
    }
    
    // Agregar filtros como sugerencias (tipo: 'tag' - Title Case)
    // Filtro1 y Filtro2 son tags únicos. Filtro3 puede tener varios separados por coma o punto y coma.
    const addTag = (f) => {
      const t = f.trim().toLowerCase();
      if (t.length >= 2) registerSuggestion(t, 'tag');
    };
    if (producto.Filtro1) addTag(producto.Filtro1);
    if (producto.Filtro2) addTag(producto.Filtro2);
    if (producto.Filtro3) {
      producto.Filtro3.split(/[,;]/).forEach(part => {
        if (part && part.trim()) addTag(part);
      });
    }
  });

  for (const cluster of clusters.values()) {
    const display = pickClusterDisplayVariant(cluster);
    if (!display) continue;
    suggestions.add(display);
    const dominantType =
      cluster.typeCounts.tag >= cluster.typeCounts.product ? "tag" : "product";
    suggestionTypes.set(display, dominantType);
    suggestionSearchTerms.set(display, display);
  }
  
  autocompleteSuggestions = suggestions;
}

// Función para obtener sugerencias filtradas
function getFilteredSuggestions(term) {
  if (!term || term.length < 2) return [];
  
  const termLower = normalizeAutocompleteText(term);
  return Array.from(autocompleteSuggestions)
    .map((suggestion) => ({
      suggestion,
      matchType: getSuggestionMatchType(termLower, suggestion),
      score: getSuggestionScore(termLower, suggestion),
      normalized: normalizeAutocompleteText(suggestion),
    }))
    .filter((item) => item.matchType < 99 && item.score > 0)
    .sort((a, b) => {
      if (a.matchType !== b.matchType) return a.matchType - b.matchType;
      if (b.score !== a.score) return b.score - a.score;
      if (a.normalized.length !== b.normalized.length) {
        return a.normalized.length - b.normalized.length;
      }
      return a.suggestion.localeCompare(b.suggestion);
    })
    .slice(0, 8)
    .map((item) => item.suggestion);
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
  const searchValue = suggestionSearchTerms.get(suggestion) || suggestion;
  inputElement.value = suggestion;
  hideAutocomplete();
  performSearch(searchValue, { source: "autocomplete" });
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
      performSearch(term, { source: "submit" });
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
const performSearch = debounce(async (term, options = {}) => {
  const source = options.source || "live";
  const shouldTrack = source !== "live";

  // Si hay una función global para buscar en todos los productos, usarla
  if (typeof window.buscarProductosEnTodos === 'function') {
    await window.buscarProductosEnTodos(term);
    // Si hay filtro de talles activo, re-aplicarlo sobre el nuevo render.
    if (typeof window.reapplyActiveSizeFilter === "function") {
      await window.reapplyActiveSizeFilter();
    }
    
    if (shouldTrack) {
      try {
        if (fylAnalytics.isReady()) {
          fylAnalytics.setPageType(term ? "search_results" : "home");
          fylAnalytics.event("search", { search_term: String(term || ""), source });
        }
      } catch (_e) {}
      trackMetaSearch(term);
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

  if (shouldTrack) {
    try {
      if (fylAnalytics.isReady()) {
        fylAnalytics.setPageType(term ? "search_results" : "home");
        fylAnalytics.event("search", { search_term: String(term || ""), source });
      }
    } catch (_e) {}
    trackMetaSearch(term);
  }
}, 300);

// Sincronizar ambos inputs de búsqueda
function syncSearchInputs(sourceInput, targetInput) {
  if (targetInput && sourceInput.value !== targetInput.value) {
    targetInput.value = sourceInput.value;
  }
}

// Función para manejar input de búsqueda
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
  
  // Búsqueda en vivo con debounce (mejora UX en mobile y desktop).
  if (term.length >= 2) {
    performSearch(term, { source: "live" });
  } else if (term.length === 0) {
    performSearch("", { source: "live" });
  }
  
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
    performSearch(term, { source: "submit" });
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
async function clearSearch(options = {}) {
  const skipCatalogReset = !!options.skipCatalogReset;
  if (searchInput) {
    searchInput.value = "";
  }
  if (searchBarMobile) {
    searchBarMobile.value = "";
  }
  
  // Ocultar autocompletado
  hideAutocomplete();

  if (typeof window !== "undefined") {
    window.__fylSearchDerivedCategory = null;
  }

  if (skipCatalogReset) {
    if (typeof window.refreshCatalogFilterBar === "function") {
      window.refreshCatalogFilterBar();
    }
    return;
  }
  
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
  window.clearSearch = clearSearch;
}
