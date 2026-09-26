/**
 * Selftest del Search Resolver. No toca producción.
 * Run: npx tsx lib/search/search-resolver.selftest.ts
 */
import { resolveSearchQuery } from "./search-resolver";
import { buildSeedSearchDictionary } from "./seed-data";
import { buildSuggestions, searchProducts } from "../utils/search";
import type { GroupedProduct } from "../../types/catalog";

const dict = buildSeedSearchDictionary();

function emptyProduct(partial: Partial<GroupedProduct>): GroupedProduct {
  return {
    Articulo: "",
    Descripcion: "",
    Precio: "",
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "",
    Categoria: "Calzado",
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    DetalleColor: [],
    ...partial,
  };
}

const cases: Array<{ name: string; input: string; expected: string }> = [
  { name: "NORMALIZACIÓN", input: "PÁNTUBOTA", expected: "pantubota" },
  { name: "PLURAL", input: "pantubotas", expected: "pantubota" },
  { name: "MULTI TOKEN", input: "zapatillas negras", expected: "zapatilla negro" },
  { name: "ALIAS COMERCIAL", input: "zapa negra", expected: "zapatilla negro" },
  { name: "FRASE", input: "pantu bota negra", expected: "pantubota negro" },
  { name: "FALLBACK", input: "plataforma", expected: "plataforma" },
  { name: "TYPO NO REGISTRADO", input: "pantubotaa", expected: "pantubotaa" },
  { name: "GUION", input: "pantu-bota negra", expected: "pantubota negro" },
];

let failed = 0;

for (const c of cases) {
  const got = resolveSearchQuery(c.input, dict).resolvedQuery;
  const ok = got === c.expected;
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: "${c.input}" → "${got}"${ok ? "" : ` (esperado "${c.expected}")`}`);
}

const ui = resolveSearchQuery("pantubotas", dict);
const uiOk = ui.originalQuery === "pantubotas" && ui.resolvedQuery === "pantubota";
if (!uiOk) failed += 1;
console.log(`${uiOk ? "PASS" : "FAIL"} UI original intacto: original="${ui.originalQuery}" resolved="${ui.resolvedQuery}"`);

const products = [
  emptyProduct({ Articulo: "PANT2", Filtro1: "Pantubota", Filtro2: "Pantubotas" }),
  emptyProduct({ Articulo: "Z01", Filtro1: "Zapatilla" }),
];
const suggestions = buildSuggestions(products, "pantubotas", 7, dict);
const tagLabels = suggestions.filter((s) => s.type === "tag").map((s) => s.label);
const noDup = tagLabels.filter((l) => /pantubota/i.test(l)).length <= 1;
const prefersCanonical = tagLabels.includes("Pantubota");
if (!noDup || !prefersCanonical) failed += 1;
console.log(
  `${noDup && prefersCanonical ? "PASS" : "FAIL"} AUTOCOMPLETE dedupe: ${JSON.stringify(tagLabels)}`
);

const productSuggestions = buildSuggestions(products, "PANT2", 7, dict);
const productHit = productSuggestions.some(
  (s) => s.type === "product" && s.href === "/producto/PANT2"
);
if (!productHit) failed += 1;
console.log(`${productHit ? "PASS" : "FAIL"} PRODUCT suggestion sigue siendo PDP`);

const withDetail = [
  emptyProduct({ Articulo: "BOTON", DetallesSimilitud: "Frio,Peluche" }),
];
const detailSuggestions = buildSuggestions(withDetail, "peluche", 7, dict);
const detailSearch = searchProducts(withDetail, "peluche", dict);
const detailOk = detailSearch.some((p) => p.Articulo === "BOTON");
if (!detailOk) failed += 1;
console.log(`${detailOk ? "PASS" : "FAIL"} DETAILS peluche encuentra BOTON`);
void detailSuggestions;

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
