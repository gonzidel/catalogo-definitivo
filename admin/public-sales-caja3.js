// admin/public-sales.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";

await requireAuth();

// ============================================================================
// QZ TRAY - Funciones helper para impresión térmica ESC/POS
// ============================================================================

// Ancho del ticket en caracteres (80mm ≈ 42 caracteres con fuente estándar)
const TICKET_WIDTH = 42;

/**
 * Conecta al websocket de QZ Tray si no está activo
 * @returns {Promise<void>}
 */
async function qzConnect() {
  // Verificar si QZ está disponible
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    throw new Error("QZ Tray no está disponible");
  }
  
  if (!qz.websocket.isActive()) {
    try {
      await qz.websocket.connect();
      console.log("✅ QZ Tray conectado");
    } catch (error) {
      // No mostrar errores de conexión en consola si QZ no está disponible
      // Solo lanzar el error para que el fallback funcione
      throw error;
    }
  }
}

/**
 * Obtiene la configuración de la impresora por defecto
 * @returns {Promise<Object>} Configuración de QZ para la impresora
 */
async function qzGetPrinterConfig() {
  try {
    const printerName = await qz.printers.getDefault();
    console.log("✅ Impresora por defecto:", printerName);
    const config = qz.configs.create(printerName);
    return config;
  } catch (error) {
    console.error("❌ Error obteniendo impresora:", error);
    throw error;
  }
}

/**
 * Convierte un valor a string de forma segura
 * @param {any} text - Valor a convertir
 * @returns {string}
 */
function toStr(text) {
  return (text === null || text === undefined) ? "" : text.toString();
}

/**
 * Rellena texto a la derecha hasta el ancho especificado
 * @param {string} text - Texto a rellenar
 * @param {number} width - Ancho deseado
 * @returns {string}
 */
function padRight(text, width) {
  text = toStr(text);
  if (width <= 0) return "";
  if (text.length >= width) {
    // si se pasa, lo cortamos
    return text.slice(0, width);
  }
  return text + " ".repeat(width - text.length);
}

/**
 * Rellena texto a la izquierda hasta el ancho especificado
 * @param {string} text - Texto a rellenar
 * @param {number} width - Ancho deseado
 * @returns {string}
 */
function padLeft(text, width) {
  text = toStr(text);
  if (width <= 0) return "";
  if (text.length >= width) {
    // si se pasa, lo cortamos
    return text.slice(0, width);
  }
  return " ".repeat(width - text.length) + text;
}

/**
 * Centra texto en el ancho especificado
 * @param {string} text - Texto a centrar
 * @param {number} width - Ancho deseado (por defecto TICKET_WIDTH)
 * @returns {string}
 */
function center(text, width = TICKET_WIDTH) {
  text = toStr(text);
  if (width <= 0) return "";
  if (text.length >= width) {
    return text.slice(0, width);
  }
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(left) + text;
}

/**
 * Construye el ticket en formato ESC/POS a partir de los datos de la venta
 * @param {Object} saleDetails - Detalles de la venta
 * @param {Object} customer - Datos del cliente (opcional)
 * @param {number} finalTotal - Total final de la venta
 * @returns {string} Ticket formateado en texto plano
 */
function buildEscposTicket(saleDetails, customer, finalTotal) {
  const sale = saleDetails.sale;
  const items = saleDetails.items || [];
  
  // Formatear fecha y hora
  const saleDate = new Date(sale.created_at);
  const dateStr = saleDate.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const timeStr = saleDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  let ticket = [];
  
  // Encabezado centrado
  ticket.push(center("FYL moda"));
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");
  
  // Datos de venta
  ticket.push(`Venta: ${sale.sale_number}`);
  ticket.push(`Fecha: ${dateStr}`);
  ticket.push(`Hora: ${timeStr}`);
  if (customer) {
    const customerName = `${customer.first_name} ${customer.last_name || ''}`.trim();
    const maxNameLength = TICKET_WIDTH - 9; // "Cliente: " = 9 caracteres
    ticket.push(`Cliente: ${customerName.substring(0, maxNameLength)}`);
  }
  ticket.push("");
  ticket.push("-".repeat(TICKET_WIDTH));
  
  // Sección DETALLE DE LA COMPRA (centrada)
  ticket.push(center("DETALLE DE LA COMPRA"));
  ticket.push("-".repeat(TICKET_WIDTH));
  
  // Cabecera de columnas con anchos: Producto 22, Cant 4, Precio 8, Total 8
  const colProducto = 22;
  const colCant = 4;
  const colPrecio = 8;
  const colTotal = 8;
  
  const header = padRight("Producto", colProducto) +
                 padLeft("Cant", colCant) +
                 padLeft("Precio", colPrecio) +
                 padLeft("Total", colTotal);
  ticket.push(header);
  ticket.push("-".repeat(TICKET_WIDTH));
  
  // Items de la venta
  items.forEach(item => {
    const price = parseFloat(item.price || item.price_snapshot || 0);
    const total = price * item.qty;
    const isReturn = item.is_return || false;
    
    // Nombre del producto (truncar a 22 caracteres)
    let productName = `${item.product_name || 'N/A'}`;
    if (item.color) productName += ` - ${item.color}`;
    if (item.size) productName += ` (${item.size})`;
    if (isReturn) productName += " [DEV]";
    
    // Truncar a 22 caracteres
    const name = productName.slice(0, colProducto);
    
    // Formatear valores
    const qty = padLeft(String(item.qty), colCant);
    const priceStr = `$${price.toLocaleString('es-AR')}`;
    const totalStr = `${isReturn ? '-' : ''}$${total.toLocaleString('es-AR')}`;
    const priceFormatted = padLeft(priceStr, colPrecio);
    const totalFormatted = padLeft(totalStr, colTotal);
    
    // Línea del item con columnas alineadas
    ticket.push(
      padRight(name, colProducto) +
      qty +
      priceFormatted +
      totalFormatted
    );
  });
  
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");
  
  // Crédito aplicado (si existe) - sin tilde
  if (sale.credit_used > 0) {
    const creditAmount = parseFloat(sale.credit_used);
    const creditStr = `-$${creditAmount.toLocaleString('es-AR')}`;
    ticket.push(`Credito Aplicado: ${padLeft(creditStr, TICKET_WIDTH - 20)}`);
    ticket.push("");
  }
  
  // TOTAL alineado a la derecha
  const totalAmount = parseFloat(sale.total_amount);
  const totalStr = `${totalAmount < 0 ? '-' : ''}$${Math.abs(totalAmount).toLocaleString('es-AR')}`;
  ticket.push(padLeft(`TOTAL: ${totalStr}`, TICKET_WIDTH));
  ticket.push("");
  
  // Saldo a favor (si el total es negativo) - sin tilde
  if (totalAmount < 0) {
    ticket.push("Saldo a favor (Credito):");
    ticket.push(padLeft(totalStr, TICKET_WIDTH));
    ticket.push("");
  }
  
  // Footer primero: DOCUMENTO NO VALIDO / COMO FACTURA
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push(center("DOCUMENTO NO VALIDO"));
  ticket.push(center("COMO FACTURA"));
  ticket.push("");
  
  // Texto previo al QR (si existe cliente con QR) - sin tilde
  if (customer?.qr_code) {
    ticket.push(center("Escanea para ver tu"));
    ticket.push(center("historial y creditos:"));
  }
  
  return ticket.join("\n");
}

/**
 * Imprime el ticket usando QZ Tray
 * @param {Object} saleDetails - Detalles de la venta
 * @param {Object} customer - Datos del cliente (opcional)
 * @param {number} finalTotal - Total final de la venta
 * @returns {Promise<void>}
 */
async function printSaleWithQZ(saleDetails, customer, finalTotal) {
  // Verificar si QZ está disponible antes de intentar
  if (typeof qz === 'undefined' || !qz) {
    throw new Error("QZ Tray no está disponible");
  }
  
  try {
    // Conectar a QZ
    await qzConnect();
    
    // Obtener configuración de impresora
    const config = await qzGetPrinterConfig();
    
    // Construir ticket de texto
    const ticketText = buildEscposTicket(saleDetails, customer, finalTotal);
    
    // Preparar datos para QZ
    const data = [];
    
    // Reset impresora
    data.push("\x1B\x40");
    
    // Ticket de texto
    data.push(ticketText + "\n\n");
    
    // QR Code como imagen (si existe cliente con QR)
    if (customer && customer.qr_code) {
      const url = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
      const size = 180;
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(url)}`;
      
      // Alineacion centrada antes del QR
      data.push("\x1B\x61\x01");  // ESC a 1
      
      data.push({
        type: "raw",
        format: "image",
        flavor: "file",
        data: qrApiUrl,
        options: {
          language: "ESCPOS"
        }
      });
      
      // Alimentar un poco despues del QR (pero no tanto)
      data.push("\x1B\x64\x03");  // ESC d 3 -> 3 lineas
      
      // Volver a alineacion izquierda
      data.push("\x1B\x61\x00");  // ESC a 0
    }
    
    // Corte total
    data.push("\x1D\x56\x42\x00");   // GS V 66 0
    
    // Imprimir
    await qz.print(config, data);
    console.log("✅ Ticket enviado a impresora");
    
  } catch (error) {
    console.error("❌ Error imprimiendo con QZ Tray:", error);
    throw error; // Re-lanzar para que el fallback funcione
  }
}

// Función principal para generar QR usando API (más confiable que librería)
function generateQRCode(url, container, size = 200) {
  console.log("generateQRCode llamado con:", { url, container: !!container, size });
  
  if (!container) {
    console.error("❌ Container no encontrado para generar QR");
    return;
  }
  
  if (!url) {
    console.error("❌ URL no proporcionada para generar QR");
    return;
  }
  
  console.log("🔄 Generando QR code usando API para:", url);
  
  // Limpiar contenedor primero
  container.innerHTML = "";
  
  // Usar API de QR Server (más confiable que librerías CDN)
  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(url)}`;
  console.log("📡 URL de API QR:", qrApiUrl);
  
  const img = document.createElement('img');
  img.src = qrApiUrl;
  img.alt = "QR Code";
  img.style.maxWidth = `${size}px`;
  img.style.height = "auto";
  img.style.display = "block";
  img.style.margin = "0 auto";
  img.style.border = "1px solid #ddd";
  img.style.borderRadius = "4px";
  
  img.onload = () => {
    console.log("✅ QR code generado exitosamente usando API");
    console.log("✅ Imagen cargada correctamente, dimensiones:", img.width, "x", img.height);
  };
  
  img.onerror = (error) => {
    console.error("❌ Error cargando QR desde API:", error);
    console.error("❌ URL que falló:", qrApiUrl);
    container.innerHTML = `<p style="word-break: break-all; font-size: 12px; text-align: center; color: #dc3545;">Error al cargar QR. URL: ${url}</p>`;
  };
  
  container.appendChild(img);
  console.log("📝 Imagen agregada al contenedor");
}

// Función alternativa para generar QR usando librería si está disponible
function generateQRWithLibrary(url, container, size = 200) {
  if (typeof QRCode === 'undefined' || !container) {
    console.warn("QRCode librería no disponible, usando API");
    generateQRCode(url, container, size);
    return;
  }
  
  try {
    const canvas = document.createElement('canvas');
    container.innerHTML = "";
    container.appendChild(canvas);
    
    QRCode.toCanvas(canvas, url, {
      width: size,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    }, (error) => {
      if (error) {
        console.error("Error generando QR con librería:", error);
        generateQRCode(url, container, size);
      } else {
        console.log("✅ QR generado exitosamente con librería");
      }
    });
  } catch (err) {
    console.error("Error en QRCode.toCanvas:", err);
    generateQRCode(url, container, size);
  }
}

// Elementos del DOM
const skuSearch = document.getElementById("sku-search");
const customerSearch = document.getElementById("customer-search");
const customerSuggestions = document.getElementById("customer-suggestions");
const searchBtn = document.getElementById("search-btn");
const returnMode = document.getElementById("return-mode");
const returnModeIndicator = document.getElementById("return-mode-indicator");
const customerInfo = document.getElementById("customer-info");
const customerName = document.getElementById("customer-name");
const customerLastPurchase = document.getElementById("customer-last-purchase");
const customerCredit = document.getElementById("customer-credit");
const loadCreditBtn = document.getElementById("load-credit-btn");
const productSelection = document.getElementById("product-selection");
const productName = document.getElementById("product-name");
const productOfferInfo = document.getElementById("product-offer-info");
const productPrice = document.getElementById("product-price");
const colorButtons = document.getElementById("color-buttons");
const sizeButtons = document.getElementById("size-buttons");
const loadToSaleBtn = document.getElementById("load-to-sale-btn");
const saleListTbody = document.getElementById("sale-list-tbody");
const totalItems = document.getElementById("total-items");
const creditApplied = document.getElementById("credit-applied");
const totalAmount = document.getElementById("total-amount");
const moneyReceived = document.getElementById("money-received");
const changeAmount = document.getElementById("change-amount");
const finalizeSaleBtn = document.getElementById("finalize-sale-btn");
const customersBtn = document.getElementById("customers-btn");
const historyBtn = document.getElementById("history-btn");
const customersModal = document.getElementById("customers-modal");
const closeCustomersModal = document.getElementById("close-customers-modal");
const createCustomerForm = document.getElementById("create-customer-form");
const modalCustomerSearch = document.getElementById("modal-customer-search");
const modalSearchCustomerBtn = document.getElementById("modal-search-customer-btn");
const modalCustomerResults = document.getElementById("modal-customer-results");
const customerQrContainer = document.getElementById("customer-qr-container");
const customerQrCode = document.getElementById("customer-qr-code");
const customerQrUrl = document.getElementById("customer-qr-url");
const closeQrBtn = document.getElementById("close-qr-btn");
const historyModal = document.getElementById("history-modal");
const closeHistoryModal = document.getElementById("close-history-modal");
const historyList = document.getElementById("history-list");
const messageContainer = document.getElementById("message-container");
const printModal = document.getElementById("print-modal");
const closePrintModal = document.getElementById("close-print-modal");
const printBtn = document.getElementById("print-btn");
const printContent = document.getElementById("print-content");
const finalizeLoadingOverlay = document.getElementById("finalize-loading-overlay");
const manualProduct = document.getElementById("manual-product");
const manualSearchBtn = document.getElementById("manual-search-btn");
const manualProductSelection = document.getElementById("manual-product-selection");
const manualProductInfo = document.getElementById("manual-product-info");
const manualProductName = document.getElementById("manual-product-name");
const manualProductOfferInfo = document.getElementById("manual-product-offer-info");
const manualProductPrice = document.getElementById("manual-product-price");
const manualColorButtons = document.getElementById("manual-color-buttons");
const manualSizeButtons = document.getElementById("manual-size-buttons");
const manualLoadBtn = document.getElementById("manual-load-btn");
const autocompleteDropdown = document.getElementById("autocomplete-dropdown");
const extraNumericInput = document.getElementById("extra-numeric");
const extraPercentageInput = document.getElementById("extra-percentage");
const applyExtrasBtn = document.getElementById("apply-extras-btn");
const paymentMethodIndicator = document.getElementById("payment-method-indicator");
const paymentMethodText = document.getElementById("payment-method-text");
const loadAsCreditContainer = document.getElementById("load-as-credit-container");
const loadAsCreditCheckbox = document.getElementById("load-as-credit");
const paymentMethodModal = document.getElementById("payment-method-modal");
const paymentMethodYesBtn = document.getElementById("payment-method-yes");
const paymentMethodNoBtn = document.getElementById("payment-method-no");

// Estado
let currentProduct = null;
let currentVariants = [];
let selectedColor = null;
let selectedSizes = {}; // { size: quantity }
let selectedSizesSource = {}; // { size: { ventaPublico: qty, general: qty } } - rastrear de dónde viene cada cantidad
let saleItems = []; // Array de items en la venta
let selectedCustomer = null;
let customerCredits = [];
let currentSaleData = null; // Datos de la venta actual para QZ Tray

// Estado para modo manual
let manualCurrentProduct = null;
let manualCurrentVariants = [];
let manualSelectedColor = null;
let manualSelectedSizes = {};
let manualSelectedSizesSource = {}; // { size: { ventaPublico: qty, general: qty } }

// Estado para autocompletado
let autocompleteProducts = [];
let autocompleteSelectedIndex = -1;

// Estado para método de pago (por defecto todas las ventas son "contado")
let paymentMethod = 'contado';

// Estado para cargar saldo a favor como crédito
let loadAsCredit = false;

// Identificador de caja actual
const currentCaja = 3;

// Escuchar cambios en modo devoluciones
returnMode.addEventListener("change", async (e) => {
  returnModeIndicator.style.display = e.target.checked ? "block" : "none";
  if (e.target.checked) {
    selectedSizes = {};
    renderSizeButtons();
  }
  // Recalcular totales cuando cambia el modo de devolución
  await calculateTotals();
});

// Buscar por SKU
skuSearch.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    await searchBySku(skuSearch.value.trim());
  }
});

// Buscar producto
searchBtn.addEventListener("click", async () => {
  const sku = skuSearch.value.trim();
  if (sku) {
    await searchBySku(sku);
  } else {
    showMessage("Ingrese un SKU para buscar", "error");
  }
});

// Buscar cliente
let customerSearchTimeout = null;
customerSearch.addEventListener("input", (e) => {
  clearTimeout(customerSearchTimeout);
  const term = e.target.value.trim();
  
  if (term.length < 2) {
    customerSuggestions.innerHTML = "";
    return;
  }

  customerSearchTimeout = setTimeout(async () => {
    await searchCustomer(term);
  }, 300);
});

