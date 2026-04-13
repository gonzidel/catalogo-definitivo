// admin/public-sales.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { SUPABASE_URL, QZ_SIGN_SECRET } from "../scripts/config.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";
import { parseARSNumber, resolveOrderItemUnitPrice } from "../scripts/utils/price.js";

const TIMEZONE_BUENOS_AIRES = "America/Argentina/Buenos_Aires";

await requireAuth();

// Caja actual: 1 = finalizar venta aquí; 2 o 3 = enviar a Caja 1 (definido en HTML antes del script)
const PUBLIC_SALES_CAJA = Number(window.PUBLIC_SALES_CAJA) || 1;

// ============================================================================
// QZ TRAY - Funciones helper para impresión térmica ESC/POS
// ============================================================================

// Ancho del ticket en caracteres (80mm ≈ 42 caracteres con fuente estándar)
const TICKET_WIDTH = 42;
const editOrderVariantPriceMap = new Map(); // variant_id -> price de catálogo (raw)

// Función helper para configurar firma remota de QZ Tray
async function setupQZSignature() {
  if (typeof qz === 'undefined' || !qz || !qz.security) {
    console.warn("⚠️ QZ Tray no disponible");
    return;
  }

  try {
    console.log("🔧 Configurando certificado y firma remota de QZ Tray...");

    // PASO 1: Precargar y configurar certificado público (ANTES de la firma)
    console.log("📜 setCertificatePromise: cargando /certs/qz-site.crt");
    const certResponse = await fetch("/certs/qz-site.crt", { cache: "no-store" });
    const certText = await certResponse.text();
    console.log("✅ cert cargado, len=", certText.length, "begin=", certText.includes("BEGIN CERTIFICATE"));

    qz.security.setCertificatePromise((resolve, reject) => {
      console.log("📜 setCertificatePromise: resolviendo certificado precargado");
      if (certText) {
        const match = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
        if (match) {
          console.log("✅ Certificado sanitizado encontrado");
          resolve(match[0]);
        } else {
          console.warn("⚠️ No se pudo extraer bloque limpio, usando texto original");
          resolve(certText);
        }
      } else {
        reject(new Error("Certificado vacío"));
      }
    });

    console.log("✅ Certificado público configurado");

    // IMPORTANTE: Configurar algoritmo SHA-512 (requerido por QZ Tray 2.1+)
    qz.security.setSignatureAlgorithm("SHA512");
    console.log("✅ Algoritmo de firma configurado: SHA512");

    // PASO 2: Configurar firma remota (DESPUÉS del certificado)
    qz.security.setSignaturePromise(async (toSign) => {
      console.log("🔐 QZ Tray solicitó firma. Longitud:", toSign?.length || 0);

      if (!toSign || typeof toSign !== 'string') {
        throw new Error("toSign inválido o vacío");
      }

      // Obtener secret desde config (requiere QZ_SIGN_SECRET en config.local.js)
      const secret = QZ_SIGN_SECRET ||
        (typeof window !== 'undefined' ? window.QZ_SIGN_SECRET : "");
      if (!secret) {
        throw new Error("QZ_SIGN_SECRET no configurado. Agrega QZ_SIGN_SECRET en scripts/config.local.js");
      }

      console.log("📡 Enviando request de firma a Edge Function...");
      console.log("📤 toSign a enviar (len=" + toSign.length + "):", toSign.substring(0, 50) + "...");

      // IMPORTANTE: Enviar toSign como text/plain (no JSON) para evitar alteraciones
      // QZ Tray requiere que el string llegue exactamente igual, sin JSON.stringify
      const res = await fetch(`${SUPABASE_URL}/functions/v1/qz-sign`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
          "x-qz-secret": secret
        },
        body: toSign // Enviar directamente, sin JSON.stringify
      });

      console.log("📥 Respuesta recibida. Status:", res.status);

      if (!res.ok) {
        const errorText = await res.text();
        console.error("❌ Error HTTP:", res.status, errorText);
        throw new Error(`Error en firma: ${res.status} - ${errorText}`);
      }

      const signature = (await res.text()).trim();
      console.log("✅ Firma generada correctamente. Longitud:", signature.length);
      return signature;
    });

    console.log("✅ Certificado y firma remota configurados para QZ Tray");
  } catch (e) {
    console.error("❌ Error setupQZSignature:", e);
  }
}

// NO configurar firma aquí - se configurará cuando QZ esté disponible en qzConnect() o loadQZTray()

/**
 * Conecta al websocket de QZ Tray si no está activo
 * @returns {Promise<void>}
 */
async function qzConnect() {
  // Verificar si QZ está disponible
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    throw new Error("QZ Tray no está disponible");
  }

  // Asegurar que la firma esté configurada antes de conectar
  setupQZSignature();

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
    day: '2-digit',
    timeZone: TIMEZONE_BUENOS_AIRES,
  });
  const timeStr = saleDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE_BUENOS_AIRES,
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
    const price = parseARSNumber(item.price ?? item.price_snapshot ?? 0);
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
    const creditAmount = parseARSNumber(sale.credit_used);
    const creditStr = `-$${creditAmount.toLocaleString('es-AR')}`;
    ticket.push(`Credito Aplicado: ${padLeft(creditStr, TICKET_WIDTH - 20)}`);
    ticket.push("");
  }

  // TOTAL alineado a la derecha
  // Usar finalTotal si se proporciona (incluye todos los extras), sino usar sale.total_amount
  const totalAmount = finalTotal !== undefined && finalTotal !== null
    ? parseARSNumber(finalTotal)
    : parseARSNumber(sale.total_amount);
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
const saveOrderBtn = document.getElementById("save-order-btn");
const customersBtn = document.getElementById("customers-btn");
const historyBtn = document.getElementById("history-btn");
const ordersBtn = document.getElementById("orders-btn");
const ordersModal = document.getElementById("orders-modal");
const closeOrdersModal = document.getElementById("close-orders-modal");
const ordersReceivedTab = document.getElementById("orders-received-tab");
const ordersNewTab = document.getElementById("orders-new-tab");
const ordersReceivedList = document.getElementById("orders-received-list");
const ordersNewList = document.getElementById("orders-new-list");
const ordersTabButtons = document.querySelectorAll(".orders-tab-btn");
const createLocalOrderBtn = document.getElementById("create-local-order-btn");
const ordersSearchInput = document.getElementById("orders-search-input");
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
const pendingSalesContainer = document.getElementById("pending-sales-container");
const pendingSalesGrid = document.getElementById("pending-sales-grid");
const caja2Btn = document.getElementById("caja2-btn");
const caja3Btn = document.getElementById("caja3-btn");
// Campana: pendientes en local (pedidos web)
const reservasBellBtn = document.getElementById("reservas-bell-btn");
const reservasBellBadge = document.getElementById("reservas-bell-badge");
const reservasModal = document.getElementById("reservas-modal");
const closeReservasModalBtn = document.getElementById("close-reservas-modal");
const reservasList = document.getElementById("reservas-list");
const reservasRefreshBtn = document.getElementById("reservas-refresh-btn");
let reservasRealtimeChannel = null;
let reservasRefreshDebounceTimer = null;
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
const specialExtraNameInput = document.getElementById("special-extra-name");
const specialExtraAmountInput = document.getElementById("special-extra-amount");
const addSpecialExtraBtn = document.getElementById("add-special-extra-btn");
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
let manualSelectedSizesConfirmedWithoutStock = {}; // { size: true } - talles confirmados para agregar sin stock

// Control de versiones para evitar race conditions en renderizado de talles
let renderSizeButtonsVersion = 0;
let renderManualSizeButtonsVersion = 0;

// Estado para autocompletado
let autocompleteProducts = [];
let autocompleteSelectedIndex = -1;

// Estado para método de pago (por defecto todas las ventas son "contado")
let paymentMethod = 'contado';

// Estado para cargar saldo a favor como crédito
let loadAsCredit = false;

// Estado para compras pendientes
let pendingSales = [];
let currentPendingSale = null;
let currentLocalOrderId = null; // ID del pedido local si viene de un pedido local

// =============================================================================
// Campana: líneas de pedidos web con stock desde venta-público (espera en local)
// =============================================================================

function _safeText(v) {
  return (v ?? "").toString();
}

function setBellCount(units) {
  const n = Number(units || 0) || 0;
  if (!reservasBellBadge) return;
  if (n <= 0) {
    reservasBellBadge.style.display = "none";
    reservasBellBadge.textContent = "0";
    return;
  }
  reservasBellBadge.style.display = "inline-flex";
  reservasBellBadge.textContent = n > 99 ? "99+" : String(n);
}

function toggleReservasPanel(forceOpen = null) {
  if (!reservasModal) return;
  const open = forceOpen == null ? !reservasModal.classList.contains("active") : !!forceOpen;
  reservasModal.classList.toggle("active", open);
  reservasModal.setAttribute("aria-hidden", open ? "false" : "true");
  if (open) {
    document.body.style.overflow = "hidden";
    refreshReservas().catch((e) => console.warn("refreshReservas:", e?.message || e));
  } else {
    document.body.style.overflow = "";
  }
}

async function fetchLocalReservations() {
  if (!supabase) return { items: [], ventaPublicoId: null };

  // A) Resolver IDs de warehouses (general / venta-publico)
  const { data: whData, error: whErr } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);

  if (whErr) throw whErr;
  const generalId = (whData || []).find((w) => w.code === "general")?.id;
  const ventaId = (whData || []).find((w) => w.code === "venta-publico")?.id;

  if (!generalId || !ventaId) return { items: [], ventaPublicoId: null };

  // B) Líneas en espera (nuevo checkout) o reservadas solo-VP (legado antes del split)
  const { data, error } = await supabase
    .from("order_items")
    .select(
      [
        "id",
        "order_id",
        "product_name",
        "color",
        "size",
        "quantity",
        "status",
        "created_at",
        "orders(id, order_number, status, customer_id, customers(full_name))",
        "order_item_stock_sources(qty, warehouse_id)"
      ].join(",")
    )
    .in("status", ["waiting", "reserved"]);

  if (error) throw error;

  const finalStatuses = new Set(["closed", "sent", "devolucion", "devolución", "devolucion_alt", "cancelled"]);
  const rows = Array.isArray(data) ? data : [];

  const filtered = rows.filter((oi) => {
    const order = oi.orders;
    if (!order) return false;
    const orderStatus = _safeText(order.status).trim().toLowerCase();
    if (finalStatuses.has(orderStatus)) return false;

    const qty = Number(oi.quantity || 0) || 0;
    if (qty <= 0) return false;

    const sources = Array.isArray(oi.order_item_stock_sources) ? oi.order_item_stock_sources : [];
    let ventaQty = 0;
    let generalQty = 0;
    sources.forEach((s) => {
      const q = Number(s?.qty || 0) || 0;
      if (s?.warehouse_id === ventaId) ventaQty += q;
      if (s?.warehouse_id === generalId) generalQty += q;
    });

    if (ventaQty <= 0) return false;

    const st = _safeText(oi.status).trim().toLowerCase();
    if (st === "waiting") return true;
    // Legado: una sola línea reserved con todo el stock en venta-público
    if (st === "reserved" && generalQty === 0 && ventaQty === qty) return true;
    return false;
  });

  return { items: filtered, ventaPublicoId: ventaId };
}

function sumVentaUnitsForBell(items, ventaId) {
  if (!ventaId) {
    return (items || []).reduce((sum, oi) => sum + (Number(oi.quantity || 0) || 0), 0);
  }
  return (items || []).reduce((sum, oi) => {
    const sources = Array.isArray(oi.order_item_stock_sources) ? oi.order_item_stock_sources : [];
    let v = 0;
    sources.forEach((s) => {
      if (s?.warehouse_id === ventaId) v += Number(s?.qty || 0) || 0;
    });
    return sum + (v > 0 ? v : Number(oi.quantity || 0) || 0);
  }, 0);
}

function groupReservationsByOrder(items) {
  const map = new Map();
  (items || []).forEach((oi) => {
    const order = oi.orders || {};
    const orderId = order.id || oi.order_id || "unknown";
    if (!map.has(orderId)) {
      map.set(orderId, {
        orderId,
        orderNumber: order.order_number || "",
        customerName: order.customers?.full_name || "",
        items: [],
      });
    }
    map.get(orderId).items.push(oi);
  });
  return Array.from(map.values());
}

function renderReservations(items) {
  if (!reservasList) return;
  const groups = groupReservationsByOrder(items);
  if (groups.length === 0) {
    reservasList.innerHTML = `<div style="color:#666;font-size:13px;padding:8px 0;">No hay productos pendientes de retirar en local.</div>`;
    return;
  }

  reservasList.innerHTML = groups
    .map((g) => {
      const header = `
        <div class="reserva-order__meta">
          <div>
            <div class="reserva-order__customer">${_safeText(g.customerName) || "Cliente"}</div>
            <div style="font-size:12px;color:#666;">Pedido ${_safeText(g.orderNumber) || ""}</div>
          </div>
          <div style="font-size:12px;color:#666; font-weight:700;">en local</div>
        </div>
      `;

      const itemsHtml = (g.items || [])
        .map((oi) => {
          const name = _safeText(oi.product_name) || "Producto";
          const color = _safeText(oi.color) || "-";
          const size = _safeText(oi.size) || "-";
          const qty = Number(oi.quantity || 0) || 0;
          return `
            <div class="reserva-item">
              <div>
                <div class="reserva-item__name">${name}</div>
                <div class="reserva-item__meta">Color: <strong>${color}</strong> • Talle: <strong>${size}</strong> • Cant: <strong>${qty}</strong></div>
              </div>
              <div class="reserva-item__actions">
                <button type="button" class="reserva-action-btn reserva-action-btn--ok" data-reserva-action="confirm" data-order-item-id="${oi.id}">Apartado</button>
                <button type="button" class="reserva-action-btn reserva-action-btn--no" data-reserva-action="reject" data-order-item-id="${oi.id}">Faltante</button>
              </div>
            </div>
          `;
        })
        .join("");

      return `<div class="reserva-order">${header}${itemsHtml}</div>`;
    })
    .join("");
}

async function refreshReservas() {
  if (!supabase) return;
  const { items, ventaPublicoId } = await fetchLocalReservations();
  setBellCount(sumVentaUnitsForBell(items, ventaPublicoId));
  if (reservasModal?.classList.contains("active")) {
    renderReservations(items);
  }
}

function scheduleReservasRefreshFromRealtime() {
  if (reservasRefreshDebounceTimer) clearTimeout(reservasRefreshDebounceTimer);
  reservasRefreshDebounceTimer = setTimeout(() => {
    reservasRefreshDebounceTimer = null;
    refreshReservas().catch((e) => console.warn("refreshReservas (realtime):", e?.message || e));
  }, 400);
}

function setupReservasRealtime() {
  if (!supabase || reservasRealtimeChannel) return;
  try {
    reservasRealtimeChannel = supabase
      .channel("public-sales-pendientes-local")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "order_items" },
        () => scheduleReservasRefreshFromRealtime()
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "orders" },
        () => scheduleReservasRefreshFromRealtime()
      )
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR") {
          console.warn("Campana pendientes: error de canal Realtime (¿tabla en publicación?)");
        }
      });
  } catch (e) {
    console.warn("setupReservasRealtime:", e?.message || e);
  }
}

async function handleReservaAction(action, orderItemId) {
  if (!supabase) throw new Error("Supabase no disponible");
  const a = _safeText(action).trim().toLowerCase();
  const nextStatus = a === "confirm" ? "picked" : a === "reject" ? "missing" : null;
  if (!nextStatus) return;

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user?.id) throw new Error("Sesión no disponible");

  const { error } = await supabase.rpc("rpc_update_order_item_status", {
    p_item_id: orderItemId,
    p_status: nextStatus,
    p_checked_by: user.id,
  });
  if (error) throw error;
  await refreshReservas();
}

// Cache y sistema de cola para QR
let warehousesCache = null; // Cache de warehouses (general, venta-publico)
let qrProcessingQueue = []; // Cola de códigos QR pendientes de procesar
let isProcessingQr = false; // Flag para saber si se está procesando un QR
let renderDebounceTimeout = null; // Timeout para debounce de renderSaleList
let calculateTotalsDebounceTimeout = null; // Timeout para debounce de calculateTotals

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
let skuSearchTimeout = null;
skuSearch.addEventListener("input", async (e) => {
  const sku = e.target.value.trim();
  
  // Si el campo tiene contenido, esperar un breve momento y luego buscar automáticamente
  // Esto simula la lectura de QR que escribe el código completo de una vez
  if (sku.length > 0) {
    clearTimeout(skuSearchTimeout);
    skuSearchTimeout = setTimeout(async () => {
      // Solo buscar si el campo todavía tiene contenido (no fue limpiado)
      const currentSku = skuSearch.value.trim();
      if (currentSku.length > 0) {
        // Si es numérico (QR code), agregar a la cola para procesamiento rápido
        if (/^\d+$/.test(currentSku)) {
          addToQrQueue(currentSku);
        } else {
          // Si no es numérico, buscar por SKU normalmente
          await searchBySku(currentSku);
        }
      }
    }, 150); // Reducido a 150ms para respuesta más rápida
  }
});

skuSearch.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(skuSearchTimeout); // Cancelar timeout si se presiona Enter manualmente
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

// Ordenar productos: primero coincidencia exacta, luego "empieza por", luego "contiene"
function sortProductsByRelevance(products, term) {
  if (!term) return products;
  const t = term.trim().toLowerCase();
  return [...products].sort((a, b) => {
    const aName = (a.name || "").trim().toLowerCase();
    const bName = (b.name || "").trim().toLowerCase();
    const aExact = aName === t;
    const bExact = bName === t;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    const aStarts = aName.startsWith(t);
    const bStarts = bName.startsWith(t);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return 0;
  });
}

// Cargar sugerencias de productos y renderizar en el dropdown
async function loadProductSuggestions(term) {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category")
      .ilike("name", `%${term}%`)
      .in("status", ["active", "pending_stock", "draft"]) // Incluir productos activos, con stock pendiente y en borrador
      .limit(50);

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
      // Priorizar: 1) nombre exacto, 2) empieza por término, 3) contiene
      const sorted = sortProductsByRelevance(uniqueProducts, term).slice(0, 10);
      autocompleteProducts = sorted;

      // Renderizar items en el dropdown
      sorted.forEach((product, index) => {
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
  // Volver a renderizar después de calcular totales para mostrar los valores actualizados de extras porcentuales
  renderSaleList();
  showMessage("Extras aplicados correctamente", "success");
}

// Agregar extra especial al pedido
async function addSpecialExtra() {
  const name = specialExtraNameInput ? specialExtraNameInput.value.trim() : '';
  const amount = specialExtraAmountInput ? parseFloat(specialExtraAmountInput.value) : 0;
  
  // Validaciones
  if (!name) {
    showMessage("Por favor ingrese un nombre para el extra especial", "error");
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    showMessage("Por favor ingrese un monto válido mayor a 0", "error");
    return;
  }
  
  // Crear item de extra especial
  const specialExtra = {
    isExtra: true,
    isSpecialExtra: true, // Flag adicional para distinguirlo de otros extras
    extraType: 'special',
    productName: name,
    totalValue: amount,
    totalQuantity: 1,
    sku: 'EXTRA-ESPECIAL',
    color: '-',
    sizes: [],
    price: amount
  };
  
  saleItems.push(specialExtra);
  
  // Limpiar campos
  if (specialExtraNameInput) specialExtraNameInput.value = "";
  if (specialExtraAmountInput) specialExtraAmountInput.value = "";
  
  // Actualizar lista y totales
  renderSaleList();
  await calculateTotals();
  showMessage(`Extra especial "${name}" agregado correctamente`, "success");
}

// Event listener para botón aplicar extras
if (applyExtrasBtn) {
  applyExtrasBtn.addEventListener("click", async () => {
    await applyExtras();
  });
}

// Event listener para botón agregar extra especial (deshabilitar mientras ejecuta para evitar doble clic)
if (addSpecialExtraBtn) {
  addSpecialExtraBtn.addEventListener("click", async () => {
    addSpecialExtraBtn.disabled = true;
    try {
      await addSpecialExtra();
    } finally {
      addSpecialExtraBtn.disabled = false;
    }
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
      .in("status", ["active", "pending_stock", "draft"]) // Incluir productos activos, con stock pendiente y en borrador
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
    // Nuevo producto: invalidar renders async previos y limpiar UI de talles/cantidades
    // (si no, manualSelectedColor sigue seteado y renderManualColorButtons no vuelve a llamar renderManualSizeButtons)
    renderManualSizeButtonsVersion++;
    manualSelectedColor = null;
    manualSelectedSizes = {};
    manualSelectedSizesSource = {};
    manualSelectedSizesConfirmedWithoutStock = {};
    if (manualSizeButtons) manualSizeButtons.innerHTML = "";
    if (manualLoadBtn) manualLoadBtn.disabled = true;

    // Cargar variantes (sin size, ya que los talles están en variant_sizes)
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
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
      .in("products.status", ["active", "pending_stock", "draft"]); // Incluir productos activos, con stock pendiente y en borrador

    if (error) throw error;

    if (!variants || variants.length === 0) {
      showMessage("No se encontraron variantes activas para este producto. Verifica que el producto esté activo y las variantes tengan el checkbox 'Activa' marcado.", "error");
      return;
    }

    // Cargar talles desde variant_sizes para cada variante
    const variantIds = variants.map(v => v.id);
    const { data: sizesData, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("variant_id, size, stock_qty, sku")
      .in("variant_id", variantIds)
      .order("size");

    // Agrupar talles por variant_id
    // IMPORTANTE: Normalizar los tamaños al cargarlos desde variant_sizes para asegurar consistencia
    const sizesByVariant = new Map();
    if (sizesData) {
      sizesData.forEach(sizeRow => {
        if (!sizesByVariant.has(sizeRow.variant_id)) {
          sizesByVariant.set(sizeRow.variant_id, []);
        }
        // Normalizar el tamaño antes de guardarlo
        const normalizedSize = normalizeSize(sizeRow.size);
        if (normalizedSize) {
          sizesByVariant.get(sizeRow.variant_id).push({
            size: normalizedSize, // Guardar tamaño normalizado
            stock_qty: sizeRow.stock_qty || 0,
            sku: sizeRow.sku,
          });
        }
      });
    }

    // Agregar talles a cada variante y crear variantes "virtuales" por cada talle
    const variantsWithSizes = [];
    variants.forEach(variant => {
      const sizes = sizesByVariant.get(variant.id) || [];
      if (sizes.length > 0) {
        // Crear una variante virtual por cada talle
        sizes.forEach(sizeData => {
          variantsWithSizes.push({
            ...variant,
            size: sizeData.size, // Ya está normalizado desde sizesByVariant
            sizeSku: sizeData.sku, // SKU completo con talle
            qr_code: sizeData.qr_code, // Código QR numérico único
            stock_qty: sizeData.stock_qty, // Stock del talle desde variant_sizes
          });
        });
      } else {
        // Si no tiene talles, agregar la variante sin size (modo legacy)
        variantsWithSizes.push({
          ...variant,
          size: null,
        });
      }
    });

    manualCurrentProduct = variants[0].products;
    manualCurrentVariants = variantsWithSizes;

    // Mostrar información básica inmediatamente (sin esperar datos adicionales)
    manualProductName.textContent = manualCurrentProduct.name;
    const firstVariant = manualCurrentVariants[0];
    manualProductPrice.textContent = `$${firstVariant.price.toLocaleString('es-AR')}`;
    if (manualProductInfo) {
      manualProductInfo.style.display = "flex";
    }

    // Renderizar colores inmediatamente con precios base
    await renderManualColorButtons();

    // Obtener stock, precios efectivos e información de ofertas/promociones para cada variante EN PARALELO
    const variantPromises = manualCurrentVariants.map(async (variant) => {
      // Ejecutar datos de precio/promoción en paralelo; stock se resuelve por semántica de talle.
      const [effectivePrice, offerInfo, promotionInfo] = await Promise.all([
        getEffectivePrice(variant.id),
        getOfferInfo(variant.id, manualCurrentProduct.id, variant.color),
        getPromotionInfo(variant.id)
      ]);

      if (variant.size && variant.sizeSku) {
        variant.stockData = await getVariantSizeStockByWarehouse(variant.id, variant.size);
      } else {
        // Variante sin talle específico: mantener modo legacy.
        variant.stockData = await getVariantStock(variant.id);
      }

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
    await renderManualColorButtons();
  } catch (error) {
    console.error("Error cargando variantes manuales:", error);
    showMessage("Error al cargar variantes: " + error.message, "error");
  }
}

// Renderizar botones de colores para modo manual
async function renderManualColorButtons() {
  const colors = [...new Set(manualCurrentVariants.map(v => v.color).filter(Boolean))];

  if (!manualColorButtons) return;
  manualColorButtons.innerHTML = "";

  colors.forEach(color => {
    const btn = document.createElement("button");
    btn.className = "color-btn";
    btn.textContent = color;
    btn.style.padding = "10px 20px";
    btn.style.fontSize = "14px";
    btn.style.minWidth = "88px";
    btn.style.whiteSpace = "nowrap";
    btn.style.textAlign = "center";
    btn.style.display = "flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.addEventListener("click", async () => {
      document.querySelectorAll("#manual-color-buttons .color-btn").forEach(b => {
        b.classList.remove("active");
        b.style.color = ""; // Resetear color para que use el CSS
      });
      btn.classList.add("active");
      manualSelectedColor = color;
      manualSelectedSizes = {};
      manualSelectedSizesSource = {}; // Limpiar fuente de stock al cambiar de color
      manualSelectedSizesConfirmedWithoutStock = {};

      // Actualizar precio e información de oferta para el color seleccionado
      const variantsByColor = manualCurrentVariants.filter(v => v.color === color);
      if (variantsByColor.length > 0) {
        const firstVariant = variantsByColor[0];
        const effectivePrice = firstVariant.effectivePrice || firstVariant.price;
        manualProductPrice.textContent = `$${effectivePrice.toLocaleString('es-AR')}`;
        updateProductOfferDisplay(firstVariant, manualProductOfferInfo);
      }

      await renderManualSizeButtons();
    });
    manualColorButtons.appendChild(btn);
  });

  // Siempre refrescar talles al reconstruir colores (nuevo producto o 2.ª pasada tras enriquecer variantes).
  // Antes solo se llamaba con !manualSelectedColor: al buscar otro producto el color seguía seteado y los cuadros quedaban del producto anterior.
  if (colors.length > 0) {
    if (!manualSelectedColor || !colors.includes(manualSelectedColor)) {
      manualSelectedColor = colors[0];
    }
    document.querySelectorAll("#manual-color-buttons .color-btn").forEach((b) => {
      b.classList.toggle("active", b.textContent === manualSelectedColor);
    });

    const variantsByColor = manualCurrentVariants.filter((v) => v.color === manualSelectedColor);
    if (variantsByColor.length > 0) {
      const firstVariant = variantsByColor[0];
      const effectivePrice = firstVariant.effectivePrice || firstVariant.price;
      manualProductPrice.textContent = `$${effectivePrice.toLocaleString("es-AR")}`;
      updateProductOfferDisplay(firstVariant, manualProductOfferInfo);
    }

    await renderManualSizeButtons();
  }
}

// Actualizar un botón de talle específico sin recrear toda la lista
function updateManualSizeButton(size, generalStock, ventaPublicoStock, totalStock) {
  if (!manualSizeButtons) return;
  
  const btn = manualSizeButtons.querySelector(`[data-size="${size}"]`);
  if (!btn) return;
  
  const quantity = manualSelectedSizes[size] || 0;
  const source = manualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };
  
  // Actualizar clases CSS según stock y cantidad
  btn.className = "size-btn";
  if (totalStock === 0) {
    btn.classList.add("size-zero");
  } else if (ventaPublicoStock > 0 && source.general === 0) {
    btn.classList.add("size-available");
  } else if (generalStock > 0 || source.general > 0) {
    btn.classList.add("size-green");
  } else {
    btn.classList.add("size-zero");
  }
  
  // Actualizar o crear contador
  let counter = btn.querySelector(".size-counter");
  if (quantity > 0) {
    if (!counter) {
      counter = document.createElement("div");
      counter.className = "size-counter";
      counter.style.width = "18px";
      counter.style.height = "18px";
      counter.style.fontSize = "11px";
      btn.appendChild(counter);
    }
    counter.textContent = quantity;
  } else if (counter) {
    counter.remove();
  }
  
  // Actualizar o crear botón de decremento
  let decrementBtn = btn.querySelector(".size-decrement");
  if (quantity > 0) {
    if (!decrementBtn) {
      decrementBtn = document.createElement("button");
      decrementBtn.className = "size-decrement";
      decrementBtn.textContent = "-";
      decrementBtn.type = "button";
      decrementBtn.style.width = "16px";
      decrementBtn.style.height = "16px";
      decrementBtn.style.fontSize = "12px";
      decrementBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (manualSelectedSizes[size] > 0) {
          manualSelectedSizes[size]--;
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
          // Obtener stock actualizado para este talle (comparar talles normalizados para evitar fallos por formato)
          const variant = manualCurrentVariants.find(v => v.color === manualSelectedColor && normalizeSize(v.size) === normalizeSize(size));
          if (variant) {
            const { data: warehouses } = await supabase
              .from("warehouses")
              .select("id, code")
              .in("code", ["general", "venta-publico"]);
            const warehouseMap = new Map();
            let generalWarehouseId = null;
            let ventaPublicoWarehouseId = null;
            if (warehouses && warehouses.length > 0) {
              warehouses.forEach(w => warehouseMap.set(w.code, w.id));
              generalWarehouseId = warehouseMap.get("general");
              ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
            }
            let genStock = 0;
            let ventaStock = 0;
            if (generalWarehouseId && ventaPublicoWarehouseId) {
              // Normalizar el tamaño antes de consultar
              const normalizedSize = normalizeSize(size);
              
              // Cargar todos los registros de stock para esta variante y normalizar después
              const { data: sizeWarehouseStocks } = await supabase
                .from("variant_size_warehouse_stock")
                .select("size, warehouse_id, stock_qty")
                .eq("variant_id", variant.id)
                .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
              if (sizeWarehouseStocks) {
                // Filtrar por tamaño normalizado después de obtener los datos
                sizeWarehouseStocks.forEach(sws => {
                  const swsNormalizedSize = normalizeSize(sws.size);
                  if (swsNormalizedSize !== normalizedSize) return; // Saltar si no coincide después de normalizar
                  
                  if (sws.warehouse_id === generalWarehouseId) {
                    genStock = sws.stock_qty || 0;
                  } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
                    ventaStock = sws.stock_qty || 0;
                  }
                });
              }
            }
            updateManualSizeButton(size, genStock, ventaStock, genStock + ventaStock);
          } else {
            updateManualSizeButton(size, 0, 0, 0);
          }
          updateManualLoadButton();
        }
      });
      btn.appendChild(decrementBtn);
    }
  } else if (decrementBtn) {
    decrementBtn.remove();
  }
}

