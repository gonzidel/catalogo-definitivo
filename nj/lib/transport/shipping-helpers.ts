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

export function resolveShippingOptions(province: string, city: string, rawOptions: string[]) {
  let opciones = rawOptions.map(canonicalizeTransportName);
  let efectivo = opciones[0] ?? "—";

  if (isChacoSpecial(province, city)) {
    opciones = ["Retiro de Local"];
    efectivo = "Retiro de Local";
  }

  const soloSedeUnico = opciones.length === 1 && opciones[0] === "SEDE";
  return { opciones, efectivo, soloSedeUnico };
}
