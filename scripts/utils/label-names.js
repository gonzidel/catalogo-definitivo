// scripts/utils/label-names.js
// Pool de nombres para rótulos: titular + sub-nombres del cliente.

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

export function getOrderActiveLabelButtonIndex(order, customer) {
  const pool = buildCustomerLabelNamePoolDetailed(customer);
  if (pool.length <= 1) return 1;

  const assigned = String(order?.label_customer_name || "").trim();
  if (assigned) {
    const match = pool.find(
      (entry) => normalizeLabelNameCompare(entry.full_name) === normalizeLabelNameCompare(assigned)
    );
    if (match) return match.button;
  }

  return 1;
}

export function getOrderLabelDisplayName(order, customer) {
  const fromOrder = String(order?.label_customer_name || "").trim();
  if (fromOrder) return fromOrder;
  return String(customer?.full_name || customer?.name || "").trim() || "Cliente sin nombre";
}
