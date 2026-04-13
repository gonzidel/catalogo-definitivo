// closed-orders.js - Módulo de gestión de pedidos cerrados

// Importar configuración de Supabase y QZ
import { SUPABASE_URL, QZ_SIGN_SECRET } from "../scripts/config.js";
import {
  canonicalizeTransportName,
  normalizeTransportKey,
} from "../scripts/transport-canonical.js";
import { parseARSNumber, resolveOrderItemUnitPrice } from "../scripts/utils/price.js";

const TIMEZONE_BUENOS_AIRES = "America/Argentina/Buenos_Aires";

let supabase = null;
let orders = [];
let scheduledTransports = [];
let currentSearch = '';
let searchDebounce = null;
let currentAdminUser = null;
let realtimeSubscription = null;
let isRealtimeSubscribed = false;
const closedOrdersVariantPriceMap = new Map(); // variant_id -> price de catálogo (raw)

// Función para obtener supabase
async function getSupabase() {
  if (supabase) return supabase;
  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }

  let attempts = 0;
  const maxAttempts = 50;
  while (!window.supabase && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }

  if (window.supabase) {
    supabase = window.supabase;
    return supabase;
  }

  try {
    const module = await import("../scripts/supabase-client.js");
    supabase = module.supabase || window.supabase;
    if (supabase && !window.supabase) {
      window.supabase = supabase;
    }
    return supabase;
  } catch (error) {
    console.error("❌ Error importando supabase-client:", error);
    return null;
  }
}

// Función para verificar autenticación de admin
async function verifyAdminAuth() {
  try {
    if (!supabase) {
      supabase = await getSupabase();
    }
    if (!supabase) return false;

    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return false;

    const { data: adminRow, error: adminError } = await supabase
      .from("admins")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (adminError || !adminRow) return false;

    currentAdminUser = user;
    return true;
  } catch (error) {
    console.error("❌ Error en verifyAdminAuth:", error);
    return false;
  }
}

// Función para formatear moneda
function formatCurrency(value) {
  const amount = parseARSNumber(value);
  return `$${amount.toLocaleString("es-AR")}`;
}

function getClosedOrderUnitPrice(item) {
  const variantId = item?.variant_id != null ? String(item.variant_id).trim() : "";
  const variantPrice = variantId ? closedOrdersVariantPriceMap.get(variantId) : null;
  return resolveOrderItemUnitPrice(item?.price_snapshot, variantPrice);
}

// ============================================================================
// QZ Tray - Funciones helper para TSC
// ============================================================================

// Función helper para configurar firma remota de QZ Tray
async function setupQZSignature() {
  // Esperar a que QZ Tray se cargue
  const isAvailable = await checkQZAvailable();
  
  if (!isAvailable || !qz || !qz.security) {
    console.warn("⚠️ QZ Tray no disponible para configurar firma");
    return false;
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

      // Obtener secret y URL desde config (requiere QZ_SIGN_SECRET en config.local.js)
      const secret = QZ_SIGN_SECRET ||
        (typeof window !== 'undefined' ? window.QZ_SIGN_SECRET : "");
      if (!secret) {
        throw new Error("QZ_SIGN_SECRET no configurado. Agrega QZ_SIGN_SECRET en scripts/config.local.js");
      }

      const supabaseUrl = SUPABASE_URL || 
        (typeof window !== 'undefined' ? window.SUPABASE_URL : "");

      if (!supabaseUrl) {
        console.error("❌ SUPABASE_URL no definido");
        throw new Error("SUPABASE_URL no definido");
      }

      console.log("📡 Enviando request de firma a Edge Function...");
      console.log("📤 toSign a enviar (len=" + toSign.length + "):", toSign.substring(0, 50) + "...");

      // IMPORTANTE: Enviar toSign como text/plain (no JSON) para evitar alteraciones
      // QZ Tray requiere que el string llegue exactamente igual, sin JSON.stringify
      const res = await fetch(`${supabaseUrl}/functions/v1/qz-sign`, {
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
    return true;
  } catch (e) {
    console.error("❌ Error setupQZSignature:", e);
    return false;
  }
}

/**
 * Verifica si QZ Tray está disponible y listo
 * @returns {Promise<boolean>}
 */
async function checkQZAvailable() {
  // Esperar hasta 5 segundos a que QZ Tray se cargue
  const maxWait = 5000;
  const startTime = Date.now();
  
  while (typeof qz === 'undefined' || !qz || !qz.websocket) {
    if (Date.now() - startTime > maxWait) {
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  return true;
}

async function qzConnect() {
  // Verificar que QZ Tray esté disponible
  const isAvailable = await checkQZAvailable();
  
  if (!isAvailable) {
    const error = new Error("QZ Tray no está disponible. Verificá que:\n" +
      "1. QZ Tray esté instalado en tu sistema\n" +
      "2. QZ Tray esté corriendo (buscalo en la bandeja del sistema)\n" +
      "3. El navegador tenga permisos para acceder a QZ Tray");
    console.error("❌", error.message);
    throw error;
  }

  // Asegurar que el certificado y la firma estén configurados ANTES de conectar
  await setupQZSignature();

  if (!qz.websocket.isActive()) {
    try {
      console.log("🚀 conectando QZ...");
      await qz.websocket.connect();
      console.log("✅ QZ Tray conectado");
    } catch (error) {
      console.error("❌ Error conectando QZ Tray:", error);
      
      // Mejorar mensaje de error
      if (error.message && error.message.includes("Unable to establish connection")) {
        const improvedError = new Error("No se pudo establecer conexión con QZ Tray.\n\n" +
          "Posibles causas:\n" +
          "1. QZ Tray no está corriendo (verificá la bandeja del sistema)\n" +
          "2. QZ Tray está bloqueado por firewall o antivirus\n" +
          "3. El certificado no está correctamente configurado\n\n" +
          "Solución: Abrí QZ Tray desde el menú Inicio y verificá que aparezca en la bandeja del sistema.");
        improvedError.stack = error.stack;
        throw improvedError;
      }
      
      throw error;
    }
  }
}

async function qzGetPrinterConfigTsc() {
  await qzConnect();

  const printers = await qz.printers.find();
  console.log("🖨️ Impresoras disponibles en QZ:", printers);

  // Buscar cualquier impresora que tenga "tsc" o "te210" en el nombre
  const printerName =
    printers.find(p => /tsc/i.test(p)) ||
    printers.find(p => /te210/i.test(p));

  if (!printerName) {
    console.error("❌ No se encontró una impresora TSC en la lista:", printers);
    throw new Error(
      "No se encontró una impresora TSC en la lista de QZ Tray. " +
      "Verificá que la TSC TE210 aparezca en el menú Printers de QZ."
    );
  }

  console.log("✅ Impresora TSC seleccionada:", printerName);
  return qz.configs.create(printerName);
}

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
 * Obtiene la configuración de la impresora POS-80 específicamente para tickets
 * @returns {Promise<Object>} Configuración de QZ para la impresora POS-80
 */
async function qzGetPrinterConfigPos80() {
  await qzConnect();

  const printers = await qz.printers.find();
  console.log("🖨️ Impresoras disponibles en QZ:", printers);

  // Buscar impresora POS-80 (case-insensitive, busca "pos-80" o "pos80")
  const printerName = printers.find(p => /pos-80/i.test(p) || /pos80/i.test(p));

  if (!printerName) {
    console.error("❌ No se encontró la impresora POS-80 en la lista:", printers);
    throw new Error(
      "No se encontró la impresora POS-80 en la lista de QZ Tray. " +
      "Verificá que la POS-80 aparezca en el menú Printers de QZ."
    );
  }

  console.log("✅ Impresora POS-80 seleccionada:", printerName);
  return qz.configs.create(printerName);
}

// ============================================================================
// Funciones helper para formateo de tickets
// ============================================================================

const TICKET_WIDTH = 42;

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

// ============================================================================
// Generación de TSPL para rótulos de envío
// ============================================================================

function buildTsplShippingLabel(shippingLabel, packageNumber = 1, totalPackages = 1) {
  const clean = (v) =>
    (v ?? "")
      .toString()
      .replace(/[\r\n]+/g, " ")
      .replace(/"/g, "'");

  const fullName = clean(shippingLabel.fullName).toUpperCase(); // Convertir a mayúsculas
  const address = clean(shippingLabel.address);
  const locality = clean(shippingLabel.locality);
  const province = clean(shippingLabel.province);
  const phone = clean(shippingLabel.phone);
  const carrier = clean(shippingLabel.carrier);
  const itemsCount = clean(shippingLabel.itemsCount);
  const amount = clean(shippingLabel.amount);
  const paymentMethod = clean(shippingLabel.paymentMethod || '');
  const packagesText = totalPackages > 1 ? `${packageNumber} / ${totalPackages}` : "1";

  // Dividir nombre en dos líneas si es muy largo (con tamaño 2.55 caben ~25-28 caracteres)
  let nameLine1 = fullName;
  let nameLine2 = "";
  if (fullName.length > 28) {
    // Buscar el último espacio antes del carácter 28 para dividir en una palabra completa
    const cutPoint = fullName.lastIndexOf(" ", 28);
    if (cutPoint > 0) {
      nameLine1 = fullName.slice(0, cutPoint);
      nameLine2 = fullName.slice(cutPoint + 1);
    } else {
      // Si no hay espacio, cortar en el carácter 28
      nameLine1 = fullName.slice(0, 28);
      nameLine2 = fullName.slice(28);
    }
  }

  // Dividir dirección en dos líneas si es muy larga (con tamaño doble caben ~20-22 caracteres)
  let addressLine1 = address;
  let addressLine2 = "";
  if (address.length > 22) {
    // Buscar el último espacio antes del carácter 22 para dividir en una palabra completa
    const cutPoint = address.lastIndexOf(" ", 22);
    if (cutPoint > 0) {
      addressLine1 = address.slice(0, cutPoint);
      addressLine2 = address.slice(cutPoint + 1);
    } else {
      // Si no hay espacio, cortar en el carácter 22
      addressLine1 = address.slice(0, 22);
      addressLine2 = address.slice(22);
    }
  }

  const lines = [
    'SIZE 98 mm, 80 mm',
    'GAP 3 mm, 0 mm',
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CLS',
  ];

  // Nombre - primera línea (siempre) - usando fuente 3
  let currentY = 30;
  lines.push(`TEXT 20,${currentY},"3",0,2.0,2.0,"${nameLine1}"`);

  // Nombre - segunda línea (si existe)
  if (nameLine2) {
    currentY += 40; // Espacio para la segunda línea con tamaño 2.0
    lines.push(`TEXT 20,${currentY},"3",0,2.0,2.0,"${nameLine2}"`);
    currentY += 40; // Avanzar después de la segunda línea
  } else {
    currentY += 40; // Si solo hay una línea, avanzar igual
  }

  // Dirección - primera línea (siempre)
  // Espacio después del nombre
  currentY += 20;
  lines.push(`TEXT 20,${currentY},"3",0,2,2,"${addressLine1}"`);

  // Dirección - segunda línea (si existe)
  if (addressLine2) {
    currentY += 45; // Espacio para la segunda línea con tamaño doble
    lines.push(`TEXT 20,${currentY},"3",0,2,2,"${addressLine2}"`);
    currentY += 45; // Avanzar después de la segunda línea
  } else {
    currentY += 45; // Si solo hay una línea, avanzar igual
  }

  // Línea horizontal después de la dirección (usando guiones)
  currentY += 10; // Espacio pequeño antes de la línea
  const lineDashes = "-".repeat(50); // Crear línea con guiones (ajustar cantidad según necesidad)
  lines.push(`TEXT 20,${currentY},"1",0,1,1,"${lineDashes}"`);
  currentY += 15; // Espacio después de la línea

  // Localidad y provincia (altura objetivo: 5mm)
  currentY += 10; // Espacio adicional después de línea
  // Construir texto de localidad y provincia
  const cityProvText = `${locality} - ${province}`;
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"${cityProvText}"`);

  // Teléfono - con mismo tamaño que localidad
  currentY += 50; // Espacio entre localidad y teléfono (aumentado para evitar superposición con tamaño 2.5)
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Tel: ${phone}"`);

  // Línea horizontal después del teléfono (usando guiones)
  currentY += 40; // Espacio más grande antes de la línea para no atravesar el teléfono
  const lineDashes2 = "-".repeat(50); // Crear línea con guiones
  lines.push(`TEXT 20,${currentY},"1",0,1,1,"${lineDashes2}"`);
  currentY += 15; // Espacio después de la línea

  // Transporte - espacio doble debajo del teléfono, mismo tamaño
  currentY += 75; // Espacio después de la línea (ajustado desde 100)
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Transporte: ${carrier}"`);

  // Productos - mismo tamaño que transporte, teléfono y localidad
  currentY += 50; // Espacio después del transporte
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Productos: ${itemsCount}"`);

  // Total (en línea separada)
  currentY += 50; // Espacio después de productos
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Total: $${amount}"`);

  // Paquetes - 2 espacios después del total
  currentY += 100; // Espacio doble (50 * 2) después del total
  lines.push(`TEXT 20,${currentY},"2",0,2.5,2.5,"Paquetes: ${packagesText}"`);

  // Remitente en esquina inferior derecha (letra más pequeña)
  // Etiqueta es 98mm x 80mm, posición aproximada en puntos (203 dpi ≈ 8 dots/mm)
  // Ancho: 98mm * 8 = 784 puntos, Alto: 80mm * 8 = 640 puntos
  const remitenteX = 550; // Posición X para alinear a la derecha (con margen)
  const remitenteY = 550; // Posición Y en la parte inferior (con margen)

  // Método de pago arriba de Rte. (sin etiqueta, solo el método, en mayúsculas y letra más grande)
  if (paymentMethod) {
    const paymentMethodUpper = paymentMethod.toUpperCase();

    // Si es "Contra Reembolso", dividir en dos líneas
    if (paymentMethodUpper.includes("CONTRA") && paymentMethodUpper.includes("REEMBOLSO")) {
      // Dividir "CONTRA REEMBOLSO" en dos líneas con más separación
      const contraY = remitenteY - 100; // Más arriba para no tapar Rte. y separar de REEMBOLSO
      const reembolsoY = remitenteY - 45; // Más separado de CONTRA
      lines.push(`TEXT ${remitenteX},${contraY},"2",0,2.2,2.2,"CONTRA"`);
      lines.push(`TEXT ${remitenteX},${reembolsoY},"2",0,2.2,2.2,"REEMBOLSO"`);
    } else {
      // Para otros métodos de pago, mostrar en una sola línea
      lines.push(`TEXT ${remitenteX},${remitenteY - 80},"3",0,2.0,2.0,"${paymentMethodUpper}"`);
    }
  }

  lines.push(`TEXT ${remitenteX},${remitenteY},"1",0,1,1,"Rte. FyL Moda"`);
  lines.push(`TEXT ${remitenteX},${remitenteY + 25},"1",0,1,1,"Av. Alberdi 1099"`);
  lines.push(`TEXT ${remitenteX},${remitenteY + 50},"1",0,1,1,"Resistencia - Chaco"`);

  // Imprimir
  lines.push('PRINT 1');

  // IMPORTANTE: unir con \r\n y terminar en \r\n
  return lines.join('\r\n') + '\r\n';
}

async function debugTscRawPrint() {
  try {
    await qzConnect();
    const cfg = await qzGetPrinterConfigTsc();

    const lines = [
      'SIZE 100 mm, 50 mm',
      'GAP 3 mm, 0',
      'DIRECTION 1',
      'REFERENCE 0,0',
      'CLS',
      'TEXT 40,40,"3",0,1,1,"TEST TSC"',
      'PRINT 1,1'
    ];

    // IMPORTANTE: unir con \r\n y terminar en \r\n
    const tspl = lines.join('\r\n') + '\r\n';

    console.log('📄 TSPL de prueba enviado a TSC:');
    console.log(tspl.split('\r\n'));

    await qz.print(cfg, [{
      type: 'raw',
      format: 'command',
      data: tspl
    }]);

    console.log('✅ Prueba enviada a TSC correctamente');
  } catch (err) {
    console.error('❌ Error en debugTscRawPrint:', err);
    alert('Error imprimiendo prueba en TSC: ' + err.message);
  }
}

async function printTscShippingLabel(shippingLabel, copies = 1) {
  copies = parseInt(copies, 10);
  if (!copies || copies < 1) {
    console.warn("⚠️ Cantidad de copias inválida:", copies);
    return false;
  }

  try {
    await qzConnect();

    const cfg = await qzGetPrinterConfigTsc();

    const jobs = [];
    for (let i = 0; i < copies; i++) {
      // Generar TSPL para cada paquete con su número correspondiente
      const packageNumber = i + 1;
      const tspl = buildTsplShippingLabel(shippingLabel, packageNumber, copies);

      if (i === 0) {
        console.log("📄 TSPL generado (primeras líneas):");
        console.log(tspl.split('\r\n').slice(0, 10));
      }

      jobs.push({
        type: "raw",
        format: "command",
        data: tspl,
      });
    }

    console.log(`🖨️ Enviando ${copies} trabajo(s) de impresión a TSC...`);
    await qz.print(cfg, jobs);
    console.log(`✅ ${copies} rótulo(s) enviado(s) a la impresora TSC`);
    return true;
  } catch (err) {
    console.error("❌ Error imprimiendo rótulo TSC:", err);
    console.error("❌ Detalles del error:", {
      message: err.message,
      stack: err.stack,
      name: err.name
    });
    
    // Mensaje de error más claro
    let errorMessage = "No se pudo imprimir el rótulo en la impresora TSC.\n\n";
    
    if (err.message && err.message.includes("QZ Tray no está disponible")) {
      errorMessage += "❌ QZ Tray no está disponible.\n\n";
      errorMessage += "Pasos para solucionarlo:\n";
      errorMessage += "1. Verificá que QZ Tray esté instalado\n";
      errorMessage += "2. Abrí QZ Tray desde el menú Inicio\n";
      errorMessage += "3. Verificá que aparezca el ícono de QZ Tray en la bandeja del sistema\n";
      errorMessage += "4. Recargá esta página y volvé a intentar\n";
    } else if (err.message && err.message.includes("Unable to establish connection")) {
      errorMessage += "❌ No se pudo conectar con QZ Tray.\n\n";
      errorMessage += "Verificá que:\n";
      errorMessage += "1. QZ Tray esté corriendo (ícono en la bandeja del sistema)\n";
      errorMessage += "2. No haya firewall o antivirus bloqueando la conexión\n";
      errorMessage += "3. El certificado esté correctamente configurado\n";
    } else {
      errorMessage += "Error: " + (err.message || 'Error desconocido');
    }
    
    alert(errorMessage);
    return false;
  }
}

// Función para preparar objeto shippingLabel desde un pedido
function prepareShippingLabelFromOrder(order) {
  let customer = {};
  if (Array.isArray(order.customers)) {
    customer = order.customers[0] || {};
  } else if (order.customers && typeof order.customers === 'object') {
    customer = order.customers;
  }

  // Obtener transporte asignado
  const transportId = (customer.transport_id !== undefined ? customer.transport_id : null) ||
    (order.transport_id !== undefined ? order.transport_id : null);
  const transport = scheduledTransports.find(t => t.id === transportId);
  const carrier = transport ? transport.name : (customer.transport_id ? 'Sin transporte' : 'Sin transporte asignado');

  // Calcular cantidad total de productos
  const itemsCount = (order.order_items || []).reduce(
    (sum, item) => sum + (item.quantity || 0),
    0
  );

  // Obtener monto total
  const hasStoredTotal = order.total_amount != null && String(order.total_amount).trim() !== "";
  const total = hasStoredTotal
    ? parseARSNumber(order.total_amount)
    : (order.order_items || []).reduce(
      (sum, item) => sum + (item.quantity || 0) * getClosedOrderUnitPrice(item),
      0
    );

  // Formatear monto sin símbolo de moneda para el rótulo
  const amount = total.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  // Debug: Verificar datos del customer
  console.log("🔍 Preparando shippingLabel - customer data:", {
    full_name: customer.full_name,
    address: customer.address,
    city: customer.city,
    province: customer.province,
    phone: customer.phone,
    hasAddress: !!customer.address
  });

  return {
    fullName: customer.full_name || "Cliente sin nombre",
    address: customer.address || "Sin dirección",
    locality: customer.city || "Sin localidad",
    province: customer.province || "Sin provincia",
    phone: customer.phone || "Sin teléfono",
    carrier: carrier,
    itemsCount: itemsCount.toString(),
    amount: amount,
    orderCode: order.order_number || order.id.substring(0, 8),
    paymentMethod: order.payment_method || ''
  };
}

// Función para formatear nombre de cliente
function formatCustomerDisplayName(customer) {
  const full = (customer?.full_name || customer?.name || '').trim();
  if (!full) return 'Cliente sin nombre';
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(' ');
  return `${last}, ${first}`;
}

// Función para obtener nombre de cliente
function getCustomerName(order) {
  let customerName = '';
  if (Array.isArray(order.customers)) {
    customerName = order.customers[0]?.full_name || order.customers[0]?.name || '';
  } else if (order.customers && typeof order.customers === 'object') {
    customerName = order.customers.full_name || order.customers.name || '';
  }
  return (customerName || '').toString().toLowerCase();
}

// Función para obtener teléfono del cliente
function getCustomerPhone(order) {
  if (Array.isArray(order.customers)) return (order.customers[0]?.phone || '').toString().toLowerCase();
  if (order.customers && typeof order.customers === 'object') return (order.customers.phone || '').toString().toLowerCase();
  return '';
}

// Función para obtener DNI del cliente
function getCustomerDni(order) {
  if (Array.isArray(order.customers)) return (order.customers[0]?.dni || '').toString().toLowerCase();
  if (order.customers && typeof order.customers === 'object') return (order.customers.dni || '').toString().toLowerCase();
  return '';
}

// Función para filtrar pedidos por búsqueda
function matchesSearch(order) {
  const q = (currentSearch || '').trim().toLowerCase();
  if (!q) return true;
  const name = getCustomerName(order);
  const displayName = (() => {
    const full = name;
    const parts = full.trim().split(/\s+/);
    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      const first = parts.slice(0, -1).join(' ');
      return `${last}, ${first}`.toLowerCase();
    }
    return full;
  })();
  return (
    name.includes(q) ||
    displayName.includes(q) ||
    getCustomerPhone(order).includes(q) ||
    getCustomerDni(order).includes(q)
  );
}

// Función para cargar transportes agendados
async function loadScheduledTransports() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from("transports")
      .select("*")
      .order("name", { ascending: true });

    if (error) {
      // Si la tabla no existe (404), simplemente retornar array vacío
      if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
        console.warn("⚠️ Tabla 'transports' no existe aún. Ejecuta el script SQL primero.");
        scheduledTransports = [];
        return [];
      }
      console.error("❌ Error cargando transportes:", error);
      return [];
    }

    scheduledTransports = data || [];
    return scheduledTransports;
  } catch (err) {
    console.warn("⚠️ Error al cargar transportes (tabla puede no existir):", err.message);
    scheduledTransports = [];
    return [];
  }
}

