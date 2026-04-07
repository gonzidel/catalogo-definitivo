import { fylDevLog } from "./config.js";
import { fylAnalytics } from "./analytics.js";

// Scroll to top button functionality
const scrollBtn = document.getElementById("btn-scroll-top");

if (scrollBtn) {
  window.addEventListener("scroll", () => {
    if (window.pageYOffset > 300) {
      scrollBtn.classList.add("visible");
    } else {
      scrollBtn.classList.remove("visible");
    }
  });

  scrollBtn.addEventListener("click", () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });

    try {
      if (fylAnalytics.isReady()) fylAnalytics.event("scroll_top", {});
    } catch (_e) {}
  });
}

// Asegurar que el header tenga position sticky
function ensureHeaderSticky() {
  const header = document.querySelector("header");
  if (!header) return;

  // Forzar position sticky si no está funcionando
  const computedStyle = window.getComputedStyle(header);
  if (computedStyle.position !== 'sticky' && computedStyle.position !== '-webkit-sticky') {
    header.style.position = 'sticky';
    header.style.top = '0';
    header.style.left = '0';
    header.style.right = '0';
    header.style.zIndex = '1000';
    header.style.width = '100%';
    header.style.background = '#fff';
    fylDevLog("🔧 Header sticky forzado mediante JavaScript");
  }
}

// Ajustar posición sticky del menú y quick-actions basado en altura del header
function adjustStickyPositions() {
  const header = document.querySelector("header");
  if (!header) return;

  // Obtener la altura exacta del header incluyendo padding y border
  const headerHeight = header.offsetHeight;
  const headerRect = header.getBoundingClientRect();
  
  // Ajustar menú de categorías desktop
  const menuDesktop = document.querySelector(".menu-desktop");
  if (menuDesktop) {
    // Calcular la diferencia entre la altura del header y la posición del menú
    // para eliminar cualquier espacio
    const menuRect = menuDesktop.getBoundingClientRect();
    let spaceBetween = menuRect.top - headerRect.bottom;
    
    // Usar margin-top negativo para eliminar cualquier espacio, con un overlap más agresivo
    if (spaceBetween > 0) {
      menuDesktop.style.marginTop = `-${Math.max(spaceBetween + 1, 2)}px`;
    } else {
      // Si no hay espacio medible, usar -2px para asegurar que esté completamente pegado
      menuDesktop.style.marginTop = '-2px';
    }
    
    // Posicionar el menú exactamente debajo del header con overlap
    menuDesktop.style.top = `${headerHeight - 2}px`; // Reducir el top para crear overlap
    menuDesktop.style.marginBottom = '0';
    menuDesktop.style.paddingTop = '0.5rem';
    menuDesktop.style.borderTop = 'none';
    // Asegurar que el fondo sea continuo
    menuDesktop.style.background = '#fff';
  }

  // Ajustar quick-actions-container en mobile
  const quickActions = document.querySelector(".quick-actions-container");
  if (quickActions) {
    // Solo ajustar si el header está visible (usar la variable global isHeaderVisible)
    // Si no está definida, asumir que está visible
    const headerIsVisible = typeof isHeaderVisible !== 'undefined' ? isHeaderVisible : true;
    
    // Verificar también si el header está realmente visible en el DOM
    const headerComputed = window.getComputedStyle(header);
    const headerTransform = headerComputed.transform;
    const headerActuallyVisible = !headerTransform || headerTransform === 'none' || 
                                 (!headerTransform.includes('matrix(1, 0, 0, 1, 0, -') && 
                                  header.style.transform !== 'translateY(-100%)');
    
    if (headerIsVisible && headerActuallyVisible) {
      // Header visible - posicionar debajo del header
      const quickRect = quickActions.getBoundingClientRect();
      let spaceBetween = quickRect.top - headerRect.bottom;
      
      // Usar margin-top negativo para eliminar cualquier espacio, con un overlap más agresivo
      if (spaceBetween > 0) {
        quickActions.style.marginTop = `-${Math.max(spaceBetween + 1, 2)}px`;
      } else {
        // Si no hay espacio medible, usar -2px para asegurar que esté completamente pegado
        quickActions.style.marginTop = '-2px';
      }
      
      // Posicionar las acciones rápidas exactamente debajo del header con overlap
      quickActions.style.top = `${headerHeight - 2}px`; // Reducir el top para crear overlap
      quickActions.style.marginBottom = '0';
      quickActions.style.borderTop = 'none';
      // Asegurar que el fondo cubra cualquier espacio
      quickActions.style.background = '#E5E1DC';
    }
    // Si el header está oculto, el handleHeaderVisibility se encargará de moverlo a top: 0
  }
}

