/**
 * Selftest Fase 3 — ranking / MatchQuality.
 * Run: npx tsx lib/search/search-score.selftest.ts
 */
import { classifyTokenMatch } from "./match-quality";
import { resolveSearchQuery } from "./search-resolver";
import { buildSeedSearchDictionary } from "./seed-data";
import {
  fieldMatchScore,
  scoreProductSearch,
} from "./search-score";
import { searchProductsLegacy } from "./search-score.legacy";
import { RANKING_FIXTURE, fixtureProduct } from "./search-ranking.fixture";
import { buildSuggestions, searchProducts } from "../utils/search";
import type { GroupedProduct } from "../../types/catalog";

const dict = buildSeedSearchDictionary();

function emptyProduct(partial: Partial<GroupedProduct>): GroupedProduct {
  return {
    Articulo: "X",
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

let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function arts(products: GroupedProduct[]): string[] {
  return products.map((p) => p.Articulo);
}

function rank(term: string, pool = RANKING_FIXTURE): GroupedProduct[] {
  return searchProducts(pool, term, dict);
}

function explain(product: GroupedProduct, term: string) {
  return scoreProductSearch(product, resolveSearchQuery(term, dict), undefined, dict);
}

// ── MatchQuality ─────────────────────────────────────────────────────────────

check("EXACT", classifyTokenMatch("pantubota", "pantubota") === "exact");
check("PREFIX", classifyTokenMatch("pantubota", "pantu") === "prefix");
check(
  "SUBSTRING conservador",
  classifyTokenMatch("pantubotasx", "antubota") === "substring" ||
    classifyTokenMatch("xpeluche", "peluche") === "substring"
);
check("NO substring bota⊂pantubota", classifyTokenMatch("pantubota", "bota") === "none");
check("FUZZY1", classifyTokenMatch("pantubota", "pantubotaa") === "fuzzy1");
check("FUZZY2 largo", classifyTokenMatch("plataforma", "platafomra") === "fuzzy2");
check("SKU sin fuzzy", classifyTokenMatch("pant2", "pantx", "sku") === "none");
check("CORTO exact", classifyTokenMatch("eco", "eco") === "exact");
check("CORTO prefix", classifyTokenMatch("bota", "bot") === "prefix");
check("CORTO no substring eco⊂escolar", classifyTokenMatch("escolar", "eco") === "none");
check("CORTO no fuzzy", classifyTokenMatch("rojo", "red") === "none");

check(
  "SCORE exact > prefix > substring > fuzzy1 > fuzzy2",
  fieldMatchScore("filtro1", "exact") >
    fieldMatchScore("filtro1", "prefix") &&
    fieldMatchScore("filtro1", "prefix") >
      fieldMatchScore("filtro1", "substring") &&
    fieldMatchScore("filtro1", "substring") >
      fieldMatchScore("filtro1", "fuzzy1") &&
    fieldMatchScore("filtro1", "fuzzy1") >
      fieldMatchScore("filtro1", "fuzzy2")
);

check(
  "10 fuzzy2 details no superan 1 tipo exacto",
  10 * fieldMatchScore("details", "fuzzy2") < fieldMatchScore("filtro1", "exact")
);

// ── AND + aliases ────────────────────────────────────────────────────────────

const andHits = rank("zapatilla negra plataforma");
check(
  "AND tres conceptos",
  andHits.length > 0 &&
    andHits.every((p) => p.Articulo === "HBA") &&
    andHits[0].Articulo === "HBA",
  arts(andHits).join(",")
);

check(
  "AND excluye zapatilla+plataforma sin negro",
  !andHits.some((p) => p.Articulo === "2DD" || p.Articulo === "BA")
);

const aliasA = arts(rank("pantubota"));
const aliasB = arts(rank("pantubotas"));
check(
  "ALIAS pantubotas ≈ pantubota",
  aliasA.join(",") === aliasB.join(","),
  `${aliasA.join(",")} vs ${aliasB.join(",")}`
);

const znA = arts(rank("zapatilla negra"));
const znB = arts(rank("zapatillas negras"));
check(
  "ALIAS zapatillas negras ≈ zapatilla negra",
  znA[0] === znB[0] && znA.length === znB.length,
  `first ${znA[0]}/${znB[0]} n=${znA.length}/${znB.length}`
);

// ── Campos ───────────────────────────────────────────────────────────────────

const sku = rank("PANT2");
check("ARTICULO exacto primero", sku[0]?.Articulo === "PANT2", arts(sku).slice(0, 3).join(","));

const skuHyphen = rank("PANT-2");
check("ARTICULO compacto PANT-2", skuHyphen[0]?.Articulo === "PANT2");

const skuCase = rank("pant2");
check("ARTICULO case insensitive", skuCase[0]?.Articulo === "PANT2");

const pantu = rank("pantubota");
check(
  "TIPO pantubota primero",
  pantu[0]?.Filtro1 === "Pantubota" &&
    pantu.every((p) => p.Filtro1 === "Pantubota"),
  arts(pantu).join(",")
);
check("PANT2 no entra en pantubota", !pantu.some((p) => p.Articulo === "PANT2"));

const peluche = rank("peluche");
const pelucheArts = arts(peluche);
check(
  "DETAILS peluche encuentra BOTON",
  pelucheArts.includes("BOTON")
);
check(
  "NOMBRE peluche > solo detail",
  pelucheArts.indexOf("122") < pelucheArts.indexOf("BOTON") &&
    pelucheArts.indexOf("CONF") < pelucheArts.indexOf("BOTON"),
  pelucheArts.join(",")
);
check(
  "FILTRO2 peluche entre nombre y detail",
  pelucheArts.indexOf("R2360") > pelucheArts.indexOf("122") &&
    pelucheArts.indexOf("R2360") < pelucheArts.indexOf("BOTON"),
  pelucheArts.join(",")
);

const negro = rank("negro");
check("COLOR negro tiene resultados", negro.length > 0);
check(
  "COLOR no mete Suela por fuzzy",
  !negro.some((p) => p.Articulo === "122" || p.Articulo === "BOTON"),
  arts(negro).join(",")
);

const calzado = rank("calzado");
check(
  "CATEGORIA calzado < tipo/nombre",
  calzado.length > 0 &&
    !calzado.some((p) => p.Categoria !== "Calzado")
);

const diario = rank("diario");
check(
  "DESCRIPCION larga no inventa ranking absurdo",
  diario.length === 0 || diario.every((p) => /diario/i.test(p.Descripcion)),
  arts(diario).join(",")
);

const eco = rank("eco");
check("CORTO eco no mata escolar", !eco.some((p) => p.Articulo === "MR7" || p.Articulo === "J25"));
check("CORTO eco encuentra Eco Cuero", eco.some((p) => p.Articulo === "C21"), arts(eco).join(","));

const bot = rank("bot");
check(
  "CORTO bot no mete pantubota por substring",
  !bot.some((p) => p.Articulo === "122" || p.Articulo === "PA22"),
  arts(bot).join(",")
);
check("CORTO bot encuentra Bota", bot.some((p) => p.Articulo === "MAGDA3"), arts(bot).join(","));
check(
  "CORTO bot puede prefix de Articulo BOTON",
  bot.some((p) => p.Articulo === "BOTON")
);

const jean = rank("jean");
check("JEAN por Filtro2/nombre", jean.some((p) => p.Articulo === "R1959"));

const fuzzy = rank("pantubotaa");
check("FUZZY pantubotaa encuentra tipo", fuzzy.some((p) => p.Filtro1 === "Pantubota"), arts(fuzzy).join(","));
const exactPantu = explain(RANKING_FIXTURE.find((p) => p.Articulo === "122")!, "pantubota");
const fuzzyPantu = explain(RANKING_FIXTURE.find((p) => p.Articulo === "122")!, "pantubotaa");
check(
  "FUZZY score < exact",
  !!exactPantu && !!fuzzyPantu && fuzzyPantu.score < exactPantu.score,
  `exact=${exactPantu?.score} fuzzy=${fuzzyPantu?.score}`
);
check(
  "FUZZY quality no es exact",
  fuzzyPantu?.matches[0]?.quality === "fuzzy1" ||
    fuzzyPantu?.matches[0]?.quality === "fuzzy2"
);

check("ZERO xyzabc", rank("xyzabc").length === 0);
check("ZERO red", rank("red").length === 0);
check("ZERO oro", rank("oro").length === 0);

// ── Score por campo / no inflación ───────────────────────────────────────────

const named = RANKING_FIXTURE.find((p) => p.Articulo === "122")!;
const namedExplain = explain(named, "peluche");
check(
  "BEST MATCH no infla nombre+detail",
  !!namedExplain &&
    namedExplain.matches.length === 1 &&
    namedExplain.matches[0].field === "nombre",
  JSON.stringify(namedExplain?.matches)
);

const hba = RANKING_FIXTURE.find((p) => p.Articulo === "HBA")!;
const hbaExplain = explain(hba, "zapatilla negra plataforma");
check(
  "TOKEN scores HBA",
  !!hbaExplain &&
    hbaExplain.matches.length === 3 &&
    hbaExplain.matches.some((m) => m.token === "zapatilla" && m.field === "filtro1" || m.token === "zapatilla" && m.field === "nombre") &&
    hbaExplain.matches.some((m) => m.token === "negro" && m.field === "color") &&
    hbaExplain.matches.some((m) => m.token === "plataforma"),
  JSON.stringify(hbaExplain)
);

const weakVsStrong = emptyProduct({
  Articulo: "WEAK",
  Descripcion:
    "Ojota liviana y resistente, ideal para uso deportivo diario playa pileta o estudio",
  Filtro1: "Ojota",
  Categoria: "Calzado",
});
const strongTipo = emptyProduct({
  Articulo: "STRONG",
  Descripcion: "Zapatilla urbana",
  Filtro1: "Zapatilla",
  Filtro2: "Deportivas",
  Categoria: "Calzado",
});
const deporte = searchProducts([weakVsStrong, strongTipo], "deportivo", dict);
check(
  "DESCRIPCION no gana a atributo real",
  deporte[0]?.Articulo === "STRONG",
  arts(deporte).join(",")
);

const withStock = emptyProduct({
  Articulo: "PA22",
  Filtro1: "Pantubota",
  Categoria: "Calzado",
  hasAnyStock: true,
});
const exactNoStock = emptyProduct({
  Articulo: "122",
  Descripcion: "Pantubota con peluche",
  Filtro1: "Pantubota",
  Categoria: "Calzado",
  hasAnyStock: false,
});
const stockRank = searchProducts([withStock, exactNoStock], "pantubota con peluche", dict);
check(
  "STOCK no gana a match de nombre",
  stockRank[0]?.Articulo === "122",
  arts(stockRank).join(",")
);

const tieA = emptyProduct({
  Articulo: "A1",
  Filtro1: "Zapatilla",
  Categoria: "Calzado",
  hasAnyStock: false,
  FechaPublicacion: "2020-01-01",
});
const tieB = emptyProduct({
  Articulo: "B1",
  Filtro1: "Zapatilla",
  Categoria: "Calzado",
  hasAnyStock: true,
  FechaPublicacion: "2019-01-01",
});
const tied = searchProducts([tieA, tieB], "zapatilla", dict);
check("TIE-BREAK stock", tied[0]?.Articulo === "B1", arts(tied).join(","));

// ── Autocomplete no se rompe ─────────────────────────────────────────────────

const suggestions = buildSuggestions(RANKING_FIXTURE, "pantubotas", 7, dict);
check(
  "AUTOCOMPLETE tag canónico",
  suggestions.some((s) => s.type === "tag" && s.label === "Pantubota")
);
check(
  "AUTOCOMPLETE PDP PANT2",
  buildSuggestions(RANKING_FIXTURE, "PANT2", 7, dict).some(
    (s) => s.type === "product" && s.href === "/producto/PANT2"
  )
);

// ── Comparación antes / después ──────────────────────────────────────────────

const compareQueries = ["pantubota", "zapatilla negra", "peluche", "PANT2"];
console.log("\n--- ANTES / DESPUÉS (fixture real) ---");
for (const q of compareQueries) {
  const before = arts(searchProductsLegacy(RANKING_FIXTURE, q, dict)).slice(0, 10);
  const after = arts(rank(q)).slice(0, 10);
  console.log(`\nQUERY: ${q}`);
  console.log("ANTES");
  before.forEach((a, i) => console.log(`${i + 1}. ${a}`));
  console.log("DESPUÉS");
  after.forEach((a, i) => console.log(`${i + 1}. ${a}`));
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
