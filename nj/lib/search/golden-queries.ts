/**
 * Set de regresión del buscador (auditoría 2026-11-11: 72 consultas reales).
 * Expectativas contra GOLDEN_FIXTURE (no el catálogo live completo).
 */
export type GoldenExpectation =
  | { kind: "min_results"; min: number }
  | { kind: "zero" }
  | { kind: "includes_articulo"; articulos: string[] }
  | { kind: "excludes_articulo"; articulos: string[] }
  | { kind: "not_first_articulo"; articulos: string[] }
  | { kind: "size_filter"; size: string; min: number };

export interface GoldenQuery {
  q: string;
  note: string;
  expect: GoldenExpectation[];
}

/** Smoke: no rompe; hits opcionales según fixture. */
const smoke = (q: string, note: string): GoldenQuery => ({
  q,
  note,
  expect: [{ kind: "min_results", min: 0 }],
});

export const GOLDEN_QUERIES: GoldenQuery[] = [
  // ── Críticos de la auditoría ───────────────────────────────────────────────
  { q: "sandalias", note: "plural tipo", expect: [{ kind: "min_results", min: 1 }] },
  { q: "sandalia", note: "singular tipo", expect: [{ kind: "min_results", min: 1 }] },
  { q: "sandalia negra", note: "tipo+color", expect: [{ kind: "min_results", min: 1 }] },
  { q: "sandalias negras", note: "plural+género", expect: [{ kind: "min_results", min: 1 }] },
  { q: "nude", note: "no debe matchear nudo", expect: [{ kind: "excludes_articulo", articulos: ["NUDO1"] }] },
  { q: "38", note: "talle, no SKU 380", expect: [{ kind: "size_filter", size: "38", min: 1 }, { kind: "excludes_articulo", articulos: ["380"] }] },
  { q: "talle 38", note: "talle explícito", expect: [{ kind: "size_filter", size: "38", min: 1 }] },
  { q: "jeans elástico", note: "cascade: ampliar a jeans", expect: [{ kind: "min_results", min: 1 }] },
  { q: "jeans", note: "base", expect: [{ kind: "min_results", min: 1 }] },
  { q: "jean", note: "singular jean", expect: [{ kind: "min_results", min: 1 }] },
  { q: "chatas", note: "sinónimo pendiente", expect: [{ kind: "min_results", min: 0 }] },
  { q: "chatitas", note: "tipo real", expect: [{ kind: "min_results", min: 1 }] },
  { q: "falda", note: "sinónimo pollera", expect: [{ kind: "min_results", min: 0 }] },
  { q: "pollera", note: "tipo real", expect: [{ kind: "min_results", min: 1 }] },
  { q: "leggings", note: "sinónimo calza", expect: [{ kind: "min_results", min: 0 }] },
  { q: "calzas", note: "plural", expect: [{ kind: "min_results", min: 1 }] },
  { q: "mocasines", note: "sin stock vocabulario", expect: [{ kind: "zero" }] },
  { q: "nene", note: "sinónimo niños", expect: [{ kind: "min_results", min: 0 }] },
  { q: "niños", note: "tag", expect: [{ kind: "min_results", min: 1 }] },
  { q: "chancletas", note: "sinónimo", expect: [{ kind: "zero" }] },
  { q: "borceguies", note: "typo borcegos", expect: [{ kind: "min_results", min: 0 }] },
  { q: "borcegos", note: "plural alias", expect: [{ kind: "min_results", min: 1 }] },
  { q: "taco aguja", note: "combo vacío frecuente", expect: [{ kind: "min_results", min: 0 }] },
  { q: "stiletto", note: "tipo", expect: [{ kind: "min_results", min: 1 }] },
  { q: "zapatillas negras", note: "alias plural+género", expect: [{ kind: "min_results", min: 1 }] },
  { q: "sandaila", note: "typo fuzzy sandalia", expect: [{ kind: "min_results", min: 1 }] },
  { q: "dorada", note: "género → dorado", expect: [{ kind: "min_results", min: 1 }] },
  { q: "short jean", note: "AND estricto puede fallar", expect: [{ kind: "min_results", min: 0 }] },
  { q: "camisa blanca", note: "tipo+color", expect: [{ kind: "min_results", min: 1 }] },
  { q: "vestido largo", note: "tipo+attr", expect: [{ kind: "min_results", min: 1 }] },
  { q: "vestido negro", note: "tipo+color", expect: [{ kind: "min_results", min: 1 }] },
  { q: "xyzabc", note: "basura", expect: [{ kind: "zero" }] },

  // ── Resto de la línea base (72) — smoke + hits cuando el fixture alcanza ──
  smoke("remeras", "plural remera"),
  { q: "remera", note: "tipo", expect: [{ kind: "min_results", min: 1 }] },
  smoke("pantalones", "plural"),
  smoke("pantalon", "singular"),
  smoke("botas", "plural bota"),
  smoke("bota", "tipo"),
  { q: "zapatilla blanca", note: "tipo+color", expect: [{ kind: "min_results", min: 1 }] },
  smoke("vestidos", "plural"),
  { q: "camperas", note: "plural", expect: [{ kind: "min_results", min: 1 }] },
  { q: "ojotas", note: "plural", expect: [{ kind: "min_results", min: 1 }] },
  smoke("zapatos", "genérico"),
  smoke("zuecos", "tipo raro"),
  smoke("alpargatas", "tipo"),
  smoke("carteras", "accesorio"),
  smoke("mochilas", "accesorio"),
  smoke("bolsos", "accesorio"),
  smoke("cartera", "accesorio"),
  smoke("pijama", "ropa"),
  smoke("buzo", "ropa"),
  smoke("perfumes", "fuera de catálogo tipico"),
  smoke("pantuflas", "tipo"),
  smoke("pantufla", "tipo"),
  smoke("medias", "tipo"),
  smoke("corpiño", "ropa interior"),
  smoke("ropa interior", "frase"),
  smoke("mujer", "audiencia"),
  smoke("hombre", "audiencia"),
  { q: "sandalia plataforma", note: "tipo+attr", expect: [{ kind: "min_results", min: 1 }] },
  smoke("plataforma negra", "attr+color"),
  smoke("tacos", "genérico"),
  smoke("zapatila", "typo zapatilla"),
  smoke("ojotsa", "typo ojota"),
  smoke("bota cana alta", "frase"),
  smoke("bota caña alta", "frase con tilde"),
  smoke("texanas", "tipo"),
  smoke("crocs", "marca/tipo"),
  smoke("colegial", "uso"),
  smoke("zapatillas colegio", "combo"),
  smoke("blanco", "color solo"),
  smoke("beige", "color solo"),
  smoke("rojo", "color solo"),
  { q: "sandalia dorada", note: "tipo+color", expect: [{ kind: "min_results", min: 1 }] },
  smoke("t38", "talle prefijo"),
  smoke("numero 38", "talle prefijo largo"),
  smoke("negra", "color género"),
  smoke("negras", "color plural"),
  smoke("campera", "singular"),
  smoke("ojota", "singular"),
  smoke("calza", "singular"),
  smoke("estileto", "canonical stiletto"),
];

/** Meta: cantidad objetivo del plan (= línea base auditoría). */
export const GOLDEN_QUERY_TARGET = 72;
