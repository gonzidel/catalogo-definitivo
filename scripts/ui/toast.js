// scripts/ui/toast.js - Toast/slide-up reutilizable para feedback de acciones

/**
 * Muestra un toast/slide-up no invasivo con opción de CTAs
 * @param {Object} opts
 * @param {string} opts.message - Texto principal (default: 'Agregado al carrito')
 * @param {string} [opts.primaryLabel] - Etiqueta botón primario (ej. 'Ver carrito')
 * @param {Function} [opts.onPrimary] - Callback botón primario
 * @param {string} [opts.secondaryLabel] - Etiqueta botón secundario (ej. 'Seguir agregando')
 * @param {Function} [opts.onSecondary] - Callback botón secundario
 * @param {number} [opts.autoCloseMs=5000] - Auto-cierre en ms (0 = no auto-cierre)
 * @param {Function} [opts.onClose] - Callback al cerrar
 */
export function showToast({
  message = 'Agregado al carrito',
  primaryLabel = 'Ver carrito',
  onPrimary,
  secondaryLabel = 'Seguir agregando',
  onSecondary,
  autoCloseMs = 5000,
  onClose = () => {},
} = {}) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:10002;pointer-events:none;display:flex;justify-content:center;padding:0 12px;padding-bottom:calc(var(--bottom-nav-h, 56px) + 12px + env(safe-area-inset-bottom, 0px));';
    document.body.appendChild(container);
  }

  const hasPrimary = primaryLabel && typeof onPrimary === 'function';
  const hasSecondary = secondaryLabel && typeof onSecondary === 'function';
  const hasButtons = hasPrimary || hasSecondary;

  const el = document.createElement('div');
  el.className = 'toast-slide-up';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="toast-inner" style="pointer-events:auto;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.18);padding:16px 20px;max-width:360px;width:100%;border:1px solid rgba(0,0,0,0.06);">
      <div class="toast-header" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span class="toast-message" style="font-size:15px;font-weight:600;color:#333;">${escapeHtml(message)}</span>
        <button type="button" class="toast-close" aria-label="Cerrar" style="flex-shrink:0;width:36px;height:36px;min-width:36px;min-height:36px;border:none;background:transparent;color:#666;cursor:pointer;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;">×</button>
      </div>
      ${hasButtons ? `
      <div class="toast-actions" style="display:flex;gap:10px;margin-top:14px;">
        ${hasPrimary ? `<button type="button" class="toast-btn-primary" style="flex:1;min-height:44px;padding:10px 16px;border:none;border-radius:10px;background:#CD844D;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">${escapeHtml(primaryLabel)}</button>` : ''}
        ${hasSecondary ? `<button type="button" class="toast-btn-secondary" style="flex:1;min-height:44px;padding:10px 16px;border:2px solid #ddd;border-radius:10px;background:#fff;color:#333;font-size:15px;font-weight:500;cursor:pointer;">${escapeHtml(secondaryLabel)}</button>` : ''}
      </div>
      ` : ''}
    </div>
  `;

  el.style.cssText = 'animation:toastSlideUp 0.3s ease;';

  function close() {
    el.style.animation = 'toastSlideDown 0.25s ease forwards';
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
      onClose();
    }, 250);
  }

  el.querySelector('.toast-close').addEventListener('click', () => {
    close();
  });

  if (hasPrimary) {
    el.querySelector('.toast-btn-primary').addEventListener('click', () => {
      onPrimary();
      close();
    });
  }
  if (hasSecondary) {
    el.querySelector('.toast-btn-secondary').addEventListener('click', () => {
      onSecondary();
      close();
    });
  }

  container.appendChild(el);

  if (autoCloseMs > 0) {
    const tid = setTimeout(close, autoCloseMs);
    el.dataset.autoCloseTid = tid;
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// Estilos de animación (inyectados una sola vez)
if (!document.getElementById('toast-styles')) {
  const style = document.createElement('style');
  style.id = 'toast-styles';
  style.textContent = `
    @keyframes toastSlideUp {
      from { opacity: 0; transform: translateY(24px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes toastSlideDown {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(24px); }
    }
    .toast-slide-up .toast-btn-primary:hover,
    .toast-slide-up .toast-btn-secondary:hover { opacity: 0.9; }
    .toast-slide-up .toast-close:hover { background: rgba(0,0,0,0.06); }
  `;
  document.head.appendChild(style);
}

window.showToast = showToast;
