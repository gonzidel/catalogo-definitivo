const CANONICAL_TRANSPORTS = Object.freeze({
  CORREO_ARGENTINO: "Correo Argentino",
  VIA_CARGO: "Via Cargo",
  CREDIFIN: "Credifin",
  SNAIDER: "Snaider",
  SEDE: "SEDE",
  RETIRO_DE_LOCAL: "Retira local",
});

const TRANSPORT_ALIAS_TO_CANONICAL = Object.freeze({
  "correo argentino": CANONICAL_TRANSPORTS.CORREO_ARGENTINO,
  "via cargo": CANONICAL_TRANSPORTS.VIA_CARGO,
  "credifin": CANONICAL_TRANSPORTS.CREDIFIN,
  "snaider": CANONICAL_TRANSPORTS.SNAIDER,
  "transporte snaider": CANONICAL_TRANSPORTS.SNAIDER,
  "sede": CANONICAL_TRANSPORTS.SEDE,
  "retira local": CANONICAL_TRANSPORTS.RETIRO_DE_LOCAL,
  "retiro de local": CANONICAL_TRANSPORTS.RETIRO_DE_LOCAL,
  "retiro del local": CANONICAL_TRANSPORTS.RETIRO_DE_LOCAL,
  "retiro local": CANONICAL_TRANSPORTS.RETIRO_DE_LOCAL,
});

export const RESERVED_TRANSPORT_KEYS = Object.freeze(
  new Set(Object.keys(TRANSPORT_ALIAS_TO_CANONICAL))
);

export function normalizeTransportKey(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

export function canonicalizeTransportName(input) {
  const key = normalizeTransportKey(input);
  if (!key) return "";
  return TRANSPORT_ALIAS_TO_CANONICAL[key] || String(input || "").trim();
}

export function isReservedTransportName(input) {
  return RESERVED_TRANSPORT_KEYS.has(normalizeTransportKey(input));
}

export { CANONICAL_TRANSPORTS };
