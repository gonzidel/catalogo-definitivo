/**
 * Normalizador liviano de plural / género en español para el buscador.
 * No es un stemmer general: solo reglas justificadas con el catálogo FYL.
 * Igualdad de raíz cuenta como match exacto en el scoring.
 */

/** Tokens que NO deben stemmearse (marcas / formas comerciales / invariables). */
const STEM_EXCEPTIONS = new Set([
  "jeans",
  "stras",
  "strass",
  "medias",
  "pantalon",
  "crocs",
  "shorts",
  "leggings",
  "tops",
  "body",
  "bodies",
]);

/**
 * Reduce plurales regulares y género gramatical a una raíz estable.
 * Ejemplos: sandalias→sandalia, negras→negro, dorada→dorado, camperas→campera.
 */
export function stemEsToken(token: string): string {
  const t = String(token ?? "").trim();
  if (!t || t.length < 3) return t;
  if (STEM_EXCEPTIONS.has(t)) return t;

  // -iones → -ion (excepciones ya cubiertas)
  if (t.endsWith("iones") && t.length > 6) return t.slice(0, -2);

  // -ces → -z (ej. peces → pez) — raro en catálogo, bajo riesgo
  if (t.endsWith("ces") && t.length > 4) return `${t.slice(0, -3)}z`;

  // Plurales en -es (sandalias no; sandales sí) — tras vocal+consonante
  if (t.endsWith("es") && t.length >= 5) {
    const stem = t.slice(0, -2);
    // -des (verdades) no aplica; -tes/-nes/-res frecuentes
    if (/[aeiou][dnrlst]$/.test(stem) || stem.endsWith("ion")) return stem;
  }

  // Plurales en -s
  if (t.endsWith("s") && t.length >= 4 && !t.endsWith("ss")) {
    const stem = t.slice(0, -1);
    // género: negras → negra → negro (abajo)
    if (!STEM_EXCEPTIONS.has(stem)) {
      return stemGender(stem);
    }
  }

  return stemGender(t);
}

function stemGender(t: string): string {
  // -osa/-oso, -ada/-ado, -ida/-ido, -ica/-ico, -ana/-ano
  if (t.length >= 4 && /(?:osa|ada|ida|ica|ana|iva)$/.test(t)) {
    return `${t.slice(0, -1)}o`;
  }
  // -oras → ya reducido; -ora → -or
  if (t.endsWith("ora") && t.length >= 5) return t.slice(0, -1);
  // -a → -o cuando parece adjetivo de color/atributo corto-medio
  // (negra→negro, dorada ya cubierto). Evitar tipos terminados en -a (sandalia, bota, remera).
  const typeLike = new Set([
    "sandalia",
    "bota",
    "remera",
    "campera",
    "ojota",
    "zapatilla",
    "chinela",
    "pollera",
    "camisa",
    "blusa",
    "calza",
    "falda",
    "cartera",
    "mochila",
    "pantufla",
    "pantubota",
    "musculosa",
    "guillermina",
    "alpargata",
    "plataforma",
    "chatita",
  ]);
  if (typeLike.has(t)) return t;
  if (t.length >= 4 && t.endsWith("a") && !t.endsWith("ia") && !t.endsWith("ua")) {
    // colores / atributos: blanca, negra, roja, beigea no; beige queda
    const candidate = `${t.slice(0, -1)}o`;
    if (COLORISH.has(candidate) || COLORISH.has(t)) return candidate;
  }
  return t;
}

const COLORISH = new Set([
  "negro",
  "blanco",
  "rojo",
  "azul",
  "verde",
  "gris",
  "rosa",
  "beige",
  "marron",
  "dorado",
  "plateado",
  "bordo",
  "lila",
  "fucsia",
  "celeste",
  "crema",
  "nude",
  "suela",
  "chocolate",
  "camel",
  "cobre",
  "naranja",
  "amarillo",
  "violeta",
  "turquesa",
  "salmon",
  "natural",
  "fluor",
]);

/** Stem de un token + el original (únicos). */
export function stemVariants(token: string): string[] {
  const raw = String(token ?? "").trim();
  if (!raw) return [];
  const stemmed = stemEsToken(raw);
  return stemmed === raw ? [raw] : [raw, stemmed];
}

export function tokensEqualStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return stemEsToken(a) === stemEsToken(b);
}