// Función para obtener ofertas y promociones (reutilizada de orders.js)
async function getOffersAndPromotionsForOrder(order) {
  if (!supabase || !order.order_items || order.order_items.length === 0) {
    return { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  }

  const items = order.order_items.filter(item => item.status !== 'cancelled');
  const variantIds = [];
  const itemVariantMap = new Map();
  const itemToVariantMap = new Map();

  for (const item of items) {
    let variantId = item.variant_id;
    if (variantId) {
      variantIds.push(variantId);
      if (!itemVariantMap.has(variantId)) {
        itemVariantMap.set(variantId, []);
      }
      itemVariantMap.get(variantId).push(item);
      itemToVariantMap.set(item.id, variantId);
    }
  }

  if (variantIds.length === 0) {
    return { offers: [], promotions: [], totalDiscount: 0, itemOffers: new Map(), itemPromos: new Map() };
  }

  const { data: promotionsData, error: promotionsError } = await supabase
    .rpc('get_active_promotions_for_variants', {
      p_variant_ids: variantIds
    });

  const promotions = promotionsError ? [] : (promotionsData || []);
  const itemOffersMap = new Map();
  const itemPromosMap = new Map();

  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const promoText = promo.promo_type === '2x1'
      ? '2x1'
      : promo.promo_type === '2xMonto' && promo.fixed_amount
        ? `2x$${promo.fixed_amount}`
        : null;

    if (promoText) {
      for (const variantId of variantIdsInPromo) {
        const itemsInPromo = itemVariantMap.get(variantId) || [];
        for (const item of itemsInPromo) {
          itemPromosMap.set(item.id, promoText);
        }
      }
    }
  }

  let totalDiscount = 0;
  const appliedPromotions = new Map();

  for (const promo of promotions) {
    const variantIdsInPromo = promo.variant_ids || [];
    const itemsInPromo = [];

    for (const variantId of variantIdsInPromo) {
      const variantItems = itemVariantMap.get(variantId) || [];
      itemsInPromo.push(...variantItems);
    }

    if (itemsInPromo.length === 0) continue;

    let totalQuantity = 0;
    let totalPrice = 0;

    for (const item of itemsInPromo) {
      const qty = item.quantity || 0;
      const price = getClosedOrderUnitPrice(item);
      totalQuantity += qty;
      totalPrice += qty * price;
    }

    if (totalQuantity > 0) {
      const groups = Math.floor(totalQuantity / 2);
      let discount = 0;

      if (promo.promo_type === '2x1') {
        const averagePrice = totalPrice / totalQuantity;
        discount = groups * averagePrice;
      } else if (promo.promo_type === '2xMonto' && promo.fixed_amount) {
        const promoPrice = groups * promo.fixed_amount;
        discount = totalPrice - promoPrice;
      }

      totalDiscount += discount;
    }
  }

  return {
    offers: [],
    promotions: Array.from(appliedPromotions.entries()).map(([type, info]) => ({ type, ...info })),
    totalDiscount: totalDiscount,
    itemOffers: itemOffersMap,
    itemPromos: itemPromosMap
  };
}

// Función para cargar pedidos cerrados
async function loadClosedOrders() {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    console.error("❌ Supabase no disponible");
    return;
  }

  // Primero intentar con todas las columnas nuevas
  let selectFields = `
      id,
      order_number,
      status,
      total_amount,
      created_at,
      updated_at,
      closed_at,
      customer_id,
      notes,
      labels_printed,
      labels_count,
      transport_id,
      payment_method,
      order_items (
        id,
        product_name,
        color,
        size,
        quantity,
        price_snapshot,
        status,
        imagen,
        variant_id
      )
    `;

  let response = await supabase
    .from("orders")
    .select(selectFields)
    .eq("status", "closed")
    .order("created_at", { ascending: false });

  // Si hay error por columnas inexistentes, intentar sin ellas
  if (response.error && (response.error.code === '42703' || response.error.message?.includes('does not exist'))) {
    console.warn("⚠️ Algunas columnas no existen aún. Cargando sin labels_printed, labels_count y transport_id.");
    selectFields = `
      id,
      order_number,
      status,
      total_amount,
      created_at,
      updated_at,
      closed_at,
      customer_id,
      notes,
      order_items (
        id,
        product_name,
        color,
        size,
        quantity,
        price_snapshot,
        status,
        imagen,
        variant_id
      )
    `;

    response = await supabase
      .from("orders")
      .select(selectFields)
      .eq("status", "closed")
      .order("created_at", { ascending: false });
  }

  let data = response.data;
  let error = response.error;

  if (data && !error && data.length > 0) {
    const customerIds = [...new Set(data.map(order => order.customer_id).filter(Boolean))];

    if (customerIds.length > 0) {
      // Intentar cargar transport_id de customers, pero si no existe, continuar sin él
      let customerSelectFields = "id, customer_number, full_name, address, phone, city, province, dni, email, transport_id";
      let customersResponse = await supabase
        .from("customers")
        .select(customerSelectFields)
        .in("id", customerIds);

      // Si transport_id no existe en customers, intentar sin él
      if (customersResponse.error && (customersResponse.error.code === '42703' || customersResponse.error.message?.includes('does not exist'))) {
        console.warn("⚠️ Columna transport_id no existe en customers aún.");
        customerSelectFields = "id, customer_number, full_name, address, phone, city, province, dni, email";
        customersResponse = await supabase
          .from("customers")
          .select(customerSelectFields)
          .in("id", customerIds);
      }

      const { data: customersData, error: customersError } = customersResponse;

      // Debug: Verificar que transport_id se está cargando
      if (customersData && customersData.length > 0) {
        console.log("🔍 Customers cargados con transport_id:", customersData.map(c => ({
          id: c.id?.substring(0, 8),
          name: c.full_name,
          transport_id: c.transport_id
        })));
      }

      if (customersError) {
        console.error("❌ Error obteniendo datos de customers:", customersError);
      }

      const customersMap = new Map();
      if (customersData) {
        customersData.forEach(c => {
          customersMap.set(c.id, c);
          // Debug: Log para verificar transport_id en customers
          if (c.transport_id) {
            console.log(`🔍 Customer ${c.id?.substring(0, 8)} (${c.full_name}) tiene transport_id:`, c.transport_id);
          }
        });
      }

      data = data.map(order => {
        const customer = customersMap.get(order.customer_id) || {};
        // Asegurar que el customer tenga el id del pedido
        if (!customer.id && order.customer_id) {
          customer.id = order.customer_id;
        }
        // Asegurar que transport_id esté en el customer si existe
        if (customer.transport_id === undefined && order.transport_id !== undefined) {
          customer.transport_id = order.transport_id;
        }

        // Debug: Log para verificar qué transport_id tiene el order
        if (order.customer_id) {
          console.log(`🔍 Order ${order.order_number || order.id?.substring(0, 8)} - customer_id: ${order.customer_id?.substring(0, 8)}, customer.transport_id:`, customer.transport_id, "order.transport_id:", order.transport_id);
        }

        // Agregar valores por defecto si las columnas no existen
        return {
          ...order,
          labels_printed: order.labels_printed || false,
          labels_count: order.labels_count || 1,
          transport_id: order.transport_id || customer.transport_id || null,
          customers: customer
        };
      });
    }
  }

  if (error) {
    console.error("❌ Error cargando pedidos cerrados:", error);
    const container = document.getElementById("orders-content");
    if (container) {
      container.innerHTML = `
        <div class="empty-orders">
          <h2>Error al cargar pedidos</h2>
          <p>${error.message || 'Error desconocido'}</p>
          <p style="margin-top: 16px; font-size: 14px; color: #666;">
            ⚠️ Si ves errores sobre columnas inexistentes, ejecuta el script SQL:<br/>
            <code>supabase/canonical/16_closed_orders_transport.sql</code>
          </p>
        </div>
      `;
    }
    return;
  }

  // Cargar precio de catálogo por variante para corregir snapshots legacy corruptos.
  closedOrdersVariantPriceMap.clear();
  const variantIds = Array.from(
    new Set(
      (data || [])
        .flatMap((o) => o?.order_items || [])
        .map((it) => (it?.variant_id != null ? String(it.variant_id).trim() : ""))
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
        if (id) closedOrdersVariantPriceMap.set(id, v?.price ?? null);
      });
    } else {
      console.warn("⚠️ No se pudieron cargar precios de variantes para fallback legacy:", variantsError.message || variantsError);
    }
  }

  orders = data || [];
  displayOrders();
}

