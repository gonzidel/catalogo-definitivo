// client/client-utils.js - Utilidades para el área de clientes

/**
 * Utilidades y funciones auxiliares para el área de clientes
 */

// Formatear fecha para mostrar
export function formatDate(dateString) {
  try {
    const date = new Date(dateString);
    return date.toLocaleDateString("es-AR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (error) {
    console.error("Error formateando fecha:", error);
    return dateString;
  }
}

// Formatear precio
export function formatPrice(price) {
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(price);
  } catch (error) {
    console.error("Error formateando precio:", error);
    return `$${price}`;
  }
}

// Mostrar notificación toast
export function showToast(message, type = "info", duration = 3000) {
  try {
    // Crear elemento toast
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${
        type === "success"
          ? "#28a745"
          : type === "error"
          ? "#dc3545"
          : "#17a2b8"
      };
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      font-weight: 500;
      max-width: 300px;
      word-wrap: break-word;
      transform: translateX(100%);
      transition: transform 0.3s ease;
    `;
    toast.textContent = message;

    // Agregar al DOM
    document.body.appendChild(toast);

    // Animar entrada
    setTimeout(() => {
      toast.style.transform = "translateX(0)";
    }, 100);

    // Remover después del tiempo especificado
    setTimeout(() => {
      toast.style.transform = "translateX(100%)";
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 300);
    }, duration);
  } catch (error) {
    console.error("Error mostrando toast:", error);
  }
}

// Validar email
export function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// Validar teléfono argentino
export function validatePhone(phone) {
  const re = /^(\+54|54)?[\s-]?[0-9]{2,4}[\s-]?[0-9]{6,8}$/;
  return re.test(phone.replace(/\s/g, ""));
}

// Validar DNI argentino
export function validateDNI(dni) {
  const re = /^[0-9]{7,8}$/;
  return re.test(dni);
}

// Debounce para búsquedas
export function debounce(func, wait) {
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

// Cargar imagen con fallback
export function loadImageWithFallback(
  src,
  fallbackSrc = "/icons/icon-192x192.png"
) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(src);
    img.onerror = () => resolve(fallbackSrc);
    img.src = src;
  });
}

// Copiar al portapapeles
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      showToast("Copiado al portapapeles", "success");
      return true;
    } else {
      // Fallback para navegadores más antiguos
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      const result = document.execCommand("copy");
      document.body.removeChild(textArea);
      if (result) {
        showToast("Copiado al portapapeles", "success");
      }
      return result;
    }
  } catch (error) {
    console.error("Error copiando al portapapeles:", error);
    showToast("No se pudo copiar", "error");
    return false;
  }
}

// Generar ID único
export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Verificar si es dispositivo móvil
export function isMobile() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

// Scroll suave a elemento
export function smoothScrollTo(elementId) {
  try {
    const element = document.getElementById(elementId);
    if (element) {
      element.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  } catch (error) {
    console.error("Error en scroll suave:", error);
  }
}

// Exportar funciones globalmente para compatibilidad
window.formatDate = formatDate;
window.formatPrice = formatPrice;
window.showToast = showToast;
window.validateEmail = validateEmail;
window.validatePhone = validatePhone;
window.validateDNI = validateDNI;
window.debounce = debounce;
window.loadImageWithFallback = loadImageWithFallback;
window.copyToClipboard = copyToClipboard;
window.generateId = generateId;
window.isMobile = isMobile;
window.smoothScrollTo = smoothScrollTo;