customerSearch.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    await searchCustomer(customerSearch.value.trim());
  }
});

// Funciones para manejar el dropdown de autocompletado
function showAutocompleteDropdown() {
  if (autocompleteDropdown) {
    autocompleteDropdown.style.display = "block";
  }
}

function hideAutocompleteDropdown() {
  if (autocompleteDropdown) {
    autocompleteDropdown.style.display = "none";
    autocompleteSelectedIndex = -1;
  }
}

function highlightAutocompleteItem(index) {
  const items = autocompleteDropdown.querySelectorAll(".autocomplete-item");
  items.forEach((item, i) => {
    if (i === index) {
      item.classList.add("highlighted");
      item.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      item.classList.remove("highlighted");
    }
  });
}

function selectAutocompleteProduct(product) {
  if (!product) return;
  
  manualProduct.value = product.name;
  hideAutocompleteDropdown();
  autocompleteSelectedIndex = -1;
  
  // Buscar y cargar el producto
  searchManualProduct();
}

// Función para resaltar el término de búsqueda en el texto
function highlightSearchTerm(text, term) {
  if (!term) return text;
  const regex = new RegExp(`(${term})`, "gi");
  return text.replace(regex, '<span class="highlight">$1</span>');
}

// Cargar sugerencias de productos y renderizar en el dropdown
async function loadProductSuggestions(term) {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category")
      .ilike("name", `%${term}%`)
      .eq("status", "active")
      .limit(10);

    if (error) throw error;

    if (!autocompleteDropdown) return;

    autocompleteProducts = [];
    autocompleteSelectedIndex = -1;
    autocompleteDropdown.innerHTML = "";

    if (products && products.length > 0) {
      // Filtrar productos únicos por nombre
      const uniqueProducts = [];
      const seenNames = new Set();
      for (const product of products) {
        if (!seenNames.has(product.name)) {
          seenNames.add(product.name);
          uniqueProducts.push(product);
        }
      }

      autocompleteProducts = uniqueProducts;

      // Renderizar items en el dropdown
      uniqueProducts.forEach((product, index) => {
        const item = document.createElement("div");
        item.className = "autocomplete-item";
        item.setAttribute("data-product-id", product.id);
        item.setAttribute("data-index", index);
        
        const nameHtml = highlightSearchTerm(escapeHtml(product.name), term);
        const categoryHtml = product.category ? `<div class="product-category">${escapeHtml(product.category)}</div>` : "";
        
        item.innerHTML = `
          <div class="product-name">${nameHtml}</div>
          ${categoryHtml}
        `;
        
        item.addEventListener("click", () => {
          selectAutocompleteProduct(product);
        });
        
        item.addEventListener("mouseenter", () => {
          autocompleteSelectedIndex = index;
          highlightAutocompleteItem(index);
        });
        
        autocompleteDropdown.appendChild(item);
      });

      showAutocompleteDropdown();
    } else {
      hideAutocompleteDropdown();
    }
  } catch (error) {
    console.error("Error cargando sugerencias:", error);
    hideAutocompleteDropdown();
  }
}

// Autocompletado de productos para entrada manual
let productSearchTimeout = null;
if (manualProduct) {
  manualProduct.addEventListener("input", (e) => {
    clearTimeout(productSearchTimeout);
    const term = e.target.value.trim();
    
    if (term.length < 2) {
      hideAutocompleteDropdown();
      return;
    }

    productSearchTimeout = setTimeout(async () => {
      await loadProductSuggestions(term);
    }, 150); // Reducido de 300ms a 150ms para respuesta más rápida
  });

  // Navegación con teclado
  manualProduct.addEventListener("keydown", async (e) => {
    if (!autocompleteDropdown || autocompleteDropdown.style.display === "none") {
      if (e.key === "Enter") {
        e.preventDefault();
        const term = manualProduct.value.trim();
        // Si hay texto, verificar si hay una única concordancia antes de buscar
        if (term.length >= 2) {
          // Cargar sugerencias en paralelo con la búsqueda directa para mayor velocidad
          const suggestionsPromise = loadProductSuggestions(term);
          // Si hay exactamente una concordancia después de cargar sugerencias, seleccionarla automáticamente
          await suggestionsPromise;
          if (autocompleteProducts.length === 1) {
            selectAutocompleteProduct(autocompleteProducts[0]);
            return;
          }
        }
        // Si no hay coincidencia única, buscar directamente
        searchManualProduct();
      }
      return;
    }

    const items = autocompleteDropdown.querySelectorAll(".autocomplete-item");
    if (items.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        autocompleteSelectedIndex = Math.min(autocompleteSelectedIndex + 1, items.length - 1);
        highlightAutocompleteItem(autocompleteSelectedIndex);
        break;
      
      case "ArrowUp":
        e.preventDefault();
        autocompleteSelectedIndex = Math.max(autocompleteSelectedIndex - 1, -1);
        if (autocompleteSelectedIndex === -1) {
          items.forEach(item => item.classList.remove("highlighted"));
        } else {
          highlightAutocompleteItem(autocompleteSelectedIndex);
        }
        break;
      
      case "Enter":
        e.preventDefault();
        // Si hay exactamente una concordancia, seleccionarla automáticamente
        if (autocompleteProducts.length === 1) {
          selectAutocompleteProduct(autocompleteProducts[0]);
        } else if (autocompleteSelectedIndex >= 0 && autocompleteProducts[autocompleteSelectedIndex]) {
          selectAutocompleteProduct(autocompleteProducts[autocompleteSelectedIndex]);
        } else {
          searchManualProduct();
        }
        break;
      
      case "Escape":
        e.preventDefault();
        hideAutocompleteDropdown();
        manualProduct.blur();
        break;
    }
  });

  // Buscar producto manualmente
  if (manualSearchBtn) {
    manualSearchBtn.addEventListener("click", async () => {
      await searchManualProduct();
    });
  }

  // Cerrar dropdown cuando el campo pierde el foco (con un pequeño delay para permitir clicks)
  manualProduct.addEventListener("blur", () => {
    setTimeout(() => {
      hideAutocompleteDropdown();
    }, 200);
  });
}

// Cerrar dropdown al hacer clic fuera
document.addEventListener("click", (e) => {
  if (autocompleteDropdown && manualProduct && 
      !autocompleteDropdown.contains(e.target) && 
      e.target !== manualProduct) {
    hideAutocompleteDropdown();
  }
});

// Función para preguntar método de pago cuando se ingresa extra porcentual
async function askPaymentMethod() {
  return new Promise((resolve) => {
    if (!paymentMethodModal) {
      // Fallback si el modal no existe
      const isTarjeta = confirm("¿La compra es con tarjeta?");
      paymentMethod = isTarjeta ? 'tarjeta' : 'contado';
      updatePaymentMethodIndicator();
      resolve(paymentMethod);
      return;
    }

    // Mostrar modal
    paymentMethodModal.classList.add('active');

    // Función para cerrar el modal
    const closeModal = () => {
      paymentMethodModal.classList.remove('active');
    };

    // Función para manejar la respuesta
    const handleResponse = (isTarjeta) => {
      paymentMethod = isTarjeta ? 'tarjeta' : 'contado';
      updatePaymentMethodIndicator();
      closeModal();
      resolve(paymentMethod);
    };

    // Event listeners para los botones (se limpian después de usar)
    const handleYes = () => {
      handleResponse(true);
      paymentMethodYesBtn.removeEventListener('click', handleYes);
      paymentMethodNoBtn.removeEventListener('click', handleNo);
    };

    const handleNo = () => {
      handleResponse(false);
      paymentMethodYesBtn.removeEventListener('click', handleYes);
      paymentMethodNoBtn.removeEventListener('click', handleNo);
    };

    paymentMethodYesBtn.addEventListener('click', handleYes);
    paymentMethodNoBtn.addEventListener('click', handleNo);

    // Cerrar modal al hacer clic fuera
    const handleModalClick = (e) => {
      if (e.target === paymentMethodModal) {
        handleResponse(false); // Por defecto "No" si se cierra sin seleccionar
        paymentMethodModal.removeEventListener('click', handleModalClick);
      }
    };
    paymentMethodModal.addEventListener('click', handleModalClick);
  });
}

// Función auxiliar para actualizar el indicador de método de pago
function updatePaymentMethodIndicator() {
  if (paymentMethodIndicator) {
    paymentMethodIndicator.classList.add('active');
    if (paymentMethodText) {
      paymentMethodText.textContent = paymentMethod === 'tarjeta' ? 'Tarjeta' : 'Contado';
    }
  }
}

// Event listener para campo de extra porcentual
if (extraPercentageInput) {
  extraPercentageInput.addEventListener("blur", async () => {
    const value = extraPercentageInput.value.trim();
    if (value && !isNaN(value) && parseFloat(value) !== 0) {
      await askPaymentMethod();
    }
  });

  extraPercentageInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = extraPercentageInput.value.trim();
      if (value && !isNaN(value) && parseFloat(value) !== 0) {
        await askPaymentMethod();
      }
    }
  });
}

// Función para aplicar extras
async function applyExtras() {
  const numericValue = extraNumericInput ? parseFloat(extraNumericInput.value.trim()) : 0;
  const percentageValue = extraPercentageInput ? parseFloat(extraPercentageInput.value.trim()) : 0;

  // Validar que al menos uno tenga valor
  if ((!numericValue || isNaN(numericValue)) && (!percentageValue || isNaN(percentageValue))) {
    showMessage("Ingrese al menos un valor en los campos de extras", "error");
    return;
  }

  // Si hay extra porcentual, necesitamos calcular sobre el subtotal actual
  // Primero calculamos el subtotal de productos (sin extras)
  const productItems = saleItems.filter(item => !item.isExtra);

  if (productItems.length === 0 && percentageValue) {
    showMessage("No se puede calcular extra porcentual sin productos en la venta", "error");
    return;
  }

  // El cálculo del extra porcentual se hará en calculateTotals sobre el subtotal después de créditos
  // Por ahora solo guardamos el valor del porcentaje, el cálculo se hará dinámicamente

  // Determinar el nombre del extra según el método de pago
  const extraName = paymentMethod === 'tarjeta' ? 'Tarjeta' : 'Extra';

  // Agregar extra numérico si existe
  if (numericValue && !isNaN(numericValue)) {
    const extraNumeric = {
      isExtra: true,
      extraType: 'numeric',
      value: numericValue,
      calculatedValue: numericValue,
      productName: extraName,
      totalValue: numericValue,
      totalQuantity: 1,
      sku: 'EXTRA',
      color: '',
      sizes: []
    };
    saleItems.push(extraNumeric);
  }

  // Agregar extra porcentual si existe
  if (percentageValue && !isNaN(percentageValue)) {
    // El cálculo se hará en calculateTotals sobre el subtotal después de créditos
    const extraPercentage = {
      isExtra: true,
      extraType: 'percentage',
      value: percentageValue,
      calculatedValue: 0, // Se calculará en calculateTotals
      productName: extraName,
      totalValue: 0, // Se calculará en calculateTotals
      totalQuantity: 1,
      sku: 'EXTRA',
      color: '',
      sizes: []
    };
    saleItems.push(extraPercentage);
  }

  // Limpiar campos
  if (extraNumericInput) extraNumericInput.value = "";
  if (extraPercentageInput) extraPercentageInput.value = "";

  // Actualizar lista y totales
  renderSaleList();
  await calculateTotals();
  showMessage("Extras aplicados correctamente", "success");
}

// Event listener para botón aplicar extras
if (applyExtrasBtn) {
  applyExtrasBtn.addEventListener("click", async () => {
    await applyExtras();
  });
}

// Event listener para casilla "Cargar como crédito"
if (loadAsCreditCheckbox) {
  loadAsCreditCheckbox.addEventListener("change", (e) => {
    loadAsCredit = e.target.checked;
  });
}

// Buscar producto manualmente
async function searchManualProduct() {
  const productName = manualProduct.value.trim();
  
  if (!productName) {
    showMessage("Ingrese el nombre del producto", "error");
    return;
  }

  try {
    // Buscar el producto
    const { data: products, error: productsError } = await supabase
      .from("products")
      .select("id, name")
      .ilike("name", productName)
      .eq("status", "active")
      .limit(1)
      .single();

    if (productsError || !products) {
      showMessage("No se encontró el producto", "error");
      return;
    }

    // Cargar variantes del producto
    await loadManualProductVariants(products.id);
  } catch (error) {
    console.error("Error buscando producto manual:", error);
    showMessage("Error al buscar producto: " + error.message, "error");
  }
}

