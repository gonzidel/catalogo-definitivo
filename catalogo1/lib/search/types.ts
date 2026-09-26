export type SearchKeywordKind =
  | "product_type"
  | "color"
  | "attribute"
  | "commercial";

export type SearchAliasKind =
  | "plural"
  | "grammatical"
  | "abbreviation"
  | "commercial"
  | "typo"
  | "spacing"
  | "legacy_tag";

export type ResolutionReason = SearchAliasKind | "alias" | "identity" | "fallback";

export interface SearchResolution {
  input: string;
  canonical: string;
  reason: ResolutionReason;
}

export interface ResolvedSearchQuery {
  originalQuery: string;
  normalizedQuery: string;
  originalTokens: string[];
  resolvedTokens: string[];
  resolvedQuery: string;
  resolutions: SearchResolution[];
}

export interface SearchKeywordEntry {
  canonical: string;
  displayLabel: string;
  kind: SearchKeywordKind | null;
}

export interface SearchAliasEntry {
  aliasNormalized: string;
  canonical: string;
  displayLabel: string;
  kind: SearchAliasKind | null;
  tokenCount: number;
}

export interface SearchDictionary {
  /** Aliases de ≥2 tokens, longest-first al resolver. */
  phrases: SearchAliasEntry[];
  /** alias_normalized → entrada (incluye canónicos). */
  byAlias: Map<string, SearchAliasEntry>;
  byCanonical: Map<string, SearchKeywordEntry>;
}

export interface SearchDictionaryRow {
  canonical: string;
  display_label: string;
  keyword_kind: string | null;
  alias: string;
  alias_normalized: string;
  alias_kind: string | null;
}

export const EMPTY_SEARCH_DICTIONARY: SearchDictionary = {
  phrases: [],
  byAlias: new Map(),
  byCanonical: new Map(),
};
