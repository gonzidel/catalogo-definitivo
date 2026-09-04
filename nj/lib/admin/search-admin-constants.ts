import type { SearchAliasKind, SearchKeywordKind } from "@/lib/search/types";

export const SEARCH_ADMIN_PERMISSION_KEY = "search";

export const SEARCH_TERM_MAX_LEN = 80;

export const SEARCH_KEYWORD_KINDS: SearchKeywordKind[] = [
  "product_type",
  "color",
  "attribute",
  "commercial",
];

export const SEARCH_ALIAS_KINDS: SearchAliasKind[] = [
  "plural",
  "grammatical",
  "abbreviation",
  "commercial",
  "typo",
  "spacing",
  "legacy_tag",
];

export const KEYWORD_KIND_LABELS: Record<SearchKeywordKind, string> = {
  product_type: "Tipo de producto",
  color: "Color",
  attribute: "Atributo",
  commercial: "Comercial",
};

export const ALIAS_KIND_LABELS: Record<SearchAliasKind, string> = {
  plural: "Plural",
  grammatical: "Gramatical",
  abbreviation: "Abreviatura",
  commercial: "Comercial",
  typo: "Typo",
  spacing: "Espaciado",
  legacy_tag: "Tag legado",
};

export type SearchAdminDays = 7 | 30 | 90;

export const SEARCH_ADMIN_DAY_OPTIONS: SearchAdminDays[] = [7, 30, 90];

export function isSearchKeywordKind(value: string): value is SearchKeywordKind {
  return (SEARCH_KEYWORD_KINDS as string[]).includes(value);
}

export function isSearchAliasKind(value: string): value is SearchAliasKind {
  return (SEARCH_ALIAS_KINDS as string[]).includes(value);
}

export function parseSearchAdminDays(value: string | undefined): SearchAdminDays {
  if (value === "7" || value === "90") return Number(value) as SearchAdminDays;
  return 30;
}