// Cargar variantes del producto para modo manual
async function loadManualProductVariants(productId) {
  try {
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        size,
        price,
        active,
        products!inner (
          id,
          name,
          category,
          status
        )
      `)
      .eq("product_id", productId)
      .eq("active", true)
      .eq("products.status", "active");

    if (error) throw error;

    if (!variants || variants.length === 0) {
      showMessage("No se encontraron variantes activas para este producto", "error");
      return;
    }

    manualCurrentProduct = variants[0].products;
    manualCurrentVariants = variants;

    // Mostrar información básica inmediatamente (sin esperar datos adicionales)
    manualProductName.textContent = manualCurrentProduct.name;
    const firstVariant = manualCurrentVariants[0];
    manualProductPrice.textContent = `$${firstVariant.price.toLocaleString('es-AR')}`;
    if (manualProductInfo) {
      manualProductInfo.style.display = "flex";
    }
    
    // Renderizar colores inmediatamente con precios base
    renderManualColorButtons();
    
    // Obtener stock, precios efectivos e información de ofertas/promociones para cada variante EN PARALELO
    const variantPromises = manualCurrentVariants.map(async (variant) => {
      // Ejecutar todas las llamadas en paralelo para esta variante
      const [stockData, effectivePrice, offerInfo, promotionInfo] = await Promise.all([
        getVariantStock(variant.id),
        getEffectivePrice(variant.id),
        getOfferInfo(variant.id, manualCurrentProduct.id, variant.color),
        getPromotionInfo(variant.id)
      ]);
      
      variant.stockData = stockData;
      variant.effectivePrice = effectivePrice !== null ? effectivePrice : variant.price;
      variant.offerInfo = offerInfo;
      variant.promotionInfo = promotionInfo;
      
      return variant;
    });
    
    // Esperar a que todas las variantes se procesen en paralelo
    await Promise.all(variantPromises);
    
    // Actualizar precio e información de oferta con datos reales después de cargar
    const updatedFirstVariant = manualCurrentVariants[0];
    const firstVariantEffectivePrice = updatedFirstVariant.effectivePrice || updatedFirstVariant.price;
    manualProductPrice.textContent = `$${firstVariantEffectivePrice.toLocaleString('es-AR')}`;
    updateProductOfferDisplay(updatedFirstVariant, manualProductOfferInfo);
    
    // Re-renderizar colores con datos actualizados
    renderManualColorButtons();
  } catch (error) {
    console.error("Error cargando variantes manuales:", error);
    showMessage("Error al cargar variantes: " + error.message, "error");
  }
}

// Renderizar botones de colores para modo manual
function renderManualColorButtons() {
  const colors = [...new Set(manualCurrentVariants.map(v => v.color).filter(Boolean))];
  
  if (!manualColorButtons) return;
  manualColorButtons.innerHTML = "";
  
  colors.forEach(color => {
    const btn = document.createElement("button");
    btn.className = "color-btn";
    btn.textContent = color;
    btn.style.padding = "6px 12px";
    btn.style.fontSize = "13px";
    btn.addEventListener("click", () => {
      document.querySelectorAll("#manual-color-buttons .color-btn").forEach(b => {
        b.classList.remove("active");
        b.style.color = ""; // Resetear color para que use el CSS
      });
      btn.classList.add("active");
      manualSelectedColor = color;
      manualSelectedSizes = {};
      
      // Actualizar precio e información de oferta para el color seleccionado
      const variantsByColor = manualCurrentVariants.filter(v => v.color === color);
      if (variantsByColor.length > 0) {
        const firstVariant = variantsByColor[0];
        const effectivePrice = firstVariant.effectivePrice || firstVariant.price;
        manualProductPrice.textContent = `$${effectivePrice.toLocaleString('es-AR')}`;
        updateProductOfferDisplay(firstVariant, manualProductOfferInfo);
      }
      
      renderManualSizeButtons();
    });
    manualColorButtons.appendChild(btn);
  });

  if (colors.length > 0 && !manualSelectedColor) {
    manualSelectedColor = colors[0];
    document.querySelectorAll("#manual-color-buttons .color-btn")[0]?.classList.add("active");
    
    // Actualizar precio e información de oferta para el primer color
    const variantsByColor = manualCurrentVariants.filter(v => v.color === manualSelectedColor);
    if (variantsByColor.length > 0) {
      const firstVariant = variantsByColor[0];
      const effectivePrice = firstVariant.effectivePrice || firstVariant.price;
      manualProductPrice.textContent = `$${effectivePrice.toLocaleString('es-AR')}`;
      updateProductOfferDisplay(firstVariant, manualProductOfferInfo);
    }
    
    renderManualSizeButtons();
  }
}

// Renderizar botones de talles para modo manual
function renderManualSizeButtons() {
  if (!manualSelectedColor || !manualSizeButtons) return;

  const variantsByColor = manualCurrentVariants.filter(v => v.color === manualSelectedColor);
  const sizes = [...new Set(variantsByColor.map(v => v.size).filter(Boolean))].sort((a, b) => {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return numA - numB;
  });

  manualSizeButtons.innerHTML = "";

  sizes.forEach(size => {
    const variant = variantsByColor.find(v => v.size === size);
    if (!variant) return;

    const stock = variant.stockData || { total: 0, general: { stock: 0 }, ventaPublico: { stock: 0 } };
    const totalStock = stock.total || 0;
    const generalStock = stock.general?.stock || 0;
    const ventaPublicoStock = stock.ventaPublico?.stock || 0;

    const btn = document.createElement("button");
    btn.className = "size-btn";
    btn.textContent = size;
    btn.style.width = "40px";
    btn.style.height = "40px";
    btn.style.fontSize = "14px";

    // Determinar color del botón
    if (totalStock === 0) {
      btn.classList.add("size-zero");
    } else if (ventaPublicoStock > 0) {
      btn.classList.add("size-available");
    } else if (generalStock > 0) {
      btn.classList.add("size-green");
    } else {
      btn.classList.add("size-zero");
    }

    // Mostrar contador si hay cantidad seleccionada
    const quantity = manualSelectedSizes[size] || 0;
    const source = manualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };
    
    // Si hay cantidad seleccionada y se está usando stock de general, cambiar a verde
    if (quantity > 0 && source.general > 0) {
      btn.classList.remove("size-available");
      btn.classList.add("size-green");
    }
    if (quantity > 0) {
      const counter = document.createElement("div");
      counter.className = "size-counter";
      counter.textContent = quantity;
      counter.style.width = "18px";
      counter.style.height = "18px";
      counter.style.fontSize = "11px";
      btn.appendChild(counter);
    }

    // Agregar botón de decremento si hay cantidad seleccionada
    if (quantity > 0) {
      const decrementBtn = document.createElement("button");
      decrementBtn.className = "size-decrement";
      decrementBtn.textContent = "-";
      decrementBtn.type = "button";
      decrementBtn.style.width = "16px";
      decrementBtn.style.height = "16px";
      decrementBtn.style.fontSize = "12px";
      decrementBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (manualSelectedSizes[size] > 0) {
          manualSelectedSizes[size]--;
          // Decrementar de la fuente correspondiente (primero general, luego venta-publico)
          if (manualSelectedSizesSource[size]) {
            if (manualSelectedSizesSource[size].general > 0) {
              manualSelectedSizesSource[size].general--;
            } else if (manualSelectedSizesSource[size].ventaPublico > 0) {
              manualSelectedSizesSource[size].ventaPublico--;
            }
            if (manualSelectedSizesSource[size].ventaPublico === 0 && manualSelectedSizesSource[size].general === 0) {
              delete manualSelectedSizesSource[size];
            }
          }
          if (manualSelectedSizes[size] === 0) {
            delete manualSelectedSizes[size];
            delete manualSelectedSizesSource[size];
          }
          renderManualSizeButtons();
          updateManualLoadButton();
        }
      });
      btn.appendChild(decrementBtn);
    }

    // En modo devoluciones, todos los botones están disponibles sin límite de stock
    if (returnMode.checked || totalStock > 0) {
      btn.addEventListener("click", () => {
        const currentQty = manualSelectedSizes[size] || 0;
        const currentSource = manualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };
        
        // En modo devoluciones, no hay límite de cantidad
        if (returnMode.checked) {
          manualSelectedSizes[size] = currentQty + 1;
          
          // En devoluciones, no necesitamos rastrear la fuente del stock
          // porque se agregará al stock de venta-publico
          if (!manualSelectedSizesSource[size]) {
            manualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };
          }
          
          renderManualSizeButtons();
          updateManualLoadButton();
        } else {
          // Modo venta normal: verificar stock disponible
          const totalStockAvailable = ventaPublicoStock + generalStock;
          
          if (currentQty < totalStockAvailable) {
            manualSelectedSizes[size] = currentQty + 1;
            
            // Asignar a la fuente correcta (priorizar venta-publico)
            if (!manualSelectedSizesSource[size]) {
              manualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };
            }
            
            // Calcular cuánto stock queda disponible en cada almacén
            const remainingVentaPublico = Math.max(0, ventaPublicoStock - currentSource.ventaPublico);
            const remainingGeneral = Math.max(0, generalStock - currentSource.general);
            
            if (remainingVentaPublico > 0) {
              // Aún hay stock en venta-publico, usar de ahí
              manualSelectedSizesSource[size].ventaPublico++;
            } else if (remainingGeneral > 0) {
              // Ya no hay en venta-publico, usar de general (el botón se volverá verde)
              manualSelectedSizesSource[size].general++;
            }
            
            renderManualSizeButtons();
            updateManualLoadButton();
          } else {
            showMessage(`Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock})`, "error", 10000);
          }
        }
      });
    } else {
      btn.style.cursor = "not-allowed";
      btn.style.opacity = "0.5";
    }

    manualSizeButtons.appendChild(btn);
  });

  updateManualLoadButton();
}

// Actualizar botón de cargar para modo manual
function updateManualLoadButton() {
  const hasSelections = Object.keys(manualSelectedSizes).some(size => manualSelectedSizes[size] > 0);
  if (manualLoadBtn) {
    manualLoadBtn.disabled = !hasSelections || !manualSelectedColor;
  }
}

// Cargar a lista de venta desde modo manual
if (manualLoadBtn) {
  manualLoadBtn.addEventListener("click", async () => {
    if (!manualSelectedColor || Object.keys(manualSelectedSizes).length === 0) return;

    const variantsByColor = manualCurrentVariants.filter(v => v.color === manualSelectedColor);
    const isReturn = returnMode.checked;

    // Validar stock antes de agregar
    let hasStockError = false;
    for (const size of Object.keys(manualSelectedSizes)) {
      const quantity = manualSelectedSizes[size];
      if (quantity <= 0) continue;

      const variant = variantsByColor.find(v => v.size === size);
      if (!variant) continue;

      const stock = variant.stockData || { total: 0, general: { stock: 0 }, ventaPublico: { stock: 0 } };
      const totalStock = stock.total || 0;
      
      if (!isReturn && quantity > totalStock) {
        showMessage(`Error: La cantidad seleccionada (${quantity}) para talle ${size} excede el stock disponible (${totalStock})`, "error");
        hasStockError = true;
        break;
      }
    }

    if (hasStockError) return;

    Object.keys(manualSelectedSizes).forEach(size => {
      const quantity = manualSelectedSizes[size];
      if (quantity <= 0) return;

      const variant = variantsByColor.find(v => v.size === size);
      if (!variant) return;

      // Obtener fuente del stock para este talle
      const source = manualSelectedSizesSource[size] || { ventaPublico: quantity, general: 0 };
      
      // Si no hay fuente definida, calcularla basándose en el stock disponible
      if (!manualSelectedSizesSource[size]) {
        const stock = variant.stockData || { general: { stock: 0 }, ventaPublico: { stock: 0 } };
        const ventaPublicoStock = stock.ventaPublico?.stock || 0;
        const generalStock = stock.general?.stock || 0;
        
        // Priorizar venta-publico
        source.ventaPublico = Math.min(quantity, ventaPublicoStock);
        source.general = Math.max(0, quantity - source.ventaPublico);
      }

      // Buscar si ya existe este producto/color en la lista
      const existingIndex = saleItems.findIndex(item => 
        item.productId === manualCurrentProduct.id && 
        item.color === manualSelectedColor
      );

      if (existingIndex >= 0) {
        // Agregar talle a item existente
        const existingSize = saleItems[existingIndex].sizes.find(s => s.size === size);
        if (existingSize) {
          existingSize.quantity += quantity;
          existingSize.source = {
            ventaPublico: (existingSize.source?.ventaPublico || 0) + source.ventaPublico,
            general: (existingSize.source?.general || 0) + source.general
          };
        } else {
          saleItems[existingIndex].sizes.push({ 
            size, 
            quantity, 
            variantId: variant.id,
            source: { ventaPublico: source.ventaPublico, general: source.general }
          });
        }
        saleItems[existingIndex].totalQuantity += quantity;
        
        // Actualizar información de oferta/promoción y precio base si no existe
        if (!saleItems[existingIndex].basePrice) {
          saleItems[existingIndex].basePrice = variant.price;
        }
        if (!saleItems[existingIndex].offerInfo && variant.offerInfo) {
          saleItems[existingIndex].offerInfo = variant.offerInfo;
        }
        if (!saleItems[existingIndex].promotionInfo && variant.promotionInfo) {
          saleItems[existingIndex].promotionInfo = variant.promotionInfo;
        }
        
        // Actualizar isReturn según el modo actual
        const previousIsReturn = saleItems[existingIndex].isReturn;
        saleItems[existingIndex].isReturn = isReturn;
        
        // Si cambió el modo de devolución, recalcular totalValue completo
        if (previousIsReturn !== isReturn) {
          // Recalcular totalValue desde cero basándose en todos los talles
          let recalculatedTotal = 0;
          saleItems[existingIndex].sizes.forEach(s => {
            const sizeVariant = manualCurrentVariants.find(v => v.size === s.size && v.color === manualSelectedColor);
            if (sizeVariant) {
              const effectivePrice = sizeVariant.effectivePrice || sizeVariant.price;
              if (isReturn) {
                recalculatedTotal -= effectivePrice * s.quantity;
              } else {
                recalculatedTotal += effectivePrice * s.quantity;
              }
            }
          });
          saleItems[existingIndex].totalValue = recalculatedTotal;
        } else {
          // Si no cambió el modo, solo ajustar la nueva cantidad
          const effectivePrice = variant.effectivePrice || variant.price;
          if (isReturn) {
            saleItems[existingIndex].totalValue -= effectivePrice * quantity;
          } else {
            saleItems[existingIndex].totalValue += effectivePrice * quantity;
          }
        }
      } else {
        // Crear nuevo item
        // Si es devolución, totalValue debe ser negativo
        const effectivePrice = variant.effectivePrice || variant.price;
        const basePrice = variant.price; // Precio base sin ofertas
        const itemTotalValue = isReturn ? -(effectivePrice * quantity) : (effectivePrice * quantity);
        saleItems.push({
          productId: manualCurrentProduct.id,
          productName: manualCurrentProduct.name,
          sku: variant.sku.split('-')[0],
          color: manualSelectedColor,
          price: effectivePrice,
          basePrice: basePrice, // Guardar precio base para calcular descuentos
          offerInfo: variant.offerInfo || null,
          promotionInfo: variant.promotionInfo || null,
          sizes: [{ 
            size, 
            quantity, 
            variantId: variant.id,
            source: { ventaPublico: source.ventaPublico, general: source.general }
          }],
          totalQuantity: quantity,
          totalValue: itemTotalValue,
          isReturn: isReturn
        });
      }
    });

    // Limpiar selección
    manualSelectedSizes = {};
    manualSelectedSizesSource = {};
    manualSelectedColor = null;
    manualCurrentProduct = null;
    manualCurrentVariants = [];
    manualProduct.value = "";
    if (manualProductInfo) {
      manualProductInfo.style.display = "none";
    }
    renderSaleList();
    await calculateTotals();
    showMessage("Producto(s) agregado(s) a la lista de venta", "success");
  });
}

// Buscar por SKU
async function searchBySku(sku) {
  try {
    const { data: variant, error } = await supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        size,
        price,
        active,
        products!inner (
          id,
          name,
          category,
          status
        )
      `)
      .eq("sku", sku)
      .eq("active", true)
      .eq("products.status", "active")
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        showMessage("No se encontró el producto con ese SKU", "error");
      } else {
        throw error;
      }
      return;
    }

    if (!variant) {
      showMessage("No se encontró el producto con ese SKU", "error");
      return;
    }

    // Verificar stock del SKU específico
    const stockData = await getVariantStock(variant.id);
    const totalStock = stockData.total;

    if (totalStock === 0 && !returnMode.checked) {
      showMessage(`⚠️ Advertencia: No hay stock disponible para el SKU ${sku}. Stock en General: ${stockData.general.stock}, Stock en Venta Público: ${stockData.ventaPublico.stock}`, "error");
      // Aún así cargar el producto para que pueda agregarlo manualmente si quiere
    }

    // Cargar todas las variantes del producto
    await loadProductVariants(variant.products.id);
    
    // Si el SKU tiene stock y no está en modo devoluciones, seleccionar automáticamente color y talle
    if (totalStock > 0 && !returnMode.checked) {
      // Seleccionar el color y talle del SKU encontrado
      selectedColor = variant.color;
      selectedSizes[variant.size] = 1;
      renderColorButtons();
      renderSizeButtons();
      updateLoadButton();
    }
  } catch (error) {
    console.error("Error buscando por SKU:", error);
    showMessage("Error al buscar producto: " + error.message, "error");
  }
}

