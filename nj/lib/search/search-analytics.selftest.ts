/**
 * Selftest Fase 4 — search analytics (sin red).
 * Run: npx tsx lib/search/search-analytics.selftest.ts
 */
import { resolveSearchQuery } from "./search-resolver";
import { buildSeedSearchDictionary } from "./seed-data";
import {
  compactResolutions,
  isValidSearchEventRow,
  rowFromResolved,
} from "./search-analytics";
import {
  consumeUiSearchCommit,
  markUiSearchCommit,
  __resetPendingForTests,
} from "./search-analytics-pending";

const dict = buildSeedSearchDictionary();
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const memory = new Map<string, string>();
const sessionLike = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => {
    memory.set(k, v);
  },
  removeItem: (k: string) => {
    memory.delete(k);
  },
};
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { sessionStorage?: typeof sessionLike }).sessionStorage = sessionLike;

__resetPendingForTests();
memory.clear();

const resolved = resolveSearchQuery("zapatillas negras", dict);
check("RESOLVER intacto", resolved.resolvedQuery === "zapatilla negro");

const compact = compactResolutions(resolved.resolutions);
check("RESOLUTIONS compactas", compact.length === 2 && compact[0].input === "zapatillas");

const committed = rowFromResolved("search_committed", resolved, { result_count: 8 });
check("COMMITTED válido", isValidSearchEventRow(committed) && committed.result_count === 8);
check(
  "COMMITTED sin count inválido",
  !isValidSearchEventRow({ ...committed, result_count: null })
);

const zero = rowFromResolved("search_committed", resolveSearchQuery("xyzabc", dict), {
  result_count: 0,
});
check("ZERO RESULTS representable", isValidSearchEventRow(zero) && zero.result_count === 0);

const suggestion = rowFromResolved("suggestion_selected", resolveSearchQuery("pantu", dict), {
  suggestion_type: "tag",
  suggestion_label: "Pantubota",
});
check("SUGGESTION válido", isValidSearchEventRow(suggestion));

const click = rowFromResolved("result_click", resolved, {
  product_article: "30",
  result_position: 3,
});
check("RESULT CLICK válido", isValidSearchEventRow(click) && click.result_position === 3);
check(
  "RESULT CLICK position 0 inválido",
  !isValidSearchEventRow({ ...click, result_position: 0 })
);

markUiSearchCommit("pantubotas");
const first = consumeUiSearchCommit("pantubotas");
const second = consumeUiSearchCommit("pantubotas");
check("PENDING consume una vez", !!first && second === null);

markUiSearchCommit("pantubota");
check("DIRECT URL no consume otro q", consumeUiSearchCommit("zapatilla") === null);
check("PENDING espera el q correcto", consumeUiSearchCommit("pantubota") !== null);

markUiSearchCommit("p");
check("NO registra query < 2", consumeUiSearchCommit("p") === null);

const long = "x".repeat(250);
const clipped = rowFromResolved("search_committed", resolveSearchQuery(long, dict), {
  result_count: 0,
});
check("QUERY clip 200", clipped.query_original.length <= 200);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
