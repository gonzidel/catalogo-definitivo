/**
 * Paridad con nj/lib/transport/shipping-helpers.ts (zona retiro local común).
 * Usado en admin/closed-orders.js para marcar pedidos de clientas del local
 * que cerraron con envío a domicilio.
 */

import { canonicalizeTransportName, CANONICAL_TRANSPORTS } from "./transport-canonical.js?v=m260607";

function normalizeForMatch(s) {
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
    "colonia benites",
  ].map(normalizeForMatch)
);

const localPickupShortDeadlineLocalities = new Set(
  ["resistencia", "barranqueras", "puerto vilela", "puerto vilelas", "fontana", "fortana"].map(
    normalizeForMatch
  )
);

export function isChacoSpecial(province, city) {
  return (
    normalizeForMatch(province) === "chaco" &&
    chacoSpecialLocalities.has(normalizeForMatch(city))
  );
}

export function isLocalPickupShortDeadlineZone(province, city) {
  return (
    normalizeForMatch(province) === "chaco" &&
    localPickupShortDeadlineLocalities.has(normalizeForMatch(city))
  );
}

export function isCorrientesCapital(province, city) {
  const p = normalizeForMatch(province);
  const c = normalizeForMatch(city);
  return p === "corrientes" && (c === "corrientes" || c === "corrientes capital");
}

/** Geo donde el dashboard ofrece retiro en local (Corrientes capital, Chaco especial, etc.). */
export function isDashboardRetiroLocalZone(province, city) {
  if (isChacoSpecial(province, city)) return true;
  if (isLocalPickupShortDeadlineZone(province, city)) return true;
  if (isCorrientesCapital(province, city)) return true;
  return false;
}

export function isLocalPickupTransport(transportName) {
  return canonicalizeTransportName(transportName || "") === CANONICAL_TRANSPORTS.RETIRO_DE_LOCAL;
}

function parseOrderNotesObject(rawNotes) {
  if (!rawNotes) return {};
  try {
    const parsed = JSON.parse(String(rawNotes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* noop */
  }
  return {};
}

/**
 * Pedido cerrado para envío de una clienta de zona local (ej. Corrientes/Capital con MyM).
 */
export function isClosedOrderFromLocalZoneWithShipping(order, customer, transportName) {
  const notes = parseOrderNotesObject(order?.notes);
  if (notes.local_zone_shipping_close === true) return true;

  const province = customer?.province ?? null;
  const city = customer?.city ?? null;
  if (!isDashboardRetiroLocalZone(province, city)) return false;
  if (isLocalPickupTransport(transportName)) return false;
  return Boolean(canonicalizeTransportName(transportName || ""));
}
