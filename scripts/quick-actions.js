// scripts/quick-actions.js - Gestión de acciones rápidas configurables

import { fylDevLog } from "./config.js";
import { supabase } from "./supabase-client.js";
import { fylAnalytics } from "./analytics.js";

let quickActionsData = [];
let activeAction = null;

// Cargar acciones rápidas desde Supabase
export async function loadQuickActions() {
  try {
    // 1. Cargar acciones rápidas configuradas desde la tabla quick_actions
    const { data: actionsData, error: actionsError } = await supabase
      .from("quick_actions")
      .select("*")
      .eq("enabled", true)
      .order("order", { ascending: true });

    if (actionsError) {
      console.error("Error cargando acciones rápidas:", actionsError);
    }

    const configuredActions = actionsData || [];

    // 2. Cargar dinámicamente todos los tags 1 únicos de la categoría "Otros"
    let dynamicTagActions = [];
    try {
      const { data: tagsData, error: tagsError } = await supabase
        .from("catalog_public_view")
        .select("Filtro1")
        .eq("Categoria", "Otros")
        .not("Filtro1", "is", null)
        .neq("Filtro1", "");

      if (tagsError) {
        console.error("Error cargando tags de Otros:", tagsError);
      } else if (tagsData && tagsData.length > 0) {
        // Obtener tags únicos y no vacíos
        const uniqueTags = [...new Set(
          tagsData
            .map(item => (item.Filtro1 || "").trim())
            .filter(tag => tag !== "")
        )].sort(); // Ordenar alfabéticamente

        fylDevLog(`📋 Tags 1 únicos encontrados en "Otros":`, uniqueTags);

        // Crear acciones rápidas dinámicas para cada tag
        dynamicTagActions = uniqueTags.map((tag, index) => ({
          id: `tag-otros-${tag.toLowerCase().replace(/\s+/g, '-')}`,
          type: "tag",
          label: tag,
          value: tag,
          enabled: true,
          order: 1000 + index, // Colocar después de las acciones configuradas
          isDynamic: true // Marcar como dinámica
        }));
      }
    } catch (error) {
      console.error("Error obteniendo tags dinámicos:", error);
    }

    // 3. Combinar acciones configuradas con acciones dinámicas
    quickActionsData = [...configuredActions, ...dynamicTagActions];
    
    fylDevLog(`✅ Acciones rápidas cargadas: ${configuredActions.length} configuradas + ${dynamicTagActions.length} dinámicas`);
    
    renderQuickActions();
  } catch (error) {
    console.error("Error en loadQuickActions:", error);
  }
}

// Renderizar acciones rápidas
function renderQuickActions() {
  const container = document.getElementById("quick-actions");
  if (!container) return;

  // Limpiar contenedor
  container.innerHTML = "";

  // Botón "Inicio" eliminado - ahora se usa el botón de la barra de navegación inferior

  // Renderizar acciones desde BD (solo texto, sin iconos)
  quickActionsData.forEach((action) => {
    const btn = document.createElement("button");
    btn.className = "quick-action-btn";
    btn.dataset.actionId = action.id;
    btn.dataset.actionType = action.type;
    btn.dataset.actionValue = action.value;

    // Solo mostrar el label, sin icono
    btn.innerHTML = `<span>${action.label}</span>`;

    btn.addEventListener("click", () => handleQuickAction(action));
    container.appendChild(btn);
  });
  
  // El botón "Talles" está ahora en el HTML como elemento separado
  // Solo necesitamos inicializar su event listener
  initSizeFilterButton();
}

// Inicializar el botón de filtro de talles (móvil y desktop)
function initSizeFilterButton() {
  const openModal = () => {
    if (typeof window.openSizeFilterModal === "function") {
      window.openSizeFilterModal();
    } else {
      console.warn("Función openSizeFilterModal no está disponible");
    }
  };

  const sizeFilterBtn = document.getElementById("size-filter-btn");
  if (sizeFilterBtn && !sizeFilterBtn.hasAttribute('data-initialized')) {
    sizeFilterBtn.setAttribute('data-initialized', 'true');
    sizeFilterBtn.addEventListener("click", openModal);
  }

  const sizeFilterBtnDesktop = document.getElementById("size-filter-btn-desktop");
  if (sizeFilterBtnDesktop && !sizeFilterBtnDesktop.hasAttribute('data-initialized')) {
    sizeFilterBtnDesktop.setAttribute('data-initialized', 'true');
    sizeFilterBtnDesktop.addEventListener("click", openModal);
  }
}

