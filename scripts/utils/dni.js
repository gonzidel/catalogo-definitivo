/** Solo dígitos (para guardar en base). */
export function normalizeDniInput(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/** DNI 7-8 dígitos o CUIT/CUIL 11 dígitos. Vacío = válido (opcional). */
export function isValidDni(value) {
  const digits = normalizeDniInput(value);
  if (!digits) return true;
  return /^\d{7,8}$/.test(digits) || /^\d{11}$/.test(digits);
}

/** 11 dígitos → XX-XXXXXXXX-X; 7-8 sin cambios. */
export function formatDniDisplay(value) {
  const digits = normalizeDniInput(value);
  if (!digits) return "";
  if (digits.length === 11) {
    return `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`;
  }
  return digits;
}

export const DNI_VALIDATION_MESSAGE =
  "El documento debe tener 7 u 8 dígitos (DNI) o 11 dígitos (CUIT/CUIL, ej. 20-37262546-6)";
