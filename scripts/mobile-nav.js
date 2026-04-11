// scripts/mobile-nav.js - Manejo de navegación inferior móvil

/**
 * Actualiza el badge del item "Pedidos" en la bottom nav.
 * @param {number} count - Cantidad a mostrar (0 = ocultar badge)
 */
function setPedidosBadge(count) {
  const nav = document.getElementById("nav-pedidos");
  const badge = document.getElementById("pedidos-badge");
  if (!nav || !badge) return;

  const n = Number(count || 0);
  if (n > 0) {
    badge.textContent = n > 9 ? "9+" : String(n);
    nav.classList.add("has-badge");
  } else {
    nav.classList.remove("has-badge");
  }
}

// Obtener página actual
function getCurrentPage() {
  const path = window.location.pathname;
  if (path.includes("dashboard")) return "pedidos";
  if (path.includes("profile")) return "perfil";
  if (path.includes("admin")) return "admin";
  if (path.includes("index.html") || path.endsWith("/")) return "inicio";
  return "inicio";
}

// Actualizar indicadores activos
function updateActiveNav() {
  const currentPage = getCurrentPage();
  const navItems = document.querySelectorAll(".bottom-nav-item");

  navItems.forEach((item) => {
    const navType = item.dataset.nav;
    // Si estamos en inicio, activar tanto nav-inicio como nav-categorias (que ahora es inicio)
    if (navType === currentPage || (currentPage === "inicio" && (navType === "inicio" || item.id === "nav-categorias"))) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });
}