// Renderizar botones de talles para modo manual
async function renderManualSizeButtons() {
  // Incrementar versión para cancelar renderizados anteriores
  const currentVersion = ++renderManualSizeButtonsVersion;
  
  if (!manualSelectedColor || !manualSizeButtons) return;

  const variantsByColor = manualCurrentVariants.filter(v => v.color === manualSelectedColor);
  const sizes = [...new Set(variantsByColor.map(v => v.size).filter(Boolean))].sort((a, b) => {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return numA - numB;
  });

  // Verificar versión antes de modificar DOM
  if (currentVersion !== renderManualSizeButtonsVersion) return;
  manualSizeButtons.innerHTML = "";

  // Obtener warehouses una sola vez
  const { data: warehouses } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  const warehouseMap = new Map();
  let generalWarehouseId = null;
  let ventaPublicoWarehouseId = null;
  
  if (warehouses && warehouses.length > 0) {
    warehouses.forEach(w => warehouseMap.set(w.code, w.id));
    generalWarehouseId = warehouseMap.get("general");
    ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  }

  // Normalizar todos los tamaños antes de consultar usando la función global normalizeSize
  const normalizedSizes = sizes.map(s => normalizeSize(s)).filter(Boolean);
  
  // Obtener todos los stocks por talle de una vez
  const variantIds = variantsByColor.map(v => v.id).filter(Boolean);
  const sizeStockMap = new Map(); // key: `${variantId}_${normalizedSize}`, value: { general, ventaPublico, total }
  
  if (variantIds.length > 0 && normalizedSizes.length > 0 && generalWarehouseId && ventaPublicoWarehouseId) {
    // Consultar stock por talle desde variant_size_warehouse_stock para todos los talles
    // IMPORTANTE: Normalizar los tamaños en la consulta usando una subconsulta o cargar todos y normalizar después
    const { data: sizeWarehouseStocks, error: sizeError } = await supabase
      .from("variant_size_warehouse_stock")
      .select("variant_id, size, warehouse_id, stock_qty")
      .in("variant_id", variantIds)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
    
    if (!sizeError && sizeWarehouseStocks && sizeWarehouseStocks.length > 0) {
      // Filtrar y normalizar después de obtener los datos
      sizeWarehouseStocks.forEach(sws => {
        const normalizedSize = normalizeSize(sws.size);
        if (!normalizedSize) return; // Saltar tamaños vacíos
        
        // Filtrar solo los tamaños que están en la lista de sizes normalizados
        if (!normalizedSizes.includes(normalizedSize)) return;
        
        const key = `${sws.variant_id}_${normalizedSize}`;
        if (!sizeStockMap.has(key)) {
          sizeStockMap.set(key, { general: 0, ventaPublico: 0, total: 0 });
        }
        const stock = sizeStockMap.get(key);
        
        // IMPORTANTE: Si ya existe un valor, NO sumar, REEMPLAZAR
        // (cada variante+talle+warehouse debería tener solo un registro)
        if (sws.warehouse_id === generalWarehouseId) {
          stock.general = sws.stock_qty || 0;
        } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
          stock.ventaPublico = sws.stock_qty || 0;
        }
        stock.total = stock.general + stock.ventaPublico;
      });
    }
  }

  // Verificar versión después de consultas async
  if (currentVersion !== renderManualSizeButtonsVersion) return;

  sizes.forEach(size => {
    // Normalizar el tamaño antes de buscar la variante
    const normalizedSize = normalizeSize(size);
    if (!normalizedSize) return; // Saltar tamaños vacíos
    
    // Buscar la variante usando tamaño normalizado
    const variant = variantsByColor.find(v => {
      const vNormalizedSize = normalizeSize(v.size);
      return vNormalizedSize === normalizedSize;
    });
    if (!variant) return;
    
    // Obtener stock específico del talle desde el mapa usando el tamaño normalizado
    const stockKey = `${variant.id}_${normalizedSize}`;
    let totalStock = 0;
    let generalStock = 0;
    let ventaPublicoStock = 0;
    
    if (sizeStockMap.has(stockKey)) {
      const sizeStock = sizeStockMap.get(stockKey);
      generalStock = sizeStock.general || 0;
      ventaPublicoStock = sizeStock.ventaPublico || 0;
      totalStock = sizeStock.total || 0;
    } else {
      // Fallback: intentar buscar en el mapa con todas las variantes del mismo color
      // para este tamaño (puede haber múltiples variantes con el mismo color pero diferentes IDs)
      for (const [key, stock] of sizeStockMap.entries()) {
        const [keyVariantId, keySize] = key.split('_');
        if (keySize === normalizedSize && variantIds.includes(keyVariantId)) {
          // Encontrar la variante correcta por ID
          const matchingVariant = variantsByColor.find(v => v.id === keyVariantId);
          if (matchingVariant && normalizeSize(matchingVariant.size) === normalizedSize) {
            generalStock = stock.general || 0;
            ventaPublicoStock = stock.ventaPublico || 0;
            totalStock = stock.total || 0;
            break;
          }
        }
        }
      }
      
    // Plan 2: no usar variant_sizes como fallback operativo por talle.

    const btn = document.createElement("button");
    btn.className = "size-btn";
    btn.setAttribute("data-size", size);
    btn.textContent = size;
    btn.style.width = "40px";
    btn.style.height = "40px";
    btn.style.fontSize = "14px";

    // Mostrar contador si hay cantidad seleccionada
    const quantity = manualSelectedSizes[size] || 0;
    const source = manualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };

    // Determinar color del botón según stock disponible y fuente actual
    // IMPORTANTE: Si ya se está usando stock de general, el botón debe ser verde
    if (totalStock === 0) {
      btn.classList.add("size-zero");
    } else if (source.general > 0) {
      // Ya se está usando stock de general, botón verde
      btn.classList.add("size-green");
    } else if (ventaPublicoStock > 0 && source.general === 0) {
      // Hay stock en venta-publico y no se está usando general, botón marrón
      btn.classList.add("size-available");
    } else if (generalStock > 0) {
      // Solo hay stock en general, botón verde
      btn.classList.add("size-green");
    } else {
      btn.classList.add("size-zero");
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
      decrementBtn.addEventListener("click", async (e) => {
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
          updateManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
          updateManualLoadButton();
        }
      });
      btn.appendChild(decrementBtn);
    }

    // En modo devoluciones, todos los botones están disponibles sin límite de stock
    if (returnMode.checked || totalStock > 0) {
      btn.addEventListener("click", async () => {
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

          updateManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
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

            updateManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
            updateManualLoadButton();
          } else {
            // Stock máximo alcanzado: mostrar modal de confirmación
            const modal = document.getElementById("no-stock-confirm-modal");
            const confirmYes = document.getElementById("no-stock-confirm-yes");
            const confirmNo = document.getElementById("no-stock-confirm-no");

            if (!modal || !confirmYes || !confirmNo) {
              showMessage(`Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock})`, "error", 10000);
              return;
            }

            // Actualizar mensaje del modal para stock máximo alcanzado
            const modalMessage = modal.querySelector("p");
            if (modalMessage) {
              modalMessage.textContent = `Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock}). ¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`;
            }

            modal.classList.add("active");

            // Esperar respuesta del usuario
            const userConfirmed = await new Promise((resolve) => {
              const handleYes = () => {
                modal.classList.remove("active");
                // Restaurar mensaje original del modal
                const modalMessage = modal.querySelector("p");
                if (modalMessage) {
                  modalMessage.textContent = "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
                }
                confirmYes.removeEventListener("click", handleYes);
                confirmNo.removeEventListener("click", handleNo);
                resolve(true);
              };

              const handleNo = () => {
                modal.classList.remove("active");
                // Restaurar mensaje original del modal
                const modalMessage = modal.querySelector("p");
                if (modalMessage) {
                  modalMessage.textContent = "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
                }
                confirmYes.removeEventListener("click", handleYes);
                confirmNo.removeEventListener("click", handleNo);
                resolve(false);
              };

              confirmYes.addEventListener("click", handleYes);
              confirmNo.addEventListener("click", handleNo);
            });

            if (userConfirmed) {
              // Agregar talle como si tuviera stock (para casos de mal conteo)
              manualSelectedSizes[size] = currentQty + 1;
              // Marcar que este talle fue confirmado para agregar sin stock
              manualSelectedSizesConfirmedWithoutStock[size] = true;

              // SIEMPRE resetear a 0,0 cuando se confirma sin stock
              // Esto indica que el usuario aceptó agregar sin descontar de ningún warehouse
              manualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };

              updateManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
              updateManualLoadButton();
            }
          }
        }
      });
    } else {
      // Botón sin stock: agregar event listener para mostrar confirmación
      btn.addEventListener("click", async () => {
        // Mostrar modal de confirmación
        const modal = document.getElementById("no-stock-confirm-modal");
        const confirmYes = document.getElementById("no-stock-confirm-yes");
        const confirmNo = document.getElementById("no-stock-confirm-no");

        if (!modal || !confirmYes || !confirmNo) {
          console.error("Modal de confirmación sin stock no encontrado");
          return;
        }

        modal.classList.add("active");

        // Esperar respuesta del usuario
        const userConfirmed = await new Promise((resolve) => {
          const handleYes = () => {
            modal.classList.remove("active");
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(true);
          };

          const handleNo = () => {
            modal.classList.remove("active");
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(false);
          };

          confirmYes.addEventListener("click", handleYes);
          confirmNo.addEventListener("click", handleNo);
        });

        if (userConfirmed) {
          // Agregar talle como si tuviera stock
          const currentQty = manualSelectedSizes[size] || 0;
          manualSelectedSizes[size] = currentQty + 1;
          // Marcar que este talle fue confirmado para agregar sin stock
          manualSelectedSizesConfirmedWithoutStock[size] = true;

          // SIEMPRE resetear a 0,0 cuando se confirma sin stock
          // Esto indica que el usuario aceptó agregar sin descontar de ningún warehouse
          manualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };

          // Obtener stock para actualizar el botón
          const variant = manualCurrentVariants.find(v => v.color === manualSelectedColor && v.size === size);
          if (variant) {
            const { data: warehouses } = await supabase
              .from("warehouses")
              .select("id, code")
              .in("code", ["general", "venta-publico"]);
            const warehouseMap = new Map();
            let generalWarehouseId = null;
            let ventaPublicoWarehouseId = null;
            if (warehouses && warehouses.length > 0) {
              warehouses.forEach(w => warehouseMap.set(w.code, w.id));
              generalWarehouseId = warehouseMap.get("general");
              ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
            }
            let genStock = 0;
            let ventaStock = 0;
            if (generalWarehouseId && ventaPublicoWarehouseId) {
              // Normalizar el tamaño antes de consultar
              const normalizedSize = normalizeSize(size);
              
              // Cargar todos los registros de stock para esta variante y normalizar después
              const { data: sizeWarehouseStocks } = await supabase
                .from("variant_size_warehouse_stock")
                .select("size, warehouse_id, stock_qty")
                .eq("variant_id", variant.id)
                .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
              if (sizeWarehouseStocks) {
                // Filtrar por tamaño normalizado después de obtener los datos
                sizeWarehouseStocks.forEach(sws => {
                  const swsNormalizedSize = normalizeSize(sws.size);
                  if (swsNormalizedSize !== normalizedSize) return; // Saltar si no coincide después de normalizar
                  
                  if (sws.warehouse_id === generalWarehouseId) {
                    genStock = sws.stock_qty || 0;
                  } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
                    ventaStock = sws.stock_qty || 0;
                  }
                });
              }
            }
            updateManualSizeButton(size, genStock, ventaStock, genStock + ventaStock);
          }
          updateManualLoadButton();
        }
      });
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

      const variant = variantsByColor.find(v => normalizeSize(v.size) === normalizeSize(size));
      if (!variant) continue;

      const sizeStock = await getVariantSizeStockByWarehouse(variant.id, size);
      const totalStock = sizeStock.total || 0;

      // Validar stock solo si el talle NO fue confirmado para agregar sin stock
      if (!isReturn && quantity > totalStock && !manualSelectedSizesConfirmedWithoutStock[size]) {
        showMessage(`Error: La cantidad seleccionada (${quantity}) para talle ${size} excede el stock disponible (${totalStock})`, "error");
        hasStockError = true;
        break;
      }
    }

    if (hasStockError) return;

    Object.keys(manualSelectedSizes).forEach(size => {
      const quantity = manualSelectedSizes[size];
      if (quantity <= 0) return;

      const variant = variantsByColor.find(v => normalizeSize(v.size) === normalizeSize(size));
      if (!variant) return;

      // Obtener stock disponible para este talle
      const stock = variant.stockData || { general: { stock: 0 }, ventaPublico: { stock: 0 } };
      const ventaPublicoStock = stock.ventaPublico?.stock || 0;
      const generalStock = stock.general?.stock || 0;

      // Obtener fuente del stock para este talle
      // Si manualSelectedSizesSource existe y tiene valores válidos, usarlo
      // Si no existe o tiene valores 0,0 (confirmado sin stock), calcular basándose en stock disponible
      const existingSource = manualSelectedSizesSource[size];
      const wasConfirmedWithoutStock = existingSource && 
        existingSource.ventaPublico === 0 && 
        existingSource.general === 0 &&
        manualSelectedSizesConfirmedWithoutStock[size];

      let source;
      if (wasConfirmedWithoutStock) {
        // Si fue confirmado sin stock, establecer source en 0,0 explícitamente
        source = {
          ventaPublico: 0,
          general: 0
        };
      } else if (existingSource && 
          (existingSource.ventaPublico > 0 || existingSource.general > 0)) {
        // Usar fuente existente si es válida
        source = {
          ventaPublico: existingSource.ventaPublico || 0,
          general: existingSource.general || 0
        };
      } else {
        // Calcular fuente basándose en stock disponible (mismo patrón que processQrCodeFast)
        // Priorizar venta-publico, luego general
        let ventaPublicoQty = Math.min(quantity, ventaPublicoStock);
        let generalQty = 0;
        
        if (ventaPublicoQty < quantity) {
          const neededFromGeneral = quantity - ventaPublicoQty;
          generalQty = Math.min(neededFromGeneral, generalStock);
        }
        
        source = {
          ventaPublico: ventaPublicoQty,
          general: generalQty
        };
      }

      // Buscar si ya existe este producto/color con el mismo tipo (devolución o venta) en la lista
      const existingIndex = saleItems.findIndex(item =>
        item.productId === manualCurrentProduct.id &&
        item.color === manualSelectedColor &&
        item.isReturn === isReturn
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
    manualSelectedSizesConfirmedWithoutStock = {};
    manualSelectedColor = null;
    manualCurrentProduct = null;
    manualCurrentVariants = [];
    manualProduct.value = "";
    if (manualProductInfo) {
      manualProductInfo.style.display = "none";
    }
    renderSaleList();
    await calculateTotals();
    // Mensaje eliminado - no es necesario mostrar aviso al agregar productos
  });
}

// Función helper para obtener warehouses con cache
async function getWarehousesCached() {
  if (warehousesCache) {
    return warehousesCache;
  }
  
  const { data: warehouses } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehouses) {
    const warehouseMap = {};
    warehouses.forEach(w => {
      if (w.code === "general") warehouseMap.generalId = w.id;
      if (w.code === "venta-publico") warehouseMap.ventaPublicoId = w.id;
    });
    warehousesCache = warehouseMap;
  }
  
  return warehousesCache || { generalId: null, ventaPublicoId: null };
}

// Stock disponible para variant+size restando lo ya en la lista de venta
async function getAvailableStockForVariantSizeInSale(variantId, size) {
  const wh = await getWarehousesCached();
  const generalId = wh?.generalId ?? null;
  const ventaPublicoId = wh?.ventaPublicoId ?? null;
  const normalizedSize = normalizeSize(size);
  if (!normalizedSize) return { total: 0, ventaPublico: 0, general: 0 };

  let totalStock = 0;
  let ventaPublicoStock = 0;
  let generalStock = 0;

  if (generalId && ventaPublicoId) {
    const { data: rows } = await supabase
      .from("variant_size_warehouse_stock")
      .select("size, warehouse_id, stock_qty")
      .eq("variant_id", variantId)
      .in("warehouse_id", [generalId, ventaPublicoId]);

    if (rows && rows.length > 0) {
      rows.forEach((r) => {
        if (normalizeSize(r.size) !== normalizedSize) return;
        const qty = r.stock_qty || 0;
        totalStock += qty;
        if (r.warehouse_id === ventaPublicoId) ventaPublicoStock += qty;
        else if (r.warehouse_id === generalId) generalStock += qty;
      });
    }
  }

  if (totalStock === 0) {
    const { data: vsRows } = await supabase
      .from("variant_sizes")
      .select("size, stock_qty")
      .eq("variant_id", variantId);
    if (vsRows?.length) {
      const vs = vsRows.find((r) => normalizeSize(r.size) === normalizedSize);
      if (vs?.stock_qty) {
        totalStock = vs.stock_qty;
        generalStock = vs.stock_qty;
      }
    }
  }

  let reservedTotal = 0;
  let reservedVentaPublico = 0;
  let reservedGeneral = 0;
  saleItems.forEach((item) => {
    if (!item.sizes) return;
    item.sizes.forEach((s) => {
      if (s.variantId !== variantId) return;
      if (normalizeSize(s.size) !== normalizedSize) return;
      reservedTotal += s.quantity || 0;
      const src = s.source || {};
      reservedVentaPublico += src.ventaPublico || 0;
      reservedGeneral += src.general || 0;
    });
  });

  return {
    total: Math.max(0, totalStock - reservedTotal),
    ventaPublico: Math.max(0, ventaPublicoStock - reservedVentaPublico),
    general: Math.max(0, generalStock - reservedGeneral)
  };
}

// Sistema de cola para procesar múltiples QR seguidos
function addToQrQueue(qrCode) {
  // Limpiar el input inmediatamente para permitir siguiente escaneo
  skuSearch.value = "";
  
  // Agregar a la cola
  qrProcessingQueue.push(qrCode);
  
  // Iniciar procesamiento si no está en proceso
  if (!isProcessingQr) {
    processQrQueue();
  }
}

// Procesar cola de QR
async function processQrQueue() {
  if (qrProcessingQueue.length === 0) {
    isProcessingQr = false;
    return;
  }
  
  isProcessingQr = true;
  const qrCode = qrProcessingQueue.shift();
  
  try {
    await processQrCodeFast(qrCode);
  } catch (error) {
    console.error("Error procesando QR:", error);
    showMessage(`Error al procesar código QR ${qrCode}: ${error.message}`, "error");
  }
  
  // Procesar siguiente en la cola (sin await para no bloquear)
  setTimeout(() => {
    processQrQueue();
  }, 0);
}

