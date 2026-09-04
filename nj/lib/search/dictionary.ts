import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";
import {
  EMPTY_SEARCH_DICTIONARY,
  type SearchAliasEntry,
  type SearchAliasKind,
  type SearchDictionary,
  type SearchDictionaryRow,
  type SearchKeywordEntry,
  type SearchKeywordKind,
} from "@/lib/search/types";

function asKeywordKind(value: string | null | undefined): SearchKeywordKind | null {
  if (
    value === "product_type" ||
    value === "color" ||
    value === "attribute" ||
    value === "commercial"
  ) {
    return value;
  }
  return null;
}

function asAliasKind(value: string | null | undefined): SearchAliasKind | null {
  if (
    value === "plural" ||
    value === "grammatical" ||
    value === "abbreviation" ||
    value === "commercial" ||
    value === "typo" ||
    value === "spacing" ||
    value === "legacy_tag"
  ) {
    return value;
  }
  return null;
}

export function buildSearchDictionary(rows: SearchDictionaryRow[]): SearchDictionary {
  const byAlias = new Map<string, SearchAliasEntry>();
  const byCanonical = new Map<string, SearchKeywordEntry>();
  const phrases: SearchAliasEntry[] = [];

  for (const row of rows) {
    const canonical = normalizeText(row.canonical);
    const aliasNormalized = normalizeText(row.alias_normalized || row.alias);
    if (!canonical || !aliasNormalized) continue;

    const displayLabel = (row.display_label || "").trim() || titleCaseCanonical(canonical);
    if (!byCanonical.has(canonical)) {
      byCanonical.set(canonical, {
        canonical,
        displayLabel,
        kind: asKeywordKind(row.keyword_kind),
      });
    }

    const entry: SearchAliasEntry = {
      aliasNormalized,
      canonical,
      displayLabel: byCanonical.get(canonical)!.displayLabel,
      kind: asAliasKind(row.alias_kind),
      tokenCount: tokenizeNormalized(aliasNormalized).length,
    };

    if (!byAlias.has(aliasNormalized)) {
      byAlias.set(aliasNormalized, entry);
      if (entry.tokenCount >= 2) phrases.push(entry);
    }
  }

  for (const kw of byCanonical.values()) {
    if (!byAlias.has(kw.canonical)) {
      const identity: SearchAliasEntry = {
        aliasNormalized: kw.canonical,
        canonical: kw.canonical,
        displayLabel: kw.displayLabel,
        kind: null,
        tokenCount: tokenizeNormalized(kw.canonical).length,
      };
      byAlias.set(kw.canonical, identity);
    }
  }

  phrases.sort((a, b) => b.tokenCount - a.tokenCount || b.aliasNormalized.length - a.aliasNormalized.length);

  return { phrases, byAlias, byCanonical };
}

export function titleCaseCanonical(canonical: string): string {
  return canonical
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Aliases (y el canónico) que apuntan a una keyword. */
export function aliasesForCanonical(
  dict: SearchDictionary | null | undefined,
  canonical: string
): string[] {
  const out: string[] = [];
  if (!canonical) return out;
  out.push(canonical);
  if (!dict?.byAlias) return out;
  for (const [alias, entry] of dict.byAlias) {
    if (entry.canonical === canonical) out.push(alias);
  }
  return out;
}

export function getCanonicalLabel(
  dict: SearchDictionary,
  canonical: string,
  fallbackLabel?: string
): string {
  const hit = dict.byCanonical.get(canonical);
  if (hit?.displayLabel) return hit.displayLabel;
  if (fallbackLabel && normalizeText(fallbackLabel) === canonical) return fallbackLabel;
  return titleCaseCanonical(canonical);
}

export { EMPTY_SEARCH_DICTIONARY };
