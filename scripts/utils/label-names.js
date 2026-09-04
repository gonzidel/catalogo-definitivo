// scripts/utils/label-names.js
// Pool de nombres para rótulos: titular + sub-nombres del cliente.
// Si algún nombre tiene DNI, la rotación automática solo usa entradas con DNI.

export function formatPersonDisplayName(fullName) {
  const full = String(fullName || "").trim();
  if (!full) return "Cliente sin nombre";
  const parts = full.split(/\s+/);
  if (parts.length === 1) return full;
  const last = parts.pop();
  const first = parts.join(" ");
  return `${last}, ${first}`;
}

export function normalizeLabelNameCompare(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function entryHasLabelDni(entry) {
  return String(entry?.dni || "").trim().length > 0;
}

export function parseCustomerAdditionalNamesForLabels(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, 3)
    .map((entry) => {
      const full =
        String(entry?.full_name || "").trim() ||
        String(`${entry?.first_name || ""} ${entry?.last_name || ""}`).trim() ||
        String(entry?.name || "").trim();
      const dni = String(entry?.dni || "").trim();
      return full ? { full_name: full, dni } : null;
    })
    .filter(Boolean);
}

export function buildCustomerLabelNamePoolDetailed(customer) {
  const mainName = String(customer?.full_name || customer?.name || "").trim() || "Sin nombre";
  const mainDni = String(customer?.dni || "").trim();
  const pool = [{ button: 1, full_name: mainName, dni: mainDni, isMain: true }];
  for (const entry of parseCustomerAdditionalNamesForLabels(customer?.additional_names)) {
    pool.push({
      button: pool.length + 1,
      full_name: entry.full_name,
      dni: entry.dni || "",
      isMain: false,
    });
  }
  return pool;
}

/** Pool usado por la rotación automática: prioriza nombres con DNI si existe alguno. */
export function getLabelNameRotationPool(pool) {
  const full = Array.isArray(pool) ? pool : [];
  if (full.length <= 1) return full;
  const withDni = full.filter(entryHasLabelDni);
  return withDni.length > 0 ? withDni : full;
}

/**
 * Entrada activa para mostrar / imprimir.
 * Si el pedido ya tiene label_customer_name, lo respeta.
 * Si no, usa el cursor sobre el pool de rotación (con preferencia DNI).
 */
export function getPendingLabelNameEntry(customer, order) {
  const pool = buildCustomerLabelNamePoolDetailed(customer);
  if (pool.length === 0) return null;

  const assigned = String(order?.label_customer_name || "").trim();
  if (assigned) {
    const match = pool.find(
      (entry) => normalizeLabelNameCompare(entry.full_name) === normalizeLabelNameCompare(assigned)
    );
    if (match) return match;
  }

  const rotation = getLabelNameRotationPool(pool);
  const cursor = Number(customer?.label_name_cursor) || 0;
  return rotation[cursor % rotation.length] || pool[0];
}

export function getOrderActiveLabelButtonIndex(order, customer) {
  const entry = getPendingLabelNameEntry(customer, order);
  return entry?.button || 1;
}

export function getOrderLabelDisplayName(order, customer) {
  const fromOrder = String(order?.label_customer_name || "").trim();
  if (fromOrder) return fromOrder;
  const pending = getPendingLabelNameEntry(customer, order);
  if (pending?.full_name) return pending.full_name;
  return String(customer?.full_name || customer?.name || "").trim() || "Cliente sin nombre";
}
