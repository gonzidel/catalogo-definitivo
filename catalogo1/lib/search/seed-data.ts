import { buildSearchDictionary } from "@/lib/search/dictionary";
import type { SearchDictionary, SearchDictionaryRow } from "@/lib/search/types";

/** Espejo del seed SQL 327 — solo para tests / fallback offline. */
export const SEARCH_SEED_ROWS: SearchDictionaryRow[] = [
  kw("pantubota", "Pantubota", "product_type", [
    ["pantubotas", "plural"],
    ["pantu bota", "spacing"],
  ]),
  kw("zapatilla", "Zapatilla", "product_type", [
    ["zapatillas", "plural"],
    ["zapa", "abbreviation"],
    ["zapas", "abbreviation"],
  ]),
  kw("borcego", "Borcego", "product_type", [["borcegos", "plural"]]),
  kw("ojota", "Ojota", "product_type", [["ojotas", "plural"]]),
  kw("chinela", "Chinela", "product_type", [["chinelas", "plural"]]),
  kw("deportivo", "Deportivo", "attribute", [
    ["deportiva", "grammatical"],
    ["deportivos", "plural"],
    ["deportivas", "grammatical"],
  ]),
  kw("negro", "Negro", "color", [
    ["negra", "grammatical"],
    ["negros", "plural"],
    ["negras", "grammatical"],
  ]),
].flat();

function kw(
  canonical: string,
  display: string,
  keywordKind: string,
  aliases: Array<[string, string]>
): SearchDictionaryRow[] {
  const rows: SearchDictionaryRow[] = [
    {
      canonical,
      display_label: display,
      keyword_kind: keywordKind,
      alias: canonical,
      alias_normalized: canonical,
      alias_kind: null,
    },
  ];
  for (const [alias, aliasKind] of aliases) {
    rows.push({
      canonical,
      display_label: display,
      keyword_kind: keywordKind,
      alias,
      alias_normalized: alias,
      alias_kind: aliasKind,
    });
  }
  return rows;
}

export function buildSeedSearchDictionary(): SearchDictionary {
  return buildSearchDictionary(SEARCH_SEED_ROWS);
}
