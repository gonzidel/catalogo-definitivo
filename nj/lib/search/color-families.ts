/**
 * Mapa de colores crudos del snapshot → familias canónicas de búsqueda.
 * Los códigos internos (var*, negcha, etc.) se ignoran: no son buscables.
 */
import { normalizeText } from "@/lib/search/normalize";

/** Códigos internos / basura que no deben entrar al índice de color. */
const IGNORE_COLORS = new Set([
  "var",
  "var01",
  "var02",
  "var03",
  "var04",
  "var05",
  "var07",
  "var08",
  "var10",
  "varios",
  "print",
  "prin cho",
  "multicolor",
  "hombre arana",
]);

const FAMILY_ALIASES: Record<string, string[]> = {
  negro: ["negro", "negra", "negros", "negras"],
  blanco: ["blanco", "blanca", "blancos", "blancas"],
  beige: ["beige"],
  chocolate: ["chocolate"],
  suela: ["suela"],
  azul: ["azul", "azules"],
  gris: ["gris", "grises"],
  verde: ["verde", "verdes"],
  rosa: ["rosa", "rosas"],
  celeste: ["celeste", "celestes"],
  crema: ["crema"],
  marron: ["marron", "marrones"],
  rojo: ["rojo", "roja", "rojos", "rojas"],
  lila: ["lila", "lilas"],
  bordo: ["bordo", "bordó"],
  plata: ["plata", "plateado", "plateada"],
  dorado: ["dorado", "dorada", "dorados", "doradas", "oro"],
  fucsia: ["fucsia"],
  cobre: ["cobre"],
  camel: ["camel"],
  morado: ["morado", "morada", "violeta"],
  naranja: ["naranja"],
  amarillo: ["amarillo", "amarilla"],
  salmon: ["salmon"],
  turquesa: ["turquesa"],
  natural: ["natural"],
  fluor: ["fluor"],
  nude: ["nude"],
};

/** Combos compuestos observados en snapshot. */
const COMPOUND: Record<string, string[]> = {
  negrobla: ["negro", "blanco"],
  negrogris: ["negro", "gris"],
  "gris blanco": ["gris", "blanco"],
  "azul oscuro": ["azul"],
  "azul nev": ["azul"],
  "gris.osc": ["gris"],
  "verde osc": ["verde"],
  "verde agua": ["verde"],
  "rosa v": ["rosa"],
  "celeste nev": ["celeste"],
  celesteoxi: ["celeste"],
  negfuc: ["negro", "fucsia"],
  negnar: ["negro", "naranja"],
  negneg: ["negro"],
  grifuc: ["gris", "fucsia"],
  vison: ["marron"],
};

/**
 * Devuelve familias canónicas para un color crudo de variante.
 * Vacío = ignorar (código interno).
 */
export function colorToFamilies(rawColor: string): string[] {
  const n = normalizeText(rawColor);
  if (!n || IGNORE_COLORS.has(n)) return [];
  if (COMPOUND[n]) return COMPOUND[n];

  for (const [family, aliases] of Object.entries(FAMILY_ALIASES)) {
    if (aliases.some((a) => normalizeText(a) === n) || family === n) {
      return [family];
    }
  }

  // Prefijos conocidos (azul oscuro ya compuesto; fallback: primer token)
  for (const family of Object.keys(FAMILY_ALIASES)) {
    if (n.startsWith(family) && n.length <= family.length + 4) return [family];
  }

  return [n];
}

export function isIgnoredColor(rawColor: string): boolean {
  return IGNORE_COLORS.has(normalizeText(rawColor));
}

export function allColorFamilies(): string[] {
  return Object.keys(FAMILY_ALIASES);
}