// Función optimizada para procesar QR code rápidamente
async function processQrCodeFast(qrCode) {
  // Consulta única optimizada que incluye todo lo necesario
  const { data: sizeData, error: sizeError } = await supabase
    .from("variant_sizes")
    .select(`
      variant_id,
      size,
      sku,
      qr_code,
      product_variants!inner (
        id,
        sku,
        color,
        price,
        active,
        products!inner (
          id,
          name,
          category,
          status
        )
      )
    `)
    .eq("qr_code", qrCode)
    .eq("product_variants.active", true)
    .in("product_variants.products.status", ["active", "pending_stock", "draft"])
    .maybeSingle();
  
  if (!sizeData || !sizeData.product_variants) {
    showMessage(`No se encontró el producto con el código QR "${qrCode}"`, "error");
    return;
  }
  
  const variant = {
    ...sizeData.product_variants,
    size: sizeData.size,
  };
  
  // Obtener warehouses (con cache) y stock en paralelo
  const [warehouses, stockData] = await Promise.all([
    getWarehousesCached(),
    getVariantSizeStockByWarehouse(variant.id, variant.size)
  ]);
  
  const totalStock = stockData.total;
  
  if (totalStock === 0 && !returnMode.checked) {
    // Sin stock: permitir confirmar y agregar igual (útil para mal conteo o venta excepcional).
    const modal = document.getElementById("no-stock-confirm-modal");
    const confirmYes = document.getElementById("no-stock-confirm-yes");
    const confirmNo = document.getElementById("no-stock-confirm-no");

    if (!modal || !confirmYes || !confirmNo) {
      showMessage(`⚠️ No hay stock disponible para el código QR ${qrCode}`, "error");
      return;
    }

    modal.classList.add("active");

    const userConfirmed = await new Promise((resolve) => {
      const handleYes = () => {
        modal.classList.remove("active");
        confirmYes.removeEventListener("click", handleYes);
        confirmNo.removeEventListener("click", handleNo);
        resolve(true);
      };
      const handleNo = () => {
        modal.classList.remove("active");
        confirmYes.removeEventListener("click", handleYes);
        confirmNo.removeEventListener("click", handleNo);
        resolve(false);
      };
      confirmYes.addEventListener("click", handleYes);
      confirmNo.addEventListener("click", handleNo);
    });

    if (!userConfirmed) return;
    // Continuar: se agregará con source 0,0 (marca "confirmado sin stock")
  }
  
  // Obtener stock del talle específico usando solo variant_size_warehouse_stock
  let sizeStock = { general: { stock: 0 }, ventaPublico: { stock: 0 }, total: 0 };
  const normalizedSize = normalizeSize(variant.size);
  
  // Luego obtener stock desde variant_size_warehouse_stock (DISTRIBUCIÓN POR WAREHOUSE)
  if (warehouses.generalId && warehouses.ventaPublicoId) {
    // Cargar todos los registros de stock para esta variante y normalizar después
    // Esto evita problemas de comparación si el tamaño está almacenado de diferentes formas
    const { data: sizeWarehouseStocks } = await supabase
      .from("variant_size_warehouse_stock")
      .select("size, warehouse_id, stock_qty")
      .eq("variant_id", variant.id)
      .in("warehouse_id", [warehouses.generalId, warehouses.ventaPublicoId]);
    
    if (sizeWarehouseStocks) {
      // Filtrar por tamaño normalizado después de obtener los datos
      sizeWarehouseStocks.forEach(sws => {
        const swsNormalizedSize = normalizeSize(sws.size);
        if (swsNormalizedSize !== normalizedSize) return; // Saltar si no coincide después de normalizar
        
        if (sws.warehouse_id === warehouses.generalId) {
          sizeStock.general.stock += sws.stock_qty || 0;
        } else if (sws.warehouse_id === warehouses.ventaPublicoId) {
          sizeStock.ventaPublico.stock += sws.stock_qty || 0;
        }
      });
      sizeStock.total = sizeStock.general.stock + sizeStock.ventaPublico.stock;
    }
  }
  
  // Plan 2: no usar variant_sizes como fallback operativo por talle.
  
  // Si hay stock (o fue confirmado sin stock), agregar automáticamente a la venta
  if (sizeStock.total > 0 || returnMode.checked || totalStock === 0) {
    const isReturn = returnMode.checked;
    const quantity = 1;
    
    // Buscar si ya existe este producto/color con el mismo tipo
    const existingIndex = saleItems.findIndex(item =>
      item.productId === variant.products.id &&
      item.color === variant.color &&
      item.isReturn === isReturn
    );
    
    // Obtener fuente del stock (priorizar venta-publico, si no hay usar general)
    // Caso confirmado sin stock: source 0,0 para que finalize/validaciones lo traten como excepción aceptada.
    let source = { ventaPublico: 0, general: 0 };
    if (totalStock !== 0 || returnMode.checked) {
      let ventaPublicoQty = Math.min(quantity, sizeStock.ventaPublico.stock);
      let generalQty = 0;
      if (ventaPublicoQty < quantity) {
        const neededFromGeneral = quantity - ventaPublicoQty;
        generalQty = Math.min(neededFromGeneral, sizeStock.general.stock);
      }
      source = { ventaPublico: ventaPublicoQty, general: generalQty };
    }
    
    // Usar precio directamente de la variante (sin cargar todas las variantes)
    const effectivePrice = variant.price; // Precio base, se puede mejorar después con ofertas
    const basePrice = variant.price;
    const itemTotalValue = isReturn ? -(effectivePrice * quantity) : (effectivePrice * quantity);
    
    if (existingIndex >= 0) {
      // Agregar talle a item existente
      const existingSize = saleItems[existingIndex].sizes.find(s => s.size === variant.size);
      if (existingSize) {
        existingSize.quantity += quantity;
        existingSize.source = {
          ventaPublico: (existingSize.source?.ventaPublico || 0) + source.ventaPublico,
          general: (existingSize.source?.general || 0) + source.general
        };
      } else {
        saleItems[existingIndex].sizes.push({
          size: variant.size,
          quantity,
          variantId: variant.id,
          source: { ventaPublico: source.ventaPublico, general: source.general }
        });
      }
      saleItems[existingIndex].totalQuantity += quantity;
      
      // Actualizar totalValue
      if (isReturn) {
        saleItems[existingIndex].totalValue -= effectivePrice * quantity;
      } else {
        saleItems[existingIndex].totalValue += effectivePrice * quantity;
      }
    } else {
      // Crear nuevo item
      saleItems.push({
        productId: variant.products.id,
        productName: variant.products.name,
        sku: variant.sku.split('-')[0],
        color: variant.color,
        price: effectivePrice,
        basePrice: basePrice,
        offerInfo: null, // Se puede mejorar después
        promotionInfo: null, // Se puede mejorar después
        sizes: [{
          size: variant.size,
          quantity,
          variantId: variant.id,
          source: { ventaPublico: source.ventaPublico, general: source.general }
        }],
        totalQuantity: quantity,
        totalValue: itemTotalValue,
        isReturn: isReturn
      });
    }
    
    // Actualizar UI de forma optimizada (con debounce)
    scheduleUIUpdate();
    
    // Refocar en el input SKU inmediatamente para siguiente lectura
    requestAnimationFrame(() => {
      skuSearch.focus();
    });
  } else {
    showMessage(`⚠️ No hay stock disponible para el código QR ${qrCode}`, "error");
  }
}

// Función para programar actualización de UI con debounce
function scheduleUIUpdate() {
  clearTimeout(renderDebounceTimeout);
  clearTimeout(calculateTotalsDebounceTimeout);
  
  renderDebounceTimeout = setTimeout(() => {
    requestAnimationFrame(() => {
      renderSaleList();
    });
  }, 50);
  
  calculateTotalsDebounceTimeout = setTimeout(() => {
    requestAnimationFrame(async () => {
      await calculateTotals();
      updateSaveOrderButtonVisibility();
    });
  }, 100);
}

// Función helper para procesar variante encontrada por código QR (versión original para compatibilidad)
// NOTA: Esta función se mantiene para compatibilidad, pero el flujo optimizado usa processQrCodeFast
async function processVariantFoundByQrCode(variant) {
  try {
    // Si tenemos el tamaño, usar el proceso optimizado (similar a processQrCodeFast)
    if (variant.size) {
      // Obtener warehouses y stock en paralelo
      const [warehouses, stockData] = await Promise.all([
        getWarehousesCached(),
        getVariantStock(variant.id)
      ]);
      
      const totalStock = stockData.total;

      if (totalStock === 0 && !returnMode.checked) {
        showMessage(`⚠️ Advertencia: No hay stock disponible. Stock en General: ${stockData.general.stock}, Stock en Venta Público: ${stockData.ventaPublico.stock}`, "error");
        return;
      }

      // NO cargar todas las variantes - usar datos directos
      // Establecer currentProduct para compatibilidad
      currentProduct = variant.products;
      
      // Obtener stock del talle específico usando solo variant_size_warehouse_stock
      let sizeStock = { general: { stock: 0 }, ventaPublico: { stock: 0 }, total: 0 };
      const normalizedSize = normalizeSize(variant.size);
      
      // Luego obtener stock desde variant_size_warehouse_stock (DISTRIBUCIÓN POR WAREHOUSE)
      if (warehouses.generalId && warehouses.ventaPublicoId) {
        // Cargar todos los registros de stock para esta variante y normalizar después
        const { data: sizeWarehouseStocks } = await supabase
          .from("variant_size_warehouse_stock")
          .select("size, warehouse_id, stock_qty")
          .eq("variant_id", variant.id)
          .in("warehouse_id", [warehouses.generalId, warehouses.ventaPublicoId]);
        
        if (sizeWarehouseStocks) {
          // Filtrar por tamaño normalizado después de obtener los datos
          sizeWarehouseStocks.forEach(sws => {
            const swsNormalizedSize = normalizeSize(sws.size);
            if (swsNormalizedSize !== normalizedSize) return; // Saltar si no coincide después de normalizar
            
            if (sws.warehouse_id === warehouses.generalId) {
              sizeStock.general.stock += sws.stock_qty || 0;
            } else if (sws.warehouse_id === warehouses.ventaPublicoId) {
              sizeStock.ventaPublico.stock += sws.stock_qty || 0;
            }
          });
          sizeStock.total = sizeStock.general.stock + sizeStock.ventaPublico.stock;
        }
      }
      
      // Plan 2: no usar variant_sizes como fallback operativo por talle.
      
      // Si hay stock, agregar automáticamente a la venta
      if (sizeStock.total > 0 || returnMode.checked) {
        const isReturn = returnMode.checked;
        const quantity = 1;
        
        const existingIndex = saleItems.findIndex(item =>
          item.productId === variant.products.id &&
          item.color === variant.color &&
          item.isReturn === isReturn
        );
        
        // Obtener fuente del stock
        let ventaPublicoQty = Math.min(quantity, sizeStock.ventaPublico.stock);
        let generalQty = 0;
        
        if (ventaPublicoQty < quantity) {
          const neededFromGeneral = quantity - ventaPublicoQty;
          generalQty = Math.min(neededFromGeneral, sizeStock.general.stock);
        }
        
        const source = {
          ventaPublico: ventaPublicoQty,
          general: generalQty
        };
        
        const effectivePrice = variant.price;
        const basePrice = variant.price;
        const itemTotalValue = isReturn ? -(effectivePrice * quantity) : (effectivePrice * quantity);
        
        if (existingIndex >= 0) {
          const existingSize = saleItems[existingIndex].sizes.find(s => s.size === variant.size);
          if (existingSize) {
            existingSize.quantity += quantity;
            existingSize.source = {
              ventaPublico: (existingSize.source?.ventaPublico || 0) + source.ventaPublico,
              general: (existingSize.source?.general || 0) + source.general
            };
          } else {
            saleItems[existingIndex].sizes.push({
              size: variant.size,
              quantity,
              variantId: variant.id,
              source: { ventaPublico: source.ventaPublico, general: source.general }
            });
          }
          saleItems[existingIndex].totalQuantity += quantity;
          
          if (isReturn) {
            saleItems[existingIndex].totalValue -= effectivePrice * quantity;
          } else {
            saleItems[existingIndex].totalValue += effectivePrice * quantity;
          }
        } else {
          saleItems.push({
            productId: variant.products.id,
            productName: variant.products.name,
            sku: variant.sku.split('-')[0],
            color: variant.color,
            price: effectivePrice,
            basePrice: basePrice,
            offerInfo: null,
            promotionInfo: null,
            sizes: [{
              size: variant.size,
              quantity,
              variantId: variant.id,
              source: { ventaPublico: source.ventaPublico, general: source.general }
            }],
            totalQuantity: quantity,
            totalValue: itemTotalValue,
            isReturn: isReturn
          });
        }
        
        // Actualizar UI de forma optimizada
        scheduleUIUpdate();
        
        // Refocar en el input SKU
        requestAnimationFrame(() => {
          skuSearch.focus();
        });
        
        return;
      }
    }
    
    // Si no tiene tamaño o no hay stock, cargar variantes normalmente (fallback)
    await loadProductVariants(variant.products.id);
    
    if (totalStock > 0 && !returnMode.checked) {
      selectedColor = variant.color;
      if (variant.size) {
        selectedSizes[variant.size] = 1;
      }
      renderColorButtons();
      renderSizeButtons();
      updateLoadButton();
    }
    
    skuSearch.value = "";
  } catch (error) {
    console.error("Error procesando variante encontrada:", error);
    showMessage("Error al procesar producto: " + error.message, "error");
    skuSearch.value = "";
  }
}

