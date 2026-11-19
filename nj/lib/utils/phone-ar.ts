/**
 * Teléfonos argentinos (celular) para el alta y edición de perfil.
 *
 * El cliente solo ve y escribe "característica + número" (10 dígitos, ej. 362 472-0762).
 * El prefijo internacional "+54 9" es interno: se agrega recién al guardar y nunca se
 * muestra ni se pide en pantalla.
 *
 * Un teléfono nacional argentino tiene SIEMPRE 10 dígitos: característica de 2 a 4 dígitos
 * (11 en AMBA) + número de 8 a 6 dígitos. Menos de 10 es un número incompleto.
 */

export interface PhoneValidation {
  ok: boolean;
  /** 10 dígitos nacionales (solo si ok). */
  digits: string;
  /** Mensaje para el cliente (solo si !ok). Nunca menciona el 54 ni el 9 internos. */
  error?: string;
}

const NATIONAL_LENGTH = 10;

/** Si el número trae el 15 de celular después de la característica, devuelve el número sin él. */
function stripMobile15(d: string): string {
  if (d.length !== NATIONAL_LENGTH + 2) return d;
  // Característica de 2 dígitos solo existe en AMBA (11); el resto es de 3 o 4 dígitos.
  const areaLengths = d.startsWith("11") ? [2] : [3, 4];
  for (const area of areaLengths) {
    if (d.slice(area, area + 2) === "15") {
      return d.slice(0, area) + d.slice(area + 2);
    }
  }
  return d;
}

/**
 * Lleva cualquier forma habitual de escribir un celular argentino a sus dígitos nacionales:
 * quita 0 de discado, 00, 54 (país), 9 (celular) y el 15 posterior a la característica.
 * No trunca: si el resultado no mide 10 dígitos, lo devuelve tal cual para que la validación
 * informe el problema en vez de guardar un número recortado.
 */
export function extractArgentinaNationalDigits(raw: string | null | undefined): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  let changed = true;
  while (changed && d.length > 0) {
    changed = false;
    if (d.startsWith("0")) {
      d = d.slice(1); // 0 de discado nacional o 00 internacional: ninguna característica empieza con 0
      changed = true;
    } else if (d.startsWith("54") && d.length > NATIONAL_LENGTH) {
      d = d.slice(2);
      changed = true;
    } else if (d.startsWith("9") && d.length > NATIONAL_LENGTH) {
      d = d.slice(1);
      changed = true;
    }
  }
  return stripMobile15(d);
}

function plural(n: number, singular: string, pluralWord: string): string {
  return n === 1 ? `${n} ${singular}` : `${n} ${pluralWord}`;
}

export function validateArgentinaPhone(raw: string | null | undefined): PhoneValidation {
  const digits = extractArgentinaNationalDigits(raw);

  if (!digits) {
    return { ok: false, digits: "", error: "Ingresá tu teléfono: característica + número." };
  }
  if (digits.length < NATIONAL_LENGTH) {
    const missing = NATIONAL_LENGTH - digits.length;
    const verb = missing === 1 ? "Falta" : "Faltan";
    return {
      ok: false,
      digits,
      error: `Teléfono incompleto: ${verb} ${plural(missing, "dígito", "dígitos")}. Escribí característica + número (ej: 362 472-0762).`,
    };
  }
  if (digits.length > NATIONAL_LENGTH) {
    const extra = digits.length - NATIONAL_LENGTH;
    const verb = extra === 1 ? "Sobra" : "Sobran";
    return {
      ok: false,
      digits,
      error: `${verb} ${plural(extra, "dígito", "dígitos")}. Escribí solo característica + número, sin 0 ni 15 (ej: 362 472-0762).`,
    };
  }
  // Características argentinas: 11 (AMBA) o empiezan con 2 o 3.
  const validArea = digits.startsWith("11") || digits.startsWith("2") || digits.startsWith("3");
  if (!validArea) {
    return {
      ok: false,
      digits,
      error: "La característica no es válida. Revisá que empiece con tu código de área (ej: 362 u 11).",
    };
  }
  if (/^(\d)\1+$/.test(digits)) {
    return { ok: false, digits, error: "El teléfono no parece válido. Revisalo." };
  }
  return { ok: true, digits };
}

/** "362 472-0762" / "11 2345-6789": formato que ve el cliente. */
export function formatPhoneLocalDisplay(digits10: string): string {
  const d = String(digits10 ?? "").replace(/\D/g, "");
  if (d.length !== NATIONAL_LENGTH) return d;
  const area = d.startsWith("11") ? 2 : 3;
  const number = d.slice(area);
  return `${d.slice(0, area)} ${number.slice(0, -4)}-${number.slice(-4)}`;
}

/** Formato interno que se guarda en `customers.phone`: "+54 9 362 472-0762". */
export function formatPhoneStored(digits10: string): string {
  const local = formatPhoneLocalDisplay(digits10);
  return `+54 9 ${local}`;
}

/**
 * Valor para mostrar o editar en pantalla a partir de lo guardado: sin "+54 9".
 * Si el dato guardado no es un celular completo (cargas viejas), se muestra lo que hay,
 * sin el prefijo y sin inventar dígitos.
 */
export function phoneForDisplay(stored: string | null | undefined): string {
  const text = String(stored ?? "").trim();
  if (!text) return "";
  const withoutPrefix = text.replace(/^\+\s*54\s*9?\s*/, "").trim();
  const digits = extractArgentinaNationalDigits(withoutPrefix);
  if (digits.length === NATIONAL_LENGTH) return formatPhoneLocalDisplay(digits);
  return withoutPrefix;
}

/** true si ambos son el mismo número, sin importar prefijos ni separadores. */
export function isSameArgentinaPhone(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const da = extractArgentinaNationalDigits(a);
  const db = extractArgentinaNationalDigits(b);
  return da !== "" && da === db;
}

/**
 * Limpia lo que se escribe o pega: solo dígitos, espacios y los separadores habituales.
 * NUNCA recorta por largo: un tope de caracteres puede comerse los dígitos finales de un
 * autocompletado (ese fue el bug original). Si sobran dígitos, `validateArgentinaPhone` avisa.
 */
export function sanitizePhoneInput(value: string): string {
  return String(value ?? "")
    .replace(/[^\d\s+()\-.]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^\s+/, "");
}