// Función para renderizar tarjeta de pedido
async function renderOrderCard(order) {
  let customer = {};
  if (Array.isArray(order.customers)) {
    customer = order.customers[0] || {};
  } else if (order.customers && typeof order.customers === 'object') {
    customer = order.customers;
  }

  const customerEmail = customer.email || "Sin email";
  const offersData = await getOffersAndPromotionsForOrder(order);

  const hasStoredTotal = order.total_amount != null && String(order.total_amount).trim() !== "";
  const total = hasStoredTotal
    ? parseARSNumber(order.total_amount)
    : (order.order_items || []).reduce(
      (sum, item) => sum + (item.quantity || 0) * getClosedOrderUnitPrice(item),
      0
    );

  // Calcular cantidad total de productos
  const totalProducts = (order.order_items || []).reduce(
    (sum, item) => sum + (item.quantity || 0),
    0
  );

  // Parsear valores extra desde notes
  let shippingAmount = 0;
  let discountAmount = 0;
  let extrasAmount = 0;
  let extrasPercentage = 0;

  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      shippingAmount = parseFloat(extraValues.shipping) || 0;
      discountAmount = parseFloat(extraValues.discount) || 0;
      extrasAmount = parseFloat(extraValues.extras_amount) || 0;
      extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
    } catch (e) {
      console.warn('Error parseando valores extra del pedido:', e);
    }
  }

  // Obtener transporte asignado (manejar si no existe la columna)
  // Priorizar transport_id del customer sobre el del order
  let transportId = null;

  // Debug: Ver qué tiene el customer
  console.log(`🔍 Renderizando pedido ${order.order_number || order.id?.substring(0, 8)} - customer:`, {
    isArray: Array.isArray(customer),
    hasTransportId: customer?.transport_id,
    transportIdValue: customer?.transport_id,
    customerKeys: customer ? Object.keys(customer) : []
  });

  if (customer && typeof customer === 'object') {
    if (Array.isArray(customer)) {
      const custTransportId = customer[0]?.transport_id;
      transportId = (custTransportId !== undefined && custTransportId !== null && custTransportId !== '') ? String(custTransportId) : null;
      console.log(`  → Customer es array, transportId obtenido:`, transportId);
    } else {
      const custTransportId = customer.transport_id;
      transportId = (custTransportId !== undefined && custTransportId !== null && custTransportId !== '') ? String(custTransportId) : null;
      console.log(`  → Customer es objeto, transportId obtenido:`, transportId, "de customer.transport_id:", custTransportId);
    }
  }
  // Fallback al transport_id del order si no está en customer
  if (!transportId && order.transport_id !== undefined && order.transport_id !== null && order.transport_id !== '') {
    transportId = String(order.transport_id);
    console.log(`  → Usando transport_id del order como fallback:`, transportId);
  }

  // Buscar el transporte en la lista de transportes agendados (comparar como strings)
  const transport = transportId ? scheduledTransports.find(t => String(t.id) === String(transportId)) : null;
  const transportName = transport ? transport.name : (transportId ? 'Transporte no encontrado' : 'Sin transporte asignado');

  // Debug: Log para verificar el transporte asignado
  console.log(`🔍 Pedido ${order.order_number || order.id?.substring(0, 8)}: transportId=${transportId}, transport encontrado:`, transport ? transport.name : `NO ENCONTRADO (hay ${scheduledTransports.length} transportes disponibles: ${scheduledTransports.map(t => t.name).join(', ')})`);

  // Estado de rótulos (valores por defecto si las columnas no existen)
  const labelsPrinted = order.labels_printed !== undefined ? order.labels_printed : false;
  const labelsCount = order.labels_count !== undefined ? order.labels_count : 1;
  
  // Estado de ticket impreso (usando un campo temporal en el objeto order)
  const ticketPrinted = order.ticket_printed !== undefined ? order.ticket_printed : false;

  const orderDisplayNumber = order.order_number || order.id.substring(0, 8);

  return `
    <div class="order-card" data-order-id="${order.id}">
      <div class="order-header">
        <div class="order-id">Pedido #${orderDisplayNumber}</div>
        <div class="order-status">Cerrado</div>
      </div>
      <div class="customer-info">
        <div class="customer-name">
          ${customer.customer_number ? `<span style="color: #CD844D; font-weight: 600; margin-right: 8px;">#${customer.customer_number}</span>` : ""}
          ${formatCustomerDisplayName(customer)}
          ${transport ? `<span style="margin-left: 12px; padding: 4px 8px; background: #e3f2fd; color: #1565c0; border-radius: 4px; font-size: 12px; font-weight: 500;">🚚 ${transport.name}</span>` : ''}
        </div>
        <div class="customer-details">
          ${customer.dni ? `<span>🆔 DNI: ${customer.dni}</span>` : ""}
          <span>📞 ${customer.phone || "Sin teléfono"}</span>
          <span>📧 ${customerEmail}</span>
          ${customer.address ? `<span>🏠 ${customer.address}</span>` : ""}
          ${(customer.city || customer.province) ? `<span>📍 ${[customer.city, customer.province].filter(Boolean).join(" - ")}</span>` : ""}
        </div>
      </div>
      <div class="transport-section">
        <strong>🚚 Transporte:</strong>
        ${scheduledTransports.length > 0 ? `
        <div class="transport-selector">
          <select class="transport-select" data-order-id="${order.id}" data-customer-id="${order.customer_id || customer.id || ''}" ${transportId ? `data-current-transport="${transportId}"` : ''}>
            <option value="" ${!transportId ? 'selected' : ''}>Sin transporte</option>
            ${scheduledTransports.map(t => {
    const isSelected = transportId && String(transportId) === String(t.id);
    if (isSelected) {
      console.log(`✅ Transporte seleccionado en select: ${t.name} (${t.id}) para pedido ${order.order_number || order.id?.substring(0, 8)}`);
    }
    return `<option value="${t.id}" ${isSelected ? 'selected' : ''}>${t.name || 'Sin nombre'}</option>`;
  }).join('')}
          </select>
          ${transportId ? `<input type="hidden" class="transport-id-debug" value="${transportId}" data-order-id="${order.id}" />` : ''}
          <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px;" data-create-transport="${order.id}">+ Nuevo</button>
        </div>
        ` : `
        <div style="margin-top: 8px; padding: 8px; background: #fff3cd; border-radius: 6px; font-size: 13px; color: #856404;">
          ⚠️ La tabla de transportes no existe aún. Ejecuta el script SQL primero.
          <button class="btn btn-primary" style="padding: 6px 12px; font-size: 12px; margin-left: 8px;" data-create-transport="${order.id}">+ Crear Transporte</button>
        </div>
        `}
        <div style="margin-top: 8px; font-size: 13px; color: #666;">
          ${transport ? `<strong>Asignado:</strong> ${transport.name || 'Sin nombre'}${transport.details ? ` - ${transport.details}` : ''}` : transportId ? `<strong>Asignado:</strong> Transporte (ID: ${transportId.substring(0, 8)}...)` : '<em>No hay transporte asignado</em>'}
        </div>
      </div>
      <div class="order-summary">
        <div class="order-summary-item">
          <span>📦 Productos totales:</span>
          <strong>${totalProducts}</strong>
        </div>
        ${shippingAmount > 0 ? `
        <div class="order-summary-item">
          <span>🚚 Envío:</span>
          <span style="color: #2196f3;">${formatCurrency(shippingAmount)}</span>
        </div>
        ` : ''}
        ${discountAmount > 0 ? `
        <div class="order-summary-item">
          <span>💸 Descuento:</span>
          <span style="color: #f44336;">-${formatCurrency(discountAmount)}</span>
        </div>
        ` : ''}
        ${extrasAmount > 0 ? `
        <div class="order-summary-item">
          <span>➕ Extras:</span>
          <span style="color: #9c27b0;">${formatCurrency(extrasAmount)}</span>
        </div>
        ` : ''}
        ${offersData.totalDiscount > 0 ? `
        <div class="order-summary-item">
          <span>🔥 Descuentos (ofertas/promos):</span>
          <span style="color: #ff9800;">-${formatCurrency(offersData.totalDiscount)}</span>
        </div>
        ` : ''}
      </div>
      <div class="labels-section">
        <strong>🏷️ Rótulos:</strong>
        <div class="labels-controls">
          <button class="btn-labels-decrease" data-order-id="${order.id}" style="font-weight: bold;">-</button>
          <input type="number" class="labels-count-input" data-order-id="${order.id}" value="${labelsCount}" min="1" />
          <button class="btn-labels-increase" data-order-id="${order.id}" style="font-weight: bold;">+</button>
          <button class="btn btn-success" data-print-all="${order.id}" style="margin-left: 12px;">Imprimir todo</button>
          <button class="btn btn-warning" data-print-labels="${order.id}" style="margin-left: 8px;">Imprimir rótulos</button>
          <button class="btn btn-primary" data-print-ticket="${order.id}" style="margin-left: 8px; color: #000 !important;">Imprimir ticket</button>
        </div>
        <div class="labels-printed-badge ${labelsPrinted ? 'printed' : 'not-printed'}">
          ${labelsPrinted ? '✅ Rótulos impresos' : '⚠️ Rótulos no impresos'}
        </div>
        <div class="labels-printed-badge ${ticketPrinted ? 'printed' : 'not-printed'}" style="margin-top: 8px;">
          ${ticketPrinted ? '✅ Ticket impreso' : '⚠️ Ticket no impreso'}
        </div>
      </div>
      <div class="order-total">
        <span>Total</span>
        <span>${formatCurrency(total)}</span>
      </div>
      <div class="order-actions">
        <button class="btn btn-primary" data-show-detail="${order.id}">Ver Detalle</button>
        <button class="btn btn-secondary" data-revert-order="${order.id}">Volver a Apartados</button>
        <button class="btn btn-success" data-finalize-order="${order.id}" ${!labelsPrinted ? 'disabled' : ''}>
          Finalizar (Enviar)
        </button>
      </div>
    </div>
  `;
}

// Función para mostrar pedidos
async function displayOrders() {
  const container = document.getElementById("orders-content");
  if (!container) return;

  const filtered = orders.filter(matchesSearch);

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-orders">
        <h2>No hay pedidos cerrados</h2>
        <p>No se encontraron pedidos con el filtro seleccionado.</p>
      </div>
    `;
    return;
  }

  const cardsPromises = filtered.map(async (order) => await renderOrderCard(order));
  const cardsHtml = (await Promise.all(cardsPromises)).join("");

  container.innerHTML = `<div class="orders-list">${cardsHtml}</div>`;
  attachEventHandlers();
}

// Función para configurar controles de búsqueda
function setupSearchControls() {
  const input = document.getElementById('search-input');
  if (!input) return;
  input.value = currentSearch;
  input.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      currentSearch = input.value || '';
      displayOrders();
    }, 250);
  });
}

// Función para guardar transporte
async function saveTransport(customerId, transportId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("Error: No se pudo conectar con la base de datos.");
    return false;
  }

  if (!customerId) {
    console.error("❌ Error: customerId no válido");
    alert("Error: No se pudo identificar al cliente.");
    return false;
  }

  console.log("💾 Guardando transporte:", { customerId, transportId });

  // Intentar usar función RPC primero (más confiable)
  let updateSuccess = false;
  let updateError = null;

  try {
    const { data: rpcData, error: rpcError } = await supabase.rpc("rpc_update_customer_transport", {
      p_customer_id: customerId,
      p_transport_id: transportId || null
    });

    if (rpcError) {
      // Si la función RPC no existe, usar UPDATE directo
      if (rpcError.code === '42883' || rpcError.message?.includes('does not exist')) {
        console.warn("⚠️ Función RPC no existe, usando UPDATE directo");
        updateError = null; // Continuar con UPDATE directo
      } else {
        updateError = rpcError;
      }
    } else {
      console.log("✅ Transporte guardado usando RPC. Datos:", rpcData);
      updateSuccess = true;
    }
  } catch (err) {
    console.warn("⚠️ Error al usar RPC, intentando UPDATE directo:", err.message);
    updateError = null; // Continuar con UPDATE directo
  }

  // Si RPC no funcionó, usar UPDATE directo
  if (!updateSuccess) {
    const { error: directUpdateError } = await supabase
      .from("customers")
      .update({ transport_id: transportId || null })
      .eq("id", customerId);

    if (directUpdateError) {
      // Si la columna no existe, mostrar mensaje informativo
      if (directUpdateError.code === '42703' || directUpdateError.message?.includes('does not exist')) {
        alert("⚠️ La columna 'transport_id' no existe aún. Por favor ejecuta el script SQL primero:\nsupabase/canonical/16_closed_orders_transport.sql");
        return false;
      }
      console.error("❌ Error guardando transporte:", directUpdateError);
      alert("No se pudo guardar el transporte: " + (directUpdateError.message || 'Error desconocido'));
      return false;
    }
    console.log("✅ UPDATE directo ejecutado correctamente");
  }

  // Esperar un momento para que la actualización se propague
  await new Promise(resolve => setTimeout(resolve, 300));

  // Verificar que se guardó correctamente consultando directamente
  const { data: verifyData, error: verifyError } = await supabase
    .from("customers")
    .select("id, transport_id, full_name")
    .eq("id", customerId)
    .single();

  if (verifyError) {
    console.error("❌ Error verificando transporte guardado:", verifyError);
  } else {
    console.log("✅ Verificación: customer tiene transport_id =", verifyData?.transport_id, "Nombre:", verifyData?.full_name);

    // Si la verificación muestra null pero debería tener valor, hay un problema
    if (!verifyData?.transport_id && transportId) {
      console.error("❌ PROBLEMA: El transporte se guardó pero la verificación muestra null. Puede ser un problema de RLS.");
      console.log("💡 Solución: Verifica que la política 'customers_admin_update' exista en Supabase.");
    }
  }

  // Actualizar el estado local antes de recargar para mantener la selección
  const order = orders.find(o => o.customer_id === customerId);
  if (order && order.customers) {
    if (typeof order.customers === 'object' && !Array.isArray(order.customers)) {
      order.customers.transport_id = transportId || null;
      console.log("💾 Estado local actualizado - customer.transport_id:", order.customers.transport_id);
    } else if (Array.isArray(order.customers) && order.customers.length > 0) {
      order.customers[0].transport_id = transportId || null;
      console.log("💾 Estado local actualizado - customer[0].transport_id:", order.customers[0].transport_id);
    }
  }

  // Recargar transportes primero para asegurar que estén disponibles
  await loadScheduledTransports();
  console.log("📋 Transportes recargados:", scheduledTransports.length, "transportes disponibles:", scheduledTransports.map(t => `${t.name} (${t.id?.substring(0, 8)})`).join(', '));

  // Esperar un momento adicional para que la BD se actualice completamente
  await new Promise(resolve => setTimeout(resolve, 500));

  // Forzar recarga de pedidos limpiando el array primero
  orders = [];

  // Recargar pedidos para actualizar la vista (esto recargará desde la BD con el transport_id actualizado)
  await loadClosedOrders();

  // Verificar que el pedido se cargó con el transporte correcto
  const updatedOrder = orders.find(o => o.customer_id === customerId);
  if (updatedOrder) {
    const updatedCustomer = Array.isArray(updatedOrder.customers) ? updatedOrder.customers[0] : updatedOrder.customers;
    console.log("🔍 Después de recargar - Order tiene customer.transport_id:", updatedCustomer?.transport_id);
  }

  return true;
}

// Función para crear nuevo transporte
async function createNewTransport(name, details) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("Error: No se pudo conectar con la base de datos.");
    return null;
  }

  if (!name || name.trim() === '') {
    alert("El nombre del transporte es requerido.");
    return null;
  }

  const rawName = String(name || "").trim();
  const canonicalName = canonicalizeTransportName(rawName);
  const canonicalKey = normalizeTransportKey(canonicalName);
  if (!canonicalKey) {
    alert("El nombre del transporte es requerido.");
    return null;
  }

  // Verificación local rápida para evitar roundtrip cuando ya existe en memoria.
  const duplicateInMemory = scheduledTransports.some(
    (t) => normalizeTransportKey(t?.name) === canonicalKey
  );
  if (duplicateInMemory) {
    alert(`Ya existe el transporte "${canonicalName}".`);
    return null;
  }

  // Verificación remota para cubrir listas desactualizadas y evitar duplicados por alias/mayúsculas.
  const { data: existingTransports, error: existingError } = await supabase
    .from("transports")
    .select("id, name");
  if (existingError) {
    console.warn("⚠️ No se pudo validar duplicados en transports:", existingError);
  } else {
    const duplicate = (existingTransports || []).find(
      (t) => normalizeTransportKey(t?.name) === canonicalKey
    );
    if (duplicate) {
      alert(`Ya existe el transporte "${canonicalName}" (${duplicate.name}).`);
      return null;
    }
  }

  const { data, error } = await supabase
    .from("transports")
    .insert({ name: canonicalName, details: details?.trim() || null })
    .select()
    .single();

  if (error) {
    // Si la tabla no existe, mostrar mensaje informativo
    if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
      alert("⚠️ La tabla 'transports' no existe aún. Por favor ejecuta el script SQL primero:\n\nsupabase/canonical/16_closed_orders_transport.sql\n\nDespués de ejecutar el script, podrás crear transportes.");
      return null;
    }
    console.error("❌ Error creando transporte:", error);
    alert("No se pudo crear el transporte: " + (error.message || 'Error desconocido'));
    return null;
  }

  console.log("✅ Transporte creado correctamente");
  await loadScheduledTransports();
  return data;
}

// Función para actualizar cantidad de rótulos
async function updateLabelsCount(orderId, count) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("Error: No se pudo conectar con la base de datos.");
    return;
  }

  const { error } = await supabase.rpc("rpc_update_order_labels_count", {
    p_order_id: orderId,
    p_labels_count: count
  });

  if (error) {
    // Si la función RPC no existe, intentar actualizar directamente
    if (error.code === '42883' || error.message?.includes('does not exist')) {
      console.warn("⚠️ Función RPC no existe aún. Intentando actualización directa...");
      const { error: updateError } = await supabase
        .from("orders")
        .update({ labels_count: count })
        .eq("id", orderId);

      if (updateError) {
        if (updateError.code === '42703') {
          alert("⚠️ La columna 'labels_count' no existe aún. Por favor ejecuta el script SQL primero:\nsupabase/canonical/16_closed_orders_transport.sql");
          return;
        }
        console.error("❌ Error actualizando cantidad de rótulos:", updateError);
        alert("No se pudo actualizar la cantidad de rótulos.");
        return;
      }
    } else {
      console.error("❌ Error actualizando cantidad de rótulos:", error);
      alert("No se pudo actualizar la cantidad de rótulos: " + (error.message || 'Error desconocido'));
      return;
    }
  }

  console.log("✅ Cantidad de rótulos actualizada");
  await loadClosedOrders();
}

// Función para marcar rótulos como impresos
async function markLabelsPrinted(orderId) {
  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("Error: No se pudo conectar con la base de datos.");
    return;
  }

  const { error } = await supabase.rpc("rpc_mark_labels_printed", {
    p_order_id: orderId
  });

  if (error) {
    // Si la función RPC no existe, intentar actualizar directamente
    if (error.code === '42883' || error.message?.includes('does not exist')) {
      console.warn("⚠️ Función RPC no existe aún. Intentando actualización directa...");
      const { error: updateError } = await supabase
        .from("orders")
        .update({ labels_printed: true })
        .eq("id", orderId);

      if (updateError) {
        if (updateError.code === '42703') {
          alert("⚠️ La columna 'labels_printed' no existe aún. Por favor ejecuta el script SQL primero:\nsupabase/canonical/16_closed_orders_transport.sql");
          return;
        }
        console.error("❌ Error marcando rótulos como impresos:", updateError);
        alert("No se pudo marcar los rótulos como impresos.");
        return;
      }
    } else {
      console.error("❌ Error marcando rótulos como impresos:", error);
      alert("No se pudo marcar los rótulos como impresos: " + (error.message || 'Error desconocido'));
      return;
    }
  }

  console.log("✅ Rótulos marcados como impresos");
  await loadClosedOrders();
}

// Función para revertir pedido a estado "picked"
async function revertOrderStatus(orderId) {
  if (!confirm("¿Está seguro que desea volver este pedido al estado 'Apartados'?")) {
    return;
  }

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("Error: No se pudo conectar con la base de datos.");
    return;
  }

  // Verificar el estado actual del pedido antes de revertir
  const { data: currentOrder, error: checkError } = await supabase
    .from("orders")
    .select("status")
    .eq("id", orderId)
    .maybeSingle();

  if (checkError) {
    console.error("❌ Error verificando estado del pedido:", checkError);
    alert("Error al verificar el estado del pedido.");
    return;
  }

  if (!currentOrder) {
    alert("No se encontró el pedido.");
    return;
  }

  // No permitir revertir pedidos en devolución
  if (currentOrder.status === 'devolución') {
    alert("No se puede revertir un pedido que está en devolución. Los productos ya fueron devueltos al stock general.");
    return;
  }

  const { error } = await supabase.rpc("rpc_revert_order_to_picked", {
    p_order_id: orderId
  });

  if (error) {
    // Si la función RPC no existe, intentar actualizar directamente
    if (error.code === '42883' || error.message?.includes('does not exist')) {
      console.warn("⚠️ Función RPC no existe aún. Intentando actualización directa...");
      const { error: updateError } = await supabase
        .from("orders")
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq("id", orderId);

      if (updateError) {
        console.error("❌ Error revirtiendo pedido:", updateError);
        alert("No se pudo revertir el pedido: " + (updateError.message || 'Error desconocido'));
        return;
      }
    } else {
      console.error("❌ Error revirtiendo pedido:", error);
      alert(error.message || "No se pudo revertir el pedido.");
      return;
    }
  }

  console.log("✅ Pedido revertido correctamente");
  alert("✅ Pedido revertido a estado 'Apartados'.");
  await loadClosedOrders();
}

// Función para finalizar pedido (cambiar a "sent")
async function finalizeOrder(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) {
    alert("Pedido no encontrado.");
    return;
  }

  if (!order.labels_printed) {
    alert("⚠️ No se puede finalizar el pedido. Debe imprimir los rótulos primero.");
    return;
  }

  if (!confirm("¿Está seguro que desea finalizar este pedido? El pedido se moverá a 'Enviados'.")) {
    return;
  }

  if (!supabase) {
    supabase = await getSupabase();
  }
  if (!supabase) {
    alert("Error: No se pudo conectar con la base de datos.");
    return;
  }

  const { error } = await supabase.rpc("rpc_mark_order_as_sent", {
    p_order_id: orderId
  });

  if (error) {
    console.error("❌ Error finalizando pedido:", error);
    alert(error.message || "No se pudo finalizar el pedido.");
    return;
  }

  // Notificación al cliente: pedido empaquetado
  try {
    const customerId = order?.customer_id || (Array.isArray(order?.customers) ? order.customers[0]?.id : order?.customers?.id);
    if (customerId) {
      await supabase.from("customer_notifications").delete().eq("customer_id", customerId).eq("order_id", orderId);
      await supabase.from("customer_notifications").insert({
        customer_id: customerId,
        order_id: orderId,
        type: "ORDER_PACKAGED_TODAY",
        message: "Tu pedido ya fue empaquetado y se enviará hoy al transporte.",
        payload: { action_url: "client/dashboard.html?view=history" },
        read: false,
        read_at: null,
      });
    }
  } catch (e) {
    console.warn("⚠️ No se pudo emitir notificación al cliente:", e);
  }

  console.log("✅ Pedido finalizado correctamente");
  alert("✅ Pedido finalizado. Se ha movido a 'Enviados'.");
  await loadClosedOrders();
}

// Función para mostrar detalle del pedido
async function showOrderDetail(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) {
    alert("Pedido no encontrado.");
    return;
  }

  let customer = {};
  if (Array.isArray(order.customers)) {
    customer = order.customers[0] || {};
  } else if (order.customers && typeof order.customers === 'object') {
    customer = order.customers;
  }

  const offersData = await getOffersAndPromotionsForOrder(order);
  const allItems = order.order_items || [];
  const activeItems = allItems.filter(item => item.status !== 'cancelled');

  // Parsear valores extra
  let shippingAmount = 0;
  let discountAmount = 0;
  let extrasAmount = 0;
  let extrasPercentage = 0;

  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      shippingAmount = parseFloat(extraValues.shipping) || 0;
      discountAmount = parseFloat(extraValues.discount) || 0;
      extrasAmount = parseFloat(extraValues.extras_amount) || 0;
      extrasPercentage = parseFloat(extraValues.extras_percentage) || 0;
    } catch (e) {
      console.warn('Error parseando valores extra:', e);
    }
  }

  const productsSubtotal = activeItems.reduce((sum, item) => {
    return sum + (getClosedOrderUnitPrice(item) * (item.quantity || 0));
  }, 0);

  const itemsHtml = activeItems.map((item) => {
    const promoText = offersData.itemPromos?.get(item.id);
    const offerInfo = offersData.itemOffers?.get(item.id);
    let displayPrice = getClosedOrderUnitPrice(item);
    let originalPrice = null;

    if (promoText) {
      originalPrice = displayPrice;
    } else if (offerInfo) {
      originalPrice = offerInfo.originalPrice;
      displayPrice = offerInfo.offerPrice;
    }

    const subtotal = (item.quantity || 0) * displayPrice;
    const imageHtml = item.imagen
      ? `<img src="${item.imagen}" alt="${item.product_name}" class="item-thumb" onerror="this.remove()" />`
      : "";

    let offerPromoBadge = '';
    if (promoText) {
      offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #ff9800; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">${promoText}</div>`;
    } else if (offerInfo) {
      offerPromoBadge = `<div style="margin-top: 4px; display: inline-block; padding: 4px 8px; background: #e74c3c; color: white; border-radius: 4px; font-size: 11px; font-weight: 600;">🔥 Oferta</div>`;
    }

    return `
      <div class="order-item">
        ${imageHtml}
        <div class="item-main">
          <div class="item-name">${item.product_name}</div>
          <div class="item-details">
            Color: ${item.color || "-"} • Talle: ${item.size || "-"} • Cantidad: ${item.quantity || 0}
          </div>
          ${offerPromoBadge}
          <div class="item-price">
            ${originalPrice ? `<span style="text-decoration: line-through; color: #888; font-size: 0.9em; margin-right: 8px;">${formatCurrency(originalPrice * (item.quantity || 0))}</span>` : ''}
            ${formatCurrency(subtotal)}
          </div>
        </div>
      </div>
    `;
  }).join('');

  const hasStoredDetailTotal = order.total_amount != null && String(order.total_amount).trim() !== "";
  const total = hasStoredDetailTotal
    ? parseARSNumber(order.total_amount)
    : productsSubtotal + shippingAmount - discountAmount + extrasAmount + (productsSubtotal * extrasPercentage / 100) - offersData.totalDiscount;

  const detailHtml = `
    <div>
      <h3>Cliente</h3>
      <p><strong>Nombre:</strong> ${formatCustomerDisplayName(customer)}</p>
      ${customer.dni ? `<p><strong>DNI:</strong> ${customer.dni}</p>` : ''}
      ${customer.phone ? `<p><strong>Teléfono:</strong> ${customer.phone}</p>` : ''}
      ${customer.email ? `<p><strong>Email:</strong> ${customer.email}</p>` : ''}
      ${customer.address ? `<p><strong>Dirección:</strong> ${customer.address}</p>` : ''}
      ${(customer.city || customer.province) ? `<p><strong>Ubicación:</strong> ${[customer.city, customer.province].filter(Boolean).join(" - ")}</p>` : ''}
      
      <h3 style="margin-top: 24px;">Productos</h3>
      ${itemsHtml}
      
      <div style="margin-top: 24px; padding-top: 16px; border-top: 2px solid #eee;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
          <span>Subtotal productos:</span>
          <strong>${formatCurrency(productsSubtotal)}</strong>
        </div>
        ${shippingAmount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #2196f3;">
          <span>🚚 Envío:</span>
          <strong>${formatCurrency(shippingAmount)}</strong>
        </div>
        ` : ''}
        ${discountAmount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #f44336;">
          <span>💸 Descuento:</span>
          <strong>-${formatCurrency(discountAmount)}</strong>
        </div>
        ` : ''}
        ${extrasAmount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #9c27b0;">
          <span>➕ Extras:</span>
          <strong>${formatCurrency(extrasAmount)}</strong>
        </div>
        ` : ''}
        ${extrasPercentage > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #9c27b0;">
          <span>➕ Extras (${extrasPercentage}%):</span>
          <strong>${formatCurrency(productsSubtotal * extrasPercentage / 100)}</strong>
        </div>
        ` : ''}
        ${offersData.totalDiscount > 0 ? `
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #ff9800;">
          <span>🔥 Descuentos (ofertas/promos):</span>
          <strong>-${formatCurrency(offersData.totalDiscount)}</strong>
        </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; padding-top: 16px; border-top: 2px solid #CD844D; font-size: 18px; font-weight: 600;">
          <span>Total:</span>
          <span>${formatCurrency(total)}</span>
        </div>
      </div>
    </div>
  `;

  const modalBody = document.getElementById("detail-modal-body");
  if (modalBody) {
    modalBody.innerHTML = detailHtml;
  }

  const modal = document.getElementById("detail-modal");
  if (modal) {
    modal.classList.add("active");
  }
}

// ============================================================================
// Funciones de impresión de ticket para pedidos cerrados
// ============================================================================

/**
 * Construye el ticket en formato ESC/POS a partir de los datos del pedido
 * @param {Object} order - Objeto del pedido completo
 * @returns {Promise<string>} Ticket formateado en texto plano
 */
async function buildEscposTicketOrder(order) {
  const items = order.order_items || [];
  
  // Obtener cliente (puede ser objeto o array)
  let customer = null;
  if (Array.isArray(order.customers)) {
    customer = order.customers[0] || null;
  } else if (order.customers && typeof order.customers === 'object') {
    customer = order.customers;
  }

  // Parsear valores extra desde order.notes (igual que en showOrderDetail)
  let shippingAmount = parseFloat(order.shipping_amount || 0);
  let discountAmount = parseFloat(order.discount_amount || 0);
  let extrasAmount = parseFloat(order.extras_amount || 0);
  let extrasPercentage = parseFloat(order.extras_percentage || 0);

  if (order.notes) {
    try {
      const extraValues = JSON.parse(order.notes);
      shippingAmount = parseFloat(extraValues.shipping) || shippingAmount;
      discountAmount = parseFloat(extraValues.discount) || discountAmount;
      extrasAmount = parseFloat(extraValues.extras_amount) || extrasAmount;
      extrasPercentage = parseFloat(extraValues.extras_percentage) || extrasPercentage;
    } catch (e) {
      console.warn('Error parseando valores extra del pedido:', e);
    }
  }

  // Obtener descuentos de ofertas/promociones
  let offersData = { totalDiscount: 0 };
  try {
    offersData = await getOffersAndPromotionsForOrder(order);
  } catch (e) {
    console.warn('Error obteniendo descuentos de ofertas:', e);
  }

  // Formatear fecha y hora
  const orderDate = new Date(order.created_at);
  const dateStr = orderDate.toLocaleDateString('es-AR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: TIMEZONE_BUENOS_AIRES,
  });
  const timeStr = orderDate.toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE_BUENOS_AIRES,
  });

  let ticket = [];

  // Encabezado centrado (sin líneas vacías al inicio)
  ticket.push(center("FYL moda"));
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");

  // Datos del pedido
  ticket.push(`Pedido: ${order.order_number || order.id}`);
  ticket.push(`Fecha: ${dateStr}`);
  ticket.push(`Hora: ${timeStr}`);
  if (customer) {
    // Obtener nombre del cliente (usar full_name, name, o first_name + last_name)
    let customerName = customer.full_name || customer.name || '';
    if (!customerName) {
      customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim();
    }
    customerName = customerName.trim();
    
    if (customerName) {
      const maxNameLength = TICKET_WIDTH - 9; // "Cliente: " = 9 caracteres
      ticket.push(`Cliente: ${customerName.substring(0, maxNameLength)}`);
    }
  }
  ticket.push("");
  ticket.push("-".repeat(TICKET_WIDTH));

  // Sección DETALLE DEL PEDIDO (centrada)
  ticket.push(center("DETALLE DEL PEDIDO"));
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

  // Items del pedido
  items.forEach(item => {
    const price = getClosedOrderUnitPrice(item);
    const qty = parseInt(item.quantity || 0);
    const total = price * qty;

    // Nombre del producto (truncar a 22 caracteres)
    let productName = `${item.product_name || 'N/A'}`;
    if (item.color) productName += ` - ${item.color}`;
    if (item.size) productName += ` (${item.size})`;

    // Truncar a 22 caracteres
    const name = productName.slice(0, colProducto);

    // Formatear valores
    const qtyStr = padLeft(String(qty), colCant);
    const priceStr = `$${price.toLocaleString('es-AR')}`;
    const totalStr = `$${total.toLocaleString('es-AR')}`;
    const priceFormatted = padLeft(priceStr, colPrecio);
    const totalFormatted = padLeft(totalStr, colTotal);

    // Línea del item con columnas alineadas
    ticket.push(
      padRight(name, colProducto) +
      qtyStr +
      priceFormatted +
      totalFormatted
    );
  });

  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");

  // Subtotal productos
  const productsSubtotal = items.reduce((sum, item) => {
    const price = getClosedOrderUnitPrice(item);
    const qty = parseInt(item.quantity || 0);
    return sum + (price * qty);
  }, 0);

  // Envío (si existe)
  if (shippingAmount > 0) {
    ticket.push(`Envio: ${padLeft(`$${shippingAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 7)}`);
    ticket.push("");
  }

  // Descuento (si existe)
  if (discountAmount > 0) {
    ticket.push(`Descuento: ${padLeft(`-$${discountAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 11)}`);
    ticket.push("");
  }

  // Extras (si existen)
  if (extrasAmount > 0) {
    ticket.push(`Extras: ${padLeft(`$${extrasAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 8)}`);
    ticket.push("");
  }

  // Extras porcentuales (si existen)
  if (extrasPercentage > 0) {
    const extrasPercentAmount = productsSubtotal * extrasPercentage / 100;
    ticket.push(`Extras (${extrasPercentage}%): ${padLeft(`$${extrasPercentAmount.toLocaleString('es-AR')}`, TICKET_WIDTH - 18)}`);
    ticket.push("");
  }

  // Descuentos de ofertas/promociones (si existen)
  if (offersData.totalDiscount > 0) {
    ticket.push(`Descuentos (ofertas): ${padLeft(`-$${offersData.totalDiscount.toLocaleString('es-AR')}`, TICKET_WIDTH - 22)}`);
    ticket.push("");
  }

  // TOTAL alineado a la derecha
  const totalAmount = parseARSNumber(order.total_amount || 0);
  const totalStr = `$${totalAmount.toLocaleString('es-AR')}`;
  ticket.push(padLeft(`TOTAL: ${totalStr}`, TICKET_WIDTH));
  ticket.push("");

  // Footer: DOCUMENTO NO VALIDO / COMO FACTURA
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push(center("DOCUMENTO NO VALIDO"));
  ticket.push(center("COMO FACTURA"));
  ticket.push("");

  // Texto previo al QR (si existe cliente con QR)
  if (customer?.qr_code) {
    ticket.push(center("Escanea para ver tu"));
    ticket.push(center("historial y creditos:"));
  }

  return ticket.join("\n");
}

/**
 * Imprime el ticket del pedido usando QZ Tray
 * @param {Object} order - Objeto del pedido completo
 * @returns {Promise<void>}
 */
async function printOrderTicketWithQZ(order) {
  // Verificar si QZ está disponible antes de intentar
  if (typeof qz === 'undefined' || !qz) {
    throw new Error("QZ Tray no está disponible");
  }

  try {
    // Conectar a QZ
    await qzConnect();

    // Obtener configuración de impresora POS-80 específicamente para tickets
    const config = await qzGetPrinterConfigPos80();

    // Construir ticket de texto
    const ticketText = await buildEscposTicketOrder(order);

    // Preparar datos para QZ
    const data = [];

    // Reset impresora y ticket de texto (sin espacios adicionales)
    data.push("\x1B\x40" + ticketText);

    // QR Code como imagen (si existe cliente con QR)
    let customer = null;
    if (Array.isArray(order.customers)) {
      customer = order.customers[0] || null;
    } else if (order.customers && typeof order.customers === 'object') {
      customer = order.customers;
    }

    if (customer && customer.qr_code) {
      const url = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
      const size = 180;
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(url)}`;

      // Alineación centrada antes del QR
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

      // Alimentar un poco después del QR
      data.push("\x1B\x64\x03");  // ESC d 3 -> 3 líneas

      // Volver a alineación izquierda
      data.push("\x1B\x61\x00");  // ESC a 0
    }

    // Corte total
    data.push("\x1D\x56\x42\x00");   // GS V 66 0

    // Imprimir
    await qz.print(config, data);
    console.log("✅ Ticket del pedido enviado a impresora");

  } catch (error) {
    console.error("❌ Error imprimiendo con QZ Tray:", error);
    throw error;
  }
}

/**
 * Imprime el ticket del pedido directamente usando QZ Tray
 * @param {Object} order - Objeto del pedido completo
 * @returns {Promise<void>}
 */
async function printOrderTicketDirectly(order) {
  // Verificar que QZ Tray esté disponible
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    alert("⚠️ QZ Tray no está disponible. Por favor, instala QZ Tray para imprimir tickets.");
    return;
  }

  try {
    await printOrderTicketWithQZ(order);
  } catch (error) {
    console.error("❌ Error al imprimir ticket:", error);
    throw error;
  }
}

// Función para adjuntar manejadores de eventos
function attachEventHandlers() {
  // Selector de transporte - usar event delegation para evitar problemas con recargas
  document.querySelectorAll('.transport-select').forEach(select => {
    // Remover listeners anteriores si existen
    const newSelect = select.cloneNode(true);
    select.parentNode.replaceChild(newSelect, select);

    newSelect.addEventListener('change', async (e) => {
      const orderId = e.target.dataset.orderId;
      let customerId = e.target.dataset.customerId;
      const transportId = e.target.value || null;

      // Si no hay customerId en el dataset, intentar obtenerlo del pedido
      if (!customerId) {
        const order = orders.find(o => o.id === orderId);
        if (order) {
          customerId = order.customer_id;
        }
      }

      if (!customerId) {
        console.error("❌ Error: customerId no encontrado. OrderId:", orderId, "Dataset:", e.target.dataset);
        alert("Error: No se pudo identificar al cliente. Por favor, recarga la página.");
        // Restaurar valor anterior
        const order = orders.find(o => o.id === orderId);
        if (order) {
          const customer = order.customers;
          const currentTransportId = (customer && typeof customer === 'object' && !Array.isArray(customer) ? customer.transport_id : null) ||
            (Array.isArray(customer) && customer.length > 0 ? customer[0].transport_id : null);
          e.target.value = currentTransportId || '';
        }
        return;
      }

      console.log("💾 Guardando transporte para cliente:", customerId, "Transporte:", transportId);

      // Deshabilitar el select mientras se guarda
      e.target.disabled = true;
      const originalValue = e.target.value;

      try {
        const success = await saveTransport(customerId, transportId);
        if (!success) {
          // Si falla, restaurar el valor anterior
          e.target.value = originalValue;
        } else {
          console.log("✅ Transporte guardado exitosamente");
        }
      } catch (error) {
        console.error("❌ Error al guardar transporte:", error);
        e.target.value = originalValue;
        alert("Error al guardar el transporte: " + (error.message || 'Error desconocido'));
      } finally {
        e.target.disabled = false;
      }
    });
  });

  // Botón crear transporte
  document.querySelectorAll('[data-create-transport]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = document.getElementById("transport-modal");
      if (modal) {
        modal.classList.add("active");
        modal.dataset.orderId = btn.dataset.createTransport;
      }
    });
  });

  // Controles de rótulos
  document.querySelectorAll('.btn-labels-decrease').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.orderId;
      const input = document.querySelector(`.labels-count-input[data-order-id="${orderId}"]`);
      if (input) {
        const currentValue = parseInt(input.value) || 1;
        const newValue = Math.max(1, currentValue - 1);
        input.value = newValue;
        await updateLabelsCount(orderId, newValue);
      }
    });
  });

  document.querySelectorAll('.btn-labels-increase').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.orderId;
      const input = document.querySelector(`.labels-count-input[data-order-id="${orderId}"]`);
      if (input) {
        const currentValue = parseInt(input.value) || 1;
        const newValue = currentValue + 1;
        input.value = newValue;
        await updateLabelsCount(orderId, newValue);
      }
    });
  });

  document.querySelectorAll('.labels-count-input').forEach(input => {
    input.addEventListener('change', async (e) => {
      const orderId = e.target.dataset.orderId;
      const value = parseInt(e.target.value) || 1;
      const validValue = Math.max(1, value);
      e.target.value = validValue;
      await updateLabelsCount(orderId, validValue);
    });
  });

  // Botón imprimir rótulos
  document.querySelectorAll('[data-print-labels]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.printLabels;
      const order = orders.find(o => o.id === orderId);

      if (!order) {
        alert("Pedido no encontrado.");
        return;
      }

      // Obtener cantidad de rótulos a imprimir
      const labelsCount = order.labels_count !== undefined ? order.labels_count : 1;

      // Validar que el pedido tenga un transporte asignado
      let customer = {};
      if (Array.isArray(order.customers)) {
        customer = order.customers[0] || {};
      } else if (order.customers && typeof order.customers === 'object') {
        customer = order.customers;
      }

      // Obtener transport_id del cliente o del pedido (misma lógica que prepareShippingLabelFromOrder)
      const transportId = (customer.transport_id !== undefined ? customer.transport_id : null) ||
        (order.transport_id !== undefined ? order.transport_id : null);

      // Verificar que exista un transporte asignado
      if (!transportId) {
        alert("⚠️ No se puede imprimir el rótulo: el pedido debe tener un transporte asignado. Por favor, asigne un transporte al cliente antes de imprimir.");
        return;
      }

      // Verificar que el transporte exista en scheduledTransports
      const transport = scheduledTransports.find(t => t.id === transportId);
      if (!transport) {
        alert("⚠️ No se puede imprimir el rótulo: el transporte asignado no es válido o ha sido eliminado. Por favor, asigne un transporte válido al cliente antes de imprimir.");
        return;
      }

      // Verificar que QZ Tray esté disponible
      if (typeof qz === 'undefined' || !qz || !qz.websocket) {
        alert("⚠️ QZ Tray no está disponible. Por favor, instala QZ Tray para imprimir rótulos.");
        return;
      }

      try {
        // Preparar datos del rótulo
        const shippingLabel = prepareShippingLabelFromOrder(order);

        // Validar datos mínimos
        if (!shippingLabel.fullName || shippingLabel.fullName === "Cliente sin nombre") {
          if (!confirm("⚠️ El cliente no tiene nombre completo. ¿Deseas continuar con la impresión?")) {
            return;
          }
        }

        // Imprimir rótulos
        const printSuccess = await printTscShippingLabel(shippingLabel, labelsCount);

        if (printSuccess) {
          // Marcar como impresos si la impresión fue exitosa
          await markLabelsPrinted(orderId);
          // Alert eliminado - no es necesario mostrar confirmación
        }
      } catch (error) {
        console.error("❌ Error al imprimir rótulos:", error);
        alert("Error al imprimir los rótulos: " + (error.message || "Error desconocido"));
      }
    });
  });

  // Botón ver detalle
  document.querySelectorAll('[data-show-detail]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.showDetail;
      await showOrderDetail(orderId);
    });
  });

  // Botón revertir pedido
  document.querySelectorAll('[data-revert-order]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.revertOrder;
      await revertOrderStatus(orderId);
    });
  });

  // Botón finalizar pedido
  document.querySelectorAll('[data-finalize-order]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.finalizeOrder;
      await finalizeOrder(orderId);
    });
  });

  // Botón imprimir ticket
  document.querySelectorAll('[data-print-ticket]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.printTicket;
      const order = orders.find(o => o.id === orderId);

      if (!order) {
        alert("Pedido no encontrado.");
        return;
      }

      try {
        await printOrderTicketDirectly(order);
        
        // Marcar ticket como impreso en el objeto order
        order.ticket_printed = true;
        
        // Actualizar el badge visualmente
        const orderCard = e.target.closest('.order-card');
        if (orderCard) {
          const ticketBadge = orderCard.querySelector('.labels-printed-badge:last-of-type');
          if (ticketBadge) {
            ticketBadge.className = 'labels-printed-badge printed';
            ticketBadge.style.marginTop = '8px';
            ticketBadge.textContent = '✅ Ticket impreso';
          }
        }
      } catch (error) {
        console.error("❌ Error al imprimir ticket:", error);
        alert("Error al imprimir el ticket: " + (error.message || "Error desconocido"));
      }
    });
  });

  // Botón imprimir todo (rótulos + ticket)
  document.querySelectorAll('[data-print-all]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const orderId = e.target.dataset.printAll;
      const order = orders.find(o => o.id === orderId);

      if (!order) {
        alert("Pedido no encontrado.");
        return;
      }

      const orderCard = e.target.closest('.order-card');
      let labelsSuccess = false;
      let ticketSuccess = false;

      // Deshabilitar el botón mientras se imprime
      e.target.disabled = true;
      e.target.textContent = 'Imprimiendo...';

      try {
        // Primero imprimir rótulos
        try {
          // Obtener cantidad de rótulos a imprimir
          const labelsCount = order.labels_count !== undefined ? order.labels_count : 1;

          // Validar que el pedido tenga un transporte asignado
          let customer = {};
          if (Array.isArray(order.customers)) {
            customer = order.customers[0] || {};
          } else if (order.customers && typeof order.customers === 'object') {
            customer = order.customers;
          }

          const transportId = (customer.transport_id !== undefined ? customer.transport_id : null) ||
            (order.transport_id !== undefined ? order.transport_id : null);

          if (!transportId) {
            throw new Error("El pedido debe tener un transporte asignado para imprimir rótulos.");
          }

          const transport = scheduledTransports.find(t => t.id === transportId);
          if (!transport) {
            throw new Error("El transporte asignado no es válido.");
          }

          if (typeof qz === 'undefined' || !qz || !qz.websocket) {
            throw new Error("QZ Tray no está disponible.");
          }

          const shippingLabel = prepareShippingLabelFromOrder(order);
          labelsSuccess = await printTscShippingLabel(shippingLabel, labelsCount);

          if (labelsSuccess) {
            await markLabelsPrinted(orderId);
            order.labels_printed = true;
            
            // Actualizar badge de rótulos
            if (orderCard) {
              const labelsBadge = orderCard.querySelector('.labels-printed-badge:first-of-type');
              if (labelsBadge) {
                labelsBadge.className = 'labels-printed-badge printed';
                labelsBadge.textContent = '✅ Rótulos impresos';
              }
            }
          }
        } catch (error) {
          console.error("❌ Error al imprimir rótulos:", error);
          // Continuar con el ticket aunque falle los rótulos
        }

        // Luego imprimir ticket
        try {
          await printOrderTicketDirectly(order);
          ticketSuccess = true;
          
          // Marcar ticket como impreso
          order.ticket_printed = true;
          
          // Actualizar badge de ticket
          if (orderCard) {
            const ticketBadge = orderCard.querySelector('.labels-printed-badge:last-of-type');
            if (ticketBadge) {
              ticketBadge.className = 'labels-printed-badge printed';
              ticketBadge.style.marginTop = '8px';
              ticketBadge.textContent = '✅ Ticket impreso';
            }
          }
        } catch (error) {
          console.error("❌ Error al imprimir ticket:", error);
        }

        // Mostrar resultado
        if (labelsSuccess && ticketSuccess) {
          // Ambos exitosos - no mostrar alert, solo los badges
        } else if (labelsSuccess || ticketSuccess) {
          alert(`Se imprimió ${labelsSuccess ? 'rótulos' : ''}${labelsSuccess && ticketSuccess ? ' y ' : ''}${ticketSuccess ? 'ticket' : ''}, pero hubo un error con ${!labelsSuccess ? 'rótulos' : 'ticket'}.`);
        } else {
          alert("Error al imprimir. Verifica que QZ Tray esté disponible y que el pedido tenga transporte asignado.");
        }

      } catch (error) {
        console.error("❌ Error al imprimir:", error);
        alert("Error al imprimir: " + (error.message || "Error desconocido"));
      } finally {
        // Rehabilitar el botón
        e.target.disabled = false;
        e.target.textContent = 'Imprimir todo';
      }
    });
  });
}

// Función para configurar modales
function setupModals() {
  // Modal de detalle
  const detailModal = document.getElementById("detail-modal");
  const closeDetailModal = document.getElementById("close-detail-modal");
  if (closeDetailModal) {
    closeDetailModal.addEventListener('click', () => {
      if (detailModal) detailModal.classList.remove("active");
    });
  }
  if (detailModal) {
    detailModal.addEventListener('click', (e) => {
      if (e.target === detailModal) {
        detailModal.classList.remove("active");
      }
    });
  }

  // Modal de transporte
  const transportModal = document.getElementById("transport-modal");
  const cancelTransportModal = document.getElementById("cancel-transport-modal");
  const saveTransportModal = document.getElementById("save-transport-modal");
  const newTransportName = document.getElementById("new-transport-name");
  const newTransportDetails = document.getElementById("new-transport-details");

  if (cancelTransportModal) {
    cancelTransportModal.addEventListener('click', () => {
      if (transportModal) {
        transportModal.classList.remove("active");
        if (newTransportName) newTransportName.value = '';
        if (newTransportDetails) newTransportDetails.value = '';
      }
    });
  }

  if (saveTransportModal) {
    saveTransportModal.addEventListener('click', async () => {
      const name = newTransportName?.value?.trim();
      const details = newTransportDetails?.value?.trim();

      if (!name) {
        alert("El nombre del transporte es requerido.");
        return;
      }

      const transport = await createNewTransport(name, details);
      if (transport) {
        if (transportModal) {
          const orderId = transportModal.dataset.orderId;
          if (orderId) {
            const order = orders.find(o => o.id === orderId);
            if (order) {
              const customerId = order.customer_id;
              await saveTransport(customerId, transport.id);
            }
          }
          transportModal.classList.remove("active");
          if (newTransportName) newTransportName.value = '';
          if (newTransportDetails) newTransportDetails.value = '';
        }
      }
    });
  }

  if (transportModal) {
    transportModal.addEventListener('click', (e) => {
      if (e.target === transportModal) {
        transportModal.classList.remove("active");
        if (newTransportName) newTransportName.value = '';
        if (newTransportDetails) newTransportDetails.value = '';
      }
    });
  }
}

// Variable para debounce de recargas
let reloadDebounce = null;

// Función para configurar suscripción en tiempo real
function setupRealtimeSubscription() {
  if (!supabase) {
    console.warn("⚠️ Supabase no disponible para suscripción en tiempo real");
    return;
  }

  // Evitar múltiples suscripciones
  if (isRealtimeSubscribed && realtimeSubscription) {
    console.log("ℹ️ Suscripción en tiempo real ya está activa");
    return;
  }

  // Limpiar suscripción anterior si existe
  if (realtimeSubscription) {
    try {
      supabase.removeChannel(realtimeSubscription);
      realtimeSubscription = null;
      isRealtimeSubscribed = false;
    } catch (error) {
      console.warn("⚠️ Error al limpiar suscripción anterior:", error);
    }
  }

  // Crear nueva suscripción
  const channel = supabase
    .channel("closed-orders-changes", {
      config: {
        broadcast: { self: false }
      }
    });

  // Suscripción a cambios en orders (solo pedidos cerrados)
  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "orders",
      filter: "status=eq.closed"
    },
    async (payload) => {
      console.log("🔄 Cambio en pedidos cerrados detectado:", payload.eventType);
      // Debounce para evitar recargas excesivas
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(async () => {
        await loadClosedOrders();
      }, 500);
    }
  );

  // Suscripción a cambios en order_items (solo si afectan pedidos cerrados)
  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "order_items",
    },
    async (payload) => {
      console.log("🔄 Cambio en items de pedidos detectado:", payload.eventType);
      // Verificar si el pedido está cerrado antes de recargar
      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(async () => {
        // Solo recargar si hay pedidos cerrados
        const hasClosedOrders = orders.some(o => o.status === 'closed');
        if (hasClosedOrders) {
          await loadClosedOrders();
        }
      }, 500);
    }
  );

  // Suscripción a cambios en transports (solo si la tabla existe)
  // Intentar suscribirse, pero no fallar si la tabla no existe
  try {
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "transports",
      },
      async (payload) => {
        console.log("🔄 Cambio en transportes detectado:", payload.eventType);
        if (reloadDebounce) clearTimeout(reloadDebounce);
        reloadDebounce = setTimeout(async () => {
          await loadScheduledTransports();
          await loadClosedOrders();
        }, 500);
      }
    );
  } catch (error) {
    // Si la tabla no existe, simplemente no suscribirse a ella
    console.warn("⚠️ No se pudo suscribir a cambios en transports (tabla puede no existir):", error.message);
  }

  // Suscribirse al canal
  realtimeSubscription = channel.subscribe((status, err) => {
    if (status === "SUBSCRIBED") {
      console.log("✅ Suscripción en tiempo real activa");
      isRealtimeSubscribed = true;
    } else if (status === "CHANNEL_ERROR") {
      console.error("❌ Error en suscripción en tiempo real:", err);
      isRealtimeSubscribed = false;
      // Intentar reconectar después de un delay (solo si no hay otra suscripción activa)
      setTimeout(() => {
        if (!isRealtimeSubscribed) {
          console.log("🔄 Intentando reconectar suscripción en tiempo real...");
          setupRealtimeSubscription();
        }
      }, 5000);
    } else if (status === "TIMED_OUT") {
      console.warn("⚠️ Suscripción en tiempo real expiró, reconectando...");
      isRealtimeSubscribed = false;
      setTimeout(() => {
        if (!isRealtimeSubscribed) {
          setupRealtimeSubscription();
        }
      }, 2000);
    } else if (status === "CLOSED") {
      console.warn("⚠️ Suscripción en tiempo real cerrada");
      isRealtimeSubscribed = false;
    }
  });
}

// Función de inicialización
async function initClosedOrders() {
  try {
    supabase = await getSupabase();

    if (!supabase) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      supabase = window.supabase;

      if (!supabase) {
        console.error("❌ Supabase no disponible");
        alert("Error: Supabase no disponible. Por favor, recarga la página.");
        return;
      }
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      window.location.href = "index.html";
      return;
    }

    const isAdmin = await verifyAdminAuth();

    if (!isAdmin) {
      window.location.href = "index.html";
      return;
    }

    // Cargar transportes (puede fallar si la tabla no existe, pero no es crítico)
    await loadScheduledTransports();
    if (scheduledTransports.length === 0) {
      console.warn("⚠️ No hay transportes disponibles. La tabla puede no existir aún.");
    }

    // Cargar pedidos cerrados
    await loadClosedOrders();
    setupSearchControls();
    setupModals();
    setupPrintListsModal();
    setupRealtimeSubscription();
  } catch (error) {
    console.error("❌ Error inicializando módulo de pedidos cerrados:", error);
    const container = document.getElementById("orders-content");
    if (container) {
      container.innerHTML = `
        <div class="empty-orders">
          <h2>Error al inicializar</h2>
          <p>${error.message || 'Error desconocido'}</p>
          <p style="margin-top: 16px; font-size: 14px; color: #666;">
            ⚠️ Si ves errores sobre tablas o columnas inexistentes, ejecuta el script SQL:<br/>
            <code style="background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">supabase/canonical/16_closed_orders_transport.sql</code>
          </p>
        </div>
      `;
    }
  }
}

// Limpiar suscripción al cerrar
window.addEventListener("beforeunload", () => {
  if (realtimeSubscription && supabase) {
    try {
      supabase.removeChannel(realtimeSubscription);
      realtimeSubscription = null;
      isRealtimeSubscribed = false;
    } catch (error) {
      console.warn("⚠️ Error al limpiar suscripción:", error);
    }
  }
  if (reloadDebounce) {
    clearTimeout(reloadDebounce);
  }
});

// Variables para la funcionalidad de Imprimir Listas
let currentOrdersList = [];
let currentTransportName = "";
let currentFilterDate = "";

// Función para cargar pedidos para la lista de impresión.
// Usa RPC rpc_get_shipping_orders para evitar el límite de filas de PostgREST y alinear con el criterio del día.
async function loadOrdersForList(transportId, date) {
  try {
    if (!transportId || !date) {
      console.warn("⚠️ Transporte y fecha son requeridos");
      return [];
    }

    console.log("🔍 Buscando pedidos para lista de envíos:", { transportId, date });

    const { data: orders, error } = await supabase.rpc("rpc_get_shipping_orders", {
      p_date: date,
      p_transport_id: transportId
    });

    if (error) {
      console.error("❌ Error cargando pedidos (RPC):", error);
      throw error;
    }

    const list = Array.isArray(orders) ? orders : [];
    console.log(`✅ Pedidos devueltos por rpc_get_shipping_orders: ${list.length}`);

    return list;
  } catch (error) {
    console.error("❌ Error en loadOrdersForList:", error);
    throw error;
  }
}

// Función para cargar pedidos para extracción Excel
// Usa RPC rpc_get_shipping_orders_range para evitar límite de filas y alinear con el mismo criterio que la lista de envíos.
async function loadOrdersForExtract(startDate, endDate, transportId = null) {
  try {
    if (!startDate || !endDate) {
      console.warn("⚠️ Fechas desde y hasta son requeridas");
      return [];
    }

    const pTransportId = (transportId && transportId !== "" && transportId !== "all") ? transportId : null;
    console.log("🔍 Buscando pedidos para extracción (RPC):", { startDate, endDate, transportId: pTransportId });

    const { data: orders, error } = await supabase.rpc("rpc_get_shipping_orders_range", {
      p_start_date: startDate,
      p_end_date: endDate,
      p_transport_id: pTransportId
    });

    if (error) {
      console.error("❌ Error cargando pedidos para extracción (RPC):", error);
      throw error;
    }

    const list = Array.isArray(orders) ? orders : [];
    console.log(`✅ Pedidos devueltos por rpc_get_shipping_orders_range: ${list.length}`);

    return list;
  } catch (error) {
    console.error("❌ Error en loadOrdersForExtract:", error);
    throw error;
  }
}

// Función para descargar Excel con los datos extraídos
function downloadExtractExcel(orders, startDate, endDate) {
  try {
    if (!window.XLSX) {
      alert("Error: Librería SheetJS no está disponible. Por favor, recarga la página.");
      return;
    }

    if (!orders || orders.length === 0) {
      alert("No hay pedidos para exportar.");
      return;
    }

    // Preparar datos para Excel
    const excelData = orders.map(order => {
      // Formatear fecha de envío (dd/mm/aaaa)
      let fechaEnvio = "";
      if (order.sent_at) {
        const date = new Date(order.sent_at);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        fechaEnvio = `${day}/${month}/${year}`;
      }

      // Formatear monto como número para Excel (usar punto para decimales)
      // Excel reconocerá esto como número y aplicará formato local automáticamente
      const monto = parseARSNumber(order.total_amount || 0).toFixed(2);

      return {
        "Fecha de envío": fechaEnvio,
        "Nombre del cliente del envío": order.customer_name || "Sin nombre",
        "Pagos": order.payment_method || "Sin especificar",
        "Monto de este pedido": monto,
        "Transporte que fue enviado": order.transport_name || "Sin transporte asignado"
      };
    });

    // Crear workbook y worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);

    // Ajustar ancho de columnas
    const colWidths = [
      { wch: 15 }, // Fecha de envío
      { wch: 40 }, // Nombre del cliente
      { wch: 20 }, // Pagos
      { wch: 20 }, // Monto
      { wch: 30 }  // Transporte
    ];
    ws['!cols'] = colWidths;

    // Agregar worksheet al workbook
    XLSX.utils.book_append_sheet(wb, ws, "Envíos");

    // Generar nombre de archivo
    const startDateStr = startDate.replace(/-/g, "");
    const endDateStr = endDate.replace(/-/g, "");
    const filename = `Extraccion_Envios_${startDateStr}_${endDateStr}.xlsx`;

    // Descargar archivo
    XLSX.writeFile(wb, filename);

    console.log(`✅ Archivo Excel descargado: ${filename}`);
  } catch (error) {
    console.error("❌ Error generando Excel:", error);
    alert("Error al generar el archivo Excel: " + (error.message || "Error desconocido"));
  }
}

// Función para renderizar la lista de pedidos
function renderOrdersList(orders, transportName, date) {
  const container = document.getElementById("orders-list-container");
  const content = document.getElementById("orders-list-content");
  const empty = document.getElementById("orders-list-empty");
  const title = document.getElementById("orders-list-title");
  const printBtn = document.getElementById("print-pdf-btn");

  if (!orders || orders.length === 0) {
    container.style.display = "none";
    empty.style.display = "block";
    printBtn.style.display = "none";
    return;
  }

  container.style.display = "block";
  empty.style.display = "none";
  printBtn.style.display = "inline-block";

  // Formatear fecha para mostrar (usar la fecha del parámetro directamente, no convertir)
  const dateParts = date.split('-');
  const year = parseInt(dateParts[0]);
  const month = parseInt(dateParts[1]) - 1; // Mes es 0-indexed
  const day = parseInt(dateParts[2]);
  const dateObj = new Date(year, month, day);
  const formattedDate = dateObj.toLocaleDateString("es-AR", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  title.textContent = `${orders.length} pedido(s) - ${transportName} - ${formattedDate}`;

  // Crear tabla
  let tableHTML = `
    <table class="orders-list-table">
      <thead>
        <tr>
          <th>Cliente</th>
          <th>DNI</th>
          <th>Dirección</th>
          <th>Localidad</th>
          <th>Teléfono</th>
          <th>Productos</th>
          <th>Paquetes</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
  `;

  orders.forEach(order => {
    const locality = [order.city, order.province].filter(Boolean).join(", ") || "Sin localidad";
    const totalFormatted = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0
    }).format(order.total_amount);

    tableHTML += `
      <tr>
        <td>${escapeHtml(order.customer_name)}</td>
        <td>${escapeHtml(order.dni || "-")}</td>
        <td>${escapeHtml(order.address)}</td>
        <td>${escapeHtml(locality)}</td>
        <td>${escapeHtml(order.phone)}</td>
        <td>${order.items_count}</td>
        <td>${order.packages_count}</td>
        <td>${totalFormatted}</td>
      </tr>
    `;
  });

  tableHTML += `
      </tbody>
    </table>
  `;

  content.innerHTML = tableHTML;
}

// Función para generar PDF (y guardar la lista)
async function generateShippingListPDF(orders, transportName, date, transportId = null) {
  if (!window.jspdf) {
    alert("Error: Librería jsPDF no está disponible. Por favor, recarga la página.");
    return;
  }

  const { jsPDF } = window.jspdf;

  // Crear documento A4 en orientación horizontal (297mm x 210mm)
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: "a4"
  });

  // Función para agregar una página del PDF
  function addPageToPDF() {
    // Encabezado - título a la izquierda, transporte y fecha a la derecha
    doc.setFontSize(18);
    doc.setFont(undefined, "bold");
    doc.text("Lista de Envíos FYL", 15, 20);

    doc.setFontSize(11);
    doc.setFont(undefined, "normal");
    
    // Transporte y fecha alineados a la derecha
    doc.text(`Transporte: ${transportName}`, 282, 15, { align: "right" });

    // Convertir fecha correctamente usando fecha local (evitar problemas de UTC)
    const dateParts = date.split('-');
    const year = parseInt(dateParts[0]);
    const month = parseInt(dateParts[1]) - 1; // Mes es 0-indexed
    const day = parseInt(dateParts[2]);
    const dateObj = new Date(year, month, day);
    const formattedDate = dateObj.toLocaleDateString("es-AR", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    doc.text(`Fecha: ${formattedDate}`, 282, 22, { align: "right" });

    // Tabla de pedidos - comenzar más arriba para aprovechar el espacio
    const tableData = orders.map((order, index) => {
      const locality = [order.city, order.province].filter(Boolean).join(", ") || "Sin localidad";
      const totalFormatted = new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: "ARS",
        minimumFractionDigits: 0
      }).format(order.total_amount);

      return [
        (index + 1).toString(),
        order.customer_name,
        order.address,
        locality,
        order.phone,
        order.items_count.toString(),
        order.packages_count.toString(),
        order.payment_method || "Sin especificar",
        totalFormatted
      ];
    });

    // Calcular totales
    const totalProductos = orders.reduce((sum, order) => sum + (order.items_count || 0), 0);
    const totalPaquetes = orders.reduce((sum, order) => sum + (order.packages_count || 1), 0);
    const totalMonto = orders.reduce((sum, order) => sum + parseARSNumber(order.total_amount || 0), 0);
    // Formatear total sin espacios para evitar división en dos líneas
    const totalMontoFormatted = new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(totalMonto).replace(/\s/g, ""); // Eliminar espacios que puedan causar división

    doc.autoTable({
      startY: 30,
      head: [["N°", "Cliente", "Dirección", "Localidad", "Teléfono", "Productos", "Paquetes", "Método Pago", "Total"]],
      body: tableData,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [23, 162, 184], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      margin: { left: 15, right: 15 },
      columnStyles: {
        0: { cellWidth: 10, halign: 'center' }, // N°
        1: { cellWidth: 38 }, // Cliente
        2: { cellWidth: 60 }, // Dirección
        3: { cellWidth: 38 }, // Localidad
        4: { cellWidth: 26 }, // Teléfono
        5: { cellWidth: 18 }, // Productos
        6: { cellWidth: 18 }, // Paquetes
        7: { cellWidth: 26 }, // Método Pago
        8: { cellWidth: 30, halign: 'right' } // Total - alineado a la derecha
      }
    });

    // Total de paquetes y firma en la misma altura
    const finalY = doc.lastAutoTable.finalY + 15;
    
    // Total de paquetes a la izquierda
    doc.setFontSize(12);
    doc.setFont(undefined, "bold");
    doc.text(`Total de Paquetes: ${totalPaquetes}`, 20, finalY);

    // Firma a la derecha a la misma altura
    doc.setFontSize(10);
    doc.setFont(undefined, "normal");
    doc.text("Firma del Transporte:", 130, finalY);
    doc.line(130, finalY + 5, 180, finalY + 5);
    doc.text("Aclaración:", 190, finalY);
    doc.line(190, finalY + 5, 240, finalY + 5);
  }

  // Agregar primera página (original)
  addPageToPDF();

  // Agregar segunda página (duplicado)
  doc.addPage();
  addPageToPDF();

  // Generar nombre de archivo
  const dateStr = date.replace(/-/g, "");
  const transportStr = transportName.replace(/[^a-zA-Z0-9]/g, "_");
  const filename = `Lista_Envio_${transportStr}_${dateStr}.pdf`;

  // Guardar la lista en la base de datos
  try {
    if (transportId && orders.length > 0) {
      const { data, error } = await supabase.rpc("rpc_save_shipping_list", {
        p_transport_id: transportId,
        p_transport_name: transportName,
        p_list_date: date,
        p_orders_data: orders
      });

      if (error) {
        console.error("❌ Error guardando lista:", error);
        // Continuar con la descarga aunque falle el guardado
      } else {
        console.log("✅ Lista guardada correctamente:", data);
      }
    }
  } catch (error) {
    console.error("❌ Error al guardar lista:", error);
    // Continuar con la descarga aunque falle el guardado
  }

  // Descargar PDF
  doc.save(filename);
}

// Función para cargar listas guardadas
async function loadSavedShippingLists(startDate = null, endDate = null) {
  try {
    const { data, error } = await supabase.rpc("rpc_get_shipping_lists", {
      p_start_date: startDate,
      p_end_date: endDate
    });

    if (error) {
      console.error("❌ Error cargando listas guardadas:", error);
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error("❌ Error en loadSavedShippingLists:", error);
    throw error;
  }
}

// Función para renderizar listas guardadas
function renderSavedShippingLists(lists) {
  const container = document.getElementById("saved-lists-content");

  if (!lists || lists.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 48px; color: #666;">
        <p>No se encontraron listas guardadas para el rango de fechas seleccionado.</p>
      </div>
    `;
    return;
  }

  let html = "";
  lists.forEach(list => {
    const dateObj = new Date(list.list_date);
    const formattedDate = dateObj.toLocaleDateString("es-AR", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
    const createdDate = new Date(list.created_at);
    const formattedCreated = createdDate.toLocaleDateString("es-AR", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });

    html += `
      <div class="saved-list-item" data-list-id="${list.id}">
        <div class="saved-list-info">
          <h4>${escapeHtml(list.transport_name)}</h4>
          <p><strong>Fecha de envío:</strong> ${formattedDate}</p>
          <p><strong>Pedidos:</strong> ${list.orders_count}</p>
          <p><strong>Guardada el:</strong> ${formattedCreated}</p>
        </div>
        <div class="saved-list-actions">
          <button class="btn btn-primary view-list-btn" data-list-id="${list.id}">👁️ Ver</button>
          <button class="btn btn-success print-list-btn" data-list-id="${list.id}">🖨️ Imprimir</button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Función para cargar y mostrar una lista guardada
async function loadSavedList(listId) {
  try {
    const { data, error } = await supabase
      .from("shipping_lists")
      .select("*")
      .eq("id", listId)
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error("❌ Error cargando lista guardada:", error);
    throw error;
  }
}

// Función helper para escapar HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Configurar eventos para el modal de Imprimir Listas
function setupPrintListsModal() {
  const printListsBtn = document.getElementById("print-lists-btn");
  const printListsModal = document.getElementById("print-lists-modal");
  const closePrintListsModal = document.getElementById("close-print-lists-modal");
  const searchOrdersBtn = document.getElementById("search-orders-btn");
  const printPdfBtn = document.getElementById("print-pdf-btn");
  const filterTransport = document.getElementById("filter-transport");
  const filterDate = document.getElementById("filter-date");

  // Establecer fecha por defecto (hoy) usando hora de Buenos Aires
  if (filterDate) {
    const todayBA = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    filterDate.value = todayBA;
  }

  // Abrir modal
  if (printListsBtn) {
    printListsBtn.addEventListener("click", async () => {
      if (printListsModal) {
        printListsModal.classList.add("active");

        // Fecha por defecto = hoy en Buenos Aires (refrescar cada vez que se abre para que coincida con el día al buscar)
        if (filterDate) {
          filterDate.value = new Date().toLocaleDateString("en-CA", {
            timeZone: "America/Argentina/Buenos_Aires",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          });
        }

        // Cargar transportes en el selector de Nueva Lista
        if (filterTransport && scheduledTransports.length > 0) {
          filterTransport.innerHTML = '<option value="">Seleccionar transporte...</option>';
          scheduledTransports.forEach(transport => {
            const option = document.createElement("option");
            option.value = transport.id;
            option.textContent = transport.name || "Sin nombre";
            filterTransport.appendChild(option);
          });
        } else if (filterTransport) {
          filterTransport.innerHTML = '<option value="">No hay transportes disponibles</option>';
        }

        // Cargar transportes en el selector de Extraer
        const extractTransport = document.getElementById("extract-transport");
        if (extractTransport && scheduledTransports.length > 0) {
          extractTransport.innerHTML = '<option value="all">Todos los transportes</option>';
          scheduledTransports.forEach(transport => {
            const option = document.createElement("option");
            option.value = transport.id;
            option.textContent = transport.name || "Sin nombre";
            extractTransport.appendChild(option);
          });
        } else if (extractTransport) {
          extractTransport.innerHTML = '<option value="all">Todos los transportes</option><option value="">No hay transportes disponibles</option>';
        }
      }
    });
  }

  // Cerrar modal
  if (closePrintListsModal) {
    closePrintListsModal.addEventListener("click", () => {
      if (printListsModal) {
        printListsModal.classList.remove("active");
      }
    });
  }

  // Cerrar modal al hacer clic fuera
  if (printListsModal) {
    printListsModal.addEventListener("click", (e) => {
      if (e.target === printListsModal) {
        printListsModal.classList.remove("active");
      }
    });
  }

  // Buscar pedidos
  if (searchOrdersBtn) {
    searchOrdersBtn.addEventListener("click", async () => {
      const transportId = filterTransport?.value;
      const date = filterDate?.value;

      if (!transportId) {
        alert("Por favor, selecciona un transporte.");
        return;
      }

      if (!date) {
        alert("Por favor, selecciona una fecha.");
        return;
      }

      try {
        searchOrdersBtn.disabled = true;
        searchOrdersBtn.textContent = "Buscando...";

        const orders = await loadOrdersForList(transportId, date);
        currentOrdersList = orders;

        const selectedTransport = scheduledTransports.find(t => t.id === transportId);
        currentTransportName = selectedTransport?.name || "Desconocido";
        currentFilterDate = date;

        renderOrdersList(orders, currentTransportName, date);
      } catch (error) {
        console.error("❌ Error buscando pedidos:", error);
        alert("Error al buscar pedidos: " + (error.message || "Error desconocido"));
      } finally {
        searchOrdersBtn.disabled = false;
        searchOrdersBtn.textContent = "🔍 Buscar";
      }
    });
  }

  // Imprimir PDF - remover listeners anteriores para evitar duplicados
  if (printPdfBtn) {
    // Clonar el botón para remover todos los listeners anteriores
    const newPrintPdfBtn = printPdfBtn.cloneNode(true);
    printPdfBtn.parentNode.replaceChild(newPrintPdfBtn, printPdfBtn);

    newPrintPdfBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (currentOrdersList.length === 0) {
        alert("No hay pedidos para imprimir.");
        return;
      }

      const transportId = filterTransport?.value;
      await generateShippingListPDF(currentOrdersList, currentTransportName, currentFilterDate, transportId);
    });
  }

  // Tabs
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetTab = btn.dataset.tab;

      // Actualizar botones
      tabButtons.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      // Actualizar contenidos
      tabContents.forEach(content => {
        content.classList.remove("active");
        content.style.display = "none";
      });

      const targetContent = document.getElementById(`tab-${targetTab}`);
      if (targetContent) {
        targetContent.classList.add("active");
        targetContent.style.display = "block";
      }
    });
  });

  // Búsqueda de listas guardadas
  const searchSavedListsBtn = document.getElementById("search-saved-lists-btn");
  const savedListsStartDate = document.getElementById("saved-lists-start-date");
  const savedListsEndDate = document.getElementById("saved-lists-end-date");

  if (searchSavedListsBtn) {
    searchSavedListsBtn.addEventListener("click", async () => {
      try {
        searchSavedListsBtn.disabled = true;
        searchSavedListsBtn.textContent = "Buscando...";

        const startDate = savedListsStartDate?.value || null;
        const endDate = savedListsEndDate?.value || null;

        const lists = await loadSavedShippingLists(startDate, endDate);
        renderSavedShippingLists(lists);
      } catch (error) {
        console.error("❌ Error buscando listas guardadas:", error);
        alert("Error al buscar listas guardadas: " + (error.message || "Error desconocido"));
      } finally {
        searchSavedListsBtn.disabled = false;
        searchSavedListsBtn.textContent = "🔍 Buscar Listas";
      }
    });
  }

  // Descarga de Excel para Extraer
  const downloadExcelBtn = document.getElementById("download-excel-btn");
  const extractStartDate = document.getElementById("extract-start-date");
  const extractEndDate = document.getElementById("extract-end-date");
  const extractTransport = document.getElementById("extract-transport");
  const extractMessage = document.getElementById("extract-message");

  if (downloadExcelBtn) {
    downloadExcelBtn.addEventListener("click", async () => {
      const startDate = extractStartDate?.value;
      const endDate = extractEndDate?.value;
      const transportId = extractTransport?.value || null;

      if (!startDate || !endDate) {
        alert("Por favor, selecciona las fechas desde y hasta.");
        return;
      }

      // Validar que la fecha desde sea menor o igual a la fecha hasta
      if (new Date(startDate) > new Date(endDate)) {
        alert("La fecha 'Desde' debe ser menor o igual a la fecha 'Hasta'.");
        return;
      }

      try {
        downloadExcelBtn.disabled = true;
        downloadExcelBtn.textContent = "Generando Excel...";
        
        if (extractMessage) {
          extractMessage.style.display = "block";
          extractMessage.innerHTML = "<p>Buscando pedidos...</p>";
        }

        const orders = await loadOrdersForExtract(startDate, endDate, transportId);

        if (extractMessage) {
          if (orders.length === 0) {
            extractMessage.innerHTML = "<p style='color: #dc3545;'>No se encontraron pedidos para los filtros seleccionados.</p>";
            downloadExcelBtn.disabled = false;
            downloadExcelBtn.textContent = "📥 Descargar Excel";
            return;
          } else {
            extractMessage.innerHTML = `<p style='color: #28a745;'>Se encontraron ${orders.length} pedidos. Generando archivo Excel...</p>`;
          }
        }

        downloadExtractExcel(orders, startDate, endDate);

        if (extractMessage) {
          extractMessage.innerHTML = `<p style='color: #28a745;'>✅ Archivo Excel generado correctamente con ${orders.length} pedidos.</p>`;
        }
      } catch (error) {
        console.error("❌ Error generando Excel:", error);
        alert("Error al generar el archivo Excel: " + (error.message || "Error desconocido"));
        if (extractMessage) {
          extractMessage.innerHTML = "<p style='color: #dc3545;'>Error al generar el archivo Excel.</p>";
        }
      } finally {
        downloadExcelBtn.disabled = false;
        downloadExcelBtn.textContent = "📥 Descargar Excel";
      }
    });
  }

  // Ver lista guardada
  document.addEventListener("click", async (e) => {
    if (e.target.classList.contains("view-list-btn")) {
      const listId = e.target.dataset.listId;
      try {
        const list = await loadSavedList(listId);
        const orders = list.orders_data || [];

        // Cambiar a tab de nueva lista y mostrar los datos
        document.querySelector('[data-tab="new-list"]').click();
        renderOrdersList(orders, list.transport_name, list.list_date);

        // Mostrar el contenedor
        const container = document.getElementById("orders-list-container");
        if (container) {
          container.style.display = "block";
        }

        // Ocultar botón de imprimir (ya está guardada)
        if (printPdfBtn) {
          printPdfBtn.style.display = "none";
        }
      } catch (error) {
        console.error("❌ Error cargando lista:", error);
        alert("Error al cargar la lista: " + (error.message || "Error desconocido"));
      }
    }

    // Imprimir lista guardada
    if (e.target.classList.contains("print-list-btn")) {
      const listId = e.target.dataset.listId;
      try {
        const list = await loadSavedList(listId);
        const orders = list.orders_data || [];

        // Generar PDF sin guardar nuevamente (ya está guardada)
        if (!window.jspdf) {
          alert("Error: Librería jsPDF no está disponible.");
          return;
        }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

        function addPageToPDF() {
          // Encabezado - título a la izquierda, transporte y fecha a la derecha
          doc.setFontSize(18);
          doc.setFont(undefined, "bold");
          doc.text("Lista de Envíos FYL", 15, 20);

          doc.setFontSize(11);
          doc.setFont(undefined, "normal");
          
          // Transporte y fecha alineados a la derecha
          doc.text(`Transporte: ${list.transport_name}`, 282, 15, { align: "right" });

          // Convertir fecha correctamente usando fecha local (evitar problemas de UTC)
          const listDateParts = list.list_date.split('-');
          const listYear = parseInt(listDateParts[0]);
          const listMonth = parseInt(listDateParts[1]) - 1; // Mes es 0-indexed
          const listDay = parseInt(listDateParts[2]);
          const dateObj = new Date(listYear, listMonth, listDay);
          const formattedDate = dateObj.toLocaleDateString("es-AR", {
            year: "numeric",
            month: "long",
            day: "numeric"
          });
          doc.text(`Fecha: ${formattedDate}`, 282, 22, { align: "right" });

          const tableData = orders.map((order, index) => {
            const locality = [order.city, order.province].filter(Boolean).join(", ") || "Sin localidad";
            const totalFormatted = new Intl.NumberFormat("es-AR", {
              style: "currency",
              currency: "ARS",
              minimumFractionDigits: 0
            }).format(order.total_amount);

            return [
              (index + 1).toString(),
              order.customer_name,
              order.address,
              locality,
              order.phone,
              order.items_count.toString(),
              order.packages_count.toString(),
              totalFormatted
            ];
          });

          // Calcular totales
          const totalProductos = orders.reduce((sum, order) => sum + (order.items_count || 0), 0);
          const totalPaquetes = orders.reduce((sum, order) => sum + (order.packages_count || 1), 0);
          const totalMonto = orders.reduce((sum, order) => sum + parseARSNumber(order.total_amount || 0), 0);
          // Formatear total sin espacios para evitar división en dos líneas
          const totalMontoFormatted = new Intl.NumberFormat("es-AR", {
            style: "currency",
            currency: "ARS",
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
          }).format(totalMonto).replace(/\s/g, ""); // Eliminar espacios que puedan causar división

          doc.autoTable({
            startY: 30,
            head: [["N°", "Cliente", "Dirección", "Localidad", "Teléfono", "Productos", "Paquetes", "Total"]],
            body: tableData,
            styles: { fontSize: 9 },
            headStyles: { fillColor: [23, 162, 184], textColor: 255, fontStyle: "bold" },
            alternateRowStyles: { fillColor: [245, 245, 245] },
            margin: { left: 15, right: 15 },
            columnStyles: {
              0: { cellWidth: 10, halign: 'center' }, // N°
              1: { cellWidth: 42 }, // Cliente
              2: { cellWidth: 70 }, // Dirección
              3: { cellWidth: 42 }, // Localidad
              4: { cellWidth: 28 }, // Teléfono
              5: { cellWidth: 18 }, // Productos
              6: { cellWidth: 18 }, // Paquetes
              7: { cellWidth: 36, halign: 'right' } // Total - alineado a la derecha
            }
          });

          // Total de paquetes y firma en la misma altura
          const finalY = doc.lastAutoTable.finalY + 15;
          
          // Total de paquetes a la izquierda
          doc.setFontSize(12);
          doc.setFont(undefined, "bold");
          doc.text(`Total de Paquetes: ${totalPaquetes}`, 20, finalY);

          // Firma a la derecha a la misma altura
          doc.setFontSize(10);
          doc.setFont(undefined, "normal");
          doc.text("Firma del Transporte:", 130, finalY);
          doc.line(130, finalY + 5, 180, finalY + 5);
          doc.text("Aclaración:", 190, finalY);
          doc.line(190, finalY + 5, 240, finalY + 5);
        }

        addPageToPDF();
        doc.addPage();
        addPageToPDF();

        const dateStr = list.list_date.replace(/-/g, "");
        const transportStr = list.transport_name.replace(/[^a-zA-Z0-9]/g, "_");
        const filename = `Lista_Envio_${transportStr}_${dateStr}.pdf`;

        doc.save(filename);
      } catch (error) {
        console.error("❌ Error imprimiendo lista guardada:", error);
        alert("Error al imprimir la lista: " + (error.message || "Error desconocido"));
      }
    }
  });
}

// Inicializar cuando esté listo
async function initWhenReady() {
  if (document.readyState === "loading") {
    await new Promise(resolve => {
      document.addEventListener("DOMContentLoaded", resolve);
    });
  }

  supabase = await getSupabase();

  if (!supabase) {
    console.error("❌ No se pudo obtener Supabase");
    alert("Error: No se pudo conectar con Supabase. Por favor, recarga la página.");
    return;
  }

  await initClosedOrders();
  // setupPrintListsModal ya se llama en initClosedOrders, no es necesario llamarlo de nuevo
}

initWhenReady();
