// admin/qz-printing.js
// Módulo compartido para impresión de etiquetas con QZ Tray
import { SUPABASE_URL, QZ_SIGN_SECRET } from "../scripts/config.js";

// ============================================================================
// QZ Tray - Funciones helper
// ============================================================================

// Función helper para configurar certificado y firma de QZ Tray
export async function setupQZSignature() {
  if (typeof qz === 'undefined' || !qz || !qz.security) {
    console.warn("⚠️ QZ Tray no está disponible para configurar firma");
    return false;
  }

  // Verificar si ya está configurado para evitar configurar múltiples veces
  if (qz.security._signaturePromise) {
    console.log("ℹ️ Firma QZ ya está configurada");
    return true;
  }

  try {
    console.log("🔧 Configurando certificado y firma remota de QZ Tray...");

    // PASO 1: Precargar y configurar certificado público (ANTES de la firma)
    // Esto identifica la conexión y evita que QZ Tray la trate como "anonymous"
    console.log("📜 setCertificatePromise: cargando /certs/qz-site.crt");
    const certResponse = await fetch("/certs/qz-site.crt", { cache: "no-store" });
    const certText = await certResponse.text();
    console.log("✅ cert cargado, len=", certText.length, "begin=", certText.includes("BEGIN CERTIFICATE"));

    // Configurar setCertificatePromise con el certificado ya cargado
    qz.security.setCertificatePromise((resolve, reject) => {
      console.log("📜 setCertificatePromise: resolviendo certificado precargado");
      if (certText) {
        // Limpiar el certificado (eliminar Bag Attributes, etc.)
        // Buscamos solo el bloque entre BEGIN y END CERTIFICATE
        const match = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
        if (match) {
          console.log("✅ Certificado sanitizado encontrado");
          resolve(match[0]);
        } else {
          // Fallback: si no machea, pasamos el texto original pero advertimos
          console.warn("⚠️ No se pudo extraer bloque limpio, usando texto original");
          resolve(certText);
        }
      } else {
        reject(new Error("Certificado inválido o vacío"));
      }
    });

    console.log("✅ Certificado público configurado");

    // IMPORTANTE: Configurar algoritmo SHA-512 (requerido por QZ Tray 2.1+)
    // Según documentación oficial, QZ Tray 2.x espera SHA-512 por defecto
    qz.security.setSignatureAlgorithm("SHA512");
    console.log("✅ Algoritmo de firma configurado: SHA512");

    // PASO 2: Configurar firma remota (DESPUÉS del certificado)
    qz.security.setSignaturePromise(async (toSign) => {
      console.log("🔐 QZ Tray solicitó firma. Longitud:", toSign?.length || 0);

      // Validar que toSign existe
      if (!toSign || typeof toSign !== 'string') {
        const error = new Error("toSign inválido o vacío");
        console.error("❌ Error:", error.message);
        throw error;
      }

      try {
        // Obtener secreto compartido (requiere QZ_SIGN_SECRET en config.local.js)
        const secret = (typeof QZ_SIGN_SECRET !== 'undefined' ? QZ_SIGN_SECRET : "") ||
          (typeof window !== 'undefined' ? window.QZ_SIGN_SECRET : "");
        if (!secret) {
          throw new Error("QZ_SIGN_SECRET no configurado. Agrega QZ_SIGN_SECRET en scripts/config.local.js");
        }

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

        if (!res.ok) {
          const errorText = await res.text();
          console.error("❌ Error HTTP firma QZ:", res.status, errorText);
          throw new Error(`Error en firma: ${res.status} - ${errorText}`);
        }

        // IMPORTANTE: Leer como texto plano y trim, NO como JSON
        const signature = (await res.text()).trim();

        console.log("✅ Firma QZ generada correctamente.");
        return signature;
      } catch (error) {
        console.error("❌ Error generando firma QZ:", error);
        console.error("Stack:", error.stack);
        // Asegurar que siempre lancemos el error para que QZ Tray lo maneje
        throw error;
      }
    });

    console.log("✅ Certificado y firma remota configurados para QZ Tray");
    return true;
  } catch (error) {
    console.error("❌ Error configurando firma QZ:", error);
    console.error("Stack:", error.stack);
    return false;
  }
}

export async function qzConnect() {
  if (typeof qz === 'undefined' || !qz || !qz.websocket) {
    throw new Error("QZ Tray no está disponible");
  }

  // Asegurar que el certificado y la firma estén configurados ANTES de conectar
  // setupQZSignature ahora es async y espera a que el certificado se cargue
  const signatureConfigured = await setupQZSignature();
  if (!signatureConfigured) {
    console.warn("⚠️ No se pudo configurar la firma, QZ puede mostrar popups de seguridad");
  }

  if (!qz.websocket.isActive()) {
    try {
      console.log("🚀 conectando QZ...");
      await qz.websocket.connect();
      console.log("✅ QZ Tray conectado");
    } catch (error) {
      console.error("❌ Error conectando QZ Tray:", error);
      throw error;
    }
  }
}

