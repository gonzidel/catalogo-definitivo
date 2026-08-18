import { canonicalizeTransportName } from "./index";

function normalizeForMatch(s: string) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\u0301/g, "")
    .replace(/\u0300/g, "")
    .replace(/[\u0300-\u036f]/g, "");
}

const chacoSpecialLocalities = new Set(
  [
    "resistencia",
    "puerto vilela",
    "puerto vilelas",
    "barranqueras",
    "fontana",
    "puerto tirol",
    "margarita belen",
    "margarita belén",
    "colonia benites",
    "colonia benítez",
  ].map(normalizeForMatch)
);

export function isChacoSpecial(province: string, city: string) {
  return (
    normalizeForMatch(province) === "chaco" &&
    chacoSpecialLocalities.has(normalizeForMatch(city))
  );
}

export function getFormaPagoTextForTransport(transporte: string) {
  if (canonicalizeTransportName(transporte) === "Correo Argentino") return "";
  return "Acordar en el local.";
}

export function isLocalPickupTransport(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  return canonical === "Retira local" || canonical === "Retiro de Local";
}

/**
 * Texto del aviso "te escribimos por WhatsApp cuando esté listo" en el
 * dashboard del cliente (ActiveOrderTab). Cambia según cómo se paga con
 * cada transporte:
 * - Via Cargo / Credifin / Snaider: el pago se coordina junto con el envío
 *   por WhatsApp (no se paga en el local ni es contrarrembolso).
 * - SEDE / MyM: el pago es contrarrembolso -- se abona junto con el envío
 *   al recibirlo, no hace falta coordinar nada de pago por separado.
 * - Resto (Correo Argentino, Retira Local, etc.): solo se coordina envío.
 */
export function getOrderReadyWhatsappMessage(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  if (isLocalPickupTransport(canonical)) {
    return "Cuando esté listo, podés pasar a retirarlo por el local. Tenés 48 horas para retirarlo y el pago se realiza en el local.";
  }
  if (canonical === "Via Cargo" || canonical === "Credifin" || canonical === "Snaider") {
    return "Te escribiremos por WhatsApp cuando esté listo para coordinar el pago y el envío.";
  }
  if (canonical === "SEDE" || canonical === "MyM") {
    return "Te escribiremos por WhatsApp cuando esté listo. El pago es contrarrembolso: abonás el pedido junto con el envío cuando te lo entreguen, no hace falta coordinar nada más.";
  }
  return "Te escribiremos por WhatsApp cuando esté listo para coordinar el envío.";
}

/**
 * Texto explicativo del popover "¿Cómo funciona el envío?" en el header del
 * dashboard del cliente. Usa la misma categorización de transportes que
 * getOrderReadyWhatsappMessage, pero describiendo el transporte en sí (no el
 * aviso de "pedido listo"):
 * - Retiro de Local: no hay envío, se retira en el local sin costo.
 * - SEDE / MyM: envío a sede fija, pago contra reembolso junto con el envío.
 * - Via Cargo / Credifin / Snaider / Expreso Norte: empresa de transporte,
 *   costo y pago se coordinan por WhatsApp.
 * - Correo Argentino: costo según peso, se informa antes del despacho.
 */
export function getOrderReadyCompactMessage(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  if (isLocalPickupTransport(canonical)) {
    return "Te avisamos cuando esté listo. Tenés 48 horas para retirarlo y pagás en el local.";
  }
  if (canonical === "SEDE" || canonical === "MyM") {
    return "Te avisamos cuando esté listo. Pagás pedido y envío al recibirlo.";
  }
  if (canonical === "Via Cargo" || canonical === "Credifin" || canonical === "Snaider") {
    return "Te escribimos cuando esté listo para coordinar pago y envío.";
  }
  return "Te escribimos cuando esté listo para coordinar el envío.";
}

export function getTransportExplanationText(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  if (isLocalPickupTransport(canonical)) {
    return "Retirás tu pedido en el local, sin costo de envío. Te avisamos por WhatsApp cuando esté listo para que lo pases a buscar.";
  }
  if (canonical === "SEDE" || canonical === "MyM") {
    return "Tu pedido se envía a la sede más cercana. El pago es contra reembolso: lo abonás junto con el envío cuando te lo entreguen.";
  }
  if (canonical === "Correo Argentino") {
    return "El envío se calcula según el peso del paquete. Una vez que tu pedido esté listo te avisamos el costo total (productos + envío) para que lo abones antes del despacho.";
  }
  if (canonical === "Via Cargo" || canonical === "Credifin" || canonical === "Snaider" || canonical === "Expreso Norte") {
    return "El costo de envío se coordina por WhatsApp junto con el pago, una vez que tu pedido esté listo.";
  }
  return "El costo de envío se coordina por WhatsApp una vez que tu pedido esté listo.";
}

export function resolveShippingOptions(province: string, city: string, rawOptions: string[]) {
  let opciones = sortShippingOptions(rawOptions.map(canonicalizeTransportName));
  let efectivo = opciones[0] ?? "—";

  if (isChacoSpecial(province, city)) {
    opciones = ["Retira local"];
    efectivo = "Retira local";
  }

  const soloSedeUnico = opciones.length === 1 && opciones[0] === "SEDE";
  return { opciones, efectivo, soloSedeUnico };
}

function sortShippingOptions(options: string[]) {
  const priority = new Map([
    ["Retira local", 0],
    ["Retiro de Local", 0],
    ["SEDE", 1],
    ["MyM", 2],
    ["Expreso Norte", 3],
    ["Credifin", 4],
    ["Snaider", 5],
    ["Transporte Snaider", 5],
    ["Via Cargo", 6],
    ["Correo Argentino", 99],
  ]);

  return [...options].sort((a, b) => {
    const pa = priority.get(a) ?? 50;
    const pb = priority.get(b) ?? 50;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b, "es");
  });
}
