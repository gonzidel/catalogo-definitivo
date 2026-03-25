// scripts/banner.js - Carga y renderiza banner promocional

import { supabase } from "./supabase-client.js";

let currentBanner = null;

// Cargar banner desde Supabase
export async function loadBanner() {
  try {
    const { data, error } = await supabase
      .from("promotional_banners")
      .select("*")
      .eq("enabled", true)
      .order("order", { ascending: true })
      .limit(1)
      .single();

    if (error) {
      // Si no hay banner o error, no mostrar nada
      if (error.code === 'PGRST116') {
        // No rows returned - es normal
        return;
      }
      console.error("Error cargando banner:", error);
      return;
    }

    if (data) {
      currentBanner = data;
      renderBanner();
    }
  } catch (error) {
    console.error("Error en loadBanner:", error);
  }
}

// Renderizar banner
function renderBanner() {
  const container = document.getElementById("promotional-banner-container");
  if (!container || !currentBanner) return;

  container.innerHTML = `
    <div class="promotional-banner" id="promotional-banner">
      <span class="promotional-banner-text">${currentBanner.text}</span>
      <span class="promotional-banner-arrow">→</span>
    </div>
  `;

  // Agregar evento click
  const banner = document.getElementById("promotional-banner");
  if (banner) {
    banner.addEventListener("click", handleBannerClick);
  }
  
  // No mostrar en rutas de colección (ej. #/coleccion/fyl-originals)
  if (location.hash === "#/coleccion/fyl-originals") {
    container.style.display = 'none';
    return;
  }
  // Verificar si estamos en "Inicio" para mostrar el banner
  const urlParams = new URLSearchParams(window.location.search);
  const tabSlug = urlParams.get('tab');
  const isInicio = !tabSlug || tabSlug === '';
  if (isInicio) {
    container.style.display = 'block';
  }
}

// Mostrar banner solo en vista Inicio (no en colección FYL)
export function showPromotionalBanner() {
  if (location.hash === "#/coleccion/fyl-originals") return;
  const container = document.getElementById("promotional-banner-container");
  if (container && currentBanner) {
    container.style.display = 'block';
  } else if (container && !currentBanner) {
    // Si no hay banner cargado aún, intentar cargarlo
    loadBanner().then(() => {
      if (currentBanner && location.hash !== "#/coleccion/fyl-originals") {
        container.style.display = 'block';
      }
    });
  }
}

// Ocultar banner
export function hidePromotionalBanner() {
  const container = document.getElementById("promotional-banner-container");
  if (container) {
    container.style.display = 'none';
  }
}

// Manejar click en banner
function handleBannerClick() {
  if (!currentBanner || !currentBanner.link) return;

  if (currentBanner.link_type === "category") {
    // Filtrar por categoría
    if (typeof window.cambiarCategoria === "function") {
      window.cambiarCategoria(currentBanner.link);
    }
  } else if (currentBanner.link_type === "tag") {
    // Filtrar por tag (implementar si es necesario)
    console.log("Filtrar por tag:", currentBanner.link);
  } else if (currentBanner.link_type === "url") {
    // Redirigir a URL
    if (currentBanner.link.startsWith("http")) {
      window.location.href = currentBanner.link;
    } else {
      window.location.href = currentBanner.link;
    }
  }
}

// Inicializar cuando el DOM esté listo
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadBanner();
  });
} else {
  loadBanner();
}

// Función para verificar y mostrar banner si estamos en Inicio (no en colección)
function checkAndShowBannerIfInicio() {
  if (location.hash === "#/coleccion/fyl-originals") return;
  const urlParams = new URLSearchParams(window.location.search);
  const tabSlug = urlParams.get('tab');
  const isInicio = !tabSlug || tabSlug === '';
  if (isInicio && currentBanner) {
    showPromotionalBanner();
  }
}

// Verificar después de un pequeño delay para asegurar que la URL esté lista
setTimeout(() => {
  checkAndShowBannerIfInicio();
}, 100);

// Al navegar a colección FYL, ocultar el banner inmediatamente
window.addEventListener("hashchange", () => {
  if (location.hash === "#/coleccion/fyl-originals") {
    hidePromotionalBanner();
  }
});

// Exportar funciones para uso externo
if (typeof window !== 'undefined') {
  window.loadBanner = loadBanner;
  window.showPromotionalBanner = showPromotionalBanner;
  window.hidePromotionalBanner = hidePromotionalBanner;
  window.handleBannerClick = handleBannerClick;
}