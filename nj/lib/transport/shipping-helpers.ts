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

/** Localidades con plazo corto de retiro en local (36 h en lugar de 7 días). */
const localPickupShortDeadlineLocalities = new Set(
  [
    "resistencia",
    "barranqueras",
    "puerto vilela",
    "puerto vilelas",
    "fontana",
    "fortana", // typo frecuente
  ].map(normalizeForMatch)
);

export const LOCAL_PICKUP_DEADLINE_HOURS = 36;

/** Mínimo de unidades para cerrar Mi pedido (resto del país). */
export const ORDER_CLOSE_MIN_UNITS_DEFAULT = 4;

/**
 * Zona retiro local acotada: Resistencia, Barranqueras, Puerto Vilelas y Fontana.
 * Plazo ~36 h con vencimiento en día hábil **15:00 AR** (resto del país: 17:00).
 */
export function isLocalPickupShortDeadlineZone(
  province?: string | null,
  city?: string | null
): boolean {
  return (
    normalizeForMatch(province || "") === "chaco" &&
    localPickupShortDeadlineLocalities.has(normalizeForMatch(city || ""))
  );
}

/**
 * Geo donde el dashboard asigna "Retiro de Local" (perfil / cierre de pedido).
 * Incluye isChacoSpecial + Corrientes Capital (lista retiro_del_local).
 * Usado por el Kanban Retiro como fallback si el transport_id está viejo/vacío.
 */
export function isDashboardRetiroLocalZone(
  province?: string | null,
  city?: string | null
): boolean {
  if (isChacoSpecial(province || "", city || "")) return true;
  if (isLocalPickupShortDeadlineZone(province, city)) return true;
  // client/transportes-data.js → retiro_del_local: Corrientes / Corrientes
  if (isCorrientesCapital(province, city)) return true;
  return false;
}

/** Unidades mínimas para habilitar "Cerrar pedido" (zona local: 1; resto: 4). */
export function getOrderCloseMinimumUnits(
  province?: string | null,
  city?: string | null
): number {
  return isLocalPickupShortDeadlineZone(province, city) ? 1 : ORDER_CLOSE_MIN_UNITS_DEFAULT;
}

/**
 * Texto corto de "Forma de pago" en perfil / retiro-envío.
 * - Retiro local → acordar en el local
 * - MyM / SEDE / Expreso Norte → contrareembolso
 * - Snaider / Via Cargo / Credifin / Correo Argentino → transferencia
 */
export function getFormaPagoTextForTransport(transporte: string) {
  const canonical = canonicalizeTransportName(transporte);
  if (isLocalPickupTransport(canonical)) {
    return "Acordar en el local.";
  }
  if (canonical === "MyM" || canonical === "SEDE" || canonical === "Expreso Norte") {
    return "Contrareembolso.";
  }
  if (
    canonical === "Snaider" ||
    canonical === "Transporte Snaider" ||
    canonical === "Via Cargo" ||
    canonical === "Credifin" ||
    canonical === "Correo Argentino"
  ) {
    return "Pago por transferencia.";
  }
  return "Pago por transferencia.";
}

export function isLocalPickupTransport(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  return canonical === "Retira local" || canonical === "Retiro de Local";
}

/**
 * Texto del aviso "te escribimos por WhatsApp cuando esté listo" en el
 * dashboard del cliente (ActiveOrderTab). Cambia según cómo se paga con
 * cada transporte:
 * - SEDE / MyM / Expreso Norte: contrareembolso al recibir.
 * - Via Cargo / Credifin / Snaider / Correo: transferencia (coordina por WhatsApp).
 * - Retiro local: paga en el local.
 */
export function getOrderReadyWhatsappMessage(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  if (isLocalPickupTransport(canonical)) {
    return "Cuando esté listo, podés pasar a retirarlo por el local. Tenés 48 horas para retirarlo y el pago se realiza en el local.";
  }
  if (canonical === "SEDE" || canonical === "MyM" || canonical === "Expreso Norte") {
    return "Te escribiremos por WhatsApp cuando esté listo. El pago es contrareembolso: abonás el pedido junto con el envío cuando te lo entreguen, no hace falta coordinar nada más.";
  }
  if (
    canonical === "Via Cargo" ||
    canonical === "Credifin" ||
    canonical === "Snaider" ||
    canonical === "Transporte Snaider" ||
    canonical === "Correo Argentino"
  ) {
    return "Te escribiremos por WhatsApp cuando esté listo para coordinar el pago por transferencia y el envío.";
  }
  return "Te escribiremos por WhatsApp cuando esté listo para coordinar el envío.";
}

/**
 * Texto explicativo del popover "¿Cómo funciona el envío?" en el header del
 * dashboard del cliente. Usa la misma categorización de transportes que
 * getOrderReadyWhatsappMessage, pero describiendo el transporte en sí (no el
 * aviso de "pedido listo"):
 * - Retiro de Local: no hay envío, se retira en el local sin costo.
 * - SEDE / MyM / Expreso Norte: envío con pago contra reembolso.
 * - Via Cargo / Credifin / Snaider: empresa de transporte, transferencia.
 * - Correo Argentino: costo según peso; pago por transferencia antes del despacho.
 */
export function getOrderReadyCompactMessage(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  if (isLocalPickupTransport(canonical)) {
    return "Te avisamos cuando esté listo. Tenés 48 horas para retirarlo y pagás en el local.";
  }
  if (canonical === "SEDE" || canonical === "MyM" || canonical === "Expreso Norte") {
    return "Te avisamos cuando esté listo. Pagás pedido y envío al recibirlo (contrareembolso).";
  }
  if (
    canonical === "Via Cargo" ||
    canonical === "Credifin" ||
    canonical === "Snaider" ||
    canonical === "Transporte Snaider" ||
    canonical === "Correo Argentino"
  ) {
    return "Te escribimos cuando esté listo para coordinar el pago por transferencia y el envío.";
  }
  return "Te escribimos cuando esté listo para coordinar el envío.";
}

export function getTransportExplanationText(transporte?: string | null) {
  const canonical = canonicalizeTransportName(transporte || "");
  if (isLocalPickupTransport(canonical)) {
    return "Retirás tu pedido en el local, sin costo de envío. Te avisamos por WhatsApp cuando esté listo para que lo pases a buscar.";
  }
  if (canonical === "MyM") {
    return "Se enviará a tu domicilio. El pago es contra reembolso: lo abonás junto con el envío cuando te lo entreguen.";
  }
  if (canonical === "SEDE") {
    return "Tu pedido se envía a la sede más cercana. El pago es contra reembolso: lo abonás junto con el envío cuando te lo entreguen.";
  }
  if (canonical === "Correo Argentino") {
    return "El envío se calcula según el peso del paquete. Una vez que tu pedido esté listo te avisamos el costo total (productos + envío) para que lo abones antes del despacho.";
  }
  if (canonical === "Expreso Norte") {
    return "El envío se coordina por WhatsApp. El pago es contrareembolso: lo abonás junto con el envío cuando te lo entreguen.";
  }
  if (
    canonical === "Via Cargo" ||
    canonical === "Credifin" ||
    canonical === "Snaider" ||
    canonical === "Transporte Snaider"
  ) {
    return "El costo de envío se coordina por WhatsApp junto con el pago por transferencia, una vez que tu pedido esté listo.";
  }
  return "El costo de envío se coordina por WhatsApp una vez que tu pedido esté listo.";
}

/** Corrientes Capital: solo Retira local + MyM en UI de cierre/perfil. */
export function isCorrientesCapital(province?: string | null, city?: string | null) {
  const p = normalizeForMatch(province || "");
  const c = normalizeForMatch(city || "");
  return p === "corrientes" && (c === "corrientes" || c === "corrientes capital");
}

/**
 * Cliente de zona con retiro local habitual (Corrientes capital, Chaco especial, etc.)
 * que cerró el pedido con envío a domicilio u otro transporte (no retiro en local).
 */
export function isLocalZoneCustomerShippingOrder(
  province?: string | null,
  city?: string | null,
  transportName?: string | null
): boolean {
  if (!isDashboardRetiroLocalZone(province, city)) return false;
  if (isLocalPickupTransport(transportName)) return false;
  return Boolean(canonicalizeTransportName(transportName || ""));
}

export function resolveShippingOptions(province: string, city: string, rawOptions: string[]) {
  let opciones = sortShippingOptions(rawOptions.map(canonicalizeTransportName));
  let efectivo = opciones[0] ?? "—";

  if (isChacoSpecial(province, city)) {
    opciones = ["Retira local"];
    efectivo = "Retira local";
  } else if (isCorrientesCapital(province, city)) {
    opciones = sortShippingOptions(["Retira local", "MyM"]);
    efectivo = opciones.includes(efectivo) ? efectivo : opciones[0];
  }

  const soloSedeUnico = opciones.length === 1 && opciones[0] === "SEDE";
  return { opciones, efectivo, soloSedeUnico };
}

/**
 * Transporte efectivo para UI: prioriza el asignado en BD (customers.transport_id),
 * luego el de geo/localStorage. Si el de BD no está en opciones geo (ej. MyM
 * forzado por admin), igual se respeta.
 */
export function resolveEffectiveTransportName(opts: {
  province?: string | null;
  city?: string | null;
  assignedTransportName?: string | null;
  geoTransportName?: string | null;
}): string | null {
  const assigned = canonicalizeTransportName(opts.assignedTransportName || "");
  if (assigned) return assigned;

  const geo = canonicalizeTransportName(opts.geoTransportName || "");
  if (geo) return geo;

  const prov = String(opts.province || "").trim();
  const city = String(opts.city || "").trim();
  if (!prov || !city) return null;

  return null;
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
