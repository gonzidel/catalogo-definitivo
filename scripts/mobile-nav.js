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

function isCuratedOrBannerHashRoute() {
  const hash = location.hash || "";
  if (/^#\/banner\//i.test(hash)) return true;
  if (typeof window.parseHashBannerSlug === "function" && window.parseHashBannerSlug(hash)) {
    return true;
  }
  return false;
}

/** Rutas que deben volver a Home limpiando el hash (dispara onNavChange / resetHomeState). */
function shouldGoHomeViaHashOnly() {
  const hash = location.hash || "";
  if (hash.startsWith("#/como-comprar") || hash.startsWith("#/quienes-somos")) return true;
  if (hash === "#/coleccion/fyl-originals") return true;
  if (isCuratedOrBannerHashRoute()) return true;
  return false;
}

function goHomeViaHash() {
  const prevHash = location.hash || "";
  const mustReset = shouldGoHomeViaHashOnly();
  location.hash = "#/";
  updateActiveNav();
  const navInicio = document.getElementById("nav-inicio");
  const navCategorias = document.getElementById("nav-categorias");
  if (navInicio) navInicio.classList.add("active");
  if (navCategorias) navCategorias.classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });

  const hashUnchanged =
    prevHash === "#/" || prevHash === "#/all" || prevHash === "";
  if (mustReset && hashUnchanged && typeof window.fylResetHomeState === "function") {
    window.fylResetHomeState().catch((err) => console.error("fylResetHomeState:", err));
  }
}

// Obtener página actual
function getCurrentPage() {
  const path = window.location.pathname;
  const hash = window.location.hash || "";
  if (hash.startsWith("#/como-comprar") || hash.startsWith("#/quienes-somos")) {
    return "buscar";
  }
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

/** Inicio (bottom nav), logo header y cualquier atajo a home. */
function navigateToHome() {
  const navInicio = document.getElementById("nav-inicio");
  const navCategorias = document.getElementById("nav-categorias");

  const productModal = document.getElementById("product-modal");
  if (productModal?.classList.contains("active") && typeof window.cerrarModal === "function") {
    window.cerrarModal(true);
  }

  if (!window.__CATALOG_ONLY__ && window.location.pathname.includes("banner.html")) {
    window.location.href = "index.html";
    return;
  }

  if (shouldGoHomeViaHashOnly()) {
    goHomeViaHash();
    return;
  }

  if (typeof window.clearSearch === "function") {
    window.clearSearch({ skipCatalogReset: true });
  }
  if (typeof window.cambiarCategoria === "function") {
    Promise.resolve(window.cambiarCategoria("all"));
  } else {
    location.hash = "#/";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  if (typeof window.updateURL === "function") {
    window.updateURL({ tab: "", sku: undefined }, { mode: "replace" });
    const url = new URL(window.location);
    if (url.searchParams.has("banner")) {
      url.searchParams.delete("banner");
      window.history.replaceState({}, "", url);
    }
  } else {
    const url = new URL(window.location);
    url.searchParams.delete("tab");
    url.searchParams.delete("sku");
    url.searchParams.delete("banner");
    window.history.replaceState({}, "", url);
  }

  updateActiveNav();
  if (navInicio) navInicio.classList.add("active");
  if (navCategorias) navCategorias.classList.add("active");
}

if (typeof window !== "undefined") {
  window.fylNavigateToHome = navigateToHome;
}

// Manejar clicks en navegación
function setupNavHandlers() {
  const navInicio = document.getElementById("nav-inicio");
  const navCategorias = document.getElementById("nav-categorias");
  const navPedidos = document.getElementById("nav-pedidos");
  const navPerfil = document.getElementById("nav-perfil");
  const headerLogoHome = document.getElementById("header-logo-home");

  if (headerLogoHome) {
    headerLogoHome.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToHome();
    });
  }

  if (navInicio) {
    navInicio.addEventListener("click", (e) => {
      e.preventDefault();
      navigateToHome();
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
      
      document.querySelectorAll(".bottom-nav-item").forEach((item) => item.classList.remove("active"));
      navBuscar.classList.add("active");
    });
  }

  // Categorías - ahora es Inicio (navegar al inicio)
  if (navCategorias) {
    navCategorias.addEventListener("click", (e) => {
      e.preventDefault();
      
      // Legacy: en banner.html redirigía a index, pero en /catalogo nunca debemos salir a index.
      if (!window.__CATALOG_ONLY__ && window.location.pathname.includes('banner.html')) {
        window.location.href = 'index.html';
        return;
      }

      navigateToHome();
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
