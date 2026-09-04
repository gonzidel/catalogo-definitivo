/**
 * Selftest Fase 5 — validación de vocabulario + uso por resolutions.
 * Run: npx tsx lib/admin/search-admin.selftest.ts
 */
import { validateAliasDraft, validateKeywordDraft } from "./search-admin-validate";
import { buildKeywordUsageMap } from "./search-admin-usage";
import { normalizeText } from "../search/normalize";
import type { SearchVocabLookup } from "./search-admin-validate";

const lookup: SearchVocabLookup = {
  keywords: [
    { id: "k-pantu", canonical: "pantubota", displayLabel: "Pantubota" },
    { id: "k-zapa", canonical: "zapatilla", displayLabel: "Zapatilla" },
    { id: "k-negro", canonical: "negro", displayLabel: "Negro" },
  ],
  aliases: [
    { id: "a-id-pantu", aliasNormalized: "pantubota", keywordId: "k-pantu", canonical: "pantubota" },
    { id: "a-pantus", aliasNormalized: "pantubotas", keywordId: "k-pantu", canonical: "pantubota" },
    { id: "a-space", aliasNormalized: "pantu bota", keywordId: "k-pantu", canonical: "pantubota" },
    { id: "a-id-zapa", aliasNormalized: "zapatilla", keywordId: "k-zapa", canonical: "zapatilla" },
    { id: "a-zapas", aliasNormalized: "zapatillas", keywordId: "k-zapa", canonical: "zapatilla" },
  ],
};

let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const dup = validateAliasDraft("pantubotas", "pantubota", "plural", lookup);
check("ALIAS EXISTENTE pantubotas", !dup.ok && dup.code === "alias_exists", dup.ok ? "debería fallar" : dup.message);

const canon = validateAliasDraft("zapatilla", "pantubota", "commercial", lookup);
check(
  "COLISIÓN CANONICAL zapatilla→Pantubota",
  !canon.ok && canon.code === "canonical_collision",
  canon.ok ? "debería fallar" : canon.message
);

const accent = validateAliasDraft("PÁNTUBOTAS", "pantubota", "plural", lookup);
check(
  "NORMALIZACIÓN PÁNTUBOTAS",
  !accent.ok && accent.code === "alias_exists" && accent.normalized === "pantubotas",
  accent.ok ? "debería detectar pantubotas" : `${accent.normalized} · ${accent.message}`
);

const empty = validateAliasDraft("   ", "pantubota", "plural", lookup);
check("ALIAS VACÍO", !empty.ok && empty.code === "empty");

const long = validateAliasDraft("x".repeat(81), "pantubota", "typo", lookup);
check("ALIAS LARGO", !long.ok && long.code === "too_long");

const identity = validateAliasDraft("pantubota", "pantubota", "plural", lookup);
check("ALIAS IDENTIDAD", !identity.ok && identity.code === "identity_alias");

const fresh = validateAliasDraft("botita", "pantubota", "commercial", lookup);
check("ALIAS NUEVO botita", fresh.ok && fresh.ok && fresh.normalized === "botita");

const noDest = validateAliasDraft("botita", "", "commercial", lookup);
check("SIN DESTINO", !noDest.ok && noDest.code === "missing_destination");

const kwDup = validateKeywordDraft("pantubota", "Pantubota", "product_type", lookup);
check("KEYWORD EXISTENTE", !kwDup.ok && kwDup.code === "keyword_exists");

const kwAlias = validateKeywordDraft("pantubotas", "Pantubotas", "product_type", lookup);
check("KEYWORD ES ALIAS", !kwAlias.ok && kwAlias.code === "keyword_is_alias");

const kwNew = validateKeywordDraft("Botín", "Botín", "product_type", lookup);
check("KEYWORD NUEVA", kwNew.ok && kwNew.ok && kwNew.canonical === "botin");

check("normalize PÁNTUBOTAS", normalizeText("PÁNTUBOTAS") === "pantubotas");

const usage = buildKeywordUsageMap(
  [
    { canonical: "zapatilla", aliasInput: "zapatillas", hits: 1, lastSeen: "2026-09-03T10:00:00Z" },
    { canonical: "negro", aliasInput: "negras", hits: 1, lastSeen: "2026-09-03T10:00:00Z" },
  ],
  [{ queryResolved: "zapatilla negro", hits: 1, lastSeen: "2026-09-03T10:00:00Z" }]
);
check(
  "MULTI-PALABRA no atribuye query_resolved entero a zapatilla",
  (usage.get("zapatilla")?.resolutionHits ?? 0) === 1 &&
    (usage.get("zapatilla")?.exactResolvedHits ?? 0) === 0 &&
    (usage.get("zapatilla")?.usage ?? 0) === 1 &&
    (usage.get("negro")?.resolutionHits ?? 0) === 1 &&
    (usage.get("negro")?.exactResolvedHits ?? 0) === 0
);

const identityUsage = buildKeywordUsageMap(
  [],
  [{ queryResolved: "pantubota", hits: 4, lastSeen: "2026-09-03T12:00:00Z" }]
);
check("IDENTITY pantubota cuenta uso", (identityUsage.get("pantubota")?.usage ?? 0) === 4);

if (failed > 0) {
  console.error(`\n${failed} checks failed`);
  process.exit(1);
}
console.log("\nOK search-admin selftest");