// Manejar clicks en navegación
function setupNavHandlers() {
  const navInicio = document.getElementById("nav-inicio");
  const navCategorias = document.getElementById("nav-categorias");
  const navPedidos = document.getElementById("nav-pedidos");
  const navPerfil = document.getElementById("nav-perfil");
  const headerLogoHome = document.getElementById("header-logo-home");

  // Logo en header: reutiliza la misma lógica de Inicio.
  if (headerLogoHome) {
    headerLogoHome.addEventListener("click", (e) => {
      e.preventDefault();
      if (navInicio) {
        navInicio.click();
      } else {
        location.hash = "#/";
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  // Inicio (primer botón)
  if (navInicio) {
    navInicio.addEventListener("click", (e) => {
      e.preventDefault();
      
      // Si estamos en banner.html, redirigir a index.html
      if (window.location.pathname.includes('banner.html')) {
        window.location.href = 'index.html';
        return;
      }

      // Si estamos en "Cómo comprar", volver al inicio por hash (cerrar vista informativa)
      if ((location.hash || "").startsWith("#/como-comprar") || (location.hash || "").startsWith("#/quienes-somos")) {
        location.hash = "#/";
        updateActiveNav();
        navInicio.classList.add("active");
        if (navCategorias) navCategorias.classList.add("active");
        return;
      }
      
      // Si estamos en colección FYL, ir a Home vía hash (el router aplicará cargarCategoria)
      if (location.hash === "#/coleccion/fyl-originals") {
        location.hash = "#/";
        updateActiveNav();
        navInicio.classList.add("active");
        if (navCategorias) navCategorias.classList.add("active");
        return;
      }
      
      // Resetear filtros y mostrar todo
      if (typeof window.clearSearch === "function") {
        window.clearSearch({ skipCatalogReset: true });
      }
      if (typeof window.cambiarCategoria === "function") {
        if (typeof window.showCatalogBootOverlay === "function") {
          window.showCatalogBootOverlay();
        }
        Promise.resolve(window.cambiarCategoria("all")).finally(() => {
          if (typeof window.hideCatalogBootOverlay === "function") {
            window.hideCatalogBootOverlay();
          }
        });
      } else {
        window.location.hash = "";
        // Scroll al inicio
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      
      // Limpiar URL (remover parámetros tab, sku y banner)
      if (typeof window.updateURL === "function") {
        window.updateURL({ tab: '', sku: undefined }, { mode: 'replace' });
        // También limpiar banner manualmente si existe
        const url = new URL(window.location);
        if (url.searchParams.has('banner')) {
          url.searchParams.delete('banner');
          window.history.replaceState({}, '', url);
        }
      } else {
        // Fallback: limpiar manualmente
        const url = new URL(window.location);
        url.searchParams.delete('tab');
        url.searchParams.delete('sku');
        url.searchParams.delete('banner');
        window.history.replaceState({}, '', url);
      }
      
      updateActiveNav();
      navInicio.classList.add("active");
      // También activar el segundo botón de inicio (antes categorías)
      if (navCategorias) {
        navCategorias.classList.add("active");
      }
    });
  }

  // Buscar - scroll a búsqueda
  const navBuscar = document.getElementById("nav-buscar");
  if (navBuscar) {
    navBuscar.addEventListener("click", (e) => {
      e.preventDefault();
      
      // Scroll a barra de búsqueda
      const searchBar = document.getElementById("search-bar-mobile") || document.getElementById("searchInput");
      if (searchBar) {
        searchBar.scrollIntoView({ behavior: "smooth", block: "center" });
        searchBar.focus();
      }
      
      updateActiveNav();
      navBuscar.classList.add("active");
    });
  }

  // Categorías - ahora es Inicio (navegar al inicio)
  if (navCategorias) {
    navCategorias.addEventListener("click", (e) => {
      e.preventDefault();
      
      // Si estamos en banner.html, redirigir a index.html
      if (window.location.pathname.includes('banner.html')) {
        window.location.href = 'index.html';
        return;
      }

      // Si estamos en "Cómo comprar", volver al inicio por hash (cerrar vista informativa)
      if ((location.hash || "").startsWith("#/como-comprar") || (location.hash || "").startsWith("#/quienes-somos")) {
        location.hash = "#/";
        updateActiveNav();
        navCategorias.classList.add("active");
        if (navInicio) navInicio.classList.add("active");
        return;
      }
      
      // Navegar al inicio igual que el botón de inicio
      if (typeof window.clearSearch === "function") {
        window.clearSearch({ skipCatalogReset: true });
      }
      if (typeof window.cambiarCategoria === "function") {
        if (typeof window.showCatalogBootOverlay === "function") {
          window.showCatalogBootOverlay();
        }
        Promise.resolve(window.cambiarCategoria("all")).finally(() => {
          if (typeof window.hideCatalogBootOverlay === "function") {
            window.hideCatalogBootOverlay();
          }
        });
      } else {
        window.location.hash = "";
        // Scroll al inicio
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      
      // Limpiar URL (remover parámetros tab, sku y banner)
      if (typeof window.updateURL === "function") {
        window.updateURL({ tab: '', sku: undefined }, { mode: 'replace' });
        // También limpiar banner manualmente si existe
        const url = new URL(window.location);
        if (url.searchParams.has('banner')) {
          url.searchParams.delete('banner');
          window.history.replaceState({}, '', url);
        }
      } else {
        // Fallback: limpiar manualmente
        const url = new URL(window.location);
        url.searchParams.delete('tab');
        url.searchParams.delete('sku');
        url.searchParams.delete('banner');
        window.history.replaceState({}, '', url);
      }
      
      updateActiveNav();
      navCategorias.classList.add("active");
      // También activar el botón de inicio principal
      if (navInicio) {
        navInicio.classList.add("active");
      }
    });
  }

  // Pedidos - ya tiene href, no necesita handler especial

  // Perfil - abrir dropdown o redirigir a dashboard
  if (navPerfil) {
    navPerfil.addEventListener("click", async (e) => {
      e.preventDefault();
      
      // Verificar si hay sesión activa
      try {
        const { supabase } = await import("../scripts/supabase-client.js");
        const { data: { session } } = await supabase.auth.getSession();
        
        if (session) {
          // Si hay sesión, redirigir a dashboard
          window.location.href = "client/dashboard.html";
        } else {
          // Si no hay sesión, abrir modal de login
          const clienteLink = document.querySelector(".cliente-link");
          if (clienteLink) {
            clienteLink.click();
          }
        }
      } catch (error) {
        console.error("Error verificando sesión:", error);
        // Fallback: intentar abrir dropdown
        const clienteLink = document.querySelector(".cliente-link");
        if (clienteLink) {
          clienteLink.click();
        }
      }

      // No marcar "Perfil" como activo: seguimos en el catálogo (inicio);
      // solo se abre el modal de login.
      updateActiveNav();
    });
  }
}

// Actualizar visibilidad de navegación según tamaño de pantalla
function updateNavVisibility() {
  const bottomNav = document.getElementById("bottom-nav");
  if (!bottomNav) return;

  if (window.innerWidth <= 768) {
    bottomNav.style.display = "flex";
  } else {
    bottomNav.style.display = "none";
  }
}

// Inicializar navegación
function initMobileNav() {
  updateActiveNav();
  setupNavHandlers();
  updateNavVisibility();

  // Actualizar en resize
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      updateNavVisibility();
      updateActiveNav();
    }, 250);
  });

  // Actualizar al cambiar de página (para SPA behavior)
  window.addEventListener("hashchange", updateActiveNav);
  window.addEventListener("popstate", updateActiveNav);
}

// Inicializar cuando el DOM esté listo
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initMobileNav);
} else {
  initMobileNav();
}

// Exponer setPedidosBadge globalmente para integración con estado de pedidos
window.setPedidosBadge = setPedidosBadge;

// Exportar para uso externo
export { updateActiveNav, getCurrentPage, setPedidosBadge };