// Cargar variantes del producto
async function loadProductVariants(productId) {
  try {
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        size,
        price,
        active,
        products!inner (
          id,
          name,
          category,
          status
        )
      `)
      .eq("product_id", productId)
      .eq("active", true)
      .eq("products.status", "active");

    if (error) throw error;

    if (!variants || variants.length === 0) {
      showMessage("No se encontraron variantes activas para este producto", "error");
      return;
    }

    currentProduct = variants[0].products;
    currentVariants = variants;

    // Mostrar información básica inmediatamente (sin esperar datos adicionales)
    productName.textContent = currentProduct.name;
    const firstVariant = currentVariants[0];
    productPrice.textContent = `$${firstVariant.price.toLocaleString('es-AR')}`;
    productSelection.classList.add("active");
    
    // Renderizar colores inmediatamente con precios base
    renderColorButtons();
    
    // Obtener stock, precios efectivos e información de ofertas/promociones para cada variante EN PARALELO
    const variantPromises = currentVariants.map(async (variant) => {
      // Ejecutar todas las llamadas en paralelo para esta variante
      const [stockData, effectivePrice, offerInfo, promotionInfo] = await Promise.all([
        getVariantStock(variant.id),
        getEffectivePrice(variant.id),
        getOfferInfo(variant.id, currentProduct.id, variant.color),
        getPromotionInfo(variant.id)
      ]);
      
      variant.stockData = stockData;
      variant.effectivePrice = effectivePrice !== null ? effectivePrice : variant.price;
      variant.offerInfo = offerInfo;
      variant.promotionInfo = promotionInfo;
      
      return variant;
    });
    
    // Esperar a que todas las variantes se procesen en paralelo
    await Promise.all(variantPromises);
    
    // Actualizar precio e información de oferta con datos reales después de cargar
    const updatedFirstVariant = currentVariants[0];
    const firstVariantEffectivePrice = updatedFirstVariant.effectivePrice || updatedFirstVariant.price;
    productPrice.textContent = `$${firstVariantEffectivePrice.toLocaleString('es-AR')}`;
    updateProductOfferDisplay(updatedFirstVariant, productOfferInfo);
    
    // Re-renderizar colores con datos actualizados
    renderColorButtons();
  } catch (error) {
    console.error("Error cargando variantes:", error);
    showMessage("Error al cargar variantes: " + error.message, "error");
  }
}

// Obtener stock de variante
async function getVariantStock(variantId) {
  try {
    const { data, error } = await supabase
      .rpc("get_variant_stock_by_warehouse", { p_variant_id: variantId });

    if (error) throw error;

    const stockMap = {};
    let total = 0;

    if (data) {
      data.forEach(item => {
        stockMap[item.warehouse_code] = { stock: item.stock_qty, warehouse_id: item.warehouse_id };
        total += item.stock_qty;
      });
    }

    return {
      general: stockMap['general'] || { stock: 0 },
      ventaPublico: stockMap['venta-publico'] || { stock: 0 },
      total: total
    };
  } catch (error) {
    console.error("Error obteniendo stock:", error);
    return {
      general: { stock: 0 },
      ventaPublico: { stock: 0 },
      total: 0
    };
  }
}

// Renderizar botones de colores
function renderColorButtons() {
  const colors = [...new Set(currentVariants.map(v => v.color).filter(Boolean))];
  
  colorButtons.innerHTML = "";
  
  colors.forEach(color => {
    const btn = document.createElement("button");
    btn.className = "color-btn";
    btn.textContent = color;
      btn.addEventListener("click", () => {
      document.querySelectorAll(".color-btn").forEach(b => {
        b.classList.remove("active");
        b.style.color = ""; // Resetear color para que use el CSS
      });
      btn.classList.add("active");
      selectedColor = color;
      selectedSizes = {};
      
      // Actualizar precio e información de oferta para el color seleccionado
      const variantsByColor = currentVariants.filter(v => v.color === color);
      if (variantsByColor.length > 0) {
        const firstVariant = variantsByColor[0];
        const effectivePrice = firstVariant.effectivePrice || firstVariant.price;
        productPrice.textContent = `$${effectivePrice.toLocaleString('es-AR')}`;
        updateProductOfferDisplay(firstVariant, productOfferInfo);
      }
      
      renderSizeButtons();
    });
    colorButtons.appendChild(btn);
  });

  if (colors.length > 0 && !selectedColor) {
    selectedColor = colors[0];
    document.querySelectorAll(".color-btn")[0].classList.add("active");
    
    // Actualizar precio e información de oferta para el primer color
    const variantsByColor = currentVariants.filter(v => v.color === selectedColor);
    if (variantsByColor.length > 0) {
      const firstVariant = variantsByColor[0];
      const effectivePrice = firstVariant.effectivePrice || firstVariant.price;
      productPrice.textContent = `$${effectivePrice.toLocaleString('es-AR')}`;
      updateProductOfferDisplay(firstVariant, productOfferInfo);
    }
    
    renderSizeButtons();
  }
}

// Renderizar botones de talles
function renderSizeButtons() {
  if (!selectedColor) return;

  const variantsByColor = currentVariants.filter(v => v.color === selectedColor);
  const sizes = [...new Set(variantsByColor.map(v => v.size).filter(Boolean))].sort((a, b) => {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return numA - numB;
  });

  sizeButtons.innerHTML = "";

  sizes.forEach(size => {
    const variant = variantsByColor.find(v => v.size === size);
    if (!variant) return;

    const stock = variant.stockData || { total: 0, general: { stock: 0 }, ventaPublico: { stock: 0 } };
    const totalStock = stock.total || 0;
    const generalStock = stock.general?.stock || 0;
    const ventaPublicoStock = stock.ventaPublico?.stock || 0;

    const btn = document.createElement("button");
    btn.className = "size-btn";
    btn.textContent = size;

    // Determinar color del botón
    if (totalStock === 0) {
      btn.classList.add("size-zero");
    } else if (ventaPublicoStock > 0) {
      btn.classList.add("size-available");
    } else if (generalStock > 0) {
      btn.classList.add("size-green");
    } else {
      btn.classList.add("size-zero");
    }

    // Calcular cantidad y fuente de stock
    const quantity = selectedSizes[size] || 0;
    const source = selectedSizesSource[size] || { ventaPublico: 0, general: 0 };
    const totalFromSource = source.ventaPublico + source.general;
    
    // Si hay cantidad seleccionada, verificar si se está usando stock de general
    // El botón se vuelve verde cuando se empieza a usar stock de general
    if (quantity > 0 && source.general > 0) {
      // Se está usando stock de general, cambiar a verde
      btn.classList.remove("size-available");
      btn.classList.add("size-green");
    }

    // Mostrar contador si hay cantidad seleccionada
    if (quantity > 0) {
      const counter = document.createElement("div");
      counter.className = "size-counter";
      counter.textContent = quantity;
      btn.appendChild(counter);
    }

    // Agregar botón de decremento si hay cantidad seleccionada
    if (quantity > 0) {
      const decrementBtn = document.createElement("button");
      decrementBtn.className = "size-decrement";
      decrementBtn.textContent = "-";
      decrementBtn.type = "button";
      decrementBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectedSizes[size] > 0) {
          selectedSizes[size]--;
          // Decrementar de la fuente correspondiente (primero general, luego venta-publico)
          if (selectedSizesSource[size]) {
            if (selectedSizesSource[size].general > 0) {
              selectedSizesSource[size].general--;
            } else if (selectedSizesSource[size].ventaPublico > 0) {
              selectedSizesSource[size].ventaPublico--;
            }
            if (selectedSizesSource[size].ventaPublico === 0 && selectedSizesSource[size].general === 0) {
              delete selectedSizesSource[size];
            }
          }
          if (selectedSizes[size] === 0) {
            delete selectedSizes[size];
            delete selectedSizesSource[size];
          }
          renderSizeButtons();
          updateLoadButton();
        }
      });
      btn.appendChild(decrementBtn);
    }

    // En modo devoluciones, todos los botones están disponibles sin límite de stock
    if (returnMode.checked || totalStock > 0) {
      btn.addEventListener("click", () => {
        const currentQty = selectedSizes[size] || 0;
        const currentSource = selectedSizesSource[size] || { ventaPublico: 0, general: 0 };
        
        // En modo devoluciones, no hay límite de cantidad
        if (returnMode.checked) {
          selectedSizes[size] = currentQty + 1;
          
          // En devoluciones, no necesitamos rastrear la fuente del stock
          // porque se agregará al stock de venta-publico
          if (!selectedSizesSource[size]) {
            selectedSizesSource[size] = { ventaPublico: 0, general: 0 };
          }
          
          renderSizeButtons();
          updateLoadButton();
        } else {
          // Modo venta normal: verificar stock disponible
          const totalStockAvailable = ventaPublicoStock + generalStock;
          
          if (currentQty < totalStockAvailable) {
            selectedSizes[size] = currentQty + 1;
            
            // Asignar a la fuente correcta (priorizar venta-publico)
            if (!selectedSizesSource[size]) {
              selectedSizesSource[size] = { ventaPublico: 0, general: 0 };
            }
            
            // Calcular cuánto stock queda disponible en cada almacén
            const remainingVentaPublico = Math.max(0, ventaPublicoStock - currentSource.ventaPublico);
            const remainingGeneral = Math.max(0, generalStock - currentSource.general);
            
            if (remainingVentaPublico > 0) {
              // Aún hay stock en venta-publico, usar de ahí
              selectedSizesSource[size].ventaPublico++;
            } else if (remainingGeneral > 0) {
              // Ya no hay en venta-publico, usar de general (el botón se volverá verde)
              selectedSizesSource[size].general++;
            }
            
            renderSizeButtons();
            updateLoadButton();
          } else {
            showMessage(`Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock})`, "error", 10000);
          }
        }
      });
    } else {
      btn.style.cursor = "not-allowed";
      btn.style.opacity = "0.5";
    }

    sizeButtons.appendChild(btn);
  });

  updateLoadButton();
}

// Actualizar botón de cargar
function updateLoadButton() {
  const hasSelections = Object.keys(selectedSizes).some(size => selectedSizes[size] > 0);
  loadToSaleBtn.disabled = !hasSelections || !selectedColor;
}

// Cargar a lista de venta
loadToSaleBtn.addEventListener("click", async () => {
  if (!selectedColor || Object.keys(selectedSizes).length === 0) return;

  const variantsByColor = currentVariants.filter(v => v.color === selectedColor);
  const isReturn = returnMode.checked;

  Object.keys(selectedSizes).forEach(size => {
    const quantity = selectedSizes[size];
    if (quantity <= 0) return;

    const variant = variantsByColor.find(v => v.size === size);
    if (!variant) return;

    // Buscar si ya existe este producto/color en la lista
    const existingIndex = saleItems.findIndex(item => 
      item.productId === currentProduct.id && 
      item.color === selectedColor
    );

    // Obtener fuente del stock para este talle
    const source = selectedSizesSource[size] || { ventaPublico: quantity, general: 0 };
    
    // Si no hay fuente definida, calcularla basándose en el stock disponible
    if (!selectedSizesSource[size]) {
      const stock = variant.stockData || { general: { stock: 0 }, ventaPublico: { stock: 0 } };
      const ventaPublicoStock = stock.ventaPublico?.stock || 0;
      const generalStock = stock.general?.stock || 0;
      
      // Priorizar venta-publico
      source.ventaPublico = Math.min(quantity, ventaPublicoStock);
      source.general = Math.max(0, quantity - source.ventaPublico);
    }

    if (existingIndex >= 0) {
      // Agregar talle a item existente
      const existingSize = saleItems[existingIndex].sizes.find(s => s.size === size);
      if (existingSize) {
        existingSize.quantity += quantity;
        existingSize.source = {
          ventaPublico: (existingSize.source?.ventaPublico || 0) + source.ventaPublico,
          general: (existingSize.source?.general || 0) + source.general
        };
      } else {
        saleItems[existingIndex].sizes.push({ 
          size, 
          quantity, 
          variantId: variant.id,
          source: { ventaPublico: source.ventaPublico, general: source.general }
        });
      }
      saleItems[existingIndex].totalQuantity += quantity;
      
      // Actualizar información de oferta/promoción y precio base si no existe
      if (!saleItems[existingIndex].basePrice) {
        saleItems[existingIndex].basePrice = variant.price;
      }
      if (!saleItems[existingIndex].offerInfo && variant.offerInfo) {
        saleItems[existingIndex].offerInfo = variant.offerInfo;
      }
      if (!saleItems[existingIndex].promotionInfo && variant.promotionInfo) {
        saleItems[existingIndex].promotionInfo = variant.promotionInfo;
      }
      
      // Actualizar isReturn según el modo actual
      const previousIsReturn = saleItems[existingIndex].isReturn;
      saleItems[existingIndex].isReturn = isReturn;
      
      // Si cambió el modo de devolución, recalcular totalValue completo
      if (previousIsReturn !== isReturn) {
        // Recalcular totalValue desde cero basándose en todos los talles
        let recalculatedTotal = 0;
        saleItems[existingIndex].sizes.forEach(s => {
          const sizeVariant = variantsByColor.find(v => v.size === s.size);
          if (sizeVariant) {
            const effectivePrice = sizeVariant.effectivePrice || sizeVariant.price;
            if (isReturn) {
              recalculatedTotal -= effectivePrice * s.quantity;
            } else {
              recalculatedTotal += effectivePrice * s.quantity;
            }
          }
        });
        saleItems[existingIndex].totalValue = recalculatedTotal;
      } else {
        // Si no cambió el modo, solo ajustar la nueva cantidad
        const effectivePrice = variant.effectivePrice || variant.price;
        if (isReturn) {
          saleItems[existingIndex].totalValue -= effectivePrice * quantity;
        } else {
          saleItems[existingIndex].totalValue += effectivePrice * quantity;
        }
      }
    } else {
      // Crear nuevo item
      // Si es devolución, totalValue debe ser negativo
      const effectivePrice = variant.effectivePrice || variant.price;
      const basePrice = variant.price; // Precio base sin ofertas
      const itemTotalValue = isReturn ? -(effectivePrice * quantity) : (effectivePrice * quantity);
      saleItems.push({
        productId: currentProduct.id,
        productName: currentProduct.name,
        sku: variant.sku.split('-')[0], // SKU base
        color: selectedColor,
        price: effectivePrice,
        basePrice: basePrice, // Guardar precio base para calcular descuentos
        offerInfo: variant.offerInfo || null,
        promotionInfo: variant.promotionInfo || null,
        sizes: [{ 
          size, 
          quantity, 
          variantId: variant.id,
          source: { ventaPublico: source.ventaPublico, general: source.general }
        }],
        totalQuantity: quantity,
        totalValue: itemTotalValue,
        isReturn: isReturn
      });
    }
  });

  // Limpiar selección
  selectedSizes = {};
  selectedSizesSource = {};
  renderSizeButtons();
  renderSaleList();
  await calculateTotals();
});

// Función auxiliar para calcular el descuento de un item
function calculateItemDiscount(item) {
  if (!item.basePrice || (!item.offerInfo && !item.promotionInfo)) {
    return 0;
  }
  
  // Para ofertas: descuento = (precio base - precio efectivo) * cantidad total
  if (item.offerInfo && !item.promotionInfo) {
    const discountPerUnit = item.basePrice - item.price;
    return discountPerUnit * item.totalQuantity;
  }
  
  // Para promociones, calcular el descuento según el tipo
  // IMPORTANTE: Solo aplicar descuento si se cumple la condición mínima de la promoción
  if (item.promotionInfo) {
    // Verificar si la promoción realmente se aplica (necesita mínimo 2 unidades)
    if (item.totalQuantity < 2) {
      // Si hay menos de 2 unidades, la promoción NO se aplica, no hay descuento
      return 0;
    }
    
    // Usar precio efectivo (con ofertas aplicadas) como base para calcular el descuento de la promoción
    const totalEffectiveValue = item.price * item.totalQuantity;
    
    if (item.promotionInfo.promoType === '2x1') {
      // En 2x1: se cobra solo la mitad (redondeado hacia arriba)
      // Ejemplo: 2 items a $10.000 = $20.000, se cobra 1 = $10.000, descuento = $10.000
      // Ejemplo: 3 items a $10.000 = $30.000, se cobra 2 = $20.000, descuento = $10.000
      const toCharge = Math.ceil(item.totalQuantity / 2);
      const chargedValue = item.price * toCharge;
      const discount = totalEffectiveValue - chargedValue;
      // Solo retornar descuento si es positivo y hay al menos 2 unidades
      return discount > 0 ? discount : 0;
    } else if (item.promotionInfo.promoType === '2xMonto' && item.promotionInfo.fixedAmount) {
      // En 2xMonto: se cobra monto fijo por cada grupo de 2
      // Ejemplo: 2 items a $10.000 = $20.000, se cobra $22.222, descuento = -$2.222 (aumento)
      // Ejemplo: 4 items a $10.000 = $40.000, se cobra $44.444, descuento = -$4.444 (aumento)
      // Si el descuento es negativo, no mostrar (es un aumento de precio)
      const groups = Math.floor(item.totalQuantity / 2);
      if (groups === 0) {
        // No hay grupos completos de 2, la promoción no se aplica
        return 0;
      }
      const chargedValue = item.promotionInfo.fixedAmount * groups;
      const discount = totalEffectiveValue - chargedValue;
      // Solo mostrar descuento si es positivo (si es negativo, es un aumento y no se muestra)
      return discount > 0 ? discount : 0;
    }
  }
  
  return 0;
}

// Renderizar lista de venta
function renderSaleList() {
  if (saleItems.length === 0) {
    saleListTbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; padding: 40px; color: #999;">
          No hay productos en la lista de venta
        </td>
      </tr>
    `;
    return;
  }

  // Construir HTML de items, agregando items de oferta después de cada producto con oferta/promoción
  let html = '';
  let itemIndex = 0;
  
  saleItems.forEach((item, originalIndex) => {
    // Si es un extra, renderizar de forma especial
    if (item.isExtra) {
      const rowClass = "extra-item";
      const valueSign = item.totalValue < 0 ? '-' : '';
      const valueDisplay = Math.abs(item.totalValue);
      
      html += `
        <tr class="${rowClass}">
          <td>-</td>
          <td>${escapeHtml(item.productName)}</td>
          <td>-</td>
          <td>-</td>
          <td>-</td>
          <td>1</td>
          <td>${valueSign}$${valueDisplay.toLocaleString('es-AR')}</td>
          <td>
            <button class="btn btn-secondary" onclick="removeSaleItem(${originalIndex})" style="padding: 6px 12px; font-size: 12px;">
              Eliminar
            </button>
          </td>
        </tr>
      `;
      return; // Continuar con el siguiente item (no agregar item de oferta para extras)
    }

    // Renderizar producto normal
    const sizesHtml = item.sizes.map(s => `
      <div class="size-fraction">
        <div class="size">${escapeHtml(s.size)}</div>
        <div class="qty">${s.quantity}</div>
      </div>
    `).join("");

    const rowClass = item.isReturn ? "return-item" : "";
    
    // Construir información de oferta/promoción
    let offerInfoHtml = '';
    if (item.promotionInfo) {
      offerInfoHtml = `<div style="font-size: 11px; color: #dc3545; font-weight: 600; margin-top: 2px;">🔥 ${escapeHtml(item.promotionInfo.description)}</div>`;
    } else if (item.offerInfo) {
      const offer = item.offerInfo;
      if (offer.discountPercent > 0) {
        offerInfoHtml = `<div style="font-size: 11px; color: #dc3545; font-weight: 600; margin-top: 2px;">🔥 ${offer.discountPercent}% OFF - ${escapeHtml(offer.title)}</div>`;
      } else {
        offerInfoHtml = `<div style="font-size: 11px; color: #dc3545; font-weight: 600; margin-top: 2px;">🔥 ${escapeHtml(offer.title)}</div>`;
      }
    }

    // Renderizar el producto
    html += `
      <tr class="${rowClass}">
        <td>${escapeHtml(item.sku)}</td>
        <td>
          <div>${escapeHtml(item.productName)}</div>
          ${offerInfoHtml}
        </td>
        <td>$${item.price.toLocaleString('es-AR')}</td>
        <td>${escapeHtml(item.color)}</td>
        <td>${sizesHtml}</td>
        <td>${item.totalQuantity}</td>
        <td>${item.isReturn ? '-' : ''}$${Math.abs(item.totalValue).toLocaleString('es-AR')}</td>
        <td>
          <button class="btn btn-secondary" onclick="removeSaleItem(${originalIndex})" style="padding: 6px 12px; font-size: 12px;">
            Eliminar
          </button>
        </td>
      </tr>
    `;
    
    // Si el producto tiene oferta o promoción, agregar un item "Oferta" con el descuento
    if ((item.offerInfo || item.promotionInfo) && !item.isReturn) {
      const discount = calculateItemDiscount(item);
      if (discount > 0) {
        const discountDescription = item.promotionInfo 
          ? item.promotionInfo.description 
          : (item.offerInfo.discountPercent > 0 
              ? `${item.offerInfo.discountPercent}% OFF - ${item.offerInfo.title}`
              : item.offerInfo.title);
        
        html += `
          <tr class="offer-discount-item" style="background: #fff3cd; border-left: 4px solid #ffc107;">
            <td>-</td>
            <td>
              <div style="font-weight: 600; color: #856404;">🔥 Oferta</div>
              <div style="font-size: 11px; color: #856404; margin-top: 2px;">${escapeHtml(discountDescription)}</div>
            </td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td>-</td>
            <td style="color: #28a745; font-weight: 600;">-$${discount.toLocaleString('es-AR')}</td>
            <td></td>
          </tr>
        `;
      }
    }
    
    itemIndex++;
  });
  
  saleListTbody.innerHTML = html;
}

// Función global para eliminar item
window.removeSaleItem = async function(index) {
  saleItems.splice(index, 1);
  renderSaleList();
  await calculateTotals();
};

// Función auxiliar para obtener precio efectivo con oferta
async function getEffectivePrice(variantId) {
  try {
    const { data, error } = await supabase
      .rpc('get_effective_price', { p_variant_id: variantId });
    
    if (error) throw error;
    return data || null;
  } catch (error) {
    console.error('Error obteniendo precio efectivo:', error);
    return null;
  }
}

