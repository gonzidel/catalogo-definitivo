/**
 * Regresión golden del buscador.
 * Run: npx tsx lib/search/search-golden.selftest.ts
 */
import { buildSeedSearchDictionary } from "./seed-data";
import {
  GOLDEN_QUERIES,
  GOLDEN_QUERY_TARGET,
  type GoldenExpectation,
} from "./golden-queries";
import { GOLDEN_FIXTURE } from "./golden-fixture";
import { searchProductsDetailed } from "../utils/search";
import { productHasAnySize } from "./size-intent";
import { classifyTokenMatch } from "./match-quality";
import { stemEsToken } from "./stem-es";

const dict = buildSeedSearchDictionary();
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

check(
  `golden set size ≥ ${GOLDEN_QUERY_TARGET - 2}`,
  GOLDEN_QUERIES.length >= GOLDEN_QUERY_TARGET - 2,
  `n=${GOLDEN_QUERIES.length}`
);

function evalExpect(
  q: string,
  arts: string[],
  products: typeof GOLDEN_FIXTURE,
  exp: GoldenExpectation
): boolean {
  switch (exp.kind) {
    case "min_results":
      return arts.length >= exp.min;
    case "zero":
      return arts.length === 0;
    case "includes_articulo":
      return exp.articulos.every((a) => arts.includes(a));
    case "excludes_articulo":
      return exp.articulos.every((a) => !arts.includes(a));
    case "not_first_articulo":
      return arts.length === 0 || !exp.articulos.includes(arts[0]);
    case "size_filter":
      return (
        arts.length >= exp.min &&
        products
          .filter((p) => arts.includes(p.Articulo))
          .every((p) => productHasAnySize(p, [exp.size]))
      );
    default: {
      const _e: never = exp;
      return _e;
    }
  }
}

// Unitas rápidas del motor
check("stem sandalias→sandalia", stemEsToken("sandalias") === "sandalia");
check("stem negras→negro", stemEsToken("negras") === "negro");
check("stem dorada→dorado", stemEsToken("dorada") === "dorado");
check("stem jeans intacto", stemEsToken("jeans") === "jeans");
check("fuzzy nude≠nudo", classifyTokenMatch("nudo", "nude") === "none");
check(
  "fuzzy sandaila≈sandalia",
  classifyTokenMatch("sandalia", "sandaila") === "fuzzy1" ||
    classifyTokenMatch("sandalia", "sandaila") === "fuzzy2"
);

for (const g of GOLDEN_QUERIES) {
  const result = searchProductsDetailed(GOLDEN_FIXTURE, g.q, dict);
  const arts = result.hits.map((h) => h.product.Articulo);
  let ok = true;
  const details: string[] = [`n=${arts.length}`, `mode=${result.mode}`];
  for (const exp of g.expect) {
    if (!evalExpect(g.q, arts, GOLDEN_FIXTURE, exp)) {
      ok = false;
      details.push(`fail:${JSON.stringify(exp)}`);
    }
  }
  if (result.mode === "relaxed") details.push(`dropped=${result.dropped.join("+")}`);
  check(`GOLDEN "${g.q}" (${g.note})`, ok, details.join(" "));
}

// Meta: cero resultados “duros” de consultas que deberían recuperar algo vía cascade
const jeansEl = searchProductsDetailed(GOLDEN_FIXTURE, "jeans elástico", dict);
check(
  "cascade jeans elástico → relaxed o exact con hits",
  jeansEl.hits.length > 0 && (jeansEl.mode === "relaxed" || jeansEl.mode === "exact"),
  `mode=${jeansEl.mode} n=${jeansEl.hits.length}`
);

if (failed > 0) {
  console.error(`\n${failed} fallos`);
  process.exit(1);
}
console.log("\nOK search-golden.selftest");