// Buscar por SKU
async function searchBySku(sku) {
  try {
    // Limpiar y normalizar el SKU
    sku = sku.trim();
    if (!sku) {
      showMessage("Por favor ingrese un SKU válido", "error");
      return;
    }
    
    // Si el input es numérico, buscar directamente por qr_code (más rápido y confiable)
    if (/^\d+$/.test(sku)) {
      console.log("Buscando por código QR numérico:", sku);
      
      const { data: sizeData, error: sizeError } = await supabase
        .from("variant_sizes")
        .select(`
          variant_id,
          size,
          sku,
          qr_code,
          product_variants!inner (
            id,
            sku,
            color,
            price,
            active,
            products!inner (
              id,
              name,
              category,
              status
            )
          )
        `)
        .eq("qr_code", sku)
        .eq("product_variants.active", true)
        .in("product_variants.products.status", ["active", "pending_stock", "draft"])
        .maybeSingle();
      
      if (sizeData && sizeData.product_variants) {
        console.log("✅ Producto encontrado por código QR:", sizeData);
        // Usar el sistema de cola optimizado para procesamiento rápido
        addToQrQueue(sku);
        return;
      } else {
        showMessage(`No se encontró el producto con el código QR "${sku}"`, "error");
        return;
      }
    }
    
    // Si no es numérico, buscar por SKU (comportamiento original)
    // Generar todas las variantes posibles del SKU para buscar
    // El QR puede generar: GI'TEVA'NEG'35-36
    // La base de datos puede tener: GI-TEVA-NEG-35/36, GI-TEVA-NEG-35-36, etc.
    function generateSkuVariants(originalSku) {
      const variants = new Set();
      
      // Agregar el SKU original
      variants.add(originalSku.trim());
      
      // Variante 1: Reemplazar comillas simples por guiones
      let variant1 = originalSku.replace(/'/g, '-').replace(/\s+/g, '');
      variants.add(variant1);
      
      // Variante 2: Reemplazar comillas simples por guiones y normalizar tamaño con barra
      const parts1 = variant1.split('-');
      if (parts1.length > 0) {
        const lastPart = parts1[parts1.length - 1];
        if (/^\d+[-\/]\d+$/.test(lastPart)) {
          const sizeParts = lastPart.split(/[-\/]/);
          if (sizeParts.length === 2) {
            // Variante con barra diagonal
            parts1[parts1.length - 1] = `${sizeParts[0]}/${sizeParts[1]}`;
            variants.add(parts1.join('-'));
            // Variante con guión
            parts1[parts1.length - 1] = `${sizeParts[0]}-${sizeParts[1]}`;
            variants.add(parts1.join('-'));
          }
        }
      }
      
      // Variante 3: Si el SKU original tiene guiones, también probar con comillas
      if (originalSku.includes('-')) {
        const variant3 = originalSku.replace(/-/g, "'").replace(/\s+/g, '');
        variants.add(variant3);
      }
      
      return Array.from(variants);
    }
    
    const skuVariants = generateSkuVariants(sku);
    console.log("SKU original:", sku);
    console.log("Variantes de SKU a probar:", skuVariants);
    console.log("SKU length:", sku.length);
    console.log("SKU charCodes:", Array.from(sku).map(c => c.charCodeAt(0)));
    
    // Primero intentar buscar por SKU base en product_variants
    let variant = null;
    let error = null;
    let errorBase = null;
    let sizeError = null;
    
    // Intentar búsqueda exacta en variant_sizes probando todas las variantes
    let sizeData = null;
    let sizeErrorQuery = null;
    
    for (const skuVariant of skuVariants) {
      console.log(`Intentando buscar con variante: "${skuVariant}"`);
      const { data: sizeDataResult, error: sizeErrorResult } = await supabase
        .from("variant_sizes")
        .select(`
          variant_id,
          size,
          sku,
          qr_code,
          product_variants!inner (
            id,
            sku,
            color,
            price,
            active,
            products!inner (
              id,
              name,
              category,
              status
            )
          )
        `)
        .eq("sku", skuVariant)
        .eq("product_variants.active", true)
        .in("product_variants.products.status", ["active", "pending_stock", "draft"])
        .maybeSingle();
      
      if (sizeDataResult && sizeDataResult.product_variants) {
        console.log(`✅ Encontrado con variante: "${skuVariant}"`);
        sizeData = sizeDataResult;
        sizeErrorQuery = sizeErrorResult;
        break; // Salir del loop si encontramos el producto
      } else {
        console.log(`❌ No encontrado con variante: "${skuVariant}"`);
        if (!sizeErrorQuery && sizeErrorResult) {
          sizeErrorQuery = sizeErrorResult;
        }
      }
    }
    
    sizeError = sizeErrorQuery;
    console.log("Búsqueda en variant_sizes:", { sizeData: sizeData ? "encontrado" : "no encontrado", error: sizeError });

    if (sizeData && sizeData.product_variants) {
      // IMPORTANTE: Normalizar el tamaño antes de usarlo
      const normalizedSize = normalizeSize(sizeData.size);
      variant = {
        ...sizeData.product_variants,
        size: normalizedSize, // Usar tamaño normalizado
      };
      console.log("✅ Variante encontrada en variant_sizes:", variant);
    } else {
      // Si no se encuentra en variant_sizes, buscar por SKU base en product_variants
      // Extraer el SKU base (sin el tamaño) de todas las variantes
      const baseSkuVariants = new Set();
      skuVariants.forEach(variant => {
        // Remover el último segmento que debería ser el tamaño (formato: XX-YY o XX/YY)
        const parts = variant.split(/[-']/);
        if (parts.length > 1) {
          const lastPart = parts[parts.length - 1];
          // Si el último segmento parece un tamaño (dos números separados por - o /)
          if (/^\d+[-\/]\d+$/.test(lastPart)) {
            // Es un tamaño, removerlo
            baseSkuVariants.add(parts.slice(0, -1).join('-'));
          } else {
            // No es un tamaño, usar toda la variante
            baseSkuVariants.add(variant.replace(/[']/g, '-'));
          }
        } else {
          baseSkuVariants.add(variant.replace(/[']/g, '-'));
        }
      });
      
      console.log("Buscando SKU base en product_variants con variantes:", Array.from(baseSkuVariants));
      
      let variantByBase = null;
      errorBase = null;
      
      for (const baseSku of baseSkuVariants) {
        console.log(`Intentando buscar SKU base: "${baseSku}"`);
        const { data: variantResult, error: errorResult } = await supabase
          .from("product_variants")
          .select(`
            id,
            sku,
            color,
            price,
            active,
            products!inner (
              id,
              name,
              category,
              status
            )
          `)
          .eq("sku", baseSku)
          .eq("active", true)
          .in("products.status", ["active", "pending_stock", "draft"])
          .maybeSingle();

        if (variantResult) {
          console.log(`✅ SKU base encontrado: "${baseSku}"`);
          variantByBase = variantResult;
          errorBase = errorResult;
          break;
        } else {
          if (!errorBase && errorResult) {
            errorBase = errorResult;
          }
        }
      }

      console.log("Búsqueda en product_variants:", { variantByBase: variantByBase ? "encontrado" : "no encontrado", error: errorBase });

      if (variantByBase) {
        variant = variantByBase;
        console.log("✅ Variante encontrada en product_variants:", variant);
      } else {
        // Si hay error pero no es "no encontrado", lanzarlo
        if (sizeError && sizeError.code !== 'PGRST116') {
          error = sizeError;
        } else if (errorBase && errorBase.code !== 'PGRST116') {
          error = errorBase;
        } else {
          // Si ambos son "no encontrado", no hay error, simplemente no se encontró
          error = null;
        }
      }
    }

    if (error) {
      if (error.code === 'PGRST116') {
        showMessage("No se encontró el producto con ese SKU", "error");
      } else {
        throw error;
      }
      return;
    }

    if (!variant) {
      console.log("SKU buscado:", sku);
      console.log("Error base:", errorBase);
      console.log("Error size:", sizeError);
      
      // Intentar búsqueda alternativa más flexible (case-insensitive) con todas las variantes
      console.log("Intentando búsqueda alternativa (case-insensitive) con todas las variantes...");
      let sizeDataAlt = null;
      let sizeErrorAlt = null;
      
      for (const skuVariant of skuVariants) {
        const skuClean = skuVariant.trim().replace(/\s+/g, '');
        console.log(`Intentando búsqueda alternativa con variante: "${skuClean}"`);
        
        const { data: sizeDataResult, error: sizeErrorResult } = await supabase
          .from("variant_sizes")
          .select(`
            variant_id,
            size,
            sku,
            qr_code,
            product_variants!inner (
              id,
              sku,
              color,
              price,
              active,
              products!inner (
                id,
                name,
                category,
                status
              )
            )
          `)
          .ilike("sku", skuClean)
          .eq("product_variants.active", true)
          .in("product_variants.products.status", ["active", "pending_stock", "draft"])
          .maybeSingle();
        
        if (sizeDataResult && sizeDataResult.product_variants) {
          console.log(`✅ Encontrado con búsqueda alternativa y variante: "${skuClean}"`);
          sizeDataAlt = sizeDataResult;
          sizeErrorAlt = sizeErrorResult;
          break; // Salir del loop si encontramos el producto
        } else {
          if (!sizeErrorAlt && sizeErrorResult) {
            sizeErrorAlt = sizeErrorResult;
          }
        }
      }
      
      if (sizeDataAlt && sizeDataAlt.product_variants) {
        console.log("✅ Variante encontrada con búsqueda alternativa:", sizeDataAlt);
        // IMPORTANTE: Normalizar el tamaño antes de usarlo
        const normalizedSize = normalizeSize(sizeDataAlt.size);
        variant = {
          ...sizeDataAlt.product_variants,
          size: normalizedSize, // Usar tamaño normalizado
        };
      } else {
        // Intentar buscar SKUs similares para debugging
        // Usar la primera variante para obtener el prefijo
        const firstVariant = skuVariants[0] || sku;
        const skuPrefix = firstVariant.split(/[-']/)[0]; // Tomar la primera parte antes del primer separador
        console.log("Buscando SKUs similares con prefijo:", skuPrefix);
        
        const { data: similarSkus } = await supabase
          .from("variant_sizes")
          .select("sku, size, product_variants!inner(id, sku, color, active, products!inner(id, name, status))")
          .ilike("sku", `${skuPrefix}%`)
          .eq("product_variants.active", true)
          .in("product_variants.products.status", ["active", "pending_stock", "draft"])
          .limit(10);
        
        if (similarSkus && similarSkus.length > 0) {
          console.log("SKUs similares encontrados:", similarSkus.map(s => s.sku));
          showMessage(`No se encontró el producto con el SKU "${sku}".\n\nSKUs similares encontrados:\n${similarSkus.slice(0, 5).map(s => `- ${s.sku}`).join('\n')}\n\nVerifica que el SKU sea correcto.`, "error");
        } else {
          showMessage(`No se encontró el producto con el SKU "${sku}". Verifica que:\n- El SKU sea correcto\n- El producto esté activo\n- La variante tenga el checkbox 'Activa' marcado`, "error");
        }
        return;
      }
    }

    // Verificar stock del SKU específico
    
    const stockData = variant.size
      ? await getVariantSizeStockByWarehouse(variant.id, variant.size)
      : await getVariantStock(variant.id);
    const totalStock = stockData.total;

    if (totalStock === 0 && !returnMode.checked) {
      showMessage(`⚠️ Advertencia: No hay stock disponible para el SKU ${sku}. Stock en General: ${stockData.general.stock}, Stock en Venta Público: ${stockData.ventaPublico.stock}`, "error");
      // Aún así cargar el producto para que pueda agregarlo manualmente si quiere
    }

    // Cargar todas las variantes del producto
    await loadProductVariants(variant.products.id);

    // Si el SKU viene de variant_sizes (tiene talle específico), agregar automáticamente a la venta
    if (variant.size && totalStock > 0 && !returnMode.checked) {
      // Buscar la variante correcta en currentVariants con el talle específico
      const variantWithSize = currentVariants.find(v => 
        v.color === variant.color && normalizeSize(v.size) === normalizeSize(variant.size)
      );

      if (variantWithSize) {
        // Obtener stock del talle específico desde variant_size_warehouse_stock
        const { data: warehouses } = await supabase
          .from("warehouses")
          .select("id, code")
          .in("code", ["general", "venta-publico"]);

        let generalWarehouseId = null;
        let ventaPublicoWarehouseId = null;
        if (warehouses) {
          warehouses.forEach(w => {
            if (w.code === "general") generalWarehouseId = w.id;
            if (w.code === "venta-publico") ventaPublicoWarehouseId = w.id;
          });
        }

        // Obtener stock del talle específico usando solo variant_size_warehouse_stock
        let sizeStock = { general: { stock: 0 }, ventaPublico: { stock: 0 }, total: 0 };
        const normalizedSize = normalizeSize(variant.size);
        
        const warehouseIds = [generalWarehouseId, ventaPublicoWarehouseId].filter(Boolean);
        
        // Luego obtener stock desde variant_size_warehouse_stock (DISTRIBUCIÓN POR WAREHOUSE)
        if (warehouseIds.length > 0) {
          // Cargar todos los registros de stock para esta variante y normalizar después
          const { data: sizeWarehouseStocks } = await supabase
            .from("variant_size_warehouse_stock")
            .select("size, warehouse_id, stock_qty")
            .eq("variant_id", variant.id)
            .in("warehouse_id", warehouseIds);

          if (sizeWarehouseStocks) {
            // Filtrar por tamaño normalizado después de obtener los datos
            sizeWarehouseStocks.forEach(sws => {
              const swsNormalizedSize = normalizeSize(sws.size);
              if (swsNormalizedSize !== normalizedSize) return; // Saltar si no coincide después de normalizar
              
              if (sws.warehouse_id === generalWarehouseId) {
                sizeStock.general.stock += sws.stock_qty || 0;
              } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
                sizeStock.ventaPublico.stock += sws.stock_qty || 0;
              }
            });
            sizeStock.total = sizeStock.general.stock + sizeStock.ventaPublico.stock;
          }
        }
        
        // Plan 2: no usar variant_sizes como fallback operativo por talle.

        // Si hay stock, agregar automáticamente a la venta
        if (sizeStock.total > 0) {
          const isReturn = returnMode.checked;
          const quantity = 1; // Agregar 1 unidad por defecto

          // Buscar si ya existe este producto/color con el mismo tipo (devolución o venta) en la lista
          const existingIndex = saleItems.findIndex(item =>
            item.productId === currentProduct.id &&
            item.color === variant.color &&
            item.isReturn === isReturn
          );

          // Obtener fuente del stock para este talle (priorizar venta-publico, si no hay usar general)
          let ventaPublicoQty = Math.min(quantity, sizeStock.ventaPublico.stock);
          let generalQty = 0;
          
          // Si no hay suficiente stock en venta-publico, usar stock de general
          if (ventaPublicoQty < quantity) {
            const neededFromGeneral = quantity - ventaPublicoQty;
            generalQty = Math.min(neededFromGeneral, sizeStock.general.stock);
          }
          
          const source = {
            ventaPublico: ventaPublicoQty,
            general: generalQty
          };

          const effectivePrice = variantWithSize.effectivePrice || variantWithSize.price || variant.price;
          const basePrice = variantWithSize.price || variant.price;
          const itemTotalValue = isReturn ? -(effectivePrice * quantity) : (effectivePrice * quantity);

          if (existingIndex >= 0) {
            // Agregar talle a item existente
            const existingSize = saleItems[existingIndex].sizes.find(s => s.size === variant.size);
            if (existingSize) {
              existingSize.quantity += quantity;
              existingSize.source = {
                ventaPublico: (existingSize.source?.ventaPublico || 0) + source.ventaPublico,
                general: (existingSize.source?.general || 0) + source.general
              };
            } else {
              saleItems[existingIndex].sizes.push({
                size: variant.size,
                quantity,
                variantId: variant.id,
                source: { ventaPublico: source.ventaPublico, general: source.general }
              });
            }
            saleItems[existingIndex].totalQuantity += quantity;

            // Actualizar información de oferta/promoción y precio base si no existe
            if (!saleItems[existingIndex].basePrice) {
              saleItems[existingIndex].basePrice = basePrice;
            }
            if (!saleItems[existingIndex].offerInfo && variantWithSize.offerInfo) {
              saleItems[existingIndex].offerInfo = variantWithSize.offerInfo;
            }
            if (!saleItems[existingIndex].promotionInfo && variantWithSize.promotionInfo) {
              saleItems[existingIndex].promotionInfo = variantWithSize.promotionInfo;
            }

            // Actualizar totalValue
            if (isReturn) {
              saleItems[existingIndex].totalValue -= effectivePrice * quantity;
            } else {
              saleItems[existingIndex].totalValue += effectivePrice * quantity;
            }
          } else {
            // Crear nuevo item
            saleItems.push({
              productId: currentProduct.id,
              productName: currentProduct.name,
              sku: variant.sku.split('-')[0], // SKU base
              color: variant.color,
              price: effectivePrice,
              basePrice: basePrice,
              offerInfo: variantWithSize.offerInfo || null,
              promotionInfo: variantWithSize.promotionInfo || null,
              sizes: [{
                size: variant.size,
                quantity,
                variantId: variant.id,
                source: { ventaPublico: source.ventaPublico, general: source.general }
              }],
              totalQuantity: quantity,
              totalValue: itemTotalValue,
              isReturn: isReturn
            });
          }

          // Actualizar UI
          renderSaleList();
          await calculateTotals();
          updateSaveOrderButtonVisibility();

          // Mostrar mensaje de confirmación
          showMessage(`✅ Producto agregado: ${currentProduct.name} - ${variant.color} - Talle ${variant.size}`, "success");

          // Limpiar input SKU y ocultar selección de producto
          skuSearch.value = "";
          productSelection.classList.remove("active");

          // Refocar en el input SKU para siguiente lectura
          setTimeout(() => {
            skuSearch.focus();
          }, 50);

          return; // Salir de la función ya que el producto fue agregado automáticamente
        }
      }
    }

    // Si el SKU tiene stock y no está en modo devoluciones, seleccionar automáticamente color y talle
    if (totalStock > 0 && !returnMode.checked) {
      // Seleccionar el color del SKU encontrado
      selectedColor = variant.color;
      
      // Si el SKU incluye un talle (viene de variant_sizes), seleccionarlo
      if (variant.size) {
      selectedSizes[variant.size] = 1;
      }
      
      renderColorButtons();
      renderSizeButtons();
      updateLoadButton();
    }

    // Limpiar input SKU después de buscar exitosamente (listo para siguiente código)
    skuSearch.value = "";
  } catch (error) {
    console.error("Error buscando por SKU:", error);
    showMessage("Error al buscar producto: " + error.message, "error");
    // Limpiar input incluso si hay error para facilitar siguiente búsqueda
    skuSearch.value = "";
  }
}

// Cargar variantes del producto
async function loadProductVariants(productId) {
  try {
    // Cargar variantes (sin size, ya que los talles están en variant_sizes)
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
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
      .in("products.status", ["active", "pending_stock", "draft"]); // Incluir productos activos, con stock pendiente y en borrador

    if (error) throw error;

    if (!variants || variants.length === 0) {
      showMessage("No se encontraron variantes activas para este producto. Verifica que el producto esté activo y las variantes tengan el checkbox 'Activa' marcado.", "error");
      return;
    }

    // Cargar talles desde variant_sizes para cada variante
    const variantIds = variants.map(v => v.id);
    const { data: sizesData, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("variant_id, size, stock_qty, sku")
      .in("variant_id", variantIds)
      .order("size");

    // Agrupar talles por variant_id
    // IMPORTANTE: Normalizar los tamaños al cargarlos desde variant_sizes para asegurar consistencia
    const sizesByVariant = new Map();
    if (sizesData) {
      sizesData.forEach(sizeRow => {
        if (!sizesByVariant.has(sizeRow.variant_id)) {
          sizesByVariant.set(sizeRow.variant_id, []);
        }
        // Normalizar el tamaño antes de guardarlo
        const normalizedSize = normalizeSize(sizeRow.size);
        if (normalizedSize) {
          sizesByVariant.get(sizeRow.variant_id).push({
            size: normalizedSize, // Guardar tamaño normalizado
            stock_qty: sizeRow.stock_qty || 0,
            sku: sizeRow.sku,
          });
        }
      });
    }

    // Agregar talles a cada variante y crear variantes "virtuales" por cada talle
    const variantsWithSizes = [];
    variants.forEach(variant => {
      const sizes = sizesByVariant.get(variant.id) || [];
      if (sizes.length > 0) {
        // Crear una variante virtual por cada talle
        sizes.forEach(sizeData => {
          variantsWithSizes.push({
            ...variant,
            size: sizeData.size, // Ya está normalizado desde sizesByVariant
            sizeSku: sizeData.sku, // SKU completo con talle
            qr_code: sizeData.qr_code, // Código QR numérico único
            stock_qty: sizeData.stock_qty, // Stock del talle desde variant_sizes
          });
        });
      } else {
        // Si no tiene talles, agregar la variante sin size (modo legacy)
        variantsWithSizes.push({
          ...variant,
          size: null,
        });
      }
    });

    currentProduct = variants[0].products;
    currentVariants = variantsWithSizes;

    // Mostrar información básica inmediatamente (sin esperar datos adicionales)
    productName.textContent = currentProduct.name;
    const firstVariant = currentVariants[0];
    productPrice.textContent = `$${firstVariant.price.toLocaleString('es-AR')}`;
    productSelection.classList.add("active");

    // Renderizar colores inmediatamente con precios base
    renderColorButtons();

    // Obtener stock, precios efectivos e información de ofertas/promociones para cada variante EN PARALELO
    const variantPromises = currentVariants.map(async (variant) => {
      // Ejecutar datos de precio/promoción en paralelo; stock se resuelve por nivel correcto.
      const [effectivePrice, offerInfo, promotionInfo] = await Promise.all([
        getEffectivePrice(variant.id),
        getOfferInfo(variant.id, currentProduct.id, variant.color),
        getPromotionInfo(variant.id)
      ]);

      variant.stockData = variant.size
        ? await getVariantSizeStockByWarehouse(variant.id, variant.size)
        : await getVariantStock(variant.id);
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


    // AHORA TAMBIÉN CONSULTAR variant_size_warehouse_stock para obtener stock por talle
    const { data: warehouses } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);


    if (warehouses && warehouses.length > 0) {
      const warehouseMap = new Map();
      warehouses.forEach(w => warehouseMap.set(w.code, w.id));
      const generalWarehouseId = warehouseMap.get("general");
      const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");


      // Consultar stock por talle desde variant_size_warehouse_stock
      // IMPORTANTE: Cargar todos los registros y normalizar después para evitar problemas de comparación
      const { data: sizeWarehouseStocks, error: sizeError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", variantId)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId].filter(Boolean));


      if (!sizeError && sizeWarehouseStocks && sizeWarehouseStocks.length > 0) {
        // Sumar stock por warehouse desde variant_size_warehouse_stock
        // IMPORTANTE: Normalizar los tamaños para evitar problemas de comparación
        let generalStock = 0;
        let ventaPublicoStock = 0;
        
        sizeWarehouseStocks.forEach(sws => {
          // Normalizar el tamaño antes de procesarlo
          const normalizedSize = normalizeSize(sws.size);
          if (!normalizedSize) return; // Saltar tamaños vacíos
          
          if (sws.warehouse_id === generalWarehouseId) {
            generalStock += sws.stock_qty || 0;
          } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
            ventaPublicoStock += sws.stock_qty || 0;
          }
        });

        const sizeTotal = generalStock + ventaPublicoStock;


        // Usar el stock de variant_size_warehouse_stock si es mayor que el de variant_warehouse_stock
        if (sizeTotal > total) {
          return {
            general: { stock: generalStock },
            ventaPublico: { stock: ventaPublicoStock },
            total: sizeTotal
          };
        }
      }
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

async function getVariantSizeStockByWarehouse(variantId, size) {
  const normalizedSize = normalizeSize(size);
  if (!variantId || !normalizedSize) {
    return { general: { stock: 0 }, ventaPublico: { stock: 0 }, total: 0 };
  }

  try {
    const wh = await getWarehousesCached();
    const warehouseIds = [wh?.generalId, wh?.ventaPublicoId].filter(Boolean);
    let generalStock = 0;
    let ventaPublicoStock = 0;

    if (warehouseIds.length > 0) {
      const { data: rows, error } = await supabase
        .from("variant_size_warehouse_stock")
        .select("size, warehouse_id, stock_qty")
        .eq("variant_id", variantId)
        .in("warehouse_id", warehouseIds);
      if (error) throw error;

      (rows || []).forEach((row) => {
        if (normalizeSize(row.size) !== normalizedSize) return;
        const qty = row.stock_qty || 0;
        if (row.warehouse_id === wh.ventaPublicoId) ventaPublicoStock += qty;
        else if (row.warehouse_id === wh.generalId) generalStock += qty;
      });
    }

    return {
      general: { stock: generalStock },
      ventaPublico: { stock: ventaPublicoStock },
      total: generalStock + ventaPublicoStock
    };
  } catch (error) {
    console.error("Error obteniendo stock por talle:", error);
    return { general: { stock: 0 }, ventaPublico: { stock: 0 }, total: 0 };
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
async function renderSizeButtons() {
  // Incrementar versión para cancelar renderizados anteriores
  const currentVersion = ++renderSizeButtonsVersion;
  
  if (!selectedColor) return;

  const variantsByColor = currentVariants.filter(v => v.color === selectedColor);
  const sizes = [...new Set(variantsByColor.map(v => v.size).filter(Boolean))].sort((a, b) => {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return numA - numB;
  });

  // Verificar versión antes de modificar DOM
  if (currentVersion !== renderSizeButtonsVersion) return;
  sizeButtons.innerHTML = "";

  // Obtener warehouses una sola vez
  const { data: warehouses } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  const warehouseMap = new Map();
  let generalWarehouseId = null;
  let ventaPublicoWarehouseId = null;
  
  if (warehouses && warehouses.length > 0) {
    warehouses.forEach(w => warehouseMap.set(w.code, w.id));
    generalWarehouseId = warehouseMap.get("general");
    ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  }

  // Obtener todos los stocks por talle de una vez
  // IMPORTANTE: Normalizar todos los tamaños antes de consultar para asegurar consistencia
  const variantIds = variantsByColor.map(v => v.id).filter(Boolean);
  const normalizedSizes = sizes.map(s => normalizeSize(s)).filter(Boolean);
  
  const sizeStockMap = new Map(); // key: `${variantId}_${normalizedSize}`, value: { general, ventaPublico, total }
  
  if (variantIds.length > 0 && normalizedSizes.length > 0 && generalWarehouseId && ventaPublicoWarehouseId) {
    // Consultar stock por talle desde variant_size_warehouse_stock para todos los talles
    // IMPORTANTE: Cargar todos los registros de las variantes y normalizar después para evitar problemas de comparación
    const { data: sizeWarehouseStocks, error: sizeError } = await supabase
      .from("variant_size_warehouse_stock")
      .select("variant_id, size, warehouse_id, stock_qty")
      .in("variant_id", variantIds)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
    
    if (!sizeError && sizeWarehouseStocks && sizeWarehouseStocks.length > 0) {
      // IMPORTANTE: Normalizar los tamaños al crear las claves del mapa
      sizeWarehouseStocks.forEach(sws => {
        const normalizedSize = normalizeSize(sws.size);
        if (!normalizedSize) return; // Saltar tamaños vacíos
        
        // Filtrar solo los tamaños que están en la lista de sizes normalizados (ya calculada arriba)
        if (!normalizedSizes.includes(normalizedSize)) return; // Saltar si no está en la lista
        
        const key = `${sws.variant_id}_${normalizedSize}`;
        if (!sizeStockMap.has(key)) {
          sizeStockMap.set(key, { general: 0, ventaPublico: 0, total: 0 });
        }
        const stock = sizeStockMap.get(key);
        
        
        // IMPORTANTE: Si ya existe un valor, NO sumar, REEMPLAZAR
        // (cada variante+talle+warehouse debería tener solo un registro)
        if (sws.warehouse_id === generalWarehouseId) {
          stock.general = sws.stock_qty || 0;
        } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
          stock.ventaPublico = sws.stock_qty || 0;
        }
        stock.total = stock.general + stock.ventaPublico;
        
      });
    }
  }

  // Verificar versión después de consultas async
  if (currentVersion !== renderSizeButtonsVersion) return;

  for (const size of sizes) {
    // IMPORTANTE: Normalizar el tamaño antes de buscar la variante
    const normalizedSize = normalizeSize(size);
    if (!normalizedSize) continue; // Saltar tamaños vacíos
    
    const variant = variantsByColor.find(v => {
      const vNormalizedSize = normalizeSize(v.size);
      return vNormalizedSize === normalizedSize;
    });
    if (!variant) continue;

    // Obtener stock específico del talle desde el mapa usando tamaño normalizado
    const stockKey = `${variant.id}_${normalizedSize}`;
    let totalStock = 0;
    let generalStock = 0;
    let ventaPublicoStock = 0;
    
    if (sizeStockMap.has(stockKey)) {
      const sizeStock = sizeStockMap.get(stockKey);
      generalStock = sizeStock.general || 0;
      ventaPublicoStock = sizeStock.ventaPublico || 0;
      totalStock = sizeStock.total || 0;
    }
    
    // Plan 2: no usar variant_sizes como fallback operativo por talle.

    const btn = document.createElement("button");
    btn.className = "size-btn";
    btn.textContent = size;

    // Calcular cantidad y fuente de stock
    const quantity = selectedSizes[size] || 0;
    const source = selectedSizesSource[size] || { ventaPublico: 0, general: 0 };
    const totalFromSource = source.ventaPublico + source.general;

    // Determinar color del botón según stock disponible y fuente actual
    // IMPORTANTE: Si ya se está usando stock de general, el botón debe ser verde
    if (totalStock === 0) {
      btn.classList.add("size-zero");
    } else if (source.general > 0) {
      // Ya se está usando stock de general, botón verde
      btn.classList.add("size-green");
    } else if (ventaPublicoStock > 0 && source.general === 0) {
      // Hay stock en venta-publico y no se está usando general, botón marrón
      btn.classList.add("size-available");
    } else if (generalStock > 0) {
      // Solo hay stock en general, botón verde
      btn.classList.add("size-green");
    } else {
      btn.classList.add("size-zero");
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
      btn.addEventListener("click", async () => {
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
            // Stock máximo alcanzado: mostrar modal de confirmación
            const modal = document.getElementById("no-stock-confirm-modal");
            const confirmYes = document.getElementById("no-stock-confirm-yes");
            const confirmNo = document.getElementById("no-stock-confirm-no");

            if (!modal || !confirmYes || !confirmNo) {
              showMessage(`Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock})`, "error", 10000);
              return;
            }

            // Actualizar mensaje del modal para stock máximo alcanzado
            const modalMessage = modal.querySelector("p");
            if (modalMessage) {
              modalMessage.textContent = `Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock}). ¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`;
            }

            modal.classList.add("active");

            // Esperar respuesta del usuario
            const userConfirmed = await new Promise((resolve) => {
              const handleYes = () => {
                modal.classList.remove("active");
                // Restaurar mensaje original del modal
                const modalMessage = modal.querySelector("p");
                if (modalMessage) {
                  modalMessage.textContent = "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
                }
                confirmYes.removeEventListener("click", handleYes);
                confirmNo.removeEventListener("click", handleNo);
                resolve(true);
              };

              const handleNo = () => {
                modal.classList.remove("active");
                // Restaurar mensaje original del modal
                const modalMessage = modal.querySelector("p");
                if (modalMessage) {
                  modalMessage.textContent = "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
                }
                confirmYes.removeEventListener("click", handleYes);
                confirmNo.removeEventListener("click", handleNo);
                resolve(false);
              };

              confirmYes.addEventListener("click", handleYes);
              confirmNo.addEventListener("click", handleNo);
            });

            if (userConfirmed) {
              // Agregar talle como si tuviera stock (para casos de mal conteo)
              selectedSizes[size] = currentQty + 1;

              // SIEMPRE resetear a 0,0 cuando se confirma sin stock
              // Esto indica que el usuario aceptó agregar sin descontar de ningún warehouse
              selectedSizesSource[size] = { ventaPublico: 0, general: 0 };

              renderSizeButtons();
              updateLoadButton();
            }
          }
        }
      });
    } else {
      // Botón sin stock: agregar event listener para mostrar confirmación
      btn.addEventListener("click", async () => {
        // Mostrar modal de confirmación
        const modal = document.getElementById("no-stock-confirm-modal");
        const confirmYes = document.getElementById("no-stock-confirm-yes");
        const confirmNo = document.getElementById("no-stock-confirm-no");

        if (!modal || !confirmYes || !confirmNo) {
          console.error("Modal de confirmación sin stock no encontrado");
          return;
        }

        modal.classList.add("active");

        // Esperar respuesta del usuario
        const userConfirmed = await new Promise((resolve) => {
          const handleYes = () => {
            modal.classList.remove("active");
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(true);
          };

          const handleNo = () => {
            modal.classList.remove("active");
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(false);
          };

          confirmYes.addEventListener("click", handleYes);
          confirmNo.addEventListener("click", handleNo);
        });

        if (userConfirmed) {
          // Agregar talle como si tuviera stock (similar a modo devoluciones)
          const currentQty = selectedSizes[size] || 0;
          selectedSizes[size] = currentQty + 1;

          // SIEMPRE resetear a 0,0 cuando se confirma sin stock
          // Esto indica que el usuario aceptó agregar sin descontar de ningún warehouse
          selectedSizesSource[size] = { ventaPublico: 0, general: 0 };

          renderSizeButtons();
          updateLoadButton();
        }
      });
    }

    sizeButtons.appendChild(btn);
  }

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

    const variant = variantsByColor.find(v => normalizeSize(v.size) === normalizeSize(size));
    if (!variant) return;

    // Buscar si ya existe este producto/color con el mismo tipo (devolución o venta) en la lista
    const existingIndex = saleItems.findIndex(item =>
      item.productId === currentProduct.id &&
      item.color === selectedColor &&
      item.isReturn === isReturn
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
  selectedColor = null;
  renderSizeButtons();
  renderSaleList();
  await calculateTotals();

  // Actualizar visibilidad del botón Guardar Pedido
  updateSaveOrderButtonVisibility();

  // Limpiar input SKU, ocultar selección de producto y refocar para siguiente código
  skuSearch.value = "";
  productSelection.classList.remove("active");

  // Refocar en el input SKU para siguiente lectura
  setTimeout(() => {
    skuSearch.focus();
  }, 50);
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
      // Determinar estilo según tipo de extra
      let rowClass = "extra-item";
      let rowStyle = "";
      let nameDisplay = escapeHtml(item.productName);
      
      // Si es extra especial, aplicar estilo distintivo
      if (item.isSpecialExtra) {
        rowStyle = 'style="background: #f3e5f5; border-left: 4px solid #9c27b0;"';
        nameDisplay = `<div style="display: flex; align-items: center; gap: 8px;">
          <span style="background: #9c27b0; color: white; padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: 600;">⭐ EXTRA</span>
          <span>${escapeHtml(item.productName)}</span>
        </div>`;
      }
      
      const valueSign = item.totalValue < 0 ? '-' : '';
      const valueDisplay = Math.abs(item.totalValue);
      const qty = item.totalQuantity ?? 1;

      html += `
        <tr class="${rowClass}" ${rowStyle}>
          <td>-</td>
          <td>${nameDisplay}</td>
          <td>-</td>
          <td>-</td>
          <td>-</td>
          <td>
            <div class="sale-qty-controls" style="justify-content: center;">
              <button type="button" class="sale-qty-btn" onclick="event.stopPropagation(); decreaseExtraQuantity(${originalIndex})" title="Disminuir">−</button>
              <span class="qty">${qty}</span>
              <button type="button" class="sale-qty-btn" onclick="event.stopPropagation(); increaseExtraQuantity(${originalIndex})" title="Aumentar">+</button>
            </div>
          </td>
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

    // Renderizar producto normal (con − y + por talle)
    const sizesHtml = item.sizes.map((s, sizeIndex) => `
      <div class="size-fraction">
        <div class="size">${escapeHtml(s.size)}</div>
        <div class="sale-qty-controls">
          <button type="button" class="sale-qty-btn" onclick="event.stopPropagation(); decreaseSaleItemQuantity(${originalIndex}, ${sizeIndex})" title="Disminuir">−</button>
          <span class="qty">${s.quantity}</span>
          <button type="button" class="sale-qty-btn" onclick="event.stopPropagation(); increaseSaleItemQuantity(${originalIndex}, ${sizeIndex})" title="Aumentar">+</button>
        </div>
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

// Aumentar cantidad de un talle en la lista de venta (con validación de stock)
window.increaseSaleItemQuantity = async function (itemIndex, sizeIndex) {
  const item = saleItems[itemIndex];
  if (!item || !item.sizes || !item.sizes[sizeIndex]) return;
  const sizeEntry = item.sizes[sizeIndex];
  const sign = item.isReturn ? -1 : 1;

  if (item.isReturn) {
    sizeEntry.quantity = (sizeEntry.quantity || 0) + 1;
  } else {
    const available = await getAvailableStockForVariantSizeInSale(sizeEntry.variantId, sizeEntry.size);
    if (available.total >= 1) {
      sizeEntry.quantity = (sizeEntry.quantity || 0) + 1;
      const src = sizeEntry.source || { ventaPublico: 0, general: 0 };
      if (available.ventaPublico >= 1) src.ventaPublico = (src.ventaPublico || 0) + 1;
      else if (available.general >= 1) src.general = (src.general || 0) + 1;
      sizeEntry.source = src;
    } else {
      const modal = document.getElementById("no-stock-confirm-modal");
      const confirmYes = document.getElementById("no-stock-confirm-yes");
      const confirmNo = document.getElementById("no-stock-confirm-no");
      const modalMessage = modal?.querySelector("p");
      const originalText = modalMessage?.textContent || "";
      if (modal && confirmYes && confirmNo && modalMessage) {
        modalMessage.textContent = "No hay stock disponible para este talle. ¿Desea agregarlo de todos modos?";
        modal.classList.add("active");
        const userConfirmed = await new Promise((resolve) => {
          const handleYes = () => {
            modal.classList.remove("active");
            modalMessage.textContent = originalText;
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(true);
          };
          const handleNo = () => {
            modal.classList.remove("active");
            modalMessage.textContent = originalText;
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(false);
          };
          confirmYes.addEventListener("click", handleYes);
          confirmNo.addEventListener("click", handleNo);
        });
        if (userConfirmed) {
          sizeEntry.quantity = (sizeEntry.quantity || 0) + 1;
          sizeEntry.source = { ventaPublico: 0, general: 0 };
        } else return;
      } else {
        showMessage("No hay stock disponible para este talle.", "error");
        return;
      }
    }
  }

  item.totalQuantity = item.sizes.reduce((sum, s) => sum + (s.quantity || 0), 0);
  item.totalValue = item.sizes.reduce((sum, s) => sum + sign * item.price * (s.quantity || 0), 0);
  renderSaleList();
  await calculateTotals();
};

// Disminuir cantidad de un talle en la lista de venta
window.decreaseSaleItemQuantity = async function (itemIndex, sizeIndex) {
  const item = saleItems[itemIndex];
  if (!item || !item.sizes || !item.sizes[sizeIndex]) return;
  const sizeEntry = item.sizes[sizeIndex];
  const sign = item.isReturn ? -1 : 1;

  sizeEntry.quantity = Math.max(0, (sizeEntry.quantity || 0) - 1);
  if (sizeEntry.quantity === 0) {
    item.sizes.splice(sizeIndex, 1);
    if (item.sizes.length === 0) {
      saleItems.splice(itemIndex, 1);
      renderSaleList();
      await calculateTotals();
      updateSaveOrderButtonVisibility();
      return;
    }
  }

  item.totalQuantity = item.sizes.reduce((sum, s) => sum + (s.quantity || 0), 0);
  item.totalValue = item.sizes.reduce((sum, s) => sum + sign * item.price * (s.quantity || 0), 0);
  renderSaleList();
  await calculateTotals();
};

// Aumentar cantidad de un extra (especial, numérico o porcentual)
window.increaseExtraQuantity = async function (itemIndex) {
  const item = saleItems[itemIndex];
  if (!item || !item.isExtra) return;
  item.totalQuantity = (item.totalQuantity || 1) + 1;
  if (item.isSpecialExtra && item.price != null) {
    item.totalValue = item.price * item.totalQuantity;
  } else if (item.extraType === 'numeric' && item.value != null) {
    item.totalValue = item.value * item.totalQuantity;
  }
  renderSaleList();
  await calculateTotals();
};

// Disminuir cantidad de un extra (mínimo 1)
window.decreaseExtraQuantity = async function (itemIndex) {
  const item = saleItems[itemIndex];
  if (!item || !item.isExtra) return;
  item.totalQuantity = Math.max(1, (item.totalQuantity || 1) - 1);
  if (item.isSpecialExtra && item.price != null) {
    item.totalValue = item.price * item.totalQuantity;
  } else if (item.extraType === 'numeric' && item.value != null) {
    item.totalValue = item.value * item.totalQuantity;
  }
  renderSaleList();
  await calculateTotals();
};

// Función global para eliminar item
window.removeSaleItem = async function (index) {
  const item = saleItems[index];

  // Pedido local: stock por talle en venta-publico (variant_size_warehouse_stock)
  if (item && item.fromLocalOrder && item.sizes && item.sizes.length > 0) {
    for (const size of item.sizes) {
      if (!size.variantId || !size.quantity || size.quantity <= 0) continue;
      try {
        const { error: rpcError } = await supabase.rpc(
          "rpc_release_public_sale_draft_line",
          {
            p_variant_id: size.variantId,
            p_size: String(size.size ?? ""),
            p_qty: size.quantity,
          }
        );
        if (rpcError) {
          console.error("Error liberando stock (rpc_release_public_sale_draft_line):", rpcError);
        }
      } catch (error) {
        console.error("Error al liberar stock del item eliminado:", error);
      }
    }
  }

  saleItems.splice(index, 1);
  renderSaleList();
  await calculateTotals();

  // Actualizar visibilidad del botón Guardar Pedido
  updateSaveOrderButtonVisibility();
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

  // Base para porcentaje: subtotal después de créditos + monto de extras especiales
  const specialExtrasTotal = extraItems
    .filter(item => item.extraType === 'special')
    .reduce((sum, e) => sum + (e.totalValue || 0), 0);
  const baseForPercentage = finalTotal + specialExtrasTotal;

  // Calcular extras porcentuales sobre (subtotal - crédito) + extras especiales (por cantidad)
  const percentageExtras = extraItems.filter(item => item.extraType === 'percentage');
  percentageExtras.forEach(extra => {
    const qty = extra.totalQuantity || 1;
    const percentageValue = ((baseForPercentage * extra.value) / 100) * qty;
    extra.calculatedValue = percentageValue;
    extra.totalValue = percentageValue;
    finalTotal += percentageValue;
  });

  // Aplicar extras numéricos
  const numericExtras = extraItems.filter(item => item.extraType === 'numeric');
  numericExtras.forEach(extra => {
    finalTotal += extra.totalValue; // Ya incluye el signo negativo si corresponde
  });

  // Aplicar extras especiales
  const specialExtras = extraItems.filter(item => item.extraType === 'special');
  specialExtras.forEach(extra => {
    finalTotal += extra.totalValue;
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

    // Actualizar visibilidad del botón Guardar Pedido
    updateSaveOrderButtonVisibility();

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
      customerLastPurchase.textContent = "Ninguna compra - Cliente nuevo";
      customerLastPurchase.style.color = "#dc3545";
      customerLastPurchase.style.fontWeight = "600";
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

    // Obtener warehouses IDs una sola vez para validación de stock
    const { data: warehouses } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);

    const warehouseMap = new Map();
    if (warehouses && warehouses.length > 0) {
      warehouses.forEach(w => warehouseMap.set(w.code, w.id));
    }
    const generalWarehouseId = warehouseMap.get("general");
    const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");

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
        // Si el size ya tiene variantId (viene de compra pendiente), usarlo directamente
        let variant = null;
        if (size.variantId) {
          variant = { id: size.variantId };
        } else {
          // Buscar variant en todas las fuentes posibles
          variant = currentVariants.find(v =>
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
        }

        if (!variant || !variant.id) {
          throw new Error(`No se encontró la variante para ${item.productName} - ${item.color} - Talle ${size.size}`);
        }

        // Validar stock antes de agregar (solo si no es devolución Y no viene de pedido local)
        // Los items de pedidos locales ya tienen stock reservado/descontado, no necesitan verificación
        if (!item.isReturn && !item.fromLocalOrder) {
          // Consultar stock por talle desde variant_size_warehouse_stock
          // Normalizar el tamaño antes de consultar (consistente con otras partes del código)
          const normalizedSize = normalizeSize(size.size);

          const { data: stockData, error: stockError } = await supabase
            .from("variant_size_warehouse_stock")
            .select("size, warehouse_id, stock_qty")
            .eq("variant_id", variant.id)
            .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

          if (stockError) {
            console.warn("Error obteniendo stock:", stockError);
          }

          // Filtrar por tamaño normalizado después de obtener los datos
          // (mismo approach usado en otras partes del código - líneas 1468, 1546)
          const filteredStockData = stockData ? stockData.filter(s => {
            const dbNormalizedSize = normalizeSize(s.size);
            return dbNormalizedSize === normalizedSize;
          }) : [];

          // Calcular stock por warehouse usando los datos filtrados
          let generalStock = 0;
          let ventaPublicoStock = 0;

          if (filteredStockData && filteredStockData.length > 0) {
            filteredStockData.forEach(s => {
              if (s.warehouse_id === generalWarehouseId) {
                generalStock = s.stock_qty || 0;
              } else if (s.warehouse_id === ventaPublicoWarehouseId) {
                ventaPublicoStock = s.stock_qty || 0;
              }
            });
          }

          // Plan 2: sin fallback operativo desde variant_sizes en flujo por talle.

          // Obtener source del stock (de dónde se tomará el stock)
          const sourceVentaPublico = size.source?.ventaPublico || 0;
          const sourceGeneral = size.source?.general || 0;
          const totalSourceRequested = sourceVentaPublico + sourceGeneral;

          // Si el source total es 0 pero hay quantity, significa que el usuario confirmó agregar sin stock
          // En ese caso, NO validar stock (ya fue confirmado previamente)
          const wasConfirmedWithoutStock = (totalSourceRequested === 0 && size.quantity > 0);

          if (!wasConfirmedWithoutStock) {
            // Validar stock según source específico solo si NO fue confirmado sin stock
            
            // Solo validar si se requiere stock de venta-publico
            if (sourceVentaPublico > 0 && ventaPublicoStock < sourceVentaPublico) {
              const productInfo = `${item.productName} - ${item.color} - Talle ${size.size}`;
              throw new Error(
                `Stock insuficiente en Venta Público para ${productInfo}. ` +
                `Disponible: ${ventaPublicoStock}, Solicitado: ${sourceVentaPublico}`
              );
            }

            // Solo validar si se requiere stock de general
            if (sourceGeneral > 0 && generalStock < sourceGeneral) {
              const productInfo = `${item.productName} - ${item.color} - Talle ${size.size}`;
              throw new Error(
                `Stock insuficiente en General para ${productInfo}. ` +
                `Disponible: ${generalStock}, Solicitado: ${sourceGeneral}`
              );
            }
          }

          // Si llegamos aquí, hay stock suficiente o el usuario confirmó sin stock
        }

        // Obtener fuente del stock (venta-publico y general)
        const source = size.source || { ventaPublico: size.quantity, general: 0 };
        const srcVp = source.ventaPublico || 0;
        const srcGen = source.general || 0;
        // Confirmación "agregar sin stock" → rpc_create_public_sale no descuenta depósitos (conteo desfasado, producto físico existe)
        const sellWithoutStock = size.quantity > 0 && srcVp === 0 && srcGen === 0;

        items.push({
          variant_id: variant.id,
          qty: size.quantity,
          price: item.price,
          size: size.size ? String(size.size) : null, // Incluir tamaño como string para descontar stock por talle
          is_return: item.isReturn || false,
          from_local_order: item.fromLocalOrder || false, // Flag para indicar que viene de pedido local
          sell_without_stock: sellWithoutStock,
          source: {
            venta_publico: srcVp,
            general: srcGen
          }
        });
      }
    }

    // Separar items de productos de extras
    const productItems = saleItems.filter(item => !item.isExtra);
    const extraItems = saleItems.filter(item => item.isExtra);

    // Calcular el total antes de crear la venta (solo productos)
    // totalValue ya tiene el signo correcto (negativo para devoluciones, positivo para ventas)
    const subtotal = productItems.reduce((sum, item) => {
      return sum + item.totalValue;
    }, 0);
    const credit = customerCredits.reduce((sum, c) => sum + c.amount, 0);
    const creditToApply = subtotal > 0 ? Math.min(credit, subtotal) : 0;
    let finalTotal = subtotal - creditToApply;

    // Separar extras por tipo
    const numericExtras = extraItems.filter(item => item.extraType === 'numeric');
    const percentageExtras = extraItems.filter(item => item.extraType === 'percentage');
    const specialExtrasForBase = extraItems.filter(item => item.extraType === 'special');
    const specialExtrasSum = specialExtrasForBase.reduce((s, e) => s + (e.totalValue || 0), 0);
    const baseForPercentage = finalTotal + specialExtrasSum;

    // Calcular valores de extras porcentuales sobre (subtotal - crédito) + extras especiales
    const percentageValues = percentageExtras.map(extra => {
      return {
        extra: extra,
        value: (baseForPercentage * extra.value) / 100
      };
    });

    // Aplicar extras numéricos al total
    numericExtras.forEach(extra => {
      finalTotal += extra.totalValue;
    });

    // Aplicar extras porcentuales al total
    percentageValues.forEach(({ value }) => {
      finalTotal += value;
    });

    // Agregar todos los extras al array items para que se guarden en la base de datos y aparezcan en el ticket
    // Extras numéricos
    numericExtras.forEach(extra => {
      items.push({
        is_special_extra: true,
        product_name: extra.productName || `Extra numérico: $${extra.totalValue.toLocaleString('es-AR')}`,
        qty: extra.totalQuantity || 1,
        price: extra.totalValue,
        is_return: false
        // No incluir variant_id para que se detecte como extra especial
      });
    });

    // Extras porcentuales
    percentageValues.forEach(({ extra, value }) => {
      items.push({
        is_special_extra: true,
        product_name: extra.productName || `Extra ${extra.value}%: $${value.toLocaleString('es-AR')}`,
        qty: extra.totalQuantity || 1,
        price: value,
        is_return: false
        // No incluir variant_id para que se detecte como extra especial
      });
    });

    // Extras especiales (precio unitario: backend hace qty * price)
    const specialExtras = extraItems.filter(item => item.extraType === 'special');
    specialExtras.forEach(extra => {
      finalTotal += extra.totalValue;
      const qty = extra.totalQuantity || 1;
      items.push({
        is_special_extra: true,
        product_name: extra.productName,
        qty: qty,
        price: extra.totalValue / qty,
        is_return: false
      });
    });

    // Preparar notas con información de extras y método de pago
    let notes = "";
    if (extraItems.length > 0) {
      const extrasInfo = extraItems.map(extra => {
        if (extra.extraType === 'numeric') {
          return `Extra numérico: $${extra.totalValue.toLocaleString('es-AR')}`;
        } else if (extra.extraType === 'percentage') {
          return `Extra porcentual: ${extra.value}% ($${extra.totalValue.toLocaleString('es-AR')})`;
        } else if (extra.extraType === 'special') {
          return `${extra.productName}: $${extra.totalValue.toLocaleString('es-AR')}`;
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

    // Caja 2 y 3: enviar compra pendiente a Caja 1 en lugar de finalizar aquí
    if (PUBLIC_SALES_CAJA !== 1) {
      const saleData = {
        items,
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
        subtotal,
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
        money_received: moneyReceived?.value ?? null
      };

      const { error: pendingError } = await supabase.rpc("rpc_create_pending_sale", {
        p_source_caja: PUBLIC_SALES_CAJA,
        p_sale_data: saleData
      });

      if (pendingError) throw pendingError;

      showMessage("Compra enviada exitosamente a Caja 1", "success");

      saleItems = [];
      selectedCustomer = null;
      customerCredits = [];
      selectedSizes = {};
      selectedColor = null;
      currentProduct = null;
      currentVariants = [];
      manualSelectedSizes = {};
      manualSelectedSizesSource = {};
      manualSelectedSizesConfirmedWithoutStock = {};
      productSelection.classList.remove("active");
      customerInfo.classList.remove("active");
      customerSearch.value = "";
      if (customerLastPurchase) {
        customerLastPurchase.textContent = "";
        customerLastPurchase.style.display = "none";
      }
      skuSearch.value = "";
      if (moneyReceived) moneyReceived.value = "";
      updateChangeAmount();
      paymentMethod = "contado";
      if (paymentMethodIndicator) paymentMethodIndicator.classList.remove("active");
      if (extraNumericInput) extraNumericInput.value = "";
      if (extraPercentageInput) extraPercentageInput.value = "";
      loadAsCredit = false;
      if (loadAsCreditContainer) loadAsCreditContainer.style.display = "none";
      if (loadAsCreditCheckbox) loadAsCreditCheckbox.checked = false;
      updateSaveOrderButtonVisibility();
      renderSaleList();
      await calculateTotals();
      return;
    }

    const { data, error } = await supabase
      .rpc("rpc_create_public_sale", {
        p_items: items,
        p_customer_id: selectedCustomer?.id || null,
        p_notes: notes || null,
        p_apply_credit: true,
        p_total_amount: finalTotal // Incluir total con extras
      });


    if (error) throw error;

    // Si el total es negativo (saldo a favor), crear crédito solo si la casilla está marcada
    let creditAmount = 0;
    if (finalTotal < 0 && selectedCustomer?.id && loadAsCredit) {
      creditAmount = Math.abs(finalTotal);
      const { error: creditError } = await supabase
        .rpc("rpc_add_return_credit", {
          p_customer_id: selectedCustomer.id,
          p_amount: creditAmount,
          p_notes: `Crédito generado por devolución en venta ${data.sale_number}`
        });

      if (creditError) {
        console.error("Error creando crédito:", creditError);
        showMessage(`Venta registrada: ${data.sale_number}, pero hubo un error al crear el crédito`, "error");
      } else {
        showMessage(`Venta registrada: ${data.sale_number}. Crédito de $${creditAmount.toLocaleString('es-AR')} agregado al cliente`, "success");
      }
    } else if (finalTotal < 0 && selectedCustomer?.id && !loadAsCredit) {
      // Saldo a favor pero NO se carga como crédito - el cliente verá $0 en su historial
      showMessage(`Venta registrada exitosamente: ${data.sale_number}. El saldo a favor no se cargó como crédito al cliente.`, "success");
    } else {
      showMessage(`Venta registrada exitosamente: ${data.sale_number}`, "success");
    }

    // Obtener detalles completos de la venta para el ticket
    const { data: saleDetails, error: detailsError } = await supabase
      .rpc("rpc_get_public_sale_details", { p_sale_id: data.sale_id });
    
    if (!detailsError && saleDetails) {
      // Imprimir directamente sin mostrar modal
      // Pasar finalTotal para que el ticket muestre el total correcto con todos los extras
      await printDirectly(saleDetails, selectedCustomer, finalTotal);
    }

    // Si esta venta proviene de una compra pendiente, marcarla como completada
    if (currentPendingSale) {
      const { error: completeError } = await supabase.rpc("rpc_complete_pending_sale", {
        p_pending_sale_id: currentPendingSale.id,
        p_sale_id: data.sale_id
      });

      if (completeError) {
        console.error("Error marcando compra pendiente como completada:", completeError);
      } else {
        currentPendingSale = null;
        // Recargar lista de compras pendientes
        await loadPendingSales();
      }
    }

    // Si esta venta proviene de un pedido local, marcarlo como completado
    if (currentLocalOrderId) {
      const { error: localOrderError } = await supabase
        .from("local_orders")
        .update({
          status: 'completed',
          updated_at: new Date().toISOString()
        })
        .eq("id", currentLocalOrderId);

      if (localOrderError) {
        console.error("Error marcando pedido local como completado:", localOrderError);
      } else {
        // Recargar lista de pedidos locales si el modal está abierto
        if (ordersModal && ordersModal.classList.contains("active")) {
          await loadLocalOrders();
        }
        currentLocalOrderId = null;
      }
    }

    // Limpiar formulario
    saleItems = [];
    selectedCustomer = null;
    customerCredits = [];
    selectedSizes = {};
    selectedColor = null;
    currentProduct = null;

    // Actualizar visibilidad del botón Guardar Pedido
    updateSaveOrderButtonVisibility();
    currentVariants = [];
    currentPendingSale = null; // Limpiar referencia a compra pendiente
    currentLocalOrderId = null; // Limpiar referencia a pedido local
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
async function printDirectly(saleDetails, customer, finalTotal = null) {
  // Intentar cargar y usar QZ Tray primero (igual que el botón Imprimir)
  try {
    await loadQZTray();

    // Si QZ se cargó, intentar imprimir con QZ
    if (typeof qz !== 'undefined' && qz) {
      try {
        await printSaleWithQZ(
          saleDetails,
          customer,
          finalTotal
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
    day: 'numeric',
    timeZone: TIMEZONE_BUENOS_AIRES,
  });
  const timeStr = saleDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE_BUENOS_AIRES,
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
    const price = parseARSNumber(item.price ?? item.price_snapshot ?? 0);
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
            <span style="color: #dc3545; font-weight: 700; font-size: 16px;">-$${parseARSNumber(sale.credit_used).toLocaleString('es-AR')}</span>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 22px; font-weight: 900; border-top: 3px solid #000; padding-top: 10px; margin-top: 15px; width: 100%;">
          <strong>TOTAL:</strong>
          <span style="${parseARSNumber(sale.total_amount) < 0 ? 'color: #dc3545;' : ''}">
            ${parseARSNumber(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseARSNumber(sale.total_amount)).toLocaleString('es-AR')}
          </span>
        </div>
        ${parseARSNumber(sale.total_amount) < 0 ? `
          <div style="margin-top: 15px; padding: 12px; background: #fff3cd; border: 3px solid #ffc107; font-size: 15px;">
            <strong style="color: #856404; font-weight: 700;">Saldo a favor:</strong>
            <span style="color: #856404; font-size: 17px; font-weight: 800;">
              $${Math.abs(parseARSNumber(sale.total_amount)).toLocaleString('es-AR')}
            </span>
          </div>
        ` : ''}
        ${totalCredit > 0 && parseARSNumber(sale.total_amount) >= 0 ? `
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
    day: 'numeric',
    timeZone: TIMEZONE_BUENOS_AIRES,
  });
  const timeStr = saleDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE_BUENOS_AIRES,
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
    const price = parseARSNumber(item.price ?? item.price_snapshot ?? 0);
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
            <span style="color: #dc3545; font-weight: 700; font-size: 16px;">-$${parseARSNumber(sale.credit_used).toLocaleString('es-AR')}</span>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px; font-size: 22px; font-weight: 900; border-top: 3px solid #000; padding-top: 10px; margin-top: 15px; width: 100%;">
          <strong>TOTAL:</strong>
          <span style="${parseARSNumber(sale.total_amount) < 0 ? 'color: #dc3545;' : ''}">
            ${parseARSNumber(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseARSNumber(sale.total_amount)).toLocaleString('es-AR')}
          </span>
        </div>
        ${parseARSNumber(sale.total_amount) < 0 ? `
          <div style="margin-top: 15px; padding: 12px; background: #fff3cd; border: 3px solid #ffc107; font-size: 15px;">
            <strong style="color: #856404; font-weight: 700;">Saldo a favor:</strong>
            <span style="color: #856404; font-size: 17px; font-weight: 800;">
              $${Math.abs(parseARSNumber(sale.total_amount)).toLocaleString('es-AR')}
            </span>
          </div>
        ` : ''}
        ${totalCredit > 0 && parseARSNumber(sale.total_amount) >= 0 ? `
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
    // Si ya está cargado, configurar firma y resolver inmediatamente
    if (typeof qz !== 'undefined' && qz) {
      setupQZSignature().then(resolve);
      return;
    }

    // Verificar si el script ya se está cargando
    if (document.querySelector('script[src*="qz-tray.js"]')) {
      // Esperar a que se cargue
      const checkInterval = setInterval(() => {
        if (typeof qz !== 'undefined' && qz) {
          clearInterval(checkInterval);
          // Configurar firma remota cuando QZ se carga
          setupQZSignature().then(resolve);
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
    // NOTA: Mantener demo.qz.io hasta que el certificado esté completamente configurado
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js';
    script.async = true;

    script.onload = () => {
      // Esperar un momento para que QZ se inicialice
      setTimeout(() => {
        if (typeof qz !== 'undefined' && qz) {
          // Configurar firma remota cuando QZ se carga
          setupQZSignature().then(resolve);
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
    console.error = function (...args) {
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

// Event listener para cerrar modal de confirmación sin stock
const noStockConfirmModal = document.getElementById("no-stock-confirm-modal");
if (noStockConfirmModal) {
  noStockConfirmModal.addEventListener("click", (e) => {
    if (e.target === noStockConfirmModal) {
      noStockConfirmModal.classList.remove("active");
    }
  });
}

// ============================================================================
// FUNCIONALIDAD DE MÚLTIPLES CAJAS - COMPRAS PENDIENTES
// ============================================================================

// Cargar compras pendientes desde la base de datos
async function loadPendingSales() {
  try {
    const { data, error } = await supabase.rpc("rpc_get_pending_sales");

    if (error) {
      console.error("Error cargando compras pendientes:", error);
      return;
    }

    pendingSales = data || [];
    renderPendingSales();
  } catch (error) {
    console.error("Error en loadPendingSales:", error);
  }
}

// Renderizar cuadros numerados de compras pendientes
function renderPendingSales() {
  if (!pendingSalesGrid) return;

  if (pendingSales.length === 0) {
    pendingSalesContainer.style.display = "none";
    return;
  }

  pendingSalesContainer.style.display = "block";
  pendingSalesGrid.innerHTML = "";

  pendingSales.forEach((pendingSale, index) => {
    const box = document.createElement("div");
    box.className = "pending-sale-box";
    if (currentPendingSale && currentPendingSale.id === pendingSale.id) {
      box.classList.add("active");
    }
    box.innerHTML = `
      <div class="box-number">${index + 1}</div>
      <div class="box-caja">Caja ${pendingSale.source_caja}</div>
    `;
    box.addEventListener("click", () => {
      loadPendingSaleIntoForm(pendingSale.id);
    });
    pendingSalesGrid.appendChild(box);
  });
}

// Cargar una compra pendiente en el formulario de caja 1
async function loadPendingSaleIntoForm(pendingSaleId) {
  try {
    // Buscar la compra pendiente
    const pendingSale = pendingSales.find(p => p.id === pendingSaleId);
    if (!pendingSale) {
      showMessage("Compra pendiente no encontrada", "error");
      return;
    }

    // Marcar como procesando
    const { error: markError } = await supabase.rpc("rpc_mark_pending_sale_processing", {
      p_pending_sale_id: pendingSaleId
    });

    if (markError) {
      if (markError.message.includes("ya está siendo procesada")) {
        showMessage("Esta compra ya está siendo procesada por otro usuario", "error");
      } else {
        throw markError;
      }
      return;
    }

    // Guardar referencia a la compra pendiente actual
    currentPendingSale = pendingSale;

    // Extraer datos de la compra
    const saleData = pendingSale.sale_data;

    // Restaurar items de la venta
    saleItems = saleData.sale_items || [];

    // Restaurar cliente
    if (saleData.customer) {
      selectedCustomer = saleData.customer;
      customerName.textContent = `${selectedCustomer.first_name} ${selectedCustomer.last_name || ''}`;
      customerInfo.classList.add("active");

      // Cargar créditos del cliente
      if (saleData.customer_credits && saleData.customer_credits.length > 0) {
        customerCredits = saleData.customer_credits;
        // Actualizar display de créditos manualmente
        const totalCredit = customerCredits.reduce((sum, c) => sum + parseFloat(c.amount || 0), 0);
        if (totalCredit > 0 && customerCredit) {
          customerCredit.textContent = `Crédito disponible: $${totalCredit.toLocaleString('es-AR')}`;
          customerCredit.style.display = "block";
        } else if (customerCredit) {
          customerCredit.textContent = "";
          customerCredit.style.display = "none";
        }
      } else {
        customerCredits = [];
        await loadCustomerCredits(selectedCustomer.id);
      }

      // Cargar última compra
      if (selectedCustomer.id) {
        await loadCustomerLastPurchase(selectedCustomer.id);
      }
    } else {
      selectedCustomer = null;
      customerInfo.classList.remove("active");
      customerCredits = [];
    }

    // Restaurar método de pago
    paymentMethod = saleData.payment_method || 'contado';
    if (paymentMethod === 'tarjeta' && paymentMethodIndicator) {
      paymentMethodIndicator.classList.add('active');
      if (paymentMethodText) {
        paymentMethodText.textContent = 'Tarjeta';
      }
    } else {
      if (paymentMethodIndicator) {
        paymentMethodIndicator.classList.remove('active');
      }
    }

    // Restaurar dinero recibido
    if (moneyReceived && saleData.money_received) {
      moneyReceived.value = saleData.money_received;
    }

    // Restaurar loadAsCredit
    loadAsCredit = saleData.load_as_credit || false;
    if (loadAsCreditCheckbox) {
      loadAsCreditCheckbox.checked = loadAsCredit;
    }

    // Renderizar lista de venta primero
    renderSaleList();

    // Calcular totales y mostrar/ocultar contenedor de loadAsCredit según el total
    await calculateTotals();
    const totalValue = parseFloat(totalAmount.textContent.replace(/[^0-9]/g, '')) || 0;
    if (totalValue < 0 && selectedCustomer && loadAsCreditContainer) {
      loadAsCreditContainer.style.display = "block";
    } else if (loadAsCreditContainer) {
      loadAsCreditContainer.style.display = "none";
    }

    updateChangeAmount();

    // Actualizar renderizado de compras pendientes
    renderPendingSales();

    showMessage("Compra cargada correctamente", "success");
  } catch (error) {
    console.error("Error cargando compra pendiente:", error);
    showMessage("Error al cargar la compra: " + error.message, "error");
  }
}

// Verificar compras pendientes periódicamente
function checkPendingSales() {
  loadPendingSales();
}

// Event listeners para botones de navegación
if (caja2Btn) {
  caja2Btn.addEventListener("click", () => {
    window.open('public-sales-caja2.html', '_blank');
  });
}

if (caja3Btn) {
  caja3Btn.addEventListener("click", () => {
    window.open('public-sales-caja3.html', '_blank');
  });
}

// Campana: abre/cierra modal de pendientes en local
if (reservasBellBtn) {
  reservasBellBtn.addEventListener("click", () => {
    toggleReservasPanel();
  });
}
if (closeReservasModalBtn) {
  closeReservasModalBtn.addEventListener("click", () => toggleReservasPanel(false));
  closeReservasModalBtn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleReservasPanel(false);
    }
  });
}
if (reservasModal) {
  reservasModal.addEventListener("click", (e) => {
    if (e.target === reservasModal) toggleReservasPanel(false);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (reservasModal?.classList.contains("active")) toggleReservasPanel(false);
});
if (reservasRefreshBtn) {
  reservasRefreshBtn.addEventListener("click", () => {
    refreshReservas().catch((e) => console.warn("refreshReservas:", e?.message || e));
  });
}

// Delegación acciones confirmar/rechazar
document.addEventListener("click", (e) => {
  const btn = e.target?.closest?.("[data-reserva-action]");
  if (!btn) return;
  const action = btn.getAttribute("data-reserva-action");
  const itemId = btn.getAttribute("data-order-item-id");
  if (!action || !itemId) return;
  handleReservaAction(action, itemId).catch((err) => {
    console.error("handleReservaAction:", err);
    alert(err?.message || "No se pudo actualizar la reserva.");
  });
});

// Cargar compras pendientes al iniciar y configurar polling
loadPendingSales();
setInterval(checkPendingSales, 5000); // Verificar cada 5 segundos

// Badge campana: conteo al cargar + Supabase Realtime (order_items / orders)
refreshReservas().catch((e) => console.warn("refreshReservas inicial:", e?.message || e));
setupReservasRealtime();
// Respaldo si Realtime no está habilitado o falla el canal
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  refreshReservas().catch((e) => console.warn("refreshReservas (intervalo):", e?.message || e));
}, 45000);

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

window.selectCustomerFromModal = async function (customerId) {
  await selectCustomer(customerId);
  customersModal.classList.remove("active");
  customerSearch.value = `${selectedCustomer.first_name} ${selectedCustomer.last_name || ''}`.trim();
};

// Mostrar QR code de un cliente existente
window.showCustomerQR = function (qrCode, customerName) {
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
    expandedSaleId = null;
    loadSalesHistory();
  });
}

// Event listener para botón Guardar Pedido
if (saveOrderBtn) {
  saveOrderBtn.addEventListener("click", async () => {
    await saveLocalOrder();
  });
}

// Función para actualizar visibilidad del botón Guardar Pedido
function updateSaveOrderButtonVisibility() {
  if (!saveOrderBtn) {
    console.warn("saveOrderBtn no encontrado");
    return;
  }

  // Verificar que hay productos (excluyendo extras)
  const productItems = saleItems.filter(item => !item.isExtra && !item.isReturn);
  const hasProducts = productItems.length > 0;

  // Verificar que hay un cliente seleccionado
  const hasCustomer = selectedCustomer && selectedCustomer.id;

  // Verificar que el contenedor customer-info está visible
  const customerInfoVisible = customerInfo && customerInfo.classList.contains("active");

  // Debug temporal
  console.log("updateSaveOrderButtonVisibility:", {
    hasProducts,
    hasCustomer,
    customerInfoVisible,
    productItemsCount: productItems.length,
    saleItemsCount: saleItems.length
  });

  // Mostrar/ocultar botón según condiciones
  if (hasProducts && hasCustomer && customerInfoVisible) {
    saveOrderBtn.style.display = "block";
    console.log("Botón Guardar Pedido: VISIBLE");
  } else {
    saveOrderBtn.style.display = "none";
    console.log("Botón Guardar Pedido: OCULTO");
  }
}

// Modal de pedidos locales
if (ordersBtn) {
  ordersBtn.addEventListener("click", () => {
    ordersModal.classList.add("active");
    // Activar tab de recibidos por defecto
    switchOrdersTab('received');
    loadLocalOrders();
  });
}

if (closeOrdersModal) {
  closeOrdersModal.addEventListener("click", () => {
    ordersModal.classList.remove("active");
  });
}

if (ordersModal) {
  ordersModal.addEventListener("click", (e) => {
    if (e.target === ordersModal) {
      ordersModal.classList.remove("active");
    }
  });
}

// Cambiar tabs en modal de pedidos
if (ordersTabButtons) {
  ordersTabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      switchOrdersTab(tab);
    });
  });
}

// Función para cambiar tabs
function switchOrdersTab(tab) {
  ordersTabButtons.forEach(btn => {
    if (btn.dataset.tab === tab) {
      btn.classList.add("active");
      btn.style.borderBottomColor = "#CD844D";
      btn.style.color = "#CD844D";
    } else {
      btn.classList.remove("active");
      btn.style.borderBottomColor = "transparent";
      btn.style.color = "#666";
    }
  });

  // Obtener término de búsqueda actual si existe
  const currentSearchTerm = ordersSearchInput ? ordersSearchInput.value : '';

  if (tab === 'received') {
    if (ordersReceivedTab) {
      ordersReceivedTab.style.display = "flex";
      ordersReceivedTab.classList.add("active");
    }
    if (ordersNewTab) {
      ordersNewTab.style.display = "none";
      ordersNewTab.classList.remove("active");
    }
    loadLocalOrders(currentSearchTerm);
  } else {
    if (ordersReceivedTab) {
      ordersReceivedTab.style.display = "none";
      ordersReceivedTab.classList.remove("active");
    }
    if (ordersNewTab) {
      ordersNewTab.style.display = "flex";
      ordersNewTab.classList.add("active");
    }
    loadLocalOrders(currentSearchTerm); // Cargar pedidos también cuando se cambia a "Nuevo Pedido"
  }
}

// Función para cargar pedidos locales
async function loadLocalOrders(searchTerm = '') {
  if (!ordersReceivedList) return;

  // Mostrar loading en ambas pestañas
  ordersReceivedList.innerHTML = `
    <div style="text-align: center; padding: 40px; color: #999;">
      <div class="loading-spinner" style="width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #CD844D; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px;"></div>
      <p>Cargando pedidos...</p>
    </div>
  `;

  if (ordersNewList) {
    ordersNewList.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #999;">
        <div class="loading-spinner" style="width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #CD844D; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px;"></div>
        <p>Cargando pedidos...</p>
      </div>
    `;
  }

  try {
    // Obtener todos los pedidos locales
    const { data: allOrders, error: ordersError } = await supabase.rpc("rpc_get_local_orders", {
      p_status: null,
      p_source_order_id: null
    });

    if (ordersError) throw ordersError;

    // Separar pedidos recibidos (con source_order_id) de pedidos guardados (sin source_order_id)
    let ordersFromOrders = (allOrders || []).filter(order => order.source_order_id !== null);
    let savedOrders = (allOrders || []).filter(order => order.source_order_id === null);

    // Aplicar filtro de búsqueda si hay término de búsqueda
    if (searchTerm && searchTerm.trim() !== '') {
      const searchLower = searchTerm.toLowerCase().trim();

      // Función para verificar si un pedido coincide con la búsqueda
      const matchesSearch = (order) => {
        // Buscar en nombre del cliente
        const customerName = (order.customer_name || '').toLowerCase();
        if (customerName.includes(searchLower)) return true;

        // Buscar en número de teléfono
        const customerPhone = (order.customer_phone || '').toLowerCase().replace(/\s+/g, '');
        const searchNoSpaces = searchLower.replace(/\s+/g, '');
        if (customerPhone.includes(searchNoSpaces)) return true;

        // Buscar en DNI/document_number
        const customerDoc = (order.customer_document_number || '').toLowerCase().replace(/\s+/g, '');
        if (customerDoc.includes(searchNoSpaces)) return true;

        return false;
      };

      ordersFromOrders = ordersFromOrders.filter(matchesSearch);
      savedOrders = savedOrders.filter(matchesSearch);
    }

    // Cargar pedidos recibidos
    if (ordersFromOrders.length === 0) {
      ordersReceivedList.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #999;">
          <p>No hay pedidos recibidos</p>
        </div>
      `;
    } else {
      // Obtener items para cada pedido recibido
      const ordersWithItems = await Promise.all(
        ordersFromOrders.map(async (order) => {
          const { data: items, error: itemsError } = await supabase.rpc("rpc_get_local_order_items", {
            p_local_order_id: order.id
          });
          if (itemsError) {
            console.error("Error obteniendo ítems del pedido local", order.id, itemsError);
          }
          return {
            ...order,
            items: items || [],
            itemsLoadError: !!itemsError
          };
        })
      );

      // Renderizar pedidos recibidos
      ordersReceivedList.innerHTML = ordersWithItems.map(order => renderLocalOrderCard(order)).join('');

      // Agregar event listeners: "Cargar en Caja 1" abre modal flotante de edición (como Pedidos Locales)
      document.querySelectorAll("#orders-received-list [data-load-order-to-sale]").forEach(btn => {
        btn.addEventListener("click", () => {
          const orderId = btn.dataset.loadOrderToSale;
          openOrderEditModal(orderId);
        });
      });
    }

    // Cargar pedidos guardados localmente
    if (ordersNewList) {
      if (savedOrders.length === 0) {
        ordersNewList.innerHTML = `
          <div style="text-align: center; padding: 40px; color: #999;">
            <p>No hay pedidos guardados</p>
          </div>
        `;
      } else {
        const savedOrdersWithItems = await Promise.all(
          savedOrders.map(async (order) => {
            const { data: items, error: itemsError } = await supabase.rpc("rpc_get_local_order_items", {
              p_local_order_id: order.id
            });
            if (itemsError) {
              console.error("Error obteniendo ítems del pedido local", order.id, itemsError);
            }
            return {
              ...order,
              items: items || [],
              itemsLoadError: !!itemsError
            };
          })
        );

        const renderedHTML = savedOrdersWithItems.map(order => renderLocalOrderCard(order)).join('');

        if (ordersNewList) {
          ordersNewList.innerHTML = renderedHTML;
        }

        // Agregar event listeners: "Cargar en Caja 1" abre modal flotante de edición (como Pedidos Locales)
        document.querySelectorAll("#orders-new-list [data-load-order-to-sale]").forEach(btn => {
          btn.addEventListener("click", () => {
            const orderId = btn.dataset.loadOrderToSale;
            openOrderEditModal(orderId);
          });
        });
      }
    }

  } catch (error) {
    console.error("Error cargando pedidos locales:", error);
    ordersReceivedList.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #dc3545;">
        <p>Error al cargar pedidos: ${error.message}</p>
      </div>
    `;
    if (ordersNewList) {
      ordersNewList.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #dc3545;">
          <p>Error al cargar pedidos: ${error.message}</p>
        </div>
      `;
    }
  }
}

// --- Modal flotante "Editar pedido" (misma vista, como Pedidos Locales) ---
let editOrderId = null;
let editOrder = null;
let editOrderCustomer = null;
let editOrderItems = [];
let editManualProduct = null;
let editManualVariants = [];
let editManualSelectedColor = null;
/** Misma lógica que búsqueda manual principal: cantidades por talle antes de "Agregar". */
let editManualSelectedSizes = {};
let editManualSelectedSizesSource = {};
let editManualSelectedSizesConfirmedWithoutStock = {};
let editManualSizeRenderVersion = 0;
/** JSON de local_orders.notes (shipping, discount, extras_amount, extras_percentage) — alineado a rpc_create_local_order */
let editOrderParsedNotes = null;

function parseLocalOrderNotes(notesRaw) {
  if (notesRaw == null || String(notesRaw).trim() === "") return {};
  try {
    const o = typeof notesRaw === "string" ? JSON.parse(notesRaw) : notesRaw;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** Suma solo líneas del pedido (productos + extras guardados como ítems). */
function getEditOrderLinesSumOnly() {
  return editOrderItems.reduce((sum, it) => sum + it.quantity * getEditOrderUnitPrice(it), 0);
}

function getEditOrderUnitPrice(item) {
  const variantId = item?.variant_id != null ? String(item.variant_id).trim() : "";
  const variantPrice = variantId ? editOrderVariantPriceMap.get(variantId) : null;
  return resolveOrderItemUnitPrice(item?.price_snapshot, variantPrice);
}

/** Misma fórmula que rpc_create_local_order sobre el subtotal de líneas. */
function applyLocalOrderNotesToTotal(linesSum, parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  let t = linesSum;
  t += Number(p.shipping) || 0;
  t -= Number(p.discount) || 0;
  t += Number(p.extras_amount) || 0;
  const pct = Number(p.extras_percentage) || 0;
  if (pct) t += t * (pct / 100);
  return Math.max(t, 0);
}

function getLocalOrderBaseBeforePercentage(parsed) {
  const p = parsed && typeof parsed === "object" ? parsed : {};
  let t = getEditOrderLinesSumOnly();
  t += Number(p.shipping) || 0;
  t -= Number(p.discount) || 0;
  t += Number(p.extras_amount) || 0;
  return t;
}

async function openOrderEditModal(localOrderId) {
  const modal = document.getElementById("order-edit-modal");
  const msgEl = document.getElementById("order-edit-message");
  if (!modal) return;
  msgEl.innerHTML = "";
  // Resetear modo devoluciones del modal
  const returnModeEl = document.getElementById("order-edit-return-mode");
  const returnModeIndicatorEl = document.getElementById("order-edit-return-mode-indicator");
  if (returnModeEl) returnModeEl.checked = false;
  if (returnModeIndicatorEl) returnModeIndicatorEl.style.display = "none";
  editOrderId = localOrderId;
  editOrderItems = [];
  editOrderParsedNotes = null;
  document.getElementById("order-edit-items-tbody").innerHTML = '<tr><td colspan="5" style="text-align: center; color: #999;">Cargando...</td></tr>';

  const { data: orderData, error: orderError } = await supabase
    .from("local_orders")
    .select("id, order_number, customer_id, total_amount, notes")
    .eq("id", localOrderId)
    .single();
  if (orderError || !orderData) {
    msgEl.innerHTML = '<div class="message error">Pedido no encontrado</div>';
    modal.classList.add("active");
    return;
  }
  editOrder = orderData;
  editOrderParsedNotes = parseLocalOrderNotes(orderData.notes);

  const { data: customerData, error: customerError } = await supabase
    .from("public_sales_customers")
    .select("id, first_name, last_name, customer_number, qr_code")
    .eq("id", orderData.customer_id)
    .single();
  if (customerError || !customerData) {
    msgEl.innerHTML = '<div class="message error">Cliente no encontrado</div>';
    modal.classList.add("active");
    return;
  }
  editOrderCustomer = customerData;

  const { data: itemsData, error: itemsError } = await supabase.rpc("rpc_get_local_order_items", { p_local_order_id: localOrderId });
  if (itemsError) {
    msgEl.innerHTML = '<div class="message error">Error al cargar ítems</div>';
    modal.classList.add("active");
    return;
  }
  const mappedItems = (itemsData || []).map((row) => ({
    variant_id: row.variant_id,
    product_name: row.product_name,
    color: row.color,
    size: row.size,
    quantity: row.quantity,
    price_snapshot: row.price_snapshot,
  }));
  editOrderItems = mappedItems;

  // Cargar precios de variante para resolver snapshots legacy en edición.
  editOrderVariantPriceMap.clear();
  const variantIds = Array.from(
    new Set(
      mappedItems
        .map((row) => (row?.variant_id != null ? String(row.variant_id).trim() : ""))
        .filter(Boolean)
    )
  );
  if (variantIds.length > 0) {
    const { data: variantsData, error: variantsError } = await supabase
      .from("product_variants")
      .select("id, price")
      .in("id", variantIds);
    if (!variantsError) {
      (variantsData || []).forEach((v) => {
        const id = v?.id != null ? String(v.id).trim() : "";
        if (id) editOrderVariantPriceMap.set(id, v?.price ?? null);
      });
    } else {
      console.warn("⚠️ No se pudieron cargar precios de variantes para fallback legacy:", variantsError.message || variantsError);
    }
  }

  ordersModal.classList.remove("active");
  modal.classList.add("active");
  renderOrderEditModal();
}

function getEditOrderTotal() {
  return applyLocalOrderNotesToTotal(getEditOrderLinesSumOnly(), editOrderParsedNotes);
}

function buildEditOrderPayload() {
  return editOrderItems.map((it) => ({
    variant_id: it.variant_id || null,
    product_name: it.product_name || "Producto",
    color: it.color || "",
    size: it.size || "",
    quantity: it.quantity,
    price_snapshot: getEditOrderUnitPrice(it),
    imagen: it.imagen || null,
  }));
}

function renderOrderEditModal() {
  const tbody = document.getElementById("order-edit-items-tbody");
  const totalEl = document.getElementById("order-edit-items-total");
  const total = getEditOrderTotal();
  document.getElementById("order-edit-number").textContent = editOrder?.order_number || editOrderId?.slice(0, 8) || "";
  document.getElementById("order-edit-customer-name").textContent = editOrderCustomer ? `${editOrderCustomer.first_name} ${editOrderCustomer.last_name || ""}`.trim() : "";
  document.getElementById("order-edit-customer-number").textContent = editOrderCustomer?.customer_number ? `(Nº ${editOrderCustomer.customer_number})` : "";
  const totalText = total < 0 ? `-$${Math.abs(total).toLocaleString("es-AR")}` : `$${total.toLocaleString("es-AR")}`;
  const totalElMain = document.getElementById("order-edit-total");
  if (totalElMain) {
    totalElMain.textContent = totalText;
    totalElMain.style.color = total < 0 ? "#dc3545" : "#CD844D";
  }

  const n = editOrderParsedNotes || {};
  const noteExtraRows = [];
  if (Number(n.extras_amount) > 0) {
    const amt = Number(n.extras_amount);
    noteExtraRows.push(`<tr class="extra-item order-edit-note-extra">
      <td><span style="font-style: italic;">Extra (monto fijo)</span> <span style="font-size: 10px; color: #666;">(notas del pedido)</span></td>
      <td style="text-align: center; color: #666;">1</td>
      <td>$${amt.toLocaleString("es-AR")}</td>
      <td>$${amt.toLocaleString("es-AR")}</td>
      <td style="color: #999; font-size: 11px;">—</td>
    </tr>`);
  }
  if (Number(n.extras_percentage) > 0) {
    const pct = Number(n.extras_percentage);
    const base = getLocalOrderBaseBeforePercentage(editOrderParsedNotes);
    const pctAmt = base * (pct / 100);
    noteExtraRows.push(`<tr class="extra-item order-edit-note-extra">
      <td><span style="font-style: italic;">Extra ${pct}%</span> <span style="font-size: 10px; color: #666;">(sobre subtotal + monto fijo)</span></td>
      <td style="text-align: center; color: #666;">1</td>
      <td>${pct}%</td>
      <td>$${pctAmt.toLocaleString("es-AR")}</td>
      <td style="color: #999; font-size: 11px;">—</td>
    </tr>`);
  }

  if (editOrderItems.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align: center; color: #999;">No hay ítems</td></tr>' + noteExtraRows.join("");
  } else {
    tbody.innerHTML =
      editOrderItems
        .map((it, idx) => {
          const unitPrice = getEditOrderUnitPrice(it);
          const subtotal = it.quantity * unitPrice;
          const isReturn = !it.variant_id ? false : unitPrice < 0;
          const isExtra = !it.variant_id;
          const nameCell = isExtra
            ? `<span style="font-style: italic;">${escapeHtml(it.product_name)}</span> <span style="font-size: 11px; color: #0066cc;">(Extra)</span>`
            : `${escapeHtml(it.product_name)}${isReturn ? ' <span style="color: #dc3545; font-weight: 700; font-size: 11px; text-transform: uppercase;">[DEV]</span>' : ""}` +
              (it.color ? ` - ${escapeHtml(it.color)}` : "") +
              (it.size ? ` (${escapeHtml(it.size)})` : "");
          return `<tr class="${isExtra ? "extra-item" : isReturn ? "return-item" : ""}" data-edit-idx="${idx}">
        <td>${nameCell}</td>
        <td><input type="number" min="1" value="${it.quantity}" data-edit-idx="${idx}" class="order-edit-qty" style="width: 50px; padding: 4px; text-align: center;" /></td>
        <td>${isReturn ? "-" : ""}$${Math.abs(unitPrice).toLocaleString("es-AR")}</td>
        <td>${subtotal < 0 ? "-" : ""}$${Math.abs(subtotal).toLocaleString("es-AR")}</td>
        <td><button type="button" class="btn btn-secondary order-edit-remove" data-edit-idx="${idx}" style="padding: 4px 8px; font-size: 11px;">Quitar</button></td>
      </tr>`;
        })
        .join("") + noteExtraRows.join("");
  }
  totalEl.textContent = `Total: ${totalText}`;
  totalEl.style.color = total < 0 ? "#dc3545" : "#CD844D";

  tbody.querySelectorAll(".order-edit-qty").forEach((input) => {
    input.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.editIdx, 10);
      const q = parseInt(e.target.value, 10);
      if (!isNaN(q) && q >= 1 && editOrderItems[idx]) {
        editOrderItems[idx].quantity = q;
        renderOrderEditModal();
      }
    });
  });
  tbody.querySelectorAll(".order-edit-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.editIdx, 10);
      editOrderItems.splice(idx, 1);
      renderOrderEditModal();
    });
  });
}

function showOrderEditMessage(msg, type) {
  const el = document.getElementById("order-edit-message");
  el.innerHTML = `<div class="message ${type}">${escapeHtml(msg)}</div>`;
}

document.getElementById("close-order-edit-modal")?.addEventListener("click", () => {
  document.getElementById("order-edit-modal").classList.remove("active");
});

// Borrar pedido local desde el modal de edición
document.getElementById("order-edit-delete-btn")?.addEventListener("click", async () => {
  if (!editOrderId) {
    showOrderEditMessage("Pedido no encontrado", "error");
    return;
  }

  const orderNumber = editOrder?.order_number || editOrderId.slice(0, 8);
  const ok = confirm(
    `¿Seguro que querés borrar el pedido ${orderNumber}?\n\n` +
      `Se eliminará el pedido y TODOS los productos volverán al stock de Venta al Público.`
  );
  if (!ok) return;

  const ok2 = confirm("Confirmación final: ¿Borrar pedido definitivamente?");
  if (!ok2) return;

  const btn = document.getElementById("order-edit-delete-btn");
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  }

  try {
    const { error } = await supabase.rpc("rpc_delete_local_order", { p_local_order_id: editOrderId });
    if (error) throw error;

    showOrderEditMessage("Pedido borrado. Stock devuelto a Venta al Público.", "success");
    document.getElementById("order-edit-modal").classList.remove("active");
    await loadLocalOrders();
  } catch (e) {
    showOrderEditMessage("Error al borrar pedido: " + e.message, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = "1";
      btn.style.cursor = "pointer";
    }
  }
});

// Escuchar cambios en modo devoluciones (modal editar pedido)
document.getElementById("order-edit-return-mode")?.addEventListener("change", (e) => {
  const ind = document.getElementById("order-edit-return-mode-indicator");
  if (ind) ind.style.display = e.target.checked ? "block" : "none";
});

document.getElementById("order-edit-add-extra-btn")?.addEventListener("click", () => {
  const name = document.getElementById("order-edit-extra-name").value.trim();
  const amount = parseFloat(document.getElementById("order-edit-extra-amount").value);
  if (!name) {
    showOrderEditMessage("Ingrese el nombre del extra", "error");
    return;
  }
  if (isNaN(amount) || amount < 0) {
    showOrderEditMessage("Ingrese un monto válido", "error");
    return;
  }
  editOrderItems.push({
    variant_id: null,
    product_name: `Extra: ${name}`,
    color: "",
    size: "",
    quantity: 1,
    price_snapshot: amount,
  });
  document.getElementById("order-edit-extra-name").value = "";
  document.getElementById("order-edit-extra-amount").value = "";
  renderOrderEditModal();
  showOrderEditMessage("Extra agregado", "success");
});

document.getElementById("order-edit-save-btn")?.addEventListener("click", async () => {
  if (!editOrderId || editOrderItems.length === 0) {
    showOrderEditMessage("No hay ítems para guardar", "error");
    return;
  }
  const btn = document.getElementById("order-edit-save-btn");
  btn.disabled = true;
  try {
    const { data, error } = await supabase.rpc("rpc_update_local_order", {
      p_local_order_id: editOrderId,
      p_items: buildEditOrderPayload(),
    });
    if (error) throw error;
    editOrder.total_amount = data.total_amount;
    renderOrderEditModal();
    showOrderEditMessage("Cambios guardados correctamente", "success");
  } catch (e) {
    showOrderEditMessage("Error al guardar: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("order-edit-finalize-btn")?.addEventListener("click", async () => {
  if (!editOrderId || !editOrderCustomer || editOrderItems.length === 0) {
    showOrderEditMessage("No hay ítems para finalizar", "error");
    return;
  }
  const btn = document.getElementById("order-edit-finalize-btn");
  btn.disabled = true;
  try {
    // IMPORTANTE: persistir edición ANTES de finalizar/imprimir para que
    // los productos agregados en el modal descuenten stock correctamente.
    const { data: updateData, error: updateError } = await supabase.rpc("rpc_update_local_order", {
      p_local_order_id: editOrderId,
      p_items: buildEditOrderPayload(),
    });
    if (updateError) throw updateError;
    if (updateData?.total_amount != null) {
      editOrder.total_amount = updateData.total_amount;
      renderOrderEditModal();
    }

    const pItems = buildEditOrderPayload();
    const saleItems = [];
    for (const it of pItems) {
      if (it.variant_id) {
        const rawPrice = parseARSNumber(it.price_snapshot || 0);
        const isReturn = rawPrice < 0;
        const line = {
          variant_id: it.variant_id,
          qty: it.quantity,
          price: Math.abs(rawPrice),
          is_return: isReturn,
          // Ventas del pedido local: stock ya reservado/descontado.
          // Devoluciones: deben reingresar stock, así que NO deben llevar from_local_order=true.
          from_local_order: !isReturn,
        };
        // Sin talle, rpc_create_public_sale usa variant_warehouse_stock (legacy) y el reingreso no toca variant_size_warehouse_stock (venta al público por talle).
        const sizeStr = it.size != null ? String(it.size).trim() : "";
        if (sizeStr !== "") {
          line.size = sizeStr;
        }
        if (!isReturn) {
          line.source = { venta_publico: it.quantity, general: 0 };
        }
        saleItems.push(line);
      } else {
        saleItems.push({
          product_name: it.product_name,
          qty: it.quantity,
          price: parseARSNumber(it.price_snapshot || 0),
          is_return: false,
          is_special_extra: true,
        });
      }
    }
    const notesFin = editOrderParsedNotes || {};
    if (Number(notesFin.extras_amount) > 0) {
      saleItems.push({
        product_name: "Extra (monto fijo)",
        qty: 1,
        price: Number(notesFin.extras_amount),
        is_return: false,
        is_special_extra: true,
      });
    }
    const pctFin = Number(notesFin.extras_percentage) || 0;
    if (pctFin > 0) {
      let basePct = pItems.reduce((s, it) => s + it.quantity * parseARSNumber(it.price_snapshot || 0), 0);
      basePct += Number(notesFin.shipping) || 0;
      basePct -= Number(notesFin.discount) || 0;
      basePct += Number(notesFin.extras_amount) || 0;
      const pctAmt = basePct * (pctFin / 100);
      saleItems.push({
        product_name: `Extra ${pctFin}%`,
        qty: 1,
        price: pctAmt,
        is_return: false,
        is_special_extra: true,
      });
    }
    const finalTotal = getEditOrderTotal();
    const { data: saleData, error: saleError } = await supabase.rpc("rpc_create_public_sale", {
      p_items: saleItems,
      p_customer_id: editOrderCustomer.id,
      p_notes: `Pedido local ${editOrder.order_number || editOrderId}`,
      p_apply_credit: true,
      p_total_amount: finalTotal,
    });
    if (saleError) throw saleError;
    await supabase.from("local_orders").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", editOrderId);
    const { data: saleDetails, error: detailsError } = await supabase.rpc("rpc_get_public_sale_details", { p_sale_id: saleData.sale_id });
    if (!detailsError && saleDetails) {
      try {
        await printDirectly(saleDetails, editOrderCustomer, finalTotal);
      } catch (printErr) {
        console.warn("Impresión:", printErr);
      }
    }
    showOrderEditMessage(`Pedido finalizado. Venta ${saleData.sale_number} registrada.`, "success");
    document.getElementById("order-edit-modal").classList.remove("active");
    loadLocalOrders();
  } catch (e) {
    showOrderEditMessage("Error al finalizar: " + e.message, "error");
  } finally {
    btn.disabled = false;
  }
});

let orderEditSearchTimeout;
document.getElementById("order-edit-manual-product")?.addEventListener("input", () => {
  clearTimeout(orderEditSearchTimeout);
  const q = document.getElementById("order-edit-manual-product").value.trim();
  const drop = document.getElementById("order-edit-autocomplete");
  drop.innerHTML = "";
  drop.style.display = "none";
  if (q.length < 2) return;
  orderEditSearchTimeout = setTimeout(async () => {
    const { data: products } = await supabase.from("products").select("id, name").ilike("name", `%${q}%`).in("status", ["active", "pending_stock", "draft"]).limit(50);
    if (!products?.length) return;
    const sorted = sortProductsByRelevance(products, q).slice(0, 8);
    drop.innerHTML = sorted.map((p) => `<div class="autocomplete-item" data-id="${p.id}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`).join("");
    drop.style.display = "block";
    drop.querySelectorAll(".autocomplete-item").forEach((el) => {
      el.addEventListener("click", () => {
        document.getElementById("order-edit-manual-product").value = el.dataset.name;
        drop.style.display = "none";
        loadEditOrderProductVariants(el.dataset.id);
      });
    });
  }, 300);
});

/** Stock por variante+talle (warehouses general + venta-público), misma lógica que búsqueda manual. */
async function fetchEditOrderManualSizeStockMap(variantIds, normalizedSizes) {
  const sizeStockMap = new Map();
  if (!variantIds.length || !normalizedSizes.length) return sizeStockMap;

  const { data: warehouses } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);

  const warehouseMap = new Map();
  let generalWarehouseId = null;
  let ventaPublicoWarehouseId = null;
  if (warehouses?.length) {
    warehouses.forEach((w) => warehouseMap.set(w.code, w.id));
    generalWarehouseId = warehouseMap.get("general");
    ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  }
  if (!generalWarehouseId || !ventaPublicoWarehouseId) return sizeStockMap;

  const { data: sizeWarehouseStocks, error: sizeError } = await supabase
    .from("variant_size_warehouse_stock")
    .select("variant_id, size, warehouse_id, stock_qty")
    .in("variant_id", variantIds)
    .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

  if (sizeError || !sizeWarehouseStocks?.length) return sizeStockMap;

  sizeWarehouseStocks.forEach((sws) => {
    const normalizedSize = normalizeSize(sws.size);
    if (!normalizedSize || !normalizedSizes.includes(normalizedSize)) return;
    const key = `${sws.variant_id}_${normalizedSize}`;
    if (!sizeStockMap.has(key)) {
      sizeStockMap.set(key, { general: 0, ventaPublico: 0, total: 0 });
    }
    const stock = sizeStockMap.get(key);
    if (sws.warehouse_id === generalWarehouseId) {
      stock.general = sws.stock_qty || 0;
    } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
      stock.ventaPublico = sws.stock_qty || 0;
    }
    stock.total = stock.general + stock.ventaPublico;
  });

  return sizeStockMap;
}

function updateEditManualLoadButton() {
  const addBtn = document.getElementById("order-edit-manual-add-btn");
  const hasSelections = Object.keys(editManualSelectedSizes).some((sz) => editManualSelectedSizes[sz] > 0);
  if (addBtn) addBtn.disabled = !hasSelections || !editManualSelectedColor;
}

function updateEditManualSizeButton(size, generalStock, ventaPublicoStock, totalStock) {
  const sizesEl = document.getElementById("order-edit-manual-sizes");
  if (!sizesEl) return;

  const btn = sizesEl.querySelector(`[data-size="${size}"]`);
  if (!btn) return;

  const quantity = editManualSelectedSizes[size] || 0;
  const source = editManualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };

  btn.className = "size-btn edit-manual-size";
  if (totalStock === 0) {
    btn.classList.add("size-zero");
  } else if (source.general > 0) {
    btn.classList.add("size-green");
  } else if (ventaPublicoStock > 0 && source.general === 0) {
    btn.classList.add("size-available");
  } else if (generalStock > 0) {
    btn.classList.add("size-green");
  } else {
    btn.classList.add("size-zero");
  }

  let counter = btn.querySelector(".size-counter");
  if (quantity > 0) {
    if (!counter) {
      counter = document.createElement("div");
      counter.className = "size-counter";
      counter.style.width = "18px";
      counter.style.height = "18px";
      counter.style.fontSize = "11px";
      btn.appendChild(counter);
    }
    counter.textContent = quantity;
  } else if (counter) {
    counter.remove();
  }

  let decrementBtn = btn.querySelector(".size-decrement");
  if (quantity > 0) {
    if (!decrementBtn) {
      decrementBtn = document.createElement("button");
      decrementBtn.className = "size-decrement";
      decrementBtn.textContent = "-";
      decrementBtn.type = "button";
      decrementBtn.style.width = "16px";
      decrementBtn.style.height = "16px";
      decrementBtn.style.fontSize = "12px";
      decrementBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (editManualSelectedSizes[size] > 0) {
          editManualSelectedSizes[size]--;
          if (editManualSelectedSizesSource[size]) {
            if (editManualSelectedSizesSource[size].general > 0) {
              editManualSelectedSizesSource[size].general--;
            } else if (editManualSelectedSizesSource[size].ventaPublico > 0) {
              editManualSelectedSizesSource[size].ventaPublico--;
            }
            if (
              editManualSelectedSizesSource[size].ventaPublico === 0 &&
              editManualSelectedSizesSource[size].general === 0
            ) {
              delete editManualSelectedSizesSource[size];
            }
          }
          if (editManualSelectedSizes[size] === 0) {
            delete editManualSelectedSizes[size];
            delete editManualSelectedSizesSource[size];
          }
          const variant = editManualVariants.find(
            (v) => v.color === editManualSelectedColor && normalizeSize(v.size) === normalizeSize(size)
          );
          if (variant) {
            const { data: warehouses } = await supabase
              .from("warehouses")
              .select("id, code")
              .in("code", ["general", "venta-publico"]);
            const warehouseMap = new Map();
            let generalWarehouseId = null;
            let ventaPublicoWarehouseId = null;
            if (warehouses && warehouses.length > 0) {
              warehouses.forEach((w) => warehouseMap.set(w.code, w.id));
              generalWarehouseId = warehouseMap.get("general");
              ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
            }
            let genStock = 0;
            let ventaStock = 0;
            if (generalWarehouseId && ventaPublicoWarehouseId) {
              const normalizedSize = normalizeSize(size);
              const { data: sizeWarehouseStocks } = await supabase
                .from("variant_size_warehouse_stock")
                .select("size, warehouse_id, stock_qty")
                .eq("variant_id", variant.id)
                .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
              if (sizeWarehouseStocks) {
                sizeWarehouseStocks.forEach((sws) => {
                  const swsNormalizedSize = normalizeSize(sws.size);
                  if (swsNormalizedSize !== normalizedSize) return;
                  if (sws.warehouse_id === generalWarehouseId) {
                    genStock = sws.stock_qty || 0;
                  } else if (sws.warehouse_id === ventaPublicoWarehouseId) {
                    ventaStock = sws.stock_qty || 0;
                  }
                });
              }
            }
            updateEditManualSizeButton(size, genStock, ventaStock, genStock + ventaStock);
          } else {
            updateEditManualSizeButton(size, 0, 0, 0);
          }
          updateEditManualLoadButton();
        }
      });
      btn.appendChild(decrementBtn);
    }
  } else if (decrementBtn) {
    decrementBtn.remove();
  }
}

async function paintOrderEditManualSizesForColor(color) {
  const currentVersion = ++editManualSizeRenderVersion;
  const sizesEl = document.getElementById("order-edit-manual-sizes");
  if (!sizesEl) return;

  sizesEl.innerHTML = "";

  const byColor = editManualVariants.filter((v) => v.color === color);
  const sizes = [...new Set(byColor.map((v) => v.size).filter(Boolean))].sort((a, b) => {
    const numA = parseFloat(a) || 0;
    const numB = parseFloat(b) || 0;
    return numA - numB;
  });

  if (currentVersion !== editManualSizeRenderVersion) return;

  const variantIds = byColor.map((v) => v.id).filter(Boolean);
  const normalizedSizes = sizes.map((s) => normalizeSize(s)).filter(Boolean);
  const sizeStockMap = await fetchEditOrderManualSizeStockMap(variantIds, normalizedSizes);

  if (currentVersion !== editManualSizeRenderVersion) return;

  const { data: warehouses } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);

  const warehouseMap = new Map();
  let generalWarehouseId = null;
  let ventaPublicoWarehouseId = null;
  if (warehouses && warehouses.length > 0) {
    warehouses.forEach((w) => warehouseMap.set(w.code, w.id));
    generalWarehouseId = warehouseMap.get("general");
    ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  }

  if (currentVersion !== editManualSizeRenderVersion) return;

  const orderEditReturnMode = () => !!document.getElementById("order-edit-return-mode")?.checked;

  sizes.forEach((size) => {
    const normalizedSize = normalizeSize(size);
    if (!normalizedSize) return;

    const variant = byColor.find((v) => normalizeSize(v.size) === normalizedSize);
    if (!variant) return;

    const stockKey = `${variant.id}_${normalizedSize}`;
    let totalStock = 0;
    let generalStock = 0;
    let ventaPublicoStock = 0;

    if (sizeStockMap.has(stockKey)) {
      const sizeStock = sizeStockMap.get(stockKey);
      generalStock = sizeStock.general || 0;
      ventaPublicoStock = sizeStock.ventaPublico || 0;
      totalStock = sizeStock.total || 0;
    } else {
      for (const [key, stock] of sizeStockMap.entries()) {
        const u = key.lastIndexOf("_");
        const keyVariantId = u >= 0 ? key.slice(0, u) : key;
        const keySize = u >= 0 ? key.slice(u + 1) : "";
        if (keySize === normalizedSize && variantIds.includes(keyVariantId)) {
          const matchingVariant = byColor.find((v) => v.id === keyVariantId);
          if (matchingVariant && normalizeSize(matchingVariant.size) === normalizedSize) {
            generalStock = stock.general || 0;
            ventaPublicoStock = stock.ventaPublico || 0;
            totalStock = stock.total || 0;
            break;
          }
        }
      }
    }

    if (generalStock === 0 && ventaPublicoStock === 0 && Number(variant.stock_qty) > 0) {
      generalStock = Number(variant.stock_qty);
      totalStock = generalStock;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "size-btn edit-manual-size";
    btn.setAttribute("data-size", size);
    btn.textContent = size;
    btn.style.width = "40px";
    btn.style.height = "40px";
    btn.style.fontSize = "14px";

    const quantity = editManualSelectedSizes[size] || 0;
    const source = editManualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };

    if (totalStock === 0) {
      btn.classList.add("size-zero");
    } else if (source.general > 0) {
      btn.classList.add("size-green");
    } else if (ventaPublicoStock > 0 && source.general === 0) {
      btn.classList.add("size-available");
    } else if (generalStock > 0) {
      btn.classList.add("size-green");
    } else {
      btn.classList.add("size-zero");
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

    if (quantity > 0) {
      const decrementBtn = document.createElement("button");
      decrementBtn.className = "size-decrement";
      decrementBtn.textContent = "-";
      decrementBtn.type = "button";
      decrementBtn.style.width = "16px";
      decrementBtn.style.height = "16px";
      decrementBtn.style.fontSize = "12px";
      decrementBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (editManualSelectedSizes[size] > 0) {
          editManualSelectedSizes[size]--;
          if (editManualSelectedSizesSource[size]) {
            if (editManualSelectedSizesSource[size].general > 0) {
              editManualSelectedSizesSource[size].general--;
            } else if (editManualSelectedSizesSource[size].ventaPublico > 0) {
              editManualSelectedSizesSource[size].ventaPublico--;
            }
            if (
              editManualSelectedSizesSource[size].ventaPublico === 0 &&
              editManualSelectedSizesSource[size].general === 0
            ) {
              delete editManualSelectedSizesSource[size];
            }
          }
          if (editManualSelectedSizes[size] === 0) {
            delete editManualSelectedSizes[size];
            delete editManualSelectedSizesSource[size];
          }
          updateEditManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
          updateEditManualLoadButton();
        }
      });
      btn.appendChild(decrementBtn);
    }

    if (orderEditReturnMode() || totalStock > 0) {
      btn.addEventListener("click", async () => {
        const currentQty = editManualSelectedSizes[size] || 0;
        const currentSource = editManualSelectedSizesSource[size] || { ventaPublico: 0, general: 0 };

        if (orderEditReturnMode()) {
          editManualSelectedSizes[size] = currentQty + 1;
          if (!editManualSelectedSizesSource[size]) {
            editManualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };
          }
          updateEditManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
          updateEditManualLoadButton();
        } else {
          const totalStockAvailable = ventaPublicoStock + generalStock;

          if (currentQty < totalStockAvailable) {
            editManualSelectedSizes[size] = currentQty + 1;
            if (!editManualSelectedSizesSource[size]) {
              editManualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };
            }
            const remainingVentaPublico = Math.max(0, ventaPublicoStock - currentSource.ventaPublico);
            const remainingGeneral = Math.max(0, generalStock - currentSource.general);
            if (remainingVentaPublico > 0) {
              editManualSelectedSizesSource[size].ventaPublico++;
            } else if (remainingGeneral > 0) {
              editManualSelectedSizesSource[size].general++;
            }
            updateEditManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
            updateEditManualLoadButton();
          } else {
            const modal = document.getElementById("no-stock-confirm-modal");
            const confirmYes = document.getElementById("no-stock-confirm-yes");
            const confirmNo = document.getElementById("no-stock-confirm-no");
            if (!modal || !confirmYes || !confirmNo) {
              showOrderEditMessage(
                `Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock})`,
                "error"
              );
              return;
            }
            const modalMessage = modal.querySelector("p");
            if (modalMessage) {
              modalMessage.textContent = `Stock máximo alcanzado para talle ${size}. Disponible: ${totalStockAvailable} (Venta Público: ${ventaPublicoStock}, General: ${generalStock}). ¿Desea agregarlo de todas formas? (Útil en caso de mal conteo de stock)`;
            }
            modal.classList.add("active");
            const userConfirmed = await new Promise((resolve) => {
              const handleYes = () => {
                modal.classList.remove("active");
                const msg = modal.querySelector("p");
                if (msg) {
                  msg.textContent =
                    "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
                }
                confirmYes.removeEventListener("click", handleYes);
                confirmNo.removeEventListener("click", handleNo);
                resolve(true);
              };
              const handleNo = () => {
                modal.classList.remove("active");
                const msg = modal.querySelector("p");
                if (msg) {
                  msg.textContent =
                    "Este producto no tiene stock disponible. ¿Está seguro de que desea agregarlo de todas formas?";
                }
                confirmYes.removeEventListener("click", handleYes);
                confirmNo.removeEventListener("click", handleNo);
                resolve(false);
              };
              confirmYes.addEventListener("click", handleYes);
              confirmNo.addEventListener("click", handleNo);
            });
            if (userConfirmed) {
              editManualSelectedSizes[size] = currentQty + 1;
              editManualSelectedSizesConfirmedWithoutStock[size] = true;
              editManualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };
              updateEditManualSizeButton(size, generalStock, ventaPublicoStock, totalStock);
              updateEditManualLoadButton();
            }
          }
        }
      });
    } else {
      btn.addEventListener("click", async () => {
        const modal = document.getElementById("no-stock-confirm-modal");
        const confirmYes = document.getElementById("no-stock-confirm-yes");
        const confirmNo = document.getElementById("no-stock-confirm-no");
        if (!modal || !confirmYes || !confirmNo) return;
        modal.classList.add("active");
        const userConfirmed = await new Promise((resolve) => {
          const handleYes = () => {
            modal.classList.remove("active");
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(true);
          };
          const handleNo = () => {
            modal.classList.remove("active");
            confirmYes.removeEventListener("click", handleYes);
            confirmNo.removeEventListener("click", handleNo);
            resolve(false);
          };
          confirmYes.addEventListener("click", handleYes);
          confirmNo.addEventListener("click", handleNo);
        });
        if (userConfirmed) {
          const currentQty = editManualSelectedSizes[size] || 0;
          editManualSelectedSizes[size] = currentQty + 1;
          editManualSelectedSizesConfirmedWithoutStock[size] = true;
          editManualSelectedSizesSource[size] = { ventaPublico: 0, general: 0 };
          let genStock = generalStock;
          let ventaStock = ventaPublicoStock;
          if (variant && generalWarehouseId && ventaPublicoWarehouseId) {
            const { data: sizeWarehouseStocks } = await supabase
              .from("variant_size_warehouse_stock")
              .select("size, warehouse_id, stock_qty")
              .eq("variant_id", variant.id)
              .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
            if (sizeWarehouseStocks) {
              genStock = 0;
              ventaStock = 0;
              sizeWarehouseStocks.forEach((sws) => {
                const swsNormalizedSize = normalizeSize(sws.size);
                if (swsNormalizedSize !== normalizedSize) return;
                if (sws.warehouse_id === generalWarehouseId) genStock = sws.stock_qty || 0;
                else if (sws.warehouse_id === ventaPublicoWarehouseId) ventaStock = sws.stock_qty || 0;
              });
            }
          }
          updateEditManualSizeButton(size, genStock, ventaStock, genStock + ventaStock);
          updateEditManualLoadButton();
        }
      });
    }

    sizesEl.appendChild(btn);
  });

  updateEditManualLoadButton();
}

async function loadEditOrderProductVariants(productId) {
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("id, sku, color, price, products!inner(id, name)")
    .eq("product_id", productId)
    .eq("active", true);
  if (error || !variants?.length) {
    showOrderEditMessage("No hay variantes activas", "error");
    return;
  }
  const variantIds = variants.map((v) => v.id);
  const { data: sizesData } = await supabase
    .from("variant_sizes")
    .select("variant_id, size, stock_qty")
    .in("variant_id", variantIds)
    .order("size");
  const sizesByVariant = new Map();
  (sizesData || []).forEach((row) => {
    if (!sizesByVariant.has(row.variant_id)) sizesByVariant.set(row.variant_id, []);
    const norm = normalizeSize(row.size);
    if (norm) sizesByVariant.get(row.variant_id).push({ size: norm, stock_qty: row.stock_qty || 0 });
  });
  editManualProduct = variants[0].products;
  editManualVariants = [];
  variants.forEach((v) => {
    const sizeRows = sizesByVariant.get(v.id) || [];
    if (sizeRows.length) {
      sizeRows.forEach((row) => editManualVariants.push({ ...v, size: row.size, stock_qty: row.stock_qty }));
    } else {
      editManualVariants.push({ ...v, size: null, stock_qty: 0 });
    }
  });
  editManualSelectedColor = null;
  editManualSelectedSizes = {};
  editManualSelectedSizesSource = {};
  editManualSelectedSizesConfirmedWithoutStock = {};
  const infoEl = document.getElementById("order-edit-manual-info");
  const nameEl = document.getElementById("order-edit-manual-name");
  const priceEl = document.getElementById("order-edit-manual-price");
  if (infoEl) infoEl.style.display = "flex";
  if (nameEl) nameEl.textContent = editManualProduct.name;

  const addBtn = document.getElementById("order-edit-manual-add-btn");
  if (addBtn) addBtn.disabled = true;
  const colors = [...new Set(editManualVariants.map((x) => x.color).filter(Boolean))];
  const colorsEl = document.getElementById("order-edit-manual-colors");
  const sizesEl = document.getElementById("order-edit-manual-sizes");
  if (!colorsEl || !sizesEl) return;
  colorsEl.innerHTML = "";
  sizesEl.innerHTML = "";

  colors.forEach((c) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "color-btn edit-manual-color";
    btn.dataset.color = c;
    btn.textContent = c;
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      editManualSelectedColor = c;
      editManualSelectedSizes = {};
      editManualSelectedSizesSource = {};
      editManualSelectedSizesConfirmedWithoutStock = {};
      colorsEl.querySelectorAll(".edit-manual-color").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const firstOfColor = editManualVariants.find((v) => v.color === c);
      if (firstOfColor && priceEl) {
        priceEl.textContent = `$${Number(firstOfColor.price).toLocaleString("es-AR")}`;
      }
      await paintOrderEditManualSizesForColor(c);
    });
    colorsEl.appendChild(btn);
  });

  if (colors.length) {
    editManualSelectedColor = colors[0];
    colorsEl.querySelector(".edit-manual-color")?.classList.add("active");
    const firstOfColor = editManualVariants.find((v) => v.color === colors[0]);
    if (firstOfColor && priceEl) {
      priceEl.textContent = `$${Number(firstOfColor.price).toLocaleString("es-AR")}`;
    }
    await paintOrderEditManualSizesForColor(colors[0]);
  }
}

document.getElementById("order-edit-manual-add-btn")?.addEventListener("click", async () => {
  if (!editManualProduct || !editManualSelectedColor) return;
  const hasSelections = Object.keys(editManualSelectedSizes).some((sz) => editManualSelectedSizes[sz] > 0);
  if (!hasSelections) return;

  const isReturnMode = !!document.getElementById("order-edit-return-mode")?.checked;
  const variantsByColor = editManualVariants.filter((v) => v.color === editManualSelectedColor);
  const variantIds = variantsByColor.map((v) => v.id).filter(Boolean);
  const normalizedSizes = Object.keys(editManualSelectedSizes)
    .map((sz) => normalizeSize(sz))
    .filter(Boolean);
  const sizeStockMap = await fetchEditOrderManualSizeStockMap(variantIds, normalizedSizes);

  let hasStockError = false;
  for (const size of Object.keys(editManualSelectedSizes)) {
    const quantity = editManualSelectedSizes[size];
    if (quantity <= 0) continue;
    const variant = variantsByColor.find((v) => normalizeSize(v.size) === normalizeSize(size));
    if (!variant) continue;

    const norm = normalizeSize(size);
    const stockKey = `${variant.id}_${norm}`;
    let totalStock = 0;
    if (sizeStockMap.has(stockKey)) {
      totalStock = sizeStockMap.get(stockKey).total || 0;
    }
    if (totalStock === 0 && Number(variant.stock_qty) > 0) {
      totalStock = Number(variant.stock_qty);
    }

    if (!isReturnMode && quantity > totalStock && !editManualSelectedSizesConfirmedWithoutStock[size]) {
      showOrderEditMessage(
        `La cantidad (${quantity}) para talle ${size} supera el stock disponible (${totalStock}).`,
        "error"
      );
      hasStockError = true;
      break;
    }
  }
  if (hasStockError) return;

  for (const size of Object.keys(editManualSelectedSizes)) {
    const quantity = editManualSelectedSizes[size];
    if (quantity <= 0) continue;
    const variant = variantsByColor.find((v) => normalizeSize(v.size) === normalizeSize(size));
    if (!variant) continue;
    const unitPrice = Math.abs(parseARSNumber(variant.price || 0));
    editOrderItems.push({
      variant_id: variant.id,
      product_name: editManualProduct.name,
      color: editManualSelectedColor || "",
      size: size || "",
      quantity,
      price_snapshot: isReturnMode ? -unitPrice : unitPrice,
    });
  }

  document.getElementById("order-edit-manual-product").value = "";
  document.getElementById("order-edit-manual-info").style.display = "none";
  editManualProduct = null;
  editManualVariants = [];
  editManualSelectedColor = null;
  editManualSelectedSizes = {};
  editManualSelectedSizesSource = {};
  editManualSelectedSizesConfirmedWithoutStock = {};
  renderOrderEditModal();
  showOrderEditMessage(isReturnMode ? "Devolución agregada al pedido" : "Producto agregado al pedido", "success");
});

// Función para renderizar tarjeta de pedido local
function renderLocalOrderCard(order) {
  const statusLabels = {
    pending: 'Pendiente',
    ready: 'Listo',
    completed: 'Completado',
    cancelled: 'Cancelado'
  };

  const statusClasses = {
    pending: 'pending',
    ready: 'ready',
    completed: 'completed',
    cancelled: 'cancelled'
  };

  const statusLabel = statusLabels[order.status] || order.status;
  const statusClass = statusClasses[order.status] || 'pending';

  const items = Array.isArray(order.items) ? order.items : [];
  const nCount = Number(order.item_count);
  const lineCount =
    Number.isFinite(nCount) && nCount > 0 ? Math.floor(nCount) : items.length;
  const lineCountLabel = lineCount === 1 ? "1 línea" : `${lineCount} líneas`;

  const formatLine = (item) => {
    const q = Number(item.quantity) || 0;
    return (
      `${escapeHtml(item.product_name || "")}` +
      (item.color ? ` - ${escapeHtml(item.color)}` : "") +
      (item.size ? ` (${escapeHtml(item.size)})` : "") +
      ` x${q}`
    );
  };

  const itemsSummary = items.slice(0, 3).map(formatLine).join(", ");
  const moreItems = items.length > 3 ? ` y ${items.length - 3} más` : "";

  const fullListHtml = items.map((item) => `<div class="local-order-line">${formatLine(item)}</div>`).join("");

  let itemsBody = "";
  if (order.itemsLoadError && items.length === 0 && lineCount > 0) {
    itemsBody = `
      <p class="local-order-items-warn">${lineCountLabel}. No se pudieron cargar las líneas aquí. Usá «Cargar en Caja 1» para ver y editar el pedido completo.</p>`;
  } else {
    itemsBody = `
      <div class="local-order-line-count" aria-label="Cantidad de líneas del pedido">${escapeHtml(lineCountLabel)} · resumen</div>
      <div class="local-order-items-preview">${itemsSummary}${moreItems}</div>
      ${
        items.length > 3
          ? `<details class="local-order-items-detail">
        <summary class="local-order-items-summary">Ver listado completo (${lineCount} líneas)</summary>
        <div class="local-order-items-full">${fullListHtml}</div>
      </details>`
          : ""
      }
      <p class="local-order-items-hint">Podés revisar y modificar todo en «Cargar en Caja 1».</p>`;
  }

  const createdAt = new Date(order.created_at);
  const dateStr = createdAt.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  return `
    <div class="local-order-card">
      <div class="local-order-header">
        <div class="local-order-number">
          Pedido ${order.order_number || order.id.substring(0, 8)}
          ${order.source_order_id ? '<span class="local-order-badge">Desde Orders</span>' : ''}
        </div>
        <div class="local-order-customer-name">
          ${escapeHtml(order.customer_name || 'Cliente sin nombre')}
          ${order.customer_number ? ` <span style="font-size: 13px; color: #666;">(Nº ${escapeHtml(order.customer_number)})</span>` : ''}
        </div>
        <div class="local-order-status ${statusClass}">${statusLabel}</div>
      </div>
      <div class="local-order-items">
        ${itemsBody}
      </div>
      <div class="local-order-total">
        <span>Total:</span>
        <span style="color: #CD844D;">$${parseARSNumber(order.total_amount || 0).toLocaleString('es-AR')}</span>
        <div class="local-order-date">${dateStr}</div>
      </div>
      <div class="local-order-actions">
        <button class="btn btn-primary" data-load-order-to-sale="${order.id}" style="flex: 1; padding: 8px 12px; font-size: 13px;">
          Cargar en Caja 1
        </button>
      </div>
    </div>
  `;
}

// Función para abrir modal de crear pedido local
if (createLocalOrderBtn) {
  createLocalOrderBtn.addEventListener("click", () => {
    openCreateLocalOrderModal();
  });
}

// Event listener para el buscador de pedidos
if (ordersSearchInput) {
  let searchTimeout;
  ordersSearchInput.addEventListener("input", (e) => {
    clearTimeout(searchTimeout);
    const searchTerm = e.target.value;

    // Debounce: esperar 300ms después de que el usuario deje de escribir
    searchTimeout = setTimeout(() => {
      loadLocalOrders(searchTerm);
    }, 300);
  });

  // También buscar al presionar Enter
  ordersSearchInput.addEventListener("keypress", (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimeout);
      loadLocalOrders(e.target.value);
    }
  });
}

// Función para abrir modal de crear pedido local (similar a order-creator pero adaptado)
function openCreateLocalOrderModal() {
  // Por ahora, mostrar un mensaje indicando que se puede crear desde orders
  // En el futuro se puede implementar un modal completo similar a order-creator
  alert("Para crear un pedido local, puede usar la interfaz de creación de pedidos en la sección de Orders, o contactar al administrador para implementar la creación directa desde aquí.");

  // Alternativa: abrir el modal de crear pedido de orders.html pero adaptado
  // Por simplicidad, vamos a crear una función básica que use la misma lógica
  // pero con public_sales_customers y rpc_create_local_order

  // TODO: Implementar modal completo de creación de pedidos locales
  // que reutilice la interfaz de order-creator.js pero adaptada
}

// Función para cargar pedido local en caja 1
async function loadLocalOrderToSale(localOrderId) {
  try {
    const { data, error } = await supabase.rpc("rpc_load_local_order_to_sale", {
      p_local_order_id: localOrderId
    });

    if (error) throw error;

    // Cerrar modal de pedidos
    ordersModal.classList.remove("active");

    // Guardar el ID del pedido local para marcarlo como completado después
    currentLocalOrderId = localOrderId;

    // Establecer currentPendingSale con la compra pendiente creada
    // Esto permite que la lógica de finalización funcione correctamente
    if (data.pending_sale_id) {
      currentPendingSale = {
        id: data.pending_sale_id,
        source_caja: 1,
        sale_data: data.sale_data,
        status: 'pending'
      };
    }

    // Cargar datos en el formulario (similar a loadPendingSaleIntoForm)
    const saleData = data.sale_data;

    // Seleccionar cliente
    if (saleData.customer) {
      selectedCustomer = saleData.customer;
      customerSearch.value = `${saleData.customer.first_name} ${saleData.customer.last_name || ''}`.trim();
      customerInfo.classList.add("active");
      customerName.textContent = customerSearch.value;

      // Actualizar visibilidad del botón Guardar Pedido
      updateSaveOrderButtonVisibility();

      await loadCustomerCredits(saleData.customer.id);
    }

    // Limpiar items actuales
    saleItems = [];

    // Cargar items del pedido
    if (saleData.items && Array.isArray(saleData.items)) {
      for (const item of saleData.items) {
        // Buscar variante si tiene variant_id
        if (item.variant_id) {
          const { data: variantData } = await supabase
            .from("product_variants")
            .select("*, products(*)")
            .eq("id", item.variant_id)
            .maybeSingle();

          if (variantData) {
            // Agregar item a saleItems usando la estructura existente
            const quantity = item.quantity || 1;
            const price = resolveOrderItemUnitPrice(item.price_snapshot, variantData.price);
            const itemTotalValue = price * quantity;

            saleItems.push({
              product_name: item.product_name || variantData.products?.name || 'Producto',
              sku: variantData.sku ? variantData.sku.split('-')[0] : '',
              color: item.color || variantData.color || '',
              price: price,
              basePrice: price,
              offerInfo: null,
              promotionInfo: null,
              sizes: [{
                size: item.size || variantData.size || '',
                quantity: quantity,
                variantId: variantData.id,
                source: { ventaPublico: quantity, general: 0 }
              }],
              totalQuantity: quantity,
              totalValue: itemTotalValue,
              isReturn: false,
              fromLocalOrder: true, // Flag para indicar que viene de pedido local (stock ya descontado)
              localOrderItemId: item.id || null // ID del item del pedido local para poder liberar stock si se elimina
            });
          }
        } else {
          // Sin variant_id = extra especial (cargado desde pedido). Marcar como extra y manejar precio unitario/total.
          const quantity = item.quantity || 1;
          const priceSnapshot = parseARSNumber(item.price_snapshot || 0);
          // BD puede tener price_snapshot como total (pedidos antiguos) o unitario; con qty=1 son iguales.
          const unitPrice = quantity === 1 ? priceSnapshot : priceSnapshot / quantity;
          const itemTotalValue = quantity === 1 ? priceSnapshot : priceSnapshot;

          saleItems.push({
            isExtra: true,
            isSpecialExtra: true,
            extraType: 'special',
            productName: item.product_name || 'Producto',
            product_name: item.product_name || 'Producto',
            sku: 'EXTRA-ESPECIAL',
            color: item.color || '-',
            price: unitPrice,
            basePrice: unitPrice,
            offerInfo: null,
            promotionInfo: null,
            sizes: [],
            totalQuantity: quantity,
            totalValue: itemTotalValue,
            isReturn: false,
            fromLocalOrder: true,
            localOrderItemId: item.id || null
          });
        }
      }

      // Renderizar lista y actualizar totales
      renderSaleList();
      await calculateTotals();
    }

    // Actualizar visibilidad del botón Guardar Pedido
    updateSaveOrderButtonVisibility();

    showMessage("Pedido cargado en caja 1", "success");

  } catch (error) {
    console.error("Error cargando pedido en caja 1:", error);
    showMessage("Error al cargar pedido: " + error.message, "error");
  }
}

// Función para guardar pedido local
async function saveLocalOrder() {
  // Validar que hay productos (excluyendo extras)
  const productItems = saleItems.filter(item => !item.isExtra);
  if (productItems.length === 0) {
    showMessage("No hay productos para guardar", "error");
    return;
  }

  // Validar que hay un cliente seleccionado
  if (!selectedCustomer || !selectedCustomer.id) {
    showMessage("Debe seleccionar un cliente para guardar el pedido", "error");
    return;
  }

  try {
    // Preparar items en el formato requerido por rpc_create_local_order
    const items = [];

    for (const item of productItems) {
      // Si el item es devolución, no lo incluimos en el pedido
      if (item.isReturn) continue;

      for (const size of item.sizes) {
        // Obtener imagen del producto si está disponible
        let imagen = null;
        if (item.productId) {
          try {
            const { data: productData } = await supabase
              .from("products")
              .select("imagen")
              .eq("id", item.productId)
              .maybeSingle();

            if (productData && productData.imagen) {
              // Si imagen es un array, tomar la primera
              if (Array.isArray(productData.imagen)) {
                imagen = productData.imagen[0] || null;
              } else {
                imagen = productData.imagen;
              }
            }
          } catch (imgError) {
            console.warn("Error obteniendo imagen del producto:", imgError);
          }
        }

        const payloadItem = {
          variant_id: size.variantId || null,
          product_name: item.productName || item.product_name || 'Producto',
          color: item.color || '',
          size: size.size || '',
          quantity: size.quantity || 1,
          price_snapshot: parseARSNumber(item.price ?? item.basePrice ?? 0),
          imagen: imagen,
        };

        // Importante:
        // - Si NO enviamos source, el backend descuenta automáticamente (venta-publico y si no alcanza, general).
        // - Solo enviamos source cuando existe (incluye el caso confirmado "sin stock" => 0,0).
        if (size && size.source && (Object.prototype.hasOwnProperty.call(size.source, 'ventaPublico') || Object.prototype.hasOwnProperty.call(size.source, 'general'))) {
          payloadItem.source = {
            venta_publico: size.source.ventaPublico || 0,
            general: size.source.general || 0
          };
        }

        items.push(payloadItem);
      }
    }

    if (items.length === 0) {
      showMessage("No hay productos válidos para guardar", "error");
      return;
    }

    // Preparar extras (si los hay)
    const extraItems = saleItems.filter(item => item.isExtra);
    const extras = {};

    // Separar extras por tipo
    const numericExtras = extraItems.filter(item => item.extraType === 'numeric');
    const percentageExtras = extraItems.filter(item => item.extraType === 'percentage');
    const specialExtras = extraItems.filter(item => item.extraType === 'special');

    // Procesar extras numéricos y porcentuales para el objeto extras
    if (numericExtras.length > 0) {
      numericExtras.forEach(extra => {
        extras.extras_amount = (extras.extras_amount || 0) + extra.totalValue;
      });
    }

    if (percentageExtras.length > 0) {
      percentageExtras.forEach(extra => {
        extras.extras_percentage = (extras.extras_percentage || 0) + extra.value;
      });
    }

    // Agregar extras especiales al array items (precio unitario: backend hace quantity * price_snapshot)
    specialExtras.forEach(extra => {
      const qty = extra.totalQuantity || 1;
      items.push({
        variant_id: null, // Los extras especiales no tienen variant_id
        product_name: extra.productName || `Extra especial: $${extra.totalValue.toLocaleString('es-AR')}`,
        color: '',
        size: '',
        quantity: qty,
        price_snapshot: extra.totalValue / qty,
        imagen: null
      });
    });

    // Deshabilitar botón mientras se procesa
    if (saveOrderBtn) {
      saveOrderBtn.disabled = true;
      saveOrderBtn.style.opacity = "0.6";
      saveOrderBtn.textContent = "Guardando...";
    }

    // Llamar a rpc_create_local_order
    const { data, error } = await supabase.rpc("rpc_create_local_order", {
      p_customer_id: selectedCustomer.id,
      p_items: items,
      p_extras: Object.keys(extras).length > 0 ? extras : {}
    });

    if (error) throw error;

    // Debug: Verificar que el pedido se guardó correctamente
    console.log("✅ Pedido guardado:", data);
    console.log("Order ID:", data.local_order_id);
    console.log("Order Number:", data.order_number);

    // Mostrar mensaje de éxito
    showMessage(`Pedido guardado correctamente: ${data.order_number}`, "success");

    // Limpiar la caja
    saleItems = [];
    selectedCustomer = null;
    if (customerSearch) customerSearch.value = "";
    if (customerInfo) customerInfo.classList.remove("active");
    if (customerName) customerName.textContent = "";

    // Renderizar lista vacía
    renderSaleList();
    await calculateTotals();

    // Actualizar visibilidad del botón Guardar Pedido
    updateSaveOrderButtonVisibility();

    // Abrir modal de pedidos y mostrar el pedido guardado en "Nuevo Pedido"
    if (ordersModal) {
      ordersModal.classList.add("active");
      // Cambiar a la pestaña "Nuevo Pedido" para mostrar el pedido guardado
      switchOrdersTab('new');
      // Esperar un momento para asegurar que el pedido se haya guardado completamente
      await new Promise(resolve => setTimeout(resolve, 500));
      await loadLocalOrders();
    }

  } catch (error) {
    console.error("Error guardando pedido local:", error);
    showMessage("Error al guardar pedido: " + error.message, "error");
  } finally {
    // Rehabilitar botón
    if (saveOrderBtn) {
      saveOrderBtn.disabled = false;
      saveOrderBtn.style.opacity = "1";
      saveOrderBtn.textContent = "Guardar Pedido";
    }
  }
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
const __voidedSaleIds = new Set();

async function fetchVoidedAtMap(saleIds) {
  const map = new Map();
  const ids = (saleIds || []).filter(Boolean);
  if (ids.length === 0) return map;

  // Evitar pedir demasiado en una sola query (PostgREST limita tamaño de URL/payload)
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("public_sales")
      .select("id, voided_at")
      .in("id", chunk);
    if (error) throw error;
    (data || []).forEach((row) => map.set(row.id, row.voided_at));
  }
  return map;
}

async function loadSalesHistory(append = false) {
  try {
    // Si hay búsqueda por cliente, ignorar el filtro de fecha y cargar todos los pedidos
    const hasCustomerSearch = currentHistoryCustomerSearch && currentHistoryCustomerSearch.trim().length > 0;
    const dateFilter = hasCustomerSearch ? null : (currentHistoryDate || null);

    // Cargar todos los pedidos sin paginación (límite alto para evitar demoras)
    const { data, error } = await supabase
      .rpc("rpc_get_public_sales_history", {
        p_limit: 10000, // Límite muy alto para cargar todos los pedidos
        p_offset: 0, // Sin paginación
        p_date_filter: dateFilter,
        p_customer_search: currentHistoryCustomerSearch || null
      });

    if (error) throw error;

    const sales = data || [];

    // Auditoría/robustez: si el RPC de historial no trae voided_at en este entorno,
    // consultamos la tabla para marcar anuladas de forma persistente (sobrevive recargas).
    // Esto también evita que el usuario pueda tocar "×" en una venta ya anulada.
    try {
      const idsNeedingVoidedCheck = sales
        .filter((s) => s && s.id && !s.voided_at)
        .map((s) => s.id);
      const voidedMap = await fetchVoidedAtMap(idsNeedingVoidedCheck);
      sales.forEach((s) => {
        if (!s || !s.id) return;
        const v = voidedMap.get(s.id);
        if (v && !s.voided_at) s.voided_at = v;
      });
    } catch (e) {
      // Si falla esta consulta auxiliar (RLS/permisos), no rompemos el historial.
      console.warn("No se pudo validar voided_at desde public_sales:", e);
    }

    // Limpiar lista siempre (no hay append)
    historyList.innerHTML = "";

    if (sales.length === 0) {
      historyList.innerHTML = "<p style='padding: 20px; text-align: center; color: #666;'>No hay ventas registradas para los filtros seleccionados</p>";
      document.getElementById("history-details").style.display = "none";
      return;
    }

    // Agregar ventas a la lista (con botón Imprimir y botón X para anular si no está anulada)
    const salesHtml = sales.map(sale => {
      const isExpanded = expandedSaleId === sale.id;
      const isVoided = !!sale.voided_at || __voidedSaleIds.has(sale.id);
      return `
        <div class="history-sale-item" data-sale-id="${sale.id}" style="padding: 12px; border: 1px solid #ddd; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: background 0.2s; display: flex; align-items: center; justify-content: space-between; gap: 8px; ${isExpanded ? 'background: #f8f9fa; border-color: #CD844D;' : ''}" onclick="toggleSaleDetails('${sale.id}')">
          <div style="flex: 1; min-width: 0;">
            <div><strong>${escapeHtml(sale.sale_number)}</strong>${isVoided ? ' <span class="history-sale-voided-badge">Anulada</span>' : ''}</div>
            <div style="font-size: 12px; color: #666;">
              ${new Date(sale.created_at).toLocaleString('es-AR')} | 
              ${sale.customer_name || 'Sin cliente'} | 
              <span style="${parseARSNumber(sale.total_amount) < 0 ? 'color: #dc3545; font-weight: 700;' : ''}">
                ${parseARSNumber(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseARSNumber(sale.total_amount)).toLocaleString('es-AR')}
              </span>
            </div>
          </div>
          <div style="display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0;">
            <button type="button" class="history-sale-print-btn" onclick="event.stopPropagation(); reprintHistorySale('${sale.id}')" title="Reimprimir ticket">Imprimir</button>
            ${!isVoided ? `<button type="button" class="history-sale-void-btn" onclick="event.stopPropagation(); voidSale('${sale.id}')" title="Anular venta">×</button>` : ''}
          </div>
        </div>
      `;
    }).join("");

    historyList.innerHTML = salesHtml;

    // Si hay una venta expandida, mostrar sus detalles
    if (expandedSaleId) {
      await showSaleDetails(expandedSaleId, true);
    }

  } catch (error) {
    console.error("Error cargando historial:", error);
    historyList.innerHTML = "<p style='padding: 20px; text-align: center; color: #dc3545;'>Error al cargar historial</p>";
  }
}

// Anular venta y restablecer stock en venta al público
const __voidSaleInFlight = new Set();
const __reprintSaleInFlight = new Set();

window.reprintHistorySale = async function (saleId) {
  if (__reprintSaleInFlight.has(saleId)) return;
  try {
    __reprintSaleInFlight.add(saleId);

    const { data: saleDetails, error: detailsError } = await supabase
      .rpc("rpc_get_public_sale_details", { p_sale_id: saleId });
    if (detailsError) throw detailsError;
    if (!saleDetails?.sale) throw new Error("No se encontraron detalles de la venta");

    const sale = saleDetails.sale;
    let customer = null;

    if (sale.customer_id) {
      const { data: customerData, error: customerError } = await supabase
        .from("customers")
        .select("id, first_name, last_name, customer_number, qr_code")
        .eq("id", sale.customer_id)
        .maybeSingle();
      if (customerError) throw customerError;
      customer = customerData || null;
    }

    await printDirectly(saleDetails, customer, null);
  } catch (error) {
    console.error("Error reimprimiendo ticket:", error);
    showMessage("Error al reimprimir ticket: " + (error?.message || "Error desconocido"), "error");
  } finally {
    __reprintSaleInFlight.delete(saleId);
  }
};

window.voidSale = async function (saleId) {
  if (__voidSaleInFlight.has(saleId)) return;
  if (!confirm('¿Anular esta venta? El stock se reestablecerá en venta al público.')) {
    return;
  }
  try {
    __voidSaleInFlight.add(saleId);
    const { data, error } = await supabase.rpc('rpc_void_public_sale', { p_sale_id: saleId });
    if (error) throw error;
    __voidedSaleIds.add(saleId);
    showMessage('Venta anulada correctamente. Stock restablecido en venta al público.', 'success');
    if (expandedSaleId === saleId) {
      expandedSaleId = null;
      const detailsDiv = document.getElementById('history-details');
      if (detailsDiv) detailsDiv.style.display = 'none';
    }
    await loadSalesHistory();
  } catch (error) {
    // Si ya estaba anulada en backend, lo tratamos como estado válido y refrescamos UI.
    const code = error?.code || error?.details?.code;
    const msg = typeof error?.message === "string" ? error.message : String(error?.message || "");
    const detailsMsg =
      typeof error?.details === "string"
        ? error.details
        : error?.details != null
          ? JSON.stringify(error.details)
          : "";
    const hintMsg =
      typeof error?.hint === "string"
        ? error.hint
        : error?.hint != null
          ? JSON.stringify(error.hint)
          : "";
    const combined = `${msg}\n${detailsMsg}\n${hintMsg}`.trim();
    if (code === 'P0001' && /ya\s+est[aá]\s+anulad/i.test(combined)) {
      __voidedSaleIds.add(saleId);
      showMessage('La venta ya estaba anulada. Se actualizó el historial.', 'success');
      await loadSalesHistory();
      return;
    }
    console.error('Error anulando venta:', error);
    showMessage(
      'Error al anular venta: ' +
        (combined || error?.message || 'Error desconocido'),
      'error'
    );
  } finally {
    __voidSaleInFlight.delete(saleId);
  }
};

// Alternar detalles de venta
window.toggleSaleDetails = async function (saleId) {
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
window.showSaleDetails = async function (saleId, inModal = false) {
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
                <td style="padding: 12px; text-align: right; color: #666;">$${parseARSNumber(item.price).toLocaleString('es-AR')}</td>
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
                <td style="padding: 12px; text-align: right; ${parseARSNumber(sale.total_amount) < 0 ? 'color: #dc3545;' : 'color: #333;'}">
                  ${parseARSNumber(sale.total_amount) < 0 ? '-' : ''}$${Math.abs(parseARSNumber(sale.total_amount)).toLocaleString('es-AR')}
                </td>
              </tr>
            ${sale.credit_used > 0 ? `
              <tr style="background: #fff9e6;">
                <td colspan="6" style="padding: 8px; color: #856404;">Crédito usado</td>
                <td style="padding: 8px; text-align: right; color: #856404; font-weight: 600;">$${parseARSNumber(sale.credit_used).toLocaleString('es-AR')}</td>
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
          Cantidad: ${item.qty} - $${parseARSNumber(item.price).toLocaleString('es-AR')}
        </div>
      `).join("");

      alert(`
        Venta: ${sale.sale_number}
        Fecha: ${new Date(sale.created_at).toLocaleString('es-AR')}
        Cliente: ${sale.customer_name || 'Sin cliente'}
        Total: $${parseARSNumber(sale.total_amount).toLocaleString('es-AR')}
        Items: ${sale.item_count}
        ${sale.credit_used > 0 ? `Crédito usado: $${parseARSNumber(sale.credit_used).toLocaleString('es-AR')}` : ''}
        
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

// Foco automático en el input de SKU al cargar la página (para lectoras de código)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      if (skuSearch) skuSearch.focus();
    }, 100);
  });
} else {
  setTimeout(() => {
    if (skuSearch) skuSearch.focus();
  }, 100);
}