// Función auxiliar para obtener información de ofertas activas para una variante
async function getOfferInfo(variantId, productId, color) {
  try {
    const now = new Date().toISOString().split('T')[0];
    
    // Obtener oferta de precio por color
    const { data: offer, error: offerError } = await supabase
      .from('color_price_offers')
      .select('offer_price, offer_title, start_date, end_date, status')
      .eq('product_id', productId)
      .eq('color', color)
      .eq('status', 'active')
      .lte('start_date', now)
      .gte('end_date', now)
      .maybeSingle();
    
    if (offerError && offerError.code !== 'PGRST116') {
      console.error('Error obteniendo oferta:', offerError);
    }
    
    if (offer) {
      // Obtener precio base de la variante para calcular el descuento
      const { data: variant } = await supabase
        .from('product_variants')
        .select('price')
        .eq('id', variantId)
        .single();
      
      if (variant) {
        const basePrice = variant.price;
        const offerPrice = offer.offer_price;
        const discount = basePrice - offerPrice;
        const discountPercent = Math.round((discount / basePrice) * 100);
        
        return {
          type: 'offer',
          title: offer.offer_title || 'Oferta',
          discountPercent: discountPercent,
          offerPrice: offerPrice,
          basePrice: basePrice
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error obteniendo información de oferta:', error);
    return null;
  }
}

// Función auxiliar para obtener información de promociones activas para una variante
async function getPromotionInfo(variantId) {
  try {
    const { data: promotions, error } = await supabase
      .rpc('get_active_promotions_for_variants', { p_variant_ids: [variantId] });
    
    if (error) throw error;
    
    if (promotions && promotions.length > 0) {
      const promo = promotions[0]; // Tomar la primera promoción
      if (promo.promo_type === '2x1') {
        return {
          type: 'promotion',
          name: '2x1',
          description: 'Llevá 2 y pagá 1',
          promoType: '2x1',
          fixedAmount: null
        };
      } else if (promo.promo_type === '2xMonto' && promo.fixed_amount) {
        return {
          type: 'promotion',
          name: '2xMonto',
          description: `2x $${promo.fixed_amount.toLocaleString('es-AR')}`,
          promoType: '2xMonto',
          fixedAmount: promo.fixed_amount
        };
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error obteniendo información de promoción:', error);
    return null;
  }
}

// Función auxiliar para actualizar la visualización de información de ofertas/promociones
function updateProductOfferDisplay(variant, offerInfoElement) {
  if (!offerInfoElement || !variant) {
    if (offerInfoElement) offerInfoElement.style.display = 'none';
    return;
  }
  
  // Priorizar promoción sobre oferta
  if (variant.promotionInfo) {
    offerInfoElement.textContent = `🔥 ${variant.promotionInfo.description}`;
    offerInfoElement.style.display = 'block';
    offerInfoElement.style.color = '#dc3545';
  } else if (variant.offerInfo) {
    const offer = variant.offerInfo;
    if (offer.discountPercent > 0) {
      offerInfoElement.textContent = `🔥 ${offer.discountPercent}% OFF - ${offer.title}`;
    } else {
      offerInfoElement.textContent = `🔥 ${offer.title}`;
    }
    offerInfoElement.style.display = 'block';
    offerInfoElement.style.color = '#dc3545';
  } else {
    offerInfoElement.style.display = 'none';
  }
}

// Función auxiliar para obtener promociones activas para variantes
async function getActivePromotionsForVariants(variantIds) {
  try {
    const { data, error } = await supabase
      .rpc('get_active_promotions_for_variants', { p_variant_ids: variantIds });
    
    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error obteniendo promociones:', error);
    return [];
  }
}

// Calcular totales con ofertas y promociones
async function calculateTotals() {
  const totalItemsCount = saleItems.reduce((sum, item) => sum + item.totalQuantity, 0);
  
  // Obtener todos los variant_ids de los items
  const variantIds = [];
  saleItems.forEach(item => {
    item.sizes.forEach(size => {
      if (size.variantId) {
        variantIds.push(size.variantId);
      }
    });
  });
  
  // Obtener precios efectivos con ofertas
  const effectivePrices = new Map();
  for (const variantId of variantIds) {
    const price = await getEffectivePrice(variantId);
    if (price !== null) {
      effectivePrices.set(variantId, price);
    }
  }
  
  // Obtener promociones activas
  const promotions = await getActivePromotionsForVariants(variantIds);
  
  // Crear mapa de variant_id -> promociones
  const variantPromos = new Map();
  promotions.forEach(promo => {
    promo.variant_ids.forEach(vid => {
      if (!variantPromos.has(vid)) {
        variantPromos.set(vid, []);
      }
      variantPromos.get(vid).push(promo);
    });
  });
  
  // Calcular subtotal considerando ofertas y promociones
  let subtotal = 0;
  const itemsInPromos = new Set();
  
  // Primero procesar promociones (prioridad)
  const promoGroups = new Map(); // promotion_id -> items[]
  
  saleItems.forEach(item => {
    item.sizes.forEach(size => {
      if (!size.variantId) return;
      
      const promos = variantPromos.get(size.variantId) || [];
      if (promos.length > 0) {
        // Item está en promoción
        const promo = promos[0]; // Tomar la primera promo si hay múltiples
        if (!promoGroups.has(promo.promotion_id)) {
          promoGroups.set(promo.promotion_id, []);
        }
        promoGroups.get(promo.promotion_id).push({
          item,
          size,
          variantId: size.variantId,
          quantity: size.quantity
        });
        itemsInPromos.add(`${item.productId}-${item.color}-${size.size}`);
      }
    });
  });
  
  // Aplicar promociones (solo si se cumple la condición mínima)
  promoGroups.forEach((items, promoId) => {
    const promo = promotions.find(p => p.promotion_id === promoId);
    if (!promo) return;
    
    const totalItems = items.reduce((sum, i) => sum + i.quantity, 0);
    const groups = Math.floor(totalItems / 2); // Grupos de 2
    const isReturn = items[0]?.item?.isReturn || false;
    
    // Verificar que la promoción realmente se aplica (necesita mínimo 2 unidades)
    if (totalItems < 2) {
      // Si hay menos de 2 unidades, NO aplicar la promoción
      // Los items se procesarán como items normales más adelante
      items.forEach(({ item, size, variantId, quantity }) => {
        // Remover de itemsInPromos para que se procese como item normal
        const itemKey = `${item.productId}-${item.color}-${size.size}`;
        itemsInPromos.delete(itemKey);
      });
      return; // Saltar esta promoción
    }
    
    if (promo.promo_type === '2x1') {
      // Cobrar solo la mitad (redondear hacia arriba si impar)
      const toCharge = Math.ceil(totalItems / 2);
      let charged = 0;
      items.forEach(({ item, size, variantId, quantity }) => {
        if (charged >= toCharge) return;
        // Usar precio efectivo del variant (con ofertas) para promociones
        // Si no está en effectivePrices, usar item.price que ya contiene el precio efectivo
        const price = effectivePrices.get(variantId) || item.price || 0;
        const remainingToCharge = toCharge - charged;
        const qtyToCharge = Math.min(quantity, remainingToCharge);
        const itemValue = price * qtyToCharge;
        charged += qtyToCharge;
        if (!isReturn) {
          subtotal += itemValue;
        } else {
          subtotal -= itemValue;
        }
      });
    } else if (promo.promo_type === '2xMonto' && promo.fixed_amount) {
      // Cobrar monto fijo por cada grupo de 2 (solo si hay al menos 1 grupo completo)
      if (groups > 0) {
        const promoValue = promo.fixed_amount * groups;
        if (!isReturn) {
          subtotal += promoValue;
        } else {
          subtotal -= promoValue;
        }
      } else {
        // Si no hay grupos completos, remover de itemsInPromos para procesar como normal
        items.forEach(({ item, size }) => {
          const itemKey = `${item.productId}-${item.color}-${size.size}`;
          itemsInPromos.delete(itemKey);
        });
      }
    }
  });
  
  // Procesar items que NO están en promociones
  // Usar directamente item.price que ya contiene el precio efectivo (con ofertas aplicadas)
  saleItems.forEach(item => {
    // Saltar extras que se procesan después
    if (item.isExtra) return;
    
    item.sizes.forEach(size => {
      const itemKey = `${item.productId}-${item.color}-${size.size}`;
      if (itemsInPromos.has(itemKey)) {
        // Ya procesado en promoción
        return;
      }
      
      const quantity = size.quantity;
      // item.price ya contiene el precio efectivo (con ofertas aplicadas al cargar)
      const price = item.price || 0;
      const itemValue = price * quantity;
      
      if (item.isReturn) {
        subtotal -= itemValue;
      } else {
        subtotal += itemValue;
      }
    });
  });

  // Aplicar crédito solo si el subtotal es positivo
  const credit = customerCredits.reduce((sum, c) => sum + c.amount, 0);
  const creditToApply = subtotal > 0 ? Math.min(credit, subtotal) : 0;
  let finalTotal = subtotal - creditToApply; // Permitir valores negativos para devoluciones

  // Separar items de productos de extras
  const productItems = saleItems.filter(item => !item.isExtra);
  const extraItems = saleItems.filter(item => item.isExtra);

  // Calcular extras porcentuales sobre el subtotal después de créditos
  const percentageExtras = extraItems.filter(item => item.extraType === 'percentage');
  percentageExtras.forEach(extra => {
    // Recalcular el valor porcentual sobre el subtotal actual
    const percentageValue = (finalTotal * extra.value) / 100;
    extra.calculatedValue = percentageValue;
    extra.totalValue = percentageValue;
    finalTotal += percentageValue;
  });

  // Aplicar extras numéricos
  const numericExtras = extraItems.filter(item => item.extraType === 'numeric');
  numericExtras.forEach(extra => {
    finalTotal += extra.totalValue; // Ya incluye el signo negativo si corresponde
  });

  totalItems.textContent = totalItemsCount;
  
  // Crédito aplicado siempre en rojo
  creditApplied.textContent = `$${creditToApply.toLocaleString('es-AR')}`;
  creditApplied.style.color = "#dc3545"; // Rojo
  creditApplied.style.fontWeight = "700";
  
  // Mostrar el total: verde si positivo, rojo si negativo
  if (finalTotal < 0) {
    // Total negativo (devolución/saldo a favor) → rojo
    totalAmount.textContent = `-$${Math.abs(finalTotal).toLocaleString('es-AR')}`;
    totalAmount.style.color = "#dc3545"; // Rojo
    totalAmount.style.fontWeight = "700";
    totalAmount.style.fontSize = "20px";
    
    // Mostrar casilla "Cargar como crédito" solo si hay cliente seleccionado
    if (selectedCustomer && loadAsCreditContainer) {
      loadAsCreditContainer.style.display = "block";
    }
  } else if (finalTotal > 0) {
    // Total positivo → verde
    totalAmount.textContent = `$${finalTotal.toLocaleString('es-AR')}`;
    totalAmount.style.color = "#28a745"; // Verde
    totalAmount.style.fontWeight = "700";
    totalAmount.style.fontSize = "20px";
    
    // Ocultar casilla si el total es positivo
    if (loadAsCreditContainer) {
      loadAsCreditContainer.style.display = "none";
      loadAsCredit = false;
      if (loadAsCreditCheckbox) {
        loadAsCreditCheckbox.checked = false;
      }
    }
  } else {
    // Total cero
    totalAmount.textContent = `$0`;
    totalAmount.style.color = "#333";
    totalAmount.style.fontWeight = "normal";
    totalAmount.style.fontSize = "inherit";
    
    // Ocultar casilla si el total es cero
    if (loadAsCreditContainer) {
      loadAsCreditContainer.style.display = "none";
      loadAsCredit = false;
      if (loadAsCreditCheckbox) {
        loadAsCreditCheckbox.checked = false;
      }
    }
  }
  
  // Actualizar el cambio cuando cambia el total
  updateChangeAmount();
}

// Función para calcular y mostrar el cambio
function updateChangeAmount() {
  if (!moneyReceived || !changeAmount || !totalAmount) return;
  
  // Obtener el dinero recibido (eliminar puntos de formato para el cálculo)
  const receivedValue = moneyReceived.value.trim();
  const receivedNumbers = receivedValue.replace(/[^0-9]/g, ''); // Eliminar puntos de formato
  const received = parseFloat(receivedNumbers) || 0;
  
  // Si no se ha ingresado ningún monto (campo vacío o 0), mostrar $0
  if (!receivedValue || received === 0) {
    changeAmount.textContent = "$0";
    changeAmount.style.color = "#333";
    return;
  }
  
  // Obtener el total de la compra (sin el símbolo $)
  // Manejar tanto valores positivos como negativos (devoluciones)
  let totalText = totalAmount.textContent.trim();
  const isNegative = totalText.startsWith('-');
  
  // Eliminar símbolos y caracteres no numéricos, pero preservar el formato
  // En formato argentino, los puntos son separadores de miles, no decimales
  // Eliminamos todos los puntos y luego parseamos
  totalText = totalText.replace(/[^0-9]/g, ''); // Eliminar todo excepto números
  const total = parseFloat(totalText) || 0; // Ahora parseFloat funciona correctamente
  const totalValue = isNegative ? -total : total;
  
  // Calcular el cambio: dinero recibido - total
  // Si el total es negativo (devolución), el cambio será positivo (dinero que debemos devolver)
  const change = received - totalValue;
  
  // Mostrar el cambio
  if (change < 0) {
    // Si el dinero recibido es menor al total, mostrar en rojo (falta dinero)
    changeAmount.textContent = `-$${Math.abs(change).toLocaleString('es-AR')}`;
    changeAmount.style.color = "#dc3545";
  } else if (change > 0) {
    // Si hay cambio positivo, mostrar en verde (hay que devolver cambio)
    changeAmount.textContent = `$${change.toLocaleString('es-AR')}`;
    changeAmount.style.color = "#28a745";
  } else {
    // Si no hay cambio, mostrar $0
    changeAmount.textContent = "$0";
    changeAmount.style.color = "#333";
  }
}

// Función para formatear número con separadores de miles (formato argentino)
function formatNumberWithThousands(value) {
  // Eliminar todo excepto números
  const numbers = value.replace(/[^0-9]/g, '');
  if (!numbers) return '';
  
  // Convertir a número y formatear con puntos como separadores de miles
  const num = parseInt(numbers, 10);
  if (isNaN(num)) return '';
  
  return num.toLocaleString('es-AR');
}

// Event listener para calcular el cambio cuando se ingresa dinero recibido
if (moneyReceived) {
  // Formatear el valor mientras se escribe
  moneyReceived.addEventListener("input", (e) => {
    const input = e.target;
    const cursorPosition = input.selectionStart;
    const originalValue = input.value;
    
    // Contar cuántos caracteres hay antes del cursor (sin contar puntos)
    const beforeCursor = originalValue.substring(0, cursorPosition);
    const digitsBeforeCursor = beforeCursor.replace(/[^0-9]/g, '').length;
    
    // Obtener solo los números
    const numbers = originalValue.replace(/[^0-9]/g, '');
    
    if (numbers) {
      // Formatear el número
      const formatted = formatNumberWithThousands(numbers);
      
      // Actualizar el valor formateado
      input.value = formatted;
      
      // Calcular nueva posición del cursor
      // Contar dígitos hasta encontrar la posición correcta
      let newPosition = 0;
      let digitsCount = 0;
      for (let i = 0; i < formatted.length; i++) {
        if (formatted[i].match(/[0-9]/)) {
          digitsCount++;
          if (digitsCount === digitsBeforeCursor) {
            newPosition = i + 1;
            break;
          }
        }
        if (digitsCount < digitsBeforeCursor) {
          newPosition = i + 1;
        }
      }
      
      // Asegurar que la posición no exceda la longitud
      newPosition = Math.min(newPosition, formatted.length);
      
      // Restaurar la posición del cursor
      setTimeout(() => {
        input.setSelectionRange(newPosition, newPosition);
      }, 0);
    } else {
      input.value = '';
    }
    
    // Actualizar el cambio
    updateChangeAmount();
  });
  
  // Prevenir entrada de caracteres no numéricos (excepto en eventos controlados)
  moneyReceived.addEventListener("keypress", (e) => {
    // Permitir teclas de control (backspace, delete, tab, etc.)
    if (e.ctrlKey || e.metaKey || e.key === 'Backspace' || e.key === 'Delete' || 
        e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
      return;
    }
    
    // Solo permitir números
    if (!/[0-9]/.test(e.key)) {
      e.preventDefault();
    }
  });
  
  moneyReceived.addEventListener("change", updateChangeAmount);
  
  // Permitir solo números al pegar
  moneyReceived.addEventListener("paste", (e) => {
    e.preventDefault();
    const paste = (e.clipboardData || window.clipboardData).getData('text');
    const numbers = paste.replace(/[^0-9]/g, '');
    if (numbers) {
      const formatted = formatNumberWithThousands(numbers);
      moneyReceived.value = formatted;
      updateChangeAmount();
    }
  });
}

// Buscar cliente
async function searchCustomer(term) {
  if (!term || term.trim().length < 2) return;

  try {
    const { data, error } = await supabase
      .rpc("rpc_search_public_customer", { p_search_term: term });

    if (error) throw error;

    const customers = data || [];
    
    customerSuggestions.innerHTML = "";
    customers.forEach(customer => {
      const option = document.createElement("option");
      option.value = `${customer.first_name} ${customer.last_name || ''}`.trim();
      option.setAttribute("data-customer-id", customer.id);
      customerSuggestions.appendChild(option);
    });

    // Si hay un solo resultado, seleccionarlo automáticamente
    if (customers.length === 1) {
      await selectCustomer(customers[0].id);
    }
  } catch (error) {
    console.error("Error buscando cliente:", error);
  }
}

// Seleccionar cliente
async function selectCustomer(customerId) {
  try {
    const { data: customer, error } = await supabase
      .from("public_sales_customers")
      .select("*")
      .eq("id", customerId)
      .single();

    if (error) throw error;

    selectedCustomer = customer;
    customerName.textContent = `${customer.first_name} ${customer.last_name || ''}`.trim();
    customerInfo.classList.add("active");

    // Obtener y mostrar información de última compra
    await loadCustomerLastPurchase(customerId);

    // Cargar créditos del cliente
    await loadCustomerCredits(customerId);
  } catch (error) {
    console.error("Error seleccionando cliente:", error);
    showMessage("Error al seleccionar cliente: " + error.message, "error");
  }
}

// Función para obtener y mostrar la última compra del cliente
async function loadCustomerLastPurchase(customerId) {
  try {
    if (!customerLastPurchase) return;

    // Obtener la última venta del cliente
    const { data: lastSale, error } = await supabase
      .from("public_sales")
      .select("created_at")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Error obteniendo última compra:", error);
      customerLastPurchase.textContent = "";
      customerLastPurchase.style.display = "none";
      return;
    }

    if (!lastSale || !lastSale.created_at) {
      // Cliente sin compras previas
      customerLastPurchase.textContent = "Sin compras previas";
      customerLastPurchase.style.color = "#666";
      customerLastPurchase.style.display = "block";
      return;
    }

    // Calcular días transcurridos desde la última compra
    const lastPurchaseDate = new Date(lastSale.created_at);
    const today = new Date();
    
    // Normalizar ambas fechas a medianoche para calcular días completos
    const lastPurchaseMidnight = new Date(lastPurchaseDate.getFullYear(), lastPurchaseDate.getMonth(), lastPurchaseDate.getDate());
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    
    const diffTime = todayMidnight - lastPurchaseMidnight;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    // Formatear la fecha de la última compra
    const formattedDate = lastPurchaseDate.toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });

    // Mostrar información
    let daysText = "";
    if (diffDays === 0) {
      daysText = "Última compra: Hoy";
    } else if (diffDays === 1) {
      daysText = "Última compra: Ayer";
    } else {
      daysText = `Última compra: Hace ${diffDays} día${diffDays !== 1 ? 's' : ''} (${formattedDate})`;
    }

    customerLastPurchase.textContent = daysText;
    customerLastPurchase.style.display = "block";

    // Si pasaron más de 35 días, mostrar en rojo
    if (diffDays > 35) {
      customerLastPurchase.style.color = "#dc3545";
      customerLastPurchase.style.fontWeight = "600";
    } else {
      customerLastPurchase.style.color = "#333";
      customerLastPurchase.style.fontWeight = "normal";
    }
  } catch (error) {
    console.error("Error calculando última compra:", error);
    customerLastPurchase.textContent = "";
    customerLastPurchase.style.display = "none";
  }
}

// Cargar créditos del cliente
async function loadCustomerCredits(customerId) {
  try {
    const { data, error } = await supabase
      .rpc("rpc_get_customer_credits", { p_customer_id: customerId });

    if (error) throw error;

    customerCredits = data || [];
    const totalCredit = customerCredits.reduce((sum, c) => sum + parseFloat(c.amount), 0);

    if (totalCredit > 0) {
      const daysRemaining = customerCredits[0]?.days_remaining || 0;
      const monthsRemaining = Math.floor(daysRemaining / 30);
      const daysInMonth = daysRemaining % 30;

      let creditText = `Crédito disponible: $${totalCredit.toLocaleString('es-AR')}`;
      if (daysRemaining > 0) {
        if (monthsRemaining > 0) {
          creditText += ` (${monthsRemaining} mes${monthsRemaining > 1 ? 'es' : ''} y ${daysInMonth} día${daysInMonth !== 1 ? 's' : ''} restantes)`;
        } else {
          creditText += ` (${daysRemaining} día${daysRemaining !== 1 ? 's' : ''} restantes)`;
        }
      } else {
        creditText += " (Expirando pronto)";
      }

      customerCredit.textContent = creditText;
      customerCredit.style.display = "block";
    } else {
      customerCredit.textContent = "";
      customerCredit.style.display = "none";
    }

    await calculateTotals();
  } catch (error) {
    console.error("Error cargando créditos:", error);
  }
}

// Finalizar venta
finalizeSaleBtn.addEventListener("click", async () => {
  if (saleItems.length === 0) {
    showMessage("No hay productos en la lista de venta", "error");
    return;
  }

  // Mostrar overlay de carga y deshabilitar botón
  if (finalizeLoadingOverlay) {
    finalizeLoadingOverlay.style.display = "flex";
  }
  if (finalizeSaleBtn) {
    finalizeSaleBtn.disabled = true;
    finalizeSaleBtn.style.opacity = "0.6";
    finalizeSaleBtn.style.cursor = "not-allowed";
  }

  try {
    // Preparar items para RPC
    const items = [];
    
    // Función auxiliar para buscar variant
    async function findVariant(productId, color, sizeValue) {
      const { data: variantData, error: variantError } = await supabase
        .from("product_variants")
        .select("id")
        .eq("product_id", productId)
        .eq("color", color)
        .eq("size", sizeValue)
        .single();
      
      if (!variantError && variantData) {
        return { id: variantData.id };
      }
      return null;
    }
    
    // Procesar solo items de productos (excluir extras)
    const productItemsForSale = saleItems.filter(item => !item.isExtra);
    for (const item of productItemsForSale) {
      for (const size of item.sizes) {
        // Buscar variant en todas las fuentes posibles
        let variant = currentVariants.find(v => 
          v.color === item.color && 
          v.size === size.size
        );
        
        // Si no está en currentVariants, buscar en manualCurrentVariants
        if (!variant && manualCurrentVariants.length > 0) {
          variant = manualCurrentVariants.find(v => 
            v.color === item.color && 
            v.size === size.size
          );
        }
        
        // Si aún no está, buscar en la base de datos
        if (!variant) {
          variant = await findVariant(item.productId, item.color, size.size);
        }
        
        if (!variant) {
          throw new Error(`No se encontró la variante para ${item.productName} - ${item.color} - Talle ${size.size}`);
        }
        
        // Validar stock antes de agregar (solo si no es devolución)
        if (!item.isReturn) {
          // Obtener stock actualizado de la variante
          const { data: stockData, error: stockError } = await supabase
            .from("variant_warehouse_stock")
            .select(`
              stock_qty,
              warehouses!inner(code)
            `)
            .eq("variant_id", variant.id)
            .in("warehouses.code", ["general", "venta-publico"]);
          
          if (stockError) {
            console.warn("Error obteniendo stock:", stockError);
          }
          
          // Calcular stock total disponible
          let totalStock = 0;
          if (stockData && stockData.length > 0) {
            totalStock = stockData.reduce((sum, s) => sum + (s.stock_qty || 0), 0);
          }
          
          // Verificar si hay suficiente stock
          if (totalStock === 0) {
            const productInfo = `${item.productName} - ${item.color} - Talle ${size.size}`;
            throw new Error(
              `No hay stock disponible para ${productInfo}. ` +
              `Por favor, verifica el stock del producto antes de continuar.`
            );
          }
          
          if (totalStock < size.quantity) {
            const productInfo = `${item.productName} - ${item.color} - Talle ${size.size}`;
            throw new Error(
              `Stock insuficiente para ${productInfo}. ` +
              `Disponible: ${totalStock}, Solicitado: ${size.quantity}`
            );
          }
        }
        
        // Obtener fuente del stock (venta-publico y general)
        const source = size.source || { ventaPublico: size.quantity, general: 0 };
        
        items.push({
          variant_id: variant.id,
          qty: size.quantity,
          price: item.price,
          is_return: item.isReturn || false,
          source: {
            venta_publico: source.ventaPublico || 0,
            general: source.general || 0
          }
        });
      }
    }

    // Separar items de productos de extras
    const productItems = saleItems.filter(item => !item.isExtra);
    const extraItems = saleItems.filter(item => item.isExtra);

    // Calcular el total antes de crear la venta (solo productos)
    const subtotal = productItems.reduce((sum, item) => {
      if (item.isReturn) {
        return sum - item.totalValue;
      }
      return sum + item.totalValue;
    }, 0);
    const credit = customerCredits.reduce((sum, c) => sum + c.amount, 0);
    const creditToApply = subtotal > 0 ? Math.min(credit, subtotal) : 0;
    let finalTotal = subtotal - creditToApply;

    // Aplicar extras porcentuales
    const percentageExtras = extraItems.filter(item => item.extraType === 'percentage');
    percentageExtras.forEach(extra => {
      const percentageValue = (finalTotal * extra.value) / 100;
      finalTotal += percentageValue;
    });

    // Aplicar extras numéricos
    const numericExtras = extraItems.filter(item => item.extraType === 'numeric');
    numericExtras.forEach(extra => {
      finalTotal += extra.totalValue;
    });

    // Preparar notas con información de extras y método de pago
    let notes = "";
    if (extraItems.length > 0) {
      const extrasInfo = extraItems.map(extra => {
        if (extra.extraType === 'numeric') {
          return `Extra numérico: $${extra.totalValue.toLocaleString('es-AR')}`;
        } else {
          return `Extra porcentual: ${extra.value}% ($${extra.totalValue.toLocaleString('es-AR')})`;
        }
      }).join("; ");
      if (notes) {
        notes += ` | Extras: ${extrasInfo}`;
      } else {
        notes = `Extras: ${extrasInfo}`;
      }
    }

    // Agregar método de pago a las notas
    if (notes) {
      notes += ` | [PAYMENT_METHOD: ${paymentMethod}]`;
    } else {
      notes = `[PAYMENT_METHOD: ${paymentMethod}]`;
    }

    // Preparar datos completos de la compra para enviar a caja 1
    const saleData = {
      items: items,
      customer_id: selectedCustomer?.id || null,
      customer: selectedCustomer ? {
        id: selectedCustomer.id,
        first_name: selectedCustomer.first_name,
        last_name: selectedCustomer.last_name,
        customer_number: selectedCustomer.customer_number,
        qr_code: selectedCustomer.qr_code
      } : null,
      customer_credits: customerCredits.map(c => ({
        id: c.id,
        amount: c.amount,
        expires_at: c.expires_at
      })),
      notes: notes || null,
      subtotal: subtotal,
      credit_to_apply: creditToApply,
      final_total: finalTotal,
      payment_method: paymentMethod,
      load_as_credit: loadAsCredit,
      sale_items: saleItems.map(item => ({
        sku: item.sku,
        productId: item.productId,
        productName: item.productName,
        color: item.color,
        sizes: item.sizes,
        price: item.price,
        basePrice: item.basePrice,
        totalQuantity: item.totalQuantity,
        totalValue: item.totalValue,
        isReturn: item.isReturn || false,
        isExtra: item.isExtra || false,
        extraType: item.extraType || null,
        value: item.value || null,
        offerInfo: item.offerInfo || null,
        promotionInfo: item.promotionInfo || null
      })),
      money_received: moneyReceived ? moneyReceived.value : null
    };

    // Enviar compra pendiente a caja 1
    const { data: pendingData, error } = await supabase
      .rpc("rpc_create_pending_sale", {
        p_source_caja: currentCaja,
        p_sale_data: saleData
      });

    if (error) throw error;

    showMessage(`Compra enviada exitosamente a Caja 1`, "success");

    // Limpiar formulario
    saleItems = [];
    selectedCustomer = null;
    customerCredits = [];
    selectedSizes = {};
    selectedColor = null;
    currentProduct = null;
    currentVariants = [];
    productSelection.classList.remove("active");
    customerInfo.classList.remove("active");
    customerSearch.value = "";
    if (customerLastPurchase) {
      customerLastPurchase.textContent = "";
      customerLastPurchase.style.display = "none";
    }
    skuSearch.value = "";
    if (moneyReceived) moneyReceived.value = "";
    updateChangeAmount(); // Actualizar el cambio a $0
    paymentMethod = 'contado'; // Resetear a contado por defecto
    if (paymentMethodIndicator) {
      paymentMethodIndicator.classList.remove('active');
    }
    if (extraNumericInput) extraNumericInput.value = "";
    if (extraPercentageInput) extraPercentageInput.value = "";
    loadAsCredit = false; // Resetear estado de cargar como crédito
    if (loadAsCreditContainer) {
      loadAsCreditContainer.style.display = "none";
    }
    if (loadAsCreditCheckbox) {
      loadAsCreditCheckbox.checked = false;
    }
    renderSaleList();
    await calculateTotals();
  } catch (error) {
    console.error("Error finalizando venta:", error);
    showMessage("Error al finalizar venta: " + error.message, "error");
  } finally {
    // Ocultar overlay de carga y habilitar botón
    if (finalizeLoadingOverlay) {
      finalizeLoadingOverlay.style.display = "none";
    }
    if (finalizeSaleBtn) {
      finalizeSaleBtn.disabled = false;
      finalizeSaleBtn.style.opacity = "1";
      finalizeSaleBtn.style.cursor = "pointer";
    }
  }
});

// Función para imprimir directamente sin mostrar modal
async function printDirectly(saleDetails, customer, creditAmount) {
  // Intentar cargar y usar QZ Tray primero (igual que el botón Imprimir)
  try {
    await loadQZTray();
    
    // Si QZ se cargó, intentar imprimir con QZ
    if (typeof qz !== 'undefined' && qz) {
      try {
        await printSaleWithQZ(
          saleDetails,
          customer,
          creditAmount
        );
        return; // Si QZ funcionó, no hacer nada más
      } catch (error) {
        // QZ falló, usar impresión del navegador como fallback
        console.log("ℹ️ QZ Tray no disponible, usando impresión del navegador");
      }
    }
  } catch (error) {
    // QZ no se pudo cargar, usar impresión del navegador
    console.log("ℹ️ QZ Tray no disponible, usando impresión del navegador");
  }
  
  // Fallback: generar contenido del modal sin mostrarlo y luego imprimir
  // Usar la misma lógica que showPrintModal pero sin mostrar el modal
  if (!printModal || !printContent) {
    window.print();
    return;
  }

  const sale = saleDetails.sale;
  const items = saleDetails.items || [];
  
  // Formatear fecha y hora
  const saleDate = new Date(sale.created_at);
  const dateStr = saleDate.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = saleDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit'
  });

  // Obtener crédito total del cliente si existe
  let totalCredit = 0;
  if (customer?.id) {
    const { data: creditData } = await supabase
      .rpc("rpc_get_customer_total_credit", { p_customer_id: customer.id });
    if (creditData) {
      totalCredit = creditData.total_credit || 0;
    }
  }

  // Generar QR del cliente si existe
  let qrHtml = '';
  if (customer?.qr_code) {
    const qrUrl = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
    qrHtml = `
      <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 3px solid #000;">
        <p style="margin-bottom: 12px; font-weight: 700; font-size: 15px;">Escanea para ver tu historial y créditos:</p>
        <div id="print-qr-code-container" style="display: flex; justify-content: center; margin: 12px 0;"></div>
        <p style="margin-top: 12px; font-size: 13px; color: #666; word-break: break-all; line-height: 1.4;">${qrUrl}</p>
      </div>
    `;
  }

  // Construir HTML del ticket (formato para ticket de 80mm - usando todo el ancho)
  const html = `
    <div style="font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; color: #000; width: 100%; max-width: 100%; min-width: 100%; font-size: 16px; line-height: 1.6; padding: 0; margin: 0; box-sizing: border-box;">
      <div style="text-align: center; margin-bottom: 20px; border-bottom: 3px solid #000; padding-bottom: 15px;">
        <h1 style="margin: 0; font-size: 36px; font-weight: 900; color: #000; letter-spacing: 2px;">FYL moda</h1>
      </div>
      
      <div style="margin-bottom: 20px; font-size: 16px; width: 100%;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
          <strong style="font-size: 16px;">Venta:</strong>
          <span style="font-size: 16px; font-weight: 600;">${sale.sale_number}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
          <strong style="font-size: 16px;">Fecha:</strong>
          <span style="font-size: 16px; font-weight: 600;">${dateStr}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
          <strong style="font-size: 16px;">Hora:</strong>
          <span style="font-size: 16px; font-weight: 600;">${timeStr}</span>
        </div>
        ${customer ? `
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
            <strong style="font-size: 16px;">Cliente:</strong>
            <span style="font-size: 16px; font-weight: 600;">${customer.first_name} ${customer.last_name || ''}</span>
          </div>
        ` : ''}
      </div>

      <div style="margin-top: 20px; margin-bottom: 20px;">
        <h3 style="margin: 0 0 15px; font-size: 18px; border-bottom: 3px solid #000; padding-bottom: 8px; font-weight: 800;">Detalle de la Compra</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 15px; table-layout: fixed;">
          <thead>
            <tr style="border-bottom: 3px solid #000;">
              <th style="text-align: left; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 45%;">Producto</th>
              <th style="text-align: center; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 12%;">Cant.</th>
              <th style="text-align: right; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 20%;">Precio</th>
              <th style="text-align: right; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 23%;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const price = parseFloat(item.price || item.price_snapshot || 0);
              const total = price * item.qty;
              const productText = `${item.product_name || 'N/A'}${item.color ? ` - ${item.color}` : ''}${item.size ? ` (${item.size})` : ''}`;
              return `
              <tr style="border-bottom: 2px dotted #999;">
                <td style="padding: 8px 2px; font-size: 15px; word-break: break-word; width: 45%;">
                  ${productText}
                  ${item.is_return ? ' <span style="color: #dc3545; font-weight: 700; font-size: 14px;">[DEV]</span>' : ''}
                </td>
                <td style="text-align: center; padding: 8px 2px; font-size: 15px; font-weight: 600; width: 12%;">${item.qty}</td>
                <td style="text-align: right; padding: 8px 2px; font-size: 15px; font-weight: 600; width: 20%;">$${price.toLocaleString('es-AR')}</td>
                <td style="text-align: right; padding: 8px 2px; font-size: 15px; font-weight: 700; width: 23%; ${item.is_return ? 'color: #dc3545;' : ''}">
                  ${item.is_return ? '-' : ''}$${total.toLocaleString('es-AR')}
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div style="margin-top: 20px; padding-top: 20px; border-top: 3px solid #000; font-size: 16px; width: 100%;">
        ${sale.credit_used > 0 ? `
          <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 16px; width: 100%;">
            <strong style="font-weight: 700;">Crédito Aplicado:</strong>
            <span style="color: #dc3545; font-weight: 700; font-size: 16px;">-$${parseFloat(sale.credit_used).toLocaleString('es-AR')}</span>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 22px; font-weight: 900; border-top: 3px solid #000; padding-top: 10px; margin-top: 15px; width: 100%;">
          <strong>TOTAL:</strong>
          <span style="${parseFloat(sale.total_amount) < 0 ? 'color: #dc3545;' : ''}">
            ${parseFloat(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseFloat(sale.total_amount)).toLocaleString('es-AR')}
          </span>
        </div>
        ${parseFloat(sale.total_amount) < 0 ? `
          <div style="margin-top: 15px; padding: 12px; background: #fff3cd; border: 3px solid #ffc107; font-size: 15px;">
            <strong style="color: #856404; font-weight: 700;">Saldo a favor:</strong>
            <span style="color: #856404; font-size: 17px; font-weight: 800;">
              $${Math.abs(parseFloat(sale.total_amount)).toLocaleString('es-AR')}
            </span>
          </div>
        ` : ''}
        ${totalCredit > 0 && parseFloat(sale.total_amount) >= 0 ? `
          <div style="margin-top: 15px; padding: 12px; background: #d4edda; border: 3px solid #28a745; font-size: 15px;">
            <strong style="color: #155724; font-weight: 700;">Crédito disponible:</strong>
            <span style="color: #155724; font-size: 17px; font-weight: 800;">
              $${totalCredit.toLocaleString('es-AR')}
            </span>
          </div>
        ` : ''}
      </div>

      ${qrHtml}
      
      <div style="text-align: center; margin-top: 25px; padding-top: 20px; border-top: 3px solid #000; font-size: 15px; color: #666;">
        <p style="margin: 0; font-weight: 800; font-size: 15px;">Documento no válido como factura</p>
      </div>
    </div>
  `;

  printContent.innerHTML = html;

  // Generar QR code si existe cliente (esperar a que el DOM se actualice)
  if (customer?.qr_code) {
    const qrUrl = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
    
    // Esperar a que el DOM se actualice
    const generateQR = () => {
      const qrContainer = document.getElementById("print-qr-code-container");
      if (!qrContainer) {
        setTimeout(generateQR, 50);
        return;
      }

      // Usar API directamente (más confiable) - tamaño más grande para mejor legibilidad (aprovechando el ancho de 78mm)
      generateQRCode(qrUrl, qrContainer, 200);
    };
    
    setTimeout(generateQR, 100);
    
    // Esperar a que el QR se genere antes de imprimir
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Imprimir directamente sin mostrar el modal
  window.print();
}

// Función para mostrar el modal de impresión (mantener para compatibilidad si se necesita)
async function showPrintModal(saleDetails, customer, creditAmount) {
  if (!printModal || !printContent) return;

  const sale = saleDetails.sale;
  const items = saleDetails.items || [];
  
  // Formatear fecha y hora
  const saleDate = new Date(sale.created_at);
  const dateStr = saleDate.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timeStr = saleDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit'
  });

  // Obtener crédito total del cliente si existe
  let totalCredit = 0;
  if (customer?.id) {
    const { data: creditData } = await supabase
      .rpc("rpc_get_customer_total_credit", { p_customer_id: customer.id });
    if (creditData) {
      totalCredit = creditData.total_credit || 0;
    }
  }

  // Generar QR del cliente si existe
  let qrHtml = '';
  if (customer?.qr_code) {
    const qrUrl = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
    qrHtml = `
      <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 3px solid #000;">
        <p style="margin-bottom: 12px; font-weight: 700; font-size: 15px;">Escanea para ver tu historial y créditos:</p>
        <div id="print-qr-code-container" style="display: flex; justify-content: center; margin: 12px 0;"></div>
        <p style="margin-top: 12px; font-size: 13px; color: #666; word-break: break-all; line-height: 1.4;">${qrUrl}</p>
      </div>
    `;
  }

  // Construir HTML del ticket (formato para ticket de 80mm - usando todo el ancho)
  const html = `
    <div style="font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif; color: #000; width: 100%; max-width: 100%; min-width: 100%; font-size: 16px; line-height: 1.6; padding: 0; margin: 0; box-sizing: border-box;">
      <div style="text-align: center; margin-bottom: 20px; border-bottom: 3px solid #000; padding-bottom: 15px;">
        <h1 style="margin: 0; font-size: 36px; font-weight: 900; color: #000; letter-spacing: 2px;">FYL moda</h1>
      </div>
      
      <div style="margin-bottom: 20px; font-size: 16px; width: 100%;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
          <strong style="font-size: 16px;">Venta:</strong>
          <span style="font-size: 16px; font-weight: 600;">${sale.sale_number}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
          <strong style="font-size: 16px;">Fecha:</strong>
          <span style="font-size: 16px; font-weight: 600;">${dateStr}</span>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
          <strong style="font-size: 16px;">Hora:</strong>
          <span style="font-size: 16px; font-weight: 600;">${timeStr}</span>
        </div>
        ${customer ? `
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px; width: 100%;">
            <strong style="font-size: 16px;">Cliente:</strong>
            <span style="font-size: 16px; font-weight: 600;">${customer.first_name} ${customer.last_name || ''}</span>
          </div>
        ` : ''}
      </div>

      <div style="margin-top: 20px; margin-bottom: 20px;">
        <h3 style="margin: 0 0 15px; font-size: 18px; border-bottom: 3px solid #000; padding-bottom: 8px; font-weight: 800;">Detalle de la Compra</h3>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 15px; table-layout: fixed;">
          <thead>
            <tr style="border-bottom: 3px solid #000;">
              <th style="text-align: left; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 45%;">Producto</th>
              <th style="text-align: center; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 12%;">Cant.</th>
              <th style="text-align: right; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 20%;">Precio</th>
              <th style="text-align: right; padding: 8px 2px; font-weight: 800; font-size: 15px; width: 23%;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const price = parseFloat(item.price || item.price_snapshot || 0);
              const total = price * item.qty;
              const productText = `${item.product_name || 'N/A'}${item.color ? ` - ${item.color}` : ''}${item.size ? ` (${item.size})` : ''}`;
              return `
              <tr style="border-bottom: 2px dotted #999;">
                <td style="padding: 8px 2px; font-size: 15px; word-break: break-word; width: 45%;">
                  ${productText}
                  ${item.is_return ? ' <span style="color: #dc3545; font-weight: 700; font-size: 14px;">[DEV]</span>' : ''}
                </td>
                <td style="text-align: center; padding: 8px 2px; font-size: 15px; font-weight: 600; width: 12%;">${item.qty}</td>
                <td style="text-align: right; padding: 8px 2px; font-size: 15px; font-weight: 600; width: 20%;">$${price.toLocaleString('es-AR')}</td>
                <td style="text-align: right; padding: 8px 2px; font-size: 15px; font-weight: 700; width: 23%; ${item.is_return ? 'color: #dc3545;' : ''}">
                  ${item.is_return ? '-' : ''}$${total.toLocaleString('es-AR')}
                </td>
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div style="margin-top: 20px; padding-top: 20px; border-top: 3px solid #000; font-size: 16px; width: 100%;">
        ${sale.credit_used > 0 ? `
          <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 16px; width: 100%;">
            <strong style="font-weight: 700;">Crédito Aplicado:</strong>
            <span style="color: #dc3545; font-weight: 700; font-size: 16px;">-$${parseFloat(sale.credit_used).toLocaleString('es-AR')}</span>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 22px; font-weight: 900; border-top: 3px solid #000; padding-top: 10px; margin-top: 15px; width: 100%;">
          <strong>TOTAL:</strong>
          <span style="${parseFloat(sale.total_amount) < 0 ? 'color: #dc3545;' : ''}">
            ${parseFloat(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseFloat(sale.total_amount)).toLocaleString('es-AR')}
          </span>
        </div>
        ${parseFloat(sale.total_amount) < 0 ? `
          <div style="margin-top: 15px; padding: 12px; background: #fff3cd; border: 3px solid #ffc107; font-size: 15px;">
            <strong style="color: #856404; font-weight: 700;">Saldo a favor:</strong>
            <span style="color: #856404; font-size: 17px; font-weight: 800;">
              $${Math.abs(parseFloat(sale.total_amount)).toLocaleString('es-AR')}
            </span>
          </div>
        ` : ''}
        ${totalCredit > 0 && parseFloat(sale.total_amount) >= 0 ? `
          <div style="margin-top: 15px; padding: 12px; background: #d4edda; border: 3px solid #28a745; font-size: 15px;">
            <strong style="color: #155724; font-weight: 700;">Crédito disponible:</strong>
            <span style="color: #155724; font-size: 17px; font-weight: 800;">
              $${totalCredit.toLocaleString('es-AR')}
            </span>
          </div>
        ` : ''}
      </div>

      ${qrHtml}
      
      <div style="text-align: center; margin-top: 25px; padding-top: 20px; border-top: 3px solid #000; font-size: 15px; color: #666;">
        <p style="margin: 0; font-weight: 800; font-size: 15px;">Documento no válido como factura</p>
      </div>
    </div>
  `;

  printContent.innerHTML = html;

  // Generar QR code si existe cliente (esperar a que el DOM se actualice)
  if (customer?.qr_code) {
    const qrUrl = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
    
    // Esperar a que el DOM se actualice
    const generateQR = () => {
      const qrContainer = document.getElementById("print-qr-code-container");
      if (!qrContainer) {
        setTimeout(generateQR, 50);
        return;
      }

      // Usar API directamente (más confiable) - tamaño más grande para mejor legibilidad (aprovechando el ancho de 78mm)
      generateQRCode(qrUrl, qrContainer, 200);
    };
    
    setTimeout(generateQR, 100);
  }

  // Guardar datos de la venta para el botón de imprimir
  currentSaleData = {
    saleDetails,
    customer,
    finalTotal: creditAmount
  };
  
  // Mostrar modal
  printModal.classList.add("active");
}

// Event listeners para el modal de impresión
if (closePrintModal) {
  closePrintModal.addEventListener("click", () => {
    printModal.classList.remove("active");
  });
}

// Función para cargar QZ Tray solo cuando se necesite
function loadQZTray() {
  return new Promise((resolve, reject) => {
    // Si ya está cargado, resolver inmediatamente
    if (typeof qz !== 'undefined' && qz) {
      resolve();
      return;
    }
    
    // Verificar si el script ya se está cargando
    if (document.querySelector('script[src*="qz-tray.js"]')) {
      // Esperar a que se cargue
      const checkInterval = setInterval(() => {
        if (typeof qz !== 'undefined' && qz) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      
      // Timeout después de 3 segundos
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('QZ Tray no se pudo cargar'));
      }, 3000);
      return;
    }
    
    // Cargar el script
    const script = document.createElement('script');
    script.src = 'https://demo.qz.io/js/qz-tray.js';
    script.async = true;
    
    script.onload = () => {
      // Esperar un momento para que QZ se inicialice
      setTimeout(() => {
        if (typeof qz !== 'undefined' && qz) {
          resolve();
        } else {
          reject(new Error('QZ Tray no está disponible'));
        }
      }, 500);
    };
    
    script.onerror = () => {
      reject(new Error('Error cargando QZ Tray'));
    };
    
    // Suprimir errores de WebSocket en la consola
    const originalError = console.error;
    console.error = function(...args) {
      if (args[0] && typeof args[0] === 'string' && args[0].includes('WebSocket')) {
        // No mostrar errores de WebSocket de QZ
        return;
      }
      originalError.apply(console, args);
    };
    
    document.head.appendChild(script);
    
    // Restaurar console.error después de 2 segundos
    setTimeout(() => {
      console.error = originalError;
    }, 2000);
  });
}