// Función para ajustar posiciones después del scroll
function adjustAfterScroll() {
  requestAnimationFrame(() => {
    // Solo ajustar posiciones si el header está visible
    if (typeof isHeaderVisible !== 'undefined' && isHeaderVisible) {
      adjustStickyPositions();
    }
  });
}

// Ejecutar al cargar y cuando cambie el tamaño de la ventana
window.addEventListener("DOMContentLoaded", () => {
  ensureHeaderSticky();
  adjustStickyPositions();
  // Ajustar después de varios delays para asegurar que todo esté renderizado
  setTimeout(adjustStickyPositions, 50);
  setTimeout(adjustStickyPositions, 100);
  setTimeout(adjustStickyPositions, 200);
});

window.addEventListener("resize", () => {
  ensureHeaderSticky();
  adjustStickyPositions();
});

// Control de visibilidad del header y menú al hacer scroll
let lastScrollTop = 0;
let scrollThreshold = 3; // Píxeles mínimos de scroll para activar el comportamiento (reducido para mayor sensibilidad)
let isHeaderVisible = true;

function handleHeaderVisibility() {
  const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const header = document.querySelector("header");
  const menuDesktop = document.querySelector(".menu-desktop");
  // Buscar quick-actions-container de múltiples formas para asegurar que se encuentre
  const quickActions = document.querySelector(".quick-actions-container") || 
                       document.querySelector("#quick-actions")?.parentElement ||
                       document.querySelector('[class*="quick-actions"]');
  
  // Si estamos en la parte superior, siempre mostrar header y restaurar posición de accesos rápidos
  if (currentScrollTop <= 10) {
    if (!isHeaderVisible) {
      isHeaderVisible = true;
      
      if (header) {
        header.style.transform = 'translateY(0)';
        header.style.transition = 'transform 0.3s ease-in-out';
      }
      
      if (menuDesktop) {
        menuDesktop.style.transform = 'translateY(0)';
        menuDesktop.style.transition = 'transform 0.3s ease-in-out';
      }
      
      // Restaurar posición de quick-actions debajo del header
      if (quickActions) {
        const headerHeight = header ? header.offsetHeight : 60;
        quickActions.style.top = `${headerHeight - 2}px`;
        quickActions.style.transform = 'translateY(0)';
        quickActions.style.transition = 'top 0.3s ease-in-out, transform 0.3s ease-in-out';
        quickActions.style.willChange = 'transform, top';
      } else {
        // Si no se encuentra con el selector principal, intentar buscar de nuevo
        const quickActionsRetry = document.querySelector(".quick-actions-container");
        if (quickActionsRetry) {
          const headerHeight = header ? header.offsetHeight : 60;
          quickActionsRetry.style.top = `${headerHeight - 2}px`;
          quickActionsRetry.style.transform = 'translateY(0)';
          quickActionsRetry.style.transition = 'top 0.3s ease-in-out, transform 0.3s ease-in-out';
          quickActionsRetry.style.willChange = 'transform, top';
        }
      }
    }
    lastScrollTop = currentScrollTop;
    return;
  }
  
  // Solo activar si se ha scrolleado más del threshold
  const scrollDelta = Math.abs(currentScrollTop - lastScrollTop);
  if (scrollDelta < scrollThreshold) {
    return;
  }
  
  if (currentScrollTop > lastScrollTop && currentScrollTop > 50) {
    // Scrolleando hacia abajo - ocultar header y mover accesos rápidos arriba
    if (isHeaderVisible) {
      isHeaderVisible = false;
      
      if (header) {
        header.style.transform = 'translateY(-100%)';
        header.style.transition = 'transform 0.3s ease-in-out';
      }
      
      if (menuDesktop) {
        menuDesktop.style.transform = 'translateY(-100%)';
        menuDesktop.style.transition = 'transform 0.3s ease-in-out';
      }
      
      // Mover quick-actions a la parte superior cuando el header se oculta
      if (quickActions) {
        // Mover a la parte superior sin espacio
        quickActions.style.top = '0';
        quickActions.style.marginTop = '0';
        quickActions.style.paddingTop = '0.18rem'; // Mantener padding interno
        quickActions.style.transform = 'translateY(0)';
        quickActions.style.transition = 'top 0.3s ease-in-out, margin-top 0.3s ease-in-out, transform 0.3s ease-in-out';
        quickActions.style.willChange = 'transform, top';
        quickActions.style.borderTop = 'none';
        quickActions.style.position = 'sticky';
        quickActions.style.zIndex = '999';
        // Asegurar que no haya padding o margin que cree espacio
        quickActions.style.paddingTop = '0.18rem';
        quickActions.style.paddingBottom = '0.18rem';
      } else {
        // Si no se encuentra con el selector principal, intentar buscar de nuevo
        const quickActionsRetry = document.querySelector(".quick-actions-container");
        if (quickActionsRetry) {
          quickActionsRetry.style.top = '0';
          quickActionsRetry.style.marginTop = '0';
          quickActionsRetry.style.paddingTop = '0.18rem';
          quickActionsRetry.style.transform = 'translateY(0)';
          quickActionsRetry.style.transition = 'top 0.3s ease-in-out, margin-top 0.3s ease-in-out, transform 0.3s ease-in-out';
          quickActionsRetry.style.willChange = 'transform, top';
          quickActionsRetry.style.borderTop = 'none';
          quickActionsRetry.style.position = 'sticky';
          quickActionsRetry.style.zIndex = '999';
        }
      }
    }
  } else if (currentScrollTop < lastScrollTop) {
    // Scrolleando hacia arriba - mostrar header y restaurar posición de accesos rápidos
    if (!isHeaderVisible) {
      isHeaderVisible = true;
      
      if (header) {
        header.style.transform = 'translateY(0)';
        header.style.transition = 'transform 0.3s ease-in-out';
      }
      
      if (menuDesktop) {
        menuDesktop.style.transform = 'translateY(0)';
        menuDesktop.style.transition = 'transform 0.3s ease-in-out';
      }
      
      // Restaurar posición de quick-actions debajo del header
      if (quickActions) {
        const headerHeight = header ? header.offsetHeight : 60;
        quickActions.style.top = `${headerHeight - 2}px`;
        quickActions.style.transform = 'translateY(0)';
        quickActions.style.transition = 'top 0.3s ease-in-out, transform 0.3s ease-in-out';
        quickActions.style.willChange = 'transform, top';
      } else {
        // Si no se encuentra con el selector principal, intentar buscar de nuevo
        const quickActionsRetry = document.querySelector(".quick-actions-container");
        if (quickActionsRetry) {
          const headerHeight = header ? header.offsetHeight : 60;
          quickActionsRetry.style.top = `${headerHeight - 2}px`;
          quickActionsRetry.style.transform = 'translateY(0)';
          quickActionsRetry.style.transition = 'top 0.3s ease-in-out, transform 0.3s ease-in-out';
          quickActionsRetry.style.willChange = 'transform, top';
        }
      }
    }
  }
  
  lastScrollTop = currentScrollTop <= 0 ? 0 : currentScrollTop;
}

// Ajustar después del scroll para mantener la posición correcta
window.addEventListener("scroll", () => {
  adjustAfterScroll();
  handleHeaderVisibility();
}, { passive: true });

// También ajustar después de un pequeño delay para asegurar que el header esté completamente renderizado
setTimeout(() => {
  ensureHeaderSticky();
  adjustStickyPositions();
}, 100);
