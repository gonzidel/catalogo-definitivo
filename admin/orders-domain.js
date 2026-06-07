// admin/orders-domain.js
// Capa compartida de dominio para pedidos (sin dependencias de UI/DOM).
// Extraída desde orders.js y order-creator.js — misma semántica, sin reglas nuevas.

import { normalizeSize } from "../scripts/utils/size-normalizer.js?v=m260607";

export function normalizeCustomerSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeCustomerSearch(value) {
  return normalizeCustomerSearchText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Dígitos locales AR sin prefijo país ni 0 inicial (para comparar sufijos). */
export function normalizePhoneDigitsForMatch(text) {
  let d = String(text || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("54") && d.length > 10) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  return d;
}

export const PHONE_SEARCH_SUFFIX_LEN = 7;

export function getPhoneSearchSuffix(text, suffixLen = PHONE_SEARCH_SUFFIX_LEN) {
  const d = normalizePhoneDigitsForMatch(text);
  if (!d) return "";
  const len = Math.min(suffixLen, d.length);
  return len >= 4 ? d.slice(-len) : "";
}

/** Coincide por últimos N dígitos (prioridad 7): tolera +54, espacios, guiones, etc. */
export function phonesMatchBySuffix(
  queryText,
  storedPhone,
  suffixLen = PHONE_SEARCH_SUFFIX_LEN
) {
  const q = normalizePhoneDigitsForMatch(queryText);
  const p = normalizePhoneDigitsForMatch(storedPhone);
  if (!q || !p) return false;

  const compareLen = Math.min(suffixLen, q.length, p.length);
  if (compareLen < 4) return false;

  if (q.length >= suffixLen && p.length >= suffixLen) {
    return q.slice(-suffixLen) === p.slice(-suffixLen);
  }

  return q.slice(-compareLen) === p.slice(-compareLen);
}

export function customerMatchesFlexible(searchTerm, customer) {
  const normQuery = normalizeCustomerSearchText(searchTerm);
  const tokens = tokenizeCustomerSearch(normQuery);
  const fullName = normalizeCustomerSearchText(customer?.full_name || "");
  const dni = String(customer?.dni || "").toLowerCase();
  const email = String(customer?.email || "").toLowerCase();
  const customerNumber = String(customer?.customer_number || "").toLowerCase();
  const queryDigits = normalizePhoneDigitsForMatch(searchTerm);

  if (fullName === normQuery) return true;
  if (fullName.startsWith(normQuery)) return true;
  if (tokens.length > 0 && tokens.every((t) => fullName.includes(t))) return true;
  if (customerNumber && customerNumber.includes(normQuery)) return true;
  if (dni && dni.includes(normQuery)) return true;
  if (email && email.includes(normQuery)) return true;
  if (queryDigits && phonesMatchBySuffix(searchTerm, customer?.phone)) return true;
  if (queryDigits && String(customer?.phone || "").replace(/\D/g, "").includes(queryDigits)) {
    return true;
  }
  return false;
}

export function rankCustomersForSearch(customers, normQuery, tokens) {
  return [...customers]
    .map((customer) => {
      const fullName = normalizeCustomerSearchText(customer.full_name || "");
      const dni = String(customer.dni || "").toLowerCase();
      const email = String(customer.email || "").toLowerCase();
      const phone = normalizePhoneDigitsForMatch(customer.phone || "");
      const customerNumber = String(customer.customer_number || "").toLowerCase();
      const queryDigits = normalizePhoneDigitsForMatch(normQuery);
      const allTokensMatch = tokens.length > 0 && tokens.every((t) => fullName.includes(t));
      const startsWithAllTokens =
        tokens.length > 0 &&
        fullName &&
        tokens.every((t) => fullName.startsWith(t) || fullName.includes(` ${t}`));

      let score = 0;
      if (fullName === normQuery) score += 140;
      if (fullName.startsWith(normQuery)) score += 100;
      if (startsWithAllTokens) score += 75;
      if (allTokensMatch) score += 55;
      if (customerNumber && customerNumber.includes(normQuery)) score += 45;
      if (dni && dni.includes(normQuery)) score += 35;
      if (queryDigits && phonesMatchBySuffix(normQuery, customer.phone)) score += 90;
      else if (queryDigits && phone.includes(queryDigits)) score += 35;
      if (email && email.includes(normQuery)) score += 20;
      if (!fullName && (dni || email || customerNumber || phone)) score += 5;

      return { customer, score, fullName };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.fullName.localeCompare(b.fullName, "es", { sensitivity: "base" });
    })
    .map((row) => row.customer);
}

export function isManualMissingOrderItem(item) {
  const status = String(item?.status || "").trim().toLowerCase();
  return status === "missing" && Boolean(item?.admin_confirmed_missing);
}

// Ítems nuevos (post-fix 179): picked pero con trazabilidad de confirmación manual.
export function isPickedManualConfirmed(item) {
  const status = String(item?.status || "").trim().toLowerCase();
  return status === "picked" && Boolean(item?.admin_confirmed_missing);
}

export function parseOrderNotesObject(rawNotes) {
  if (!rawNotes) return {};
  try {
    const parsed = JSON.parse(String(rawNotes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // ignore parse errors, fallback to empty object
  }
  return {};
}

export function parseStockPendingReasonConflict(rawReason) {
  const reason = String(rawReason || "");
  if (!reason) return null;
  const variantMatch = reason.match(/variant=([0-9a-fA-F-]{36})/);
  const sizeMatch = reason.match(/size=([^,\s)]+)/i);
  const availableMatch = reason.match(/disponible=(\d+)/i);
  const requestedMatch = reason.match(/solicitado=(\d+)/i);
  if (!variantMatch) return null;
  return {
    variant_id: variantMatch[1],
    size: normalizeSize(sizeMatch?.[1] || ""),
    available: Number(availableMatch?.[1] || 0),
    requested: Number(requestedMatch?.[1] || 0),
  };
}

export function describeStockPendingConflict(order, parsedConflict, fallbackReason = "") {
  if (!parsedConflict?.variant_id) return fallbackReason || "Conflicto de stock sin detalle.";
  const items = Array.isArray(order?.order_items) ? order.order_items : [];
  const targetItem = items.find((item) => {
    const sameVariant = String(item?.variant_id || "") === String(parsedConflict.variant_id);
    const sameSize = normalizeSize(item?.size || "") === parsedConflict.size;
    return sameVariant && sameSize;
  });
  if (!targetItem) return fallbackReason || "Conflicto de stock sin detalle.";
  const productLabel = [targetItem.product_name || "Producto", targetItem.color || "-", targetItem.size || "-"].join(" · ");
  return `${productLabel} | Disponible: ${parsedConflict.available} · Solicitado: ${parsedConflict.requested}`;
}

export function clampIncidentPoints(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(3, Math.floor(n));
}

// Reparto depósito general vs venta (misma prioridad que grilla / RPC).
export function computeWarehouseQtySplitForOrderItem(quantity, stockGeneral, stockVenta) {
  const q = Math.max(0, Number(quantity) || 0);
  const gAvail = Math.max(0, Number(stockGeneral) || 0);
  const vAvail = Math.max(0, Number(stockVenta) || 0);
  let qtyFromVenta = 0;
  let qtyFromGeneral = 0;
  if (vAvail > 0) {
    qtyFromVenta = Math.min(q, vAvail);
    const remaining = q - qtyFromVenta;
    if (remaining > 0 && gAvail > 0) {
      qtyFromGeneral = Math.min(remaining, gAvail);
    }
  } else if (gAvail > 0) {
    qtyFromGeneral = Math.min(q, gAvail);
  }
  return { qty_from_general: qtyFromGeneral, qty_from_venta: qtyFromVenta };
}