if (printBtn) {
  printBtn.addEventListener("click", async () => {
    if (currentSaleData) {
      // Intentar cargar y usar QZ Tray
      try {
        await loadQZTray();
        
        // Si QZ se cargó, intentar imprimir con QZ
        if (typeof qz !== 'undefined' && qz) {
          try {
            await printSaleWithQZ(
              currentSaleData.saleDetails,
              currentSaleData.customer,
              currentSaleData.finalTotal
            );
            return; // Si QZ funcionó, no hacer nada más
          } catch (error) {
            // QZ falló, usar impresión del navegador como fallback
            console.log("ℹ️ QZ Tray no disponible, usando impresión del navegador");
          }
        }
      } catch (error) {
        // QZ no se pudo cargar, usar impresión del navegador
        console.log("ℹ️ QZ Tray no disponible, usando impresión del navegador");
      }
    }
    
    // Fallback: usar impresión del navegador
    window.print();
  });
}

if (printModal) {
  printModal.addEventListener("click", (e) => {
    if (e.target === printModal) {
      printModal.classList.remove("active");
    }
  });
}

// Modal de clientes
customersBtn.addEventListener("click", () => {
  customersModal.classList.add("active");
  // Limpiar búsqueda y resultados
  if (modalCustomerSearch) modalCustomerSearch.value = "";
  if (modalCustomerResults) modalCustomerResults.innerHTML = "";
  if (customerQrContainer) customerQrContainer.style.display = "none";
});

closeCustomersModal.addEventListener("click", () => {
  customersModal.classList.remove("active");
  if (customerQrContainer) customerQrContainer.style.display = "none";
});

customersModal.addEventListener("click", (e) => {
  if (e.target === customersModal) {
    customersModal.classList.remove("active");
    if (customerQrContainer) customerQrContainer.style.display = "none";
  }
});

// Buscar cliente en el modal
if (modalSearchCustomerBtn) {
  modalSearchCustomerBtn.addEventListener("click", async () => {
    await searchCustomerInModal();
  });
}

if (modalCustomerSearch) {
  modalCustomerSearch.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      await searchCustomerInModal();
    }
  });
}

// Función para buscar cliente en el modal
async function searchCustomerInModal() {
  const searchTerm = modalCustomerSearch ? modalCustomerSearch.value.trim() : "";
  
  if (!searchTerm || searchTerm.length < 2) {
    if (modalCustomerResults) {
      modalCustomerResults.innerHTML = "<p style='padding: 12px; color: #666; text-align: center;'>Ingrese al menos 2 caracteres para buscar</p>";
    }
    return;
  }

  try {
    const { data, error } = await supabase
      .rpc("rpc_search_public_customer", { p_search_term: searchTerm });

    if (error) throw error;

    const customers = data || [];

    if (customers.length === 0) {
      if (modalCustomerResults) {
        modalCustomerResults.innerHTML = "<p style='padding: 12px; color: #666; text-align: center;'>No se encontraron clientes</p>";
      }
      return;
    }

    // Obtener créditos de cada cliente
    const customersWithCredits = await Promise.all(customers.map(async (customer) => {
      try {
        const { data: creditData, error: creditError } = await supabase
          .rpc("rpc_get_customer_total_credit", { p_customer_id: customer.id });
        
        const totalCredit = creditError ? 0 : (creditData || 0);
        return { ...customer, totalCredit };
      } catch (error) {
        return { ...customer, totalCredit: 0 };
      }
    }));

    if (modalCustomerResults) {
      modalCustomerResults.innerHTML = customersWithCredits.map(customer => `
        <div style="padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 8px; background: white;">
          <div><strong>${escapeHtml(customer.first_name)} ${escapeHtml(customer.last_name || '')}</strong></div>
          <div style="font-size: 12px; color: #666; margin-top: 4px;">
            ${customer.customer_number ? `Número: ${escapeHtml(customer.customer_number)}` : ''}
            ${customer.document_number ? ` | DNI: ${escapeHtml(customer.document_number)}` : ''}
            ${customer.phone ? ` | Tel: ${escapeHtml(customer.phone)}` : ''}
          </div>
          ${customer.totalCredit > 0 ? `
            <div style="margin-top: 8px; padding: 8px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px;">
              <div style="font-size: 12px; color: #856404; font-weight: 600;">
                Crédito disponible: $${parseFloat(customer.totalCredit).toLocaleString('es-AR')}
              </div>
            </div>
          ` : ''}
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <button class="btn btn-primary" onclick="selectCustomerFromModal('${customer.id}')" style="flex: 1; padding: 6px 12px; font-size: 12px;">
              Seleccionar
            </button>
            ${customer.qr_code ? `
              <button class="btn btn-secondary" onclick="showCustomerQR('${customer.qr_code}', '${escapeHtml(customer.first_name)} ${escapeHtml(customer.last_name || '')}')" style="flex: 1; padding: 6px 12px; font-size: 12px;">
                Ver QR
              </button>
            ` : ''}
          </div>
        </div>
      `).join("");
    }
  } catch (error) {
    console.error("Error buscando cliente:", error);
    if (modalCustomerResults) {
      modalCustomerResults.innerHTML = "<p style='padding: 12px; color: #dc3545; text-align: center;'>Error al buscar cliente</p>";
    }
  }
}

