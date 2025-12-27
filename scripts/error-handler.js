// scripts/error-handler.js - Sistema centralizado de manejo de errores

class ErrorHandler {
  constructor() {
    this.errors = [];
    this.maxErrors = 50; // Límite de errores en memoria
  }

  log(error, context = "", level = "error") {
    const errorEntry = {
      timestamp: new Date().toISOString(),
      context,
      level,
      message: error.message || error,
      stack: error.stack,
      userAgent: navigator.userAgent,
      url: window.location.href,
    };

    // Agregar a la lista de errores
    this.errors.push(errorEntry);

    // Mantener solo los últimos errores
    if (this.errors.length > this.maxErrors) {
      this.errors = this.errors.slice(-this.maxErrors);
    }

    // Log en consola
    console[level](`[${context}]`, error);

    // Mostrar error al usuario si es crítico
    if (level === "error" && error.critical) {
      this.showUserError(error.message || "Ha ocurrido un error inesperado");
    }

    // Enviar a analytics si está disponible
    this.trackError(errorEntry);
  }

  showUserError(message, type = "error") {
    // Remover errores anteriores
    const existingError = document.querySelector(".user-error-message");
    if (existingError) {
      existingError.remove();
    }

    const errorDiv = document.createElement("div");
    errorDiv.className = "user-error-message";
    errorDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: ${type === "error" ? "#f8d7da" : "#d4edda"};
      color: ${type === "error" ? "#721c24" : "#155724"};
      border: 1px solid ${type === "error" ? "#f5c6cb" : "#c3e6cb"};
      border-radius: 8px;
      padding: 15px 20px;
      max-width: 400px;
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: slideInRight 0.3s ease;
    `;

    errorDiv.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 20px;">${type === "error" ? "⚠️" : "✅"}</span>
        <div style="flex: 1;">
          <strong>${type === "error" ? "Error" : "Información"}</strong>
          <div style="margin-top: 5px; font-size: 14px;">${message}</div>
        </div>
        <button onclick="this.parentElement.parentElement.remove()" 
                style="background: none; border: none; font-size: 18px; cursor: pointer; color: inherit;">
          ×
        </button>
      </div>
    `;

    document.body.appendChild(errorDiv);

    // Auto-remover después de 5 segundos
    setTimeout(() => {
      if (errorDiv.parentElement) {
        errorDiv.remove();
      }
    }, 5000);
  }

  trackError(errorEntry) {
    try {
      // Google Analytics
      if (typeof gtag === "function") {
        gtag("event", "exception", {
          description: errorEntry.message,
          fatal: errorEntry.level === "error",
          custom_map: {
            context: errorEntry.context,
            timestamp: errorEntry.timestamp,
          },
        });
      }
    } catch (e) {
      console.warn("Error tracking failed:", e);
    }
  }

  getErrors() {
    return this.errors;
  }

  clearErrors() {
    this.errors = [];
  }

  // Función para debugging
  debug() {
    console.group("🔍 Error Handler Debug");
    console.log("Total errors:", this.errors.length);
    console.log("Recent errors:", this.errors.slice(-5));
    console.groupEnd();
  }
}

// Instancia global
const errorHandler = new ErrorHandler();

// Función de utilidad para manejar promesas
function handlePromise(promise, context = "") {
  return promise.catch((error) => {
    errorHandler.log(error, context);
    throw error;
  });
}

// Función para manejar errores de fetch
function handleFetchError(response, context = "") {
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
    error.status = response.status;
    errorHandler.log(error, context);
    throw error;
  }
  return response;
}

// Función para retry automático
function withRetry(fn, maxRetries = 3, delay = 1000) {
  return async function (...args) {
    let lastError;

    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await fn.apply(this, args);
      } catch (error) {
        lastError = error;

        if (i === maxRetries) {
          errorHandler.log(error, "withRetry", "error");
          throw error;
        }

        errorHandler.log(
          error,
          `withRetry (attempt ${i + 1}/${maxRetries + 1})`,
          "warn"
        );

        // Esperar antes del siguiente intento
        await new Promise((resolve) =>
          setTimeout(resolve, delay * Math.pow(2, i))
        );
      }
    }

    throw lastError;
  };
}

// Función para timeouts
function withTimeout(promise, timeoutMs = 5000, context = "") {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(
      () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([promise, timeoutPromise]).catch((error) => {
    if (error.message.includes("Timeout")) {
      errorHandler.log(error, context, "error");
    }
    throw error;
  });
}

// Exportar para uso global
window.errorHandler = errorHandler;
window.handlePromise = handlePromise;
window.handleFetchError = handleFetchError;
window.withRetry = withRetry;
window.withTimeout = withTimeout;

// CSS para animaciones
const style = document.createElement("style");
style.textContent = `
  @keyframes slideInRight {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
`;
document.head.appendChild(style);

export {
  errorHandler,
  handlePromise,
  handleFetchError,
  withRetry,
  withTimeout,
};

