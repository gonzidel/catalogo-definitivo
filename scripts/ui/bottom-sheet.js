// scripts/ui/bottom-sheet.js
// Bottom Sheet modular para agregar productos al carrito

import { normalizeSize } from '../utils/size-normalizer.js';
import { parseARSNumber, formatARS } from '../utils/price.js';

(function() {
  'use strict';

  // Selectores
  const SELECTORS = {
    overlay: '#bottom-sheet-overlay',
    sheet: '#bottom-sheet-agregar',
    body: '#bottom-sheet-body',
    footer: '#bottom-sheet-footer',
    closeBtn: '.bottom-sheet-close-btn',
    addBtn: '.bottom-sheet-add-btn',
    totalCount: '.bottom-sheet-total-count'
  };

  // Estado interno
  let currentProducto = null;
  let selectedColor = null;
  let selectedQuantities = new Map(); // key: `${color}_${talle}` -> quantity

  // Inicialización
  function init() {
    const overlay = document.querySelector(SELECTORS.overlay);
    const sheet = document.querySelector(SELECTORS.sheet);
    
    if (!overlay || !sheet) {
      console.warn('Bottom Sheet: Elementos HTML no encontrados');
      return;
    }

    // Cerrar con overlay
    overlay.addEventListener('click', close);
    
    // Cerrar con ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) {
        close();
      }
    });

    // Prevenir scroll del body cuando está abierto
    const observer = new MutationObserver(() => {
      if (isOpen()) {
        document.body.style.overflow = 'hidden';
      } else {
        document.body.style.overflow = '';
      }
    });

    observer.observe(sheet, { attributes: true, attributeFilter: ['class'] });
  }

  // Utilidades
  function isOpen() {
    const sheet = document.querySelector(SELECTORS.sheet);
    return sheet && sheet.classList.contains('active');
  }

  function formatPrice(precio) {
    return formatARS(precio);
  }

  function cloudinaryOptimized(url, w) {
    if (!url || typeof url !== 'string') return url || '';
    url = url.startsWith('http://') ? url.replace('http://', 'https://') : url;
    return url.replace('/upload/', `/upload/f_auto,q_auto,c_scale,w_${w}/`);
  }

  // Renderizar HTML del Bottom Sheet
  function render(producto, selectedColor, selectedQuantities) {
    if (!producto || !producto.DetalleColor || producto.DetalleColor.length === 0) {
      console.error('Bottom Sheet: Producto inválido');
      return '';
    }

    // Color seleccionado (por defecto el primero)
    const colorObj = producto.DetalleColor.find(d => 
      (d.color || '').trim().toLowerCase() === (selectedColor || '').trim().toLowerCase()
    ) || producto.DetalleColor[0];

    const colorActual = colorObj.color || 'Sin color';
    const imagenPrincipal = colorObj.images?.[0] || producto.VariantePrincipal || '';
    const variantDetails = colorObj.variantDetails || [];

    // Precio
    const hasOffer = producto.OfertaActiva === true || producto.OfertaActiva === 'true';
    const offerPrice = producto.PrecioOferta || '';
    const displayPrice = hasOffer && offerPrice ? offerPrice : producto.Precio;

    // Colores
    const coloresHTML = producto.DetalleColor.map(detalle => {
      const hexColor = detalle.hex_color || '#CD844D';
      const displayNumber = detalle.ColorDisplayNumber || detalle.display_number;
      const isSelected = (detalle.color || '').trim().toLowerCase() === colorActual.trim().toLowerCase();
      
      // Calcular color del texto basado en luminosidad
      const hexToRgb = (hex) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16)
        } : null;
      };
      const rgb = hexToRgb(hexColor);
      const brightness = rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : 128;
      const textColor = brightness > 128 ? "#000000" : "#FFFFFF";
      
      // Agregar el número si existe
      const numberHtml = displayNumber 
        ? `<span class="color-number" style="color: ${textColor}; font-weight: bold; font-size: 0.85em; pointer-events: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);">${displayNumber}</span>` 
        : "";
      
      return `
        <button class="bottom-sheet-color-btn ${isSelected ? 'selected' : ''}" 
                data-color="${detalle.color || ''}"
                data-number="${displayNumber || ''}"
                style="background-color: ${hexColor}; position: relative; display: flex; align-items: center; justify-content: center;">
          ${numberHtml}
        </button>
      `;
    }).join('');

    // Talles con controles
    const tallesHTML = variantDetails.map(vd => {
      const key = `${colorActual}_${vd.talle}`;
      const quantity = Number(selectedQuantities.get(key)) || 0;
      const sinStock = vd.available !== null && vd.available <= 0;
      const disponible = vd.available !== null ? vd.available : null;

      if (sinStock) {
        // Renderizar sin stock: talle tachado en rojo y texto "Sin stock"
        return `
          <div class="bottom-sheet-size-item out-of-stock">
            <span class="bottom-sheet-size-label">Talle ${vd.talle}</span>
            <span class="bottom-sheet-no-stock">Sin stock</span>
          </div>
        `;
      }

      // Renderizado normal con botones + y -
      return `
        <div class="bottom-sheet-size-item">
          <span class="bottom-sheet-size-label">Talle ${vd.talle}${disponible !== null ? ` (${disponible} disp.)` : ''}</span>
          <div class="bottom-sheet-size-control-buttons">
            <button class="bottom-sheet-size-minus" 
                    data-key="${key}"
                    ${quantity <= 0 ? 'disabled' : ''}
                    type="button">−</button>
            <span class="bottom-sheet-size-quantity ${quantity > 0 ? 'has-quantity' : ''}">${quantity}</span>
            <button class="bottom-sheet-size-plus" 
                    data-key="${key}"
                    data-available="${disponible !== null ? disponible : 'null'}"
                    type="button">+</button>
          </div>
        </div>
      `;
    }).join('');

    // Total
    const total = Array.from(selectedQuantities.values()).reduce(
      (sum, qty) => sum + (Number(qty) || 0),
      0
    );

    const scroll = `
      <div class="bottom-sheet-header-compact">
        <button class="bottom-sheet-close-x" type="button" aria-label="Cerrar">×</button>
        <img src="${cloudinaryOptimized(imagenPrincipal, 180)}" 
             alt="${producto.Articulo}" 
             class="bottom-sheet-header-img">
        <div class="bottom-sheet-header-info">
          <div class="bottom-sheet-product-title">${producto.Articulo} – <span class="color-part">${colorActual}</span></div>
          <div class="bottom-sheet-header-price">${formatPrice(displayPrice)}</div>
          <div class="bottom-sheet-colors-inline">
            ${coloresHTML}
          </div>
        </div>
      </div>

      <div class="bottom-sheet-sizes">
        <h4 class="bottom-sheet-sizes-title">Talles</h4>
        <div class="bottom-sheet-size-controls">
          ${tallesHTML}
        </div>
      </div>`;

    const footerHTML = `
      <div class="bottom-sheet-total">
        <span>Total:</span>
        <span class="bottom-sheet-total-count">${total}</span>
      </div>
      <button class="bottom-sheet-close-btn" type="button">Cerrar</button>
      <button class="bottom-sheet-add-btn" ${total === 0 ? 'disabled' : ''} type="button">Agregar</button>`;

    return { scroll, footer: footerHTML };
  }

  // Actualizar contador total
  function updateTotalCounter() {
    const totalEl = document.querySelector(SELECTORS.totalCount);
    if (!totalEl) return;
    
    const total = Array.from(selectedQuantities.values()).reduce(
      (sum, qty) => sum + (Number(qty) || 0),
      0
    );
    totalEl.textContent = String(total);
    
    const addBtn = document.querySelector(SELECTORS.addBtn);
    if (addBtn) {
      addBtn.disabled = total === 0;
    }
  }

  // Handler único para todos los eventos (event delegation)
  let bodyClickHandler = null;

  function attachEventListeners() {
    const sheet = document.querySelector(SELECTORS.sheet);
    if (!sheet) return;

    // Remover handler anterior si existe
    if (bodyClickHandler) {
      sheet.removeEventListener('click', bodyClickHandler);
    }

    // Crear handler único (event delegation en sheet para capturar body + footer)
    bodyClickHandler = (e) => {
      // Botón cerrar X
      if (e.target.classList.contains('bottom-sheet-close-x')) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      // Cambio de color
      if (e.target.classList.contains('bottom-sheet-color-btn')) {
        e.preventDefault();
        e.stopPropagation();
        const nuevoColor = e.target.dataset.color;
        if (nuevoColor && nuevoColor !== selectedColor) {
          selectedColor = nuevoColor;
          selectedQuantities.clear();
          updateContent();
        }
        return;
      }

      // Decrementar cantidad
      if (e.target.classList.contains('bottom-sheet-size-minus')) {
        e.preventDefault();
        e.stopPropagation();
        const key = e.target.dataset.key;
        const currentQty = Number(selectedQuantities.get(key)) || 0;
        if (currentQty > 0) {
          selectedQuantities.set(key, currentQty - 1);
          updateQuantityDisplay(key);
          updateTotalCounter();
        }
        return;
      }

      // Incrementar cantidad
      if (e.target.classList.contains('bottom-sheet-size-plus')) {
        e.preventDefault();
        e.stopPropagation();
        const key = e.target.dataset.key;
        const available = e.target.dataset.available === 'null' ? null : parseInt(e.target.dataset.available, 10);
        const currentQty = Number(selectedQuantities.get(key)) || 0;
        
        if (available === null || currentQty < available) {
          selectedQuantities.set(key, currentQty + 1);
          updateQuantityDisplay(key);
          updateTotalCounter();
        }
        return;
      }

      // Botón cerrar
      if (e.target.classList.contains('bottom-sheet-close-btn')) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }

      // Botón agregar
      if (e.target.classList.contains('bottom-sheet-add-btn')) {
        e.preventDefault();
        e.stopPropagation();
        agregarAlCarrito();
        return;
      }
    };

    // Agregar handler en sheet para capturar body y footer
    sheet.addEventListener('click', bodyClickHandler);
  }

  // Actualizar solo el contenido scrollable cuando cambia el color
  function updateContent() {
    const body = document.querySelector(SELECTORS.body);
    const footer = document.querySelector(SELECTORS.footer);
    if (!body || !footer) return;
    const result = render(currentProducto, selectedColor, selectedQuantities);
    body.innerHTML = result.scroll;
    footer.innerHTML = result.footer;
    updateTotalCounter();
  }

  // Actualizar solo la cantidad de un talle específico
  function updateQuantityDisplay(key) {
    const body = document.querySelector(SELECTORS.body);
    if (!body) return;

    const sizeItem = body.querySelector(`[data-key="${key}"]`)?.closest('.bottom-sheet-size-item');
    if (!sizeItem) return;

    const quantity = Number(selectedQuantities.get(key)) || 0;
    const quantitySpan = sizeItem.querySelector('.bottom-sheet-size-quantity');
    const minusBtn = sizeItem.querySelector('.bottom-sheet-size-minus');
    const plusBtn = sizeItem.querySelector('.bottom-sheet-size-plus');

    if (quantitySpan) {
      quantitySpan.textContent = quantity;
      if (quantity > 0) {
        quantitySpan.classList.add('has-quantity');
      } else {
        quantitySpan.classList.remove('has-quantity');
      }
    }

    if (minusBtn) {
      minusBtn.disabled = quantity <= 0;
    }

    if (plusBtn) {
      const available = plusBtn.dataset.available === 'null' ? null : parseInt(plusBtn.dataset.available, 10);
      if (available !== null && quantity >= available) {
        plusBtn.disabled = true;
      } else {
        plusBtn.disabled = false;
      }
    }
  }

  // Agregar productos al carrito
  function agregarAlCarrito() {
    if (!currentProducto || !window.addToCart) {
      console.error('Bottom Sheet: addToCart no disponible');
      return;
    }

    const hasOffer = currentProducto.OfertaActiva === true || currentProducto.OfertaActiva === 'true';
    const precio = hasOffer && currentProducto.PrecioOferta ? currentProducto.PrecioOferta : currentProducto.Precio;
    const precioLimpio = parseARSNumber(precio);

    // Agregar cada combinación color/talle
    selectedQuantities.forEach((rawQty, key) => {
      const quantity = Number(rawQty) || 0;
      if (quantity <= 0) return;

      const [color, talle] = key.split('_');
      const detalleColor = currentProducto.DetalleColor.find(d => 
        (d.color || '').trim().toLowerCase() === color.trim().toLowerCase()
      );

      if (!detalleColor) return;

      // Normalizar talle para comparar (aunque ya viene normalizado desde enrichProductsWithStock, 
      // normalizarlo aquí también para seguir la norma y ser más defensivo)
      const normalizedTalle = normalizeSize(talle);
      const variantDetail = detalleColor.variantDetails?.find(vd => normalizeSize(vd.talle) === normalizedTalle);
      if (!variantDetail) return;

      const imagen = detalleColor.images?.[0] || currentProducto.VariantePrincipal || '';

      const productData = {
        articulo: currentProducto.Articulo,
        color: color,
        talle: talle,
        cantidad: quantity,
        precio: precioLimpio,
        imagen: imagen,
        descripcion: currentProducto.Descripcion || '',
        variant_id: variantDetail.variant_id || null,
      };

      window.addToCart(productData);
    });

    // Feedback visual en el botón carrito de la card (~600 ms)
    const cartBtn = document.querySelector(`.cart-icon-btn[data-articulo="${currentProducto.Articulo}"]`);
    if (cartBtn) {
      cartBtn.classList.add('is-added');
      setTimeout(() => cartBtn.classList.remove('is-added'), 600);
    }

    close();
  }

  // API pública
  const BottomSheet = {
    open(producto) {
      if (!producto) {
        console.error('Bottom Sheet: Producto requerido');
        return;
      }

      currentProducto = producto;
      selectedColor = producto.DetalleColor?.[0]?.color || null;
      selectedQuantities.clear();

      const body = document.querySelector(SELECTORS.body);
      const footer = document.querySelector(SELECTORS.footer);
      const overlay = document.querySelector(SELECTORS.overlay);
      const sheet = document.querySelector(SELECTORS.sheet);

      if (!body || !footer || !overlay || !sheet) {
        console.error('Bottom Sheet: Elementos HTML no encontrados');
        return;
      }

      const result = render(producto, selectedColor, selectedQuantities);
      body.innerHTML = result.scroll;
      footer.innerHTML = result.footer;
      attachEventListeners();

      overlay.classList.add('active');
      sheet.classList.add('active');
      document.body.classList.add('bottom-sheet-open');
      document.body.style.overflow = 'hidden';
    },

    close() {
      close();
    },

    isOpen() {
      return isOpen();
    }
  };

  function close() {
    const overlay = document.querySelector(SELECTORS.overlay);
    const sheet = document.querySelector(SELECTORS.sheet);

    if (sheet && bodyClickHandler) {
      sheet.removeEventListener('click', bodyClickHandler);
      bodyClickHandler = null;
    }

    if (overlay) overlay.classList.remove('active');
    if (sheet) sheet.classList.remove('active');
    document.body.classList.remove('bottom-sheet-open');
    document.body.style.overflow = '';

    currentProducto = null;
    selectedColor = null;
    selectedQuantities.clear();
  }

  // Inicializar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Exportar API global
  window.BottomSheet = BottomSheet;
})();