window.selectCustomerFromModal = async function(customerId) {
  await selectCustomer(customerId);
  customersModal.classList.remove("active");
  customerSearch.value = `${selectedCustomer.first_name} ${selectedCustomer.last_name || ''}`.trim();
};

// Mostrar QR code de un cliente existente
window.showCustomerQR = function(qrCode, customerName) {
  const qrUrl = `${window.location.origin}/customer.html?code=${qrCode}`;
  
  console.log("showCustomerQR llamado con:", { qrCode, customerName, qrUrl });
  
  if (!customerQrCode) {
    console.error("customerQrCode element no encontrado");
    return;
  }

  // Actualizar título si es posible
  const qrTitle = customerQrContainer?.querySelector('h4');
  if (qrTitle && customerName) {
    qrTitle.textContent = `QR Code - ${customerName}`;
  }
  
  if (customerQrUrl) {
    customerQrUrl.textContent = qrUrl;
  }
  
  // Mostrar el contenedor primero
  if (customerQrContainer) {
    customerQrContainer.style.display = "block";
  }
  
  // Generar QR usando API directamente
  console.log("Generando QR code usando API para cliente existente...");
  generateQRCode(qrUrl, customerQrCode, 200);
  
  // Scroll al QR code
  if (customerQrContainer) {
    customerQrContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
};

// Crear cliente
createCustomerForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const firstName = document.getElementById("customer-first-name").value.trim();
  const lastName = document.getElementById("customer-last-name").value.trim();
  const phone = document.getElementById("customer-phone").value.trim();
  const email = document.getElementById("customer-email").value.trim();
  const documentNumber = document.getElementById("customer-document").value.trim();

  if (!firstName) {
    showMessage("El nombre es obligatorio", "error");
    return;
  }

  try {
    const { data, error } = await supabase
      .rpc("rpc_create_public_customer", {
        p_first_name: firstName,
        p_last_name: lastName || null,
        p_phone: phone || null,
        p_email: email || null,
        p_document_number: documentNumber || null
      });

    if (error) throw error;

    // Mostrar QR code
    if (data && data.qr_code) {
      const qrUrl = `${window.location.origin}/customer.html?code=${data.qr_code}`;
      const customerName = `${firstName} ${lastName || ''}`.trim();
      
      // Actualizar título
      const qrTitle = document.getElementById("customer-qr-title");
      if (qrTitle) {
        qrTitle.textContent = `Cliente creado exitosamente - ${customerName}`;
      }
      
      // Mostrar el contenedor primero
      if (customerQrContainer) {
        customerQrContainer.style.display = "block";
      }
      
      // Generar QR code usando API directamente
      console.log("Generando QR code para nuevo cliente usando API...");
      console.log("customerQrCode existe:", !!customerQrCode);
      console.log("URL del QR:", qrUrl);
      
      if (customerQrCode) {
        generateQRCode(qrUrl, customerQrCode, 200);
      } else {
        console.error("customerQrCode element no encontrado");
      }
      
      if (customerQrUrl) {
        customerQrUrl.textContent = qrUrl;
      }
      
      if (customerQrContainer) {
        customerQrContainer.style.display = "block";
        // Scroll al QR code
        customerQrContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }

    showMessage("Cliente creado exitosamente", "success");
    createCustomerForm.reset();
    
    // Limpiar resultados de búsqueda
    if (modalCustomerResults) modalCustomerResults.innerHTML = "";
    if (modalCustomerSearch) modalCustomerSearch.value = "";
  } catch (error) {
    console.error("Error creando cliente:", error);
    showMessage("Error al crear cliente: " + error.message, "error");
  }
});

// Cerrar QR code
if (closeQrBtn) {
  closeQrBtn.addEventListener("click", () => {
    if (customerQrContainer) {
      customerQrContainer.style.display = "none";
    }
  });
}


// Estado del historial
let currentHistoryDate = null;
let currentHistoryCustomerSearch = '';
let currentHistoryOffset = 0;
let expandedSaleId = null;

// Modal de historial
historyBtn.addEventListener("click", () => {
  historyModal.classList.add("active");
  // Establecer fecha de hoy por defecto
  const today = new Date().toISOString().split('T')[0];
  const dateFilter = document.getElementById("history-date-filter");
  const customerSearch = document.getElementById("history-customer-search");
  if (dateFilter) dateFilter.value = today;
  if (customerSearch) customerSearch.value = '';
  currentHistoryDate = today;
  currentHistoryCustomerSearch = '';
  currentHistoryOffset = 0;
  expandedSaleId = null;
  loadSalesHistory();
});

closeHistoryModal.addEventListener("click", () => {
  historyModal.classList.remove("active");
  document.getElementById("history-details").style.display = "none";
});

historyModal.addEventListener("click", (e) => {
  if (e.target === historyModal) {
    historyModal.classList.remove("active");
    document.getElementById("history-details").style.display = "none";
  }
});

// Filtros del historial
const historyFilterBtn = document.getElementById("history-filter-btn");
const historyResetBtn = document.getElementById("history-reset-btn");

if (historyFilterBtn) {
  historyFilterBtn.addEventListener("click", () => {
    const dateFilter = document.getElementById("history-date-filter");
    const customerSearch = document.getElementById("history-customer-search");
    currentHistoryDate = dateFilter ? dateFilter.value || null : null;
    currentHistoryCustomerSearch = customerSearch ? customerSearch.value.trim() : '';
    currentHistoryOffset = 0;
    expandedSaleId = null;
    loadSalesHistory();
  });
}

if (historyResetBtn) {
  historyResetBtn.addEventListener("click", () => {
    const today = new Date().toISOString().split('T')[0];
    const dateFilter = document.getElementById("history-date-filter");
    const customerSearch = document.getElementById("history-customer-search");
    if (dateFilter) dateFilter.value = today;
    if (customerSearch) customerSearch.value = '';
    currentHistoryDate = today;
    currentHistoryCustomerSearch = '';
    currentHistoryOffset = 0;
    expandedSaleId = null;
    loadSalesHistory();
  });
}

// Permitir buscar con Enter
const historyCustomerSearch = document.getElementById("history-customer-search");
if (historyCustomerSearch) {
  historyCustomerSearch.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      historyFilterBtn.click();
    }
  });
}

// Cargar historial de ventas
async function loadSalesHistory(append = false) {
  try {
    const { data, error } = await supabase
      .rpc("rpc_get_public_sales_history", { 
        p_limit: 10, 
        p_offset: append ? currentHistoryOffset : 0,
        p_date_filter: currentHistoryDate || null,
        p_customer_search: currentHistoryCustomerSearch || null
      });

    if (error) throw error;

    const sales = data || [];

    if (!append) {
      currentHistoryOffset = 0;
      historyList.innerHTML = "";
    }

    if (sales.length === 0 && !append) {
      historyList.innerHTML = "<p style='padding: 20px; text-align: center; color: #666;'>No hay ventas registradas para los filtros seleccionados</p>";
      document.getElementById("history-details").style.display = "none";
      return;
    }

    // Agregar ventas a la lista
    const salesHtml = sales.map(sale => {
      const isExpanded = expandedSaleId === sale.id;
      return `
        <div class="history-sale-item" data-sale-id="${sale.id}" style="padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: background 0.2s; ${isExpanded ? 'background: #f8f9fa; border-color: #CD844D;' : ''}" onclick="toggleSaleDetails('${sale.id}')">
          <div><strong>${escapeHtml(sale.sale_number)}</strong></div>
          <div style="font-size: 12px; color: #666;">
            ${new Date(sale.created_at).toLocaleString('es-AR')} | 
            ${sale.customer_name || 'Sin cliente'} | 
            <span style="${parseFloat(sale.total_amount) < 0 ? 'color: #dc3545; font-weight: 700;' : ''}">
              ${parseFloat(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseFloat(sale.total_amount)).toLocaleString('es-AR')}
            </span>
          </div>
        </div>
      `;
    }).join("");

    if (append) {
      historyList.innerHTML += salesHtml;
    } else {
      historyList.innerHTML = salesHtml;
    }

    // Agregar botón "Cargar más" si hay resultados
    if (sales.length === 10) {
      const loadMoreBtn = document.createElement("button");
      loadMoreBtn.className = "btn btn-secondary";
      loadMoreBtn.textContent = "Cargar más...";
      loadMoreBtn.style.width = "100%";
      loadMoreBtn.style.marginTop = "12px";
      loadMoreBtn.addEventListener("click", () => {
        currentHistoryOffset += 10;
        loadSalesHistory(true);
        loadMoreBtn.remove();
      });
      
      // Verificar si ya existe el botón antes de agregarlo
      if (!historyList.querySelector(".load-more-btn")) {
        loadMoreBtn.classList.add("load-more-btn");
        historyList.appendChild(loadMoreBtn);
      }
    } else {
      // Remover botón si existe
      const existingBtn = historyList.querySelector(".load-more-btn");
      if (existingBtn) existingBtn.remove();
    }

    // Si hay una venta expandida, mostrar sus detalles
    if (expandedSaleId) {
      await showSaleDetails(expandedSaleId, true);
    }

  } catch (error) {
    console.error("Error cargando historial:", error);
    historyList.innerHTML = "<p style='padding: 20px; text-align: center; color: #dc3545;'>Error al cargar historial</p>";
  }
}

// Alternar detalles de venta
window.toggleSaleDetails = async function(saleId) {
  if (expandedSaleId === saleId) {
    // Colapsar
    expandedSaleId = null;
    document.getElementById("history-details").style.display = "none";
    // Actualizar estilos de items
    document.querySelectorAll(".history-sale-item").forEach(item => {
      item.style.background = "";
      item.style.borderColor = "#ddd";
    });
  } else {
    // Expandir
    expandedSaleId = saleId;
    await showSaleDetails(saleId, true);
    // Actualizar estilos de items
    document.querySelectorAll(".history-sale-item").forEach(item => {
      if (item.dataset.saleId === saleId) {
        item.style.background = "#f8f9fa";
        item.style.borderColor = "#CD844D";
      } else {
        item.style.background = "";
        item.style.borderColor = "#ddd";
      }
    });
  }
};

// Mostrar detalles de venta
window.showSaleDetails = async function(saleId, inModal = false) {
  try {
    const { data, error } = await supabase
      .rpc("rpc_get_public_sale_details", { p_sale_id: saleId });

    if (error) throw error;

    const sale = data.sale;
    const items = data.items || [];

    if (inModal) {
      // Mostrar en el modal de historial
      const detailsDiv = document.getElementById("history-details");
      const detailsTitle = document.getElementById("history-details-title");
      const detailsContent = document.getElementById("history-details-content");

      if (!detailsDiv || !detailsTitle || !detailsContent) return;

      detailsTitle.textContent = `${sale.sale_number} - ${sale.customer_name || 'Sin cliente'}`;
      
      // Crear tabla de items
      const itemsTable = `
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
          <thead>
            <tr style="background: #f8f9fa; border-bottom: 2px solid #ddd;">
              <th style="padding: 12px; text-align: left; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Tipo</th>
              <th style="padding: 12px; text-align: left; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Producto</th>
              <th style="padding: 12px; text-align: left; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Color</th>
              <th style="padding: 12px; text-align: left; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Talle</th>
              <th style="padding: 12px; text-align: center; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Cant.</th>
              <th style="padding: 12px; text-align: right; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Precio</th>
              <th style="padding: 12px; text-align: right; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(item => {
              const itemTotal = parseFloat(item.price) * item.qty;
              return `
              <tr style="${item.is_return ? 'background: #fee; border-left: 4px solid #dc3545;' : 'border-bottom: 1px solid #e9ecef;'} ${item.is_return ? '' : 'border-bottom: 1px solid #e9ecef;'}">
                <td style="padding: 12px;">
                  ${item.is_return ? '<span style="color: #dc3545; font-weight: 700; font-size: 11px; text-transform: uppercase;">DEVOLUCIÓN</span>' : '<span style="color: #28a745; font-weight: 700; font-size: 11px; text-transform: uppercase;">VENTA</span>'}
                </td>
                <td style="padding: 12px; font-weight: 600; color: #212529;">${escapeHtml(item.product_name || '-')}</td>
                <td style="padding: 12px; color: #666;">${escapeHtml(item.color || '-')}</td>
                <td style="padding: 12px; color: #666;">${escapeHtml(item.size || '-')}</td>
                <td style="padding: 12px; text-align: center; font-weight: 600;">${item.qty}</td>
                <td style="padding: 12px; text-align: right; color: #666;">$${parseFloat(item.price).toLocaleString('es-AR')}</td>
                <td style="padding: 12px; text-align: right; font-weight: 700; ${item.is_return ? 'color: #dc3545;' : 'color: #333;'}">
                  ${item.is_return ? '-' : ''}$${itemTotal.toLocaleString('es-AR')}
                </td>
              </tr>
            `;
            }).join("")}
          </tbody>
          <tfoot>
              <tr style="background: #f8f9fa; border-top: 2px solid #ddd; font-weight: 700;">
                <td colspan="5" style="padding: 12px;">Total</td>
                <td style="padding: 12px; text-align: center;">${sale.item_count}</td>
                <td style="padding: 12px; text-align: right; ${parseFloat(sale.total_amount) < 0 ? 'color: #dc3545;' : 'color: #333;'}">
                  ${parseFloat(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseFloat(sale.total_amount)).toLocaleString('es-AR')}
                </td>
              </tr>
            ${sale.credit_used > 0 ? `
              <tr style="background: #fff9e6;">
                <td colspan="6" style="padding: 8px; color: #856404;">Crédito usado</td>
                <td style="padding: 8px; text-align: right; color: #856404; font-weight: 600;">$${parseFloat(sale.credit_used).toLocaleString('es-AR')}</td>
              </tr>
            ` : ''}
          </tfoot>
        </table>
        ${sale.notes ? `<div style="margin-top: 12px; padding: 8px; background: #f8f9fa; border-radius: 4px;"><strong>Notas:</strong> ${escapeHtml(sale.notes)}</div>` : ''}
      `;

      detailsContent.innerHTML = itemsTable;
      detailsDiv.style.display = "block";
      
      // Scroll a los detalles
      detailsDiv.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      // Mostrar en alert (comportamiento original)
      const itemsHtml = items.map(item => `
        <div style="padding: 8px; border-bottom: 1px solid #f0f0f0;">
          ${item.is_return ? '<span style="color: #ff69b4;">[DEVOLUCIÓN]</span> ' : ''}
          ${escapeHtml(item.product_name)} - ${escapeHtml(item.color)} - Talle ${escapeHtml(item.size)} - 
          Cantidad: ${item.qty} - $${parseFloat(item.price).toLocaleString('es-AR')}
        </div>
      `).join("");

      alert(`
        Venta: ${sale.sale_number}
        Fecha: ${new Date(sale.created_at).toLocaleString('es-AR')}
        Cliente: ${sale.customer_name || 'Sin cliente'}
        Total: $${parseFloat(sale.total_amount).toLocaleString('es-AR')}
        Items: ${sale.item_count}
        ${sale.credit_used > 0 ? `Crédito usado: $${parseFloat(sale.credit_used).toLocaleString('es-AR')}` : ''}
        
        Productos:
        ${itemsHtml}
      `);
    }
  } catch (error) {
    console.error("Error obteniendo detalles:", error);
    if (inModal) {
      const detailsContent = document.getElementById("history-details-content");
      if (detailsContent) {
        detailsContent.innerHTML = "<p style='color: #dc3545;'>Error al cargar los detalles de la venta</p>";
      }
    } else {
      showMessage("Error al obtener detalles de la venta", "error");
    }
  }
};

// Cargar crédito manualmente
loadCreditBtn.addEventListener("click", async () => {
  if (!selectedCustomer) {
    showMessage("Seleccione un cliente primero", "error");
    return;
  }

  const amount = prompt("Ingrese el monto del crédito:");
  if (!amount || parseFloat(amount) <= 0) return;

  try {
    const { error } = await supabase
      .rpc("rpc_add_customer_credit", {
        p_customer_id: selectedCustomer.id,
        p_amount: parseFloat(amount),
        p_notes: "Crédito cargado manualmente"
      });

    if (error) throw error;

    showMessage("Crédito agregado exitosamente", "success");
    await loadCustomerCredits(selectedCustomer.id);
  } catch (error) {
    console.error("Error agregando crédito:", error);
    showMessage("Error al agregar crédito: " + error.message, "error");
  }
});

// Función helper para mostrar mensajes
function showMessage(message, type = "success", duration = 5000) {
  messageContainer.innerHTML = `
    <div class="message ${type}">
      ${escapeHtml(message)}
    </div>
  `;

  // Mensajes de error duran más tiempo para poder leerlos
  const displayDuration = type === "error" ? 10000 : duration;

  setTimeout(() => {
    messageContainer.innerHTML = "";
  }, displayDuration);
}

// Función helper para escapar HTML
function escapeHtml(text) {
  if (text === null || text === undefined) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