// Obtener icono por defecto según tipo
function getDefaultIcon(type) {
  const icons = {
    category: "📦",
    tag: "🏷️",
    offer: "🔥",
    provider: "🏭",
  };
  return icons[type] || "⚡";
}

// Manejar click en acción rápida
async function handleQuickAction(action) {
  // Remover active de todos los botones
  document.querySelectorAll(".quick-action-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  // Agregar active al botón clickeado
  const clickedBtn = document.querySelector(`[data-action-id="${action.id}"]`);

  if (clickedBtn) {
    clickedBtn.classList.add("active");
  }
  
  // Si es acción de inicio, activar también el botón de navegación inferior
  if (action.type === "inicio") {
    const navInicio = document.getElementById("nav-inicio");
    const navCategorias = document.getElementById("nav-categorias");
    if (navInicio) navInicio.classList.add("active");
    if (navCategorias) navCategorias.classList.add("active");
  }

  activeAction = action;
  try {
    if (fylAnalytics.isReady()) {
      fylAnalytics.event("quick_action_click", {
        action_id: action.id,
        action_type: action.type,
        action_value: action.value || "",
      });
    }
  } catch (_e) {}

  // Aplicar filtro según tipo
  if (action.type === "inicio" || action.value === "all") {
    // Mostrar todo (vista Inicio)
    if (typeof window.cambiarCategoria === "function") {
      window.cambiarCategoria("all");
    } else {
      // Si no hay función global, recargar todos los productos
      window.location.hash = "";
      if (window.location.reload) {
        // No recargar, solo resetear filtros
        resetFilters();
      }
    }
    // Limpiar URL para mostrar vista de Inicio
    if (typeof window.updateURL === "function") {
      window.updateURL({ tab: '', sku: undefined }, { mode: 'replace' });
    }
  } else if (action.type === "category") {
    // Filtrar por categoría
    if (typeof window.cambiarCategoria === "function") {
      window.cambiarCategoria(action.value);
    }
  } else if (action.type === "offer") {
    // Mostrar ofertas
    if (typeof window.cambiarCategoria === "function") {
      window.cambiarCategoria("Ofertas");
    }
  } else if (action.type === "tag") {
    // Filtrar por tag en categoría "Otros"
    console.log("Filtrar por tag:", action.value);
    
    // Si existe la función global, usarla
    if (typeof window.filterByTagEnOtros === "function") {
      window.filterByTagEnOtros(action.value);
    } else {
      // Usar la URL con el slug del tag para que el sistema lo maneje automáticamente
      const tagValue = (action.value || "").trim().toLowerCase();
      const tagSlug = tagValue.replace(/\s+/g, '-');
      
      // Actualizar URL con el slug del tag
      if (typeof window.updateURL === "function") {
        window.updateURL({ tab: tagSlug, sku: undefined }, { mode: 'replace' });
      } else {
        // Fallback: usar window.location
        const url = new URL(window.location);
        url.searchParams.set('tab', tagSlug);
        window.history.pushState({}, '', url);
        window.location.reload();
      }
      
      // Si el tag es "lenceria", el sistema ya lo maneja automáticamente
      // Para otros tags, necesitamos cargar "Otros" y filtrar
      if (tagValue !== "lenceria" && typeof window.cambiarCategoria === "function") {
        // Cargar categoría "Otros" primero
        await window.cambiarCategoria("Otros");
        
        // Luego filtrar los productos por el tag en el cliente
        setTimeout(() => {
          const cards = document.querySelectorAll(".card.producto");
          
          cards.forEach((card) => {
            const filtro1 = (card.dataset.filtro1 || "").trim().toLowerCase();
            if (filtro1 === tagValue) {
              card.style.display = "";
            } else {
              card.style.display = "none";
            }
          });
        }, 300);
      }
    }
  } else if (action.type === "provider") {
    // Filtrar por proveedor
    console.log("Filtrar por proveedor:", action.value);
    // TODO: Implementar filtro por proveedor
  }
}

// Resetear filtros
function resetFilters() {
  // Limpiar búsqueda
  const searchInput = document.getElementById("searchInput") || document.getElementById("search-bar-mobile");
  if (searchInput) {
    searchInput.value = "";
  }

  // Limpiar filtros de tags
  document.querySelectorAll("#filtroMenu input[type='checkbox']").forEach((checkbox) => {
    checkbox.checked = false;
  });

  // Mostrar todos los productos
  document.querySelectorAll(".card").forEach((card) => {
    card.style.display = "";
  });
}


// Inicializar cuando el DOM esté listo
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadQuickActions();
    initSizeFilterButton();
  });
} else {
  loadQuickActions();
  initSizeFilterButton();
}

// Exportar función para uso externo
export { handleQuickAction, resetFilters };