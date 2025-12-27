// suppress-extension-errors.js
// Suprimir errores de extensiones del navegador que no afectan la funcionalidad

(function() {
  'use strict';

  // Capturar y suprimir errores de extensiones del navegador
  window.addEventListener('error', function(e) {
    // Suprimir errores relacionados con message ports de extensiones
    if (e.message && (
      e.message.includes('message port') ||
      e.message.includes('runtime.lastError') ||
      e.message.includes('Extension context invalidated') ||
      e.message.includes('Receiving end does not exist')
    )) {
      e.preventDefault();
      e.stopPropagation();
      return true;
    }
  }, true);

  // También capturar errores no capturados de promesas
  window.addEventListener('unhandledrejection', function(e) {
    const reason = e.reason;
    const message = reason?.message || String(reason || '');
    
    if (message.includes('message port') || 
        message.includes('runtime.lastError') ||
        message.includes('Extension context invalidated') ||
        message.includes('Receiving end does not exist')) {
      e.preventDefault();
      return true;
    }
  });

  // Suprimir errores de console.error relacionados con extensiones
  const originalError = console.error;
  console.error = function(...args) {
    const message = args.join(' ').toLowerCase();
    if (message.includes('message port') || 
        message.includes('runtime.lasterror') ||
        message.includes('extension context invalidated') ||
        message.includes('receiving end does not exist')) {
      return; // No mostrar estos errores
    }
    originalError.apply(console, args);
  };

  // También interceptar console.warn para estos casos
  const originalWarn = console.warn;
  console.warn = function(...args) {
    const message = args.join(' ').toLowerCase();
    if (message.includes('message port') || 
        message.includes('runtime.lasterror') ||
        message.includes('extension context invalidated')) {
      return; // No mostrar estos warnings
    }
    originalWarn.apply(console, args);
  };
})();