export async function qzGetPrinterConfig() {
  try {
    // Intentar obtener la impresora Zebra GK420t específicamente
    let printerName;
    try {
      const printers = await qz.printers.find("GK420t");
      if (printers && printers.length > 0) {
        printerName = printers[0];
      } else {
        printerName = await qz.printers.getDefault();
      }
    } catch (e) {
      printerName = await qz.printers.getDefault();
    }

    console.log("✅ Impresora:", printerName);
    const config = qz.configs.create(printerName);
    return config;
  } catch (error) {
    console.error("❌ Error obteniendo impresora:", error);
    throw error;
  }
}

// ============================================================================
// Generación de ZPL
// ============================================================================

export function cleanZplText(v) {
  if (!v) return "";
  let s = v.toString();
  s = s.replace(/[\^~\\]/g, " ");
  s = s
    .replace(/[áÁ]/g, "a")
    .replace(/[éÉ]/g, "e")
    .replace(/[íÍ]/g, "i")
    .replace(/[óÓ]/g, "o")
    .replace(/[úÚ]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N");
  return s;
}

export function buildZplForSingleLabel(sku, productName, color, size, qrData) {
  const sSku = cleanZplText(sku);
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  // Limitar longitud de textos para que no se corten
  const nameShort = sName.slice(0, 20);
  const colorSizeShort = (sColor + " " + sSize).trim().slice(0, 20);

  return (
    `^XA
^PW648
^LL160
^LH0,0

^FO24,20^BQN,2,4
^FDLA,${sQr}^FS

^FO120,30^A0N,18,18^FD${sSku}^FS
^FO120,64^A0N,48,44^FD${nameShort}^FS
^FO120,104^A0N,40,36^FD${colorSizeShort}^FS

^XZ`
  ).trim();
}

export function buildZplForDoubleLabel(sku, productName, color, size, qrData) {
  const sSku = cleanZplText(sku);
  const sName = cleanZplText(productName);
  const sColor = cleanZplText(color);
  const sSize = cleanZplText(size);
  const sQr = cleanZplText(qrData);

  // Limitar longitud de textos para que no se corten
  const nameShort = sName.slice(0, 20);
  const colorSizeShort = (sColor + " " + sSize).trim().slice(0, 20);

  return (
    `^XA
^PW648
^LL160
^LH0,0

^FX ----- ETIQUETA IZQUIERDA -----
^FO24,20^BQN,2,4
^FDLA,${sQr}^FS

^FO120,30^A0N,18,18^FD${sSku}^FS
^FO120,64^A0N,48,44^FD${nameShort}^FS
^FO120,104^A0N,40,36^FD${colorSizeShort}^FS

^FX ----- ETIQUETA DERECHA -----
^FO360,20^BQN,2,4
^FDLA,${sQr}^FS

^FO456,30^A0N,18,18^FD${sSku}^FS
^FO456,64^A0N,48,44^FD${nameShort}^FS
^FO456,104^A0N,40,36^FD${colorSizeShort}^FS

^XZ`
  ).trim();
}

// ============================================================================
// Impresión de etiquetas
// ============================================================================

export async function printProductLabelsZebra(sku, productName, color, size, copies, qrDataOverride) {
  copies = parseInt(copies, 10);
  if (!copies || copies < 1) {
    console.warn("Cantidad de copias inválida:", copies);
    return;
  }

  // El QR debe contener el código numérico único (qr_code) si está disponible, sino usar SKU como fallback
  const qrData = qrDataOverride || sku;

  try {
    await qzConnect();
    const cfg = await qzGetPrinterConfig();

    const jobs = [];

    const totalLabels = copies;
    const pairs = Math.floor(totalLabels / 2); // cuantas veces imprimo doble
    const remainder = totalLabels % 2;         // 0 o 1 etiquetas sueltas

    // ZPL doble (2 etiquetas por vez)
    const zplDouble = buildZplForDoubleLabel(sku, productName, color, size, qrData);

    for (let i = 0; i < pairs; i++) {
      jobs.push({
        type: "raw",
        format: "command",
        data: zplDouble
      });
    }

    // ZPL simple (1 etiqueta sola, solo lado izquierdo)
    if (remainder === 1) {
      const zplSingle = buildZplForSingleLabel(sku, productName, color, size, qrData);
      jobs.push({
        type: "raw",
        format: "command",
        data: zplSingle
      });
    }

    if (jobs.length > 0) {
      await qz.print(cfg, jobs);
      console.log(`✅ ${copies} etiqueta(s) enviada(s) a la impresora`);
    }
  } catch (err) {
    console.error("❌ Error imprimiendo etiquetas Zebra:", err);

    // Mensaje de error más específico
    let errorMessage = "No se pudo imprimir la etiqueta en la Zebra.";

    if (err.message && err.message.includes("certificate")) {
      errorMessage += "\n\nError de certificado/firma. Verifica que la Edge Function qz-sign esté desplegada y funcionando.";
    } else if (err.message && err.message.includes("Connection blocked")) {
      errorMessage += "\n\nConexión bloqueada. Verifica que QZ Tray esté instalado y ejecutándose.";
    } else if (err.message && err.message.includes("No session token")) {
      errorMessage += "\n\nDebes estar autenticado para imprimir.";
    } else {
      errorMessage += "\n\nVerifica que:\n- QZ Tray esté instalado y ejecutándose\n- La impresora esté conectada\n- Tengas sesión activa";
    }

    alert(errorMessage);
  }
}
