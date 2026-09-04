import { normalizeText } from "@/lib/search/normalize";
import {
  SEARCH_TERM_MAX_LEN,
  isSearchAliasKind,
  isSearchKeywordKind,
} from "@/lib/admin/search-admin-constants";
import type { SearchAliasKind, SearchKeywordKind } from "@/lib/search/types";

export type SearchVocabKeyword = {
  id: string;
  canonical: string;
  displayLabel: string;
};

export type SearchVocabAlias = {
  id: string;
  aliasNormalized: string;
  keywordId: string;
  canonical: string;
};

export type SearchVocabLookup = {
  keywords: SearchVocabKeyword[];
  aliases: SearchVocabAlias[];
};

export type SearchAdminValidationError = {
  ok: false;
  code:
    | "empty"
    | "too_long"
    | "invalid_kind"
    | "alias_exists"
    | "canonical_collision"
    | "keyword_exists"
    | "keyword_is_alias"
    | "missing_destination"
    | "identity_alias";
  message: string;
  normalized?: string;
};

export type SearchAdminValidationOk<T> = { ok: true } & T;

export type AliasValidationResult =
  | SearchAdminValidationOk<{
      normalized: string;
      dest: SearchVocabKeyword;
      kind: SearchAliasKind;
    }>
  | SearchAdminValidationError;

export type KeywordValidationResult =
  | SearchAdminValidationOk<{
      canonical: string;
      displayLabel: string;
      kind: SearchKeywordKind | null;
    }>
  | SearchAdminValidationError;

export function validateNormalizedTerm(raw: string): SearchAdminValidationError | { ok: true; normalized: string } {
  const normalized = normalizeText(raw);
  if (!normalized) {
    return { ok: false, code: "empty", message: "El término quedó vacío después de normalizar." };
  }
  if (normalized.length > SEARCH_TERM_MAX_LEN) {
    return {
      ok: false,
      code: "too_long",
      message: `El término normalizado es demasiado largo (${normalized.length} caracteres, máximo ${SEARCH_TERM_MAX_LEN}).`,
      normalized,
    };
  }
  return { ok: true, normalized };
}

export function validateAliasDraft(
  rawAlias: string,
  destCanonical: string,
  kind: string,
  lookup: SearchVocabLookup,
  excludeAliasId?: string
): AliasValidationResult {
  const term = validateNormalizedTerm(rawAlias);
  if (!term.ok) return term;

  if (!isSearchAliasKind(kind)) {
    return { ok: false, code: "invalid_kind", message: "Elegí un tipo de alias válido." };
  }

  const destNorm = normalizeText(destCanonical);
  const dest = lookup.keywords.find((k) => k.canonical === destNorm);
  if (!dest) {
    return {
      ok: false,
      code: "missing_destination",
      message: "Elegí una keyword destino existente. El sistema no asigna aliases solo.",
    };
  }

  if (term.normalized === dest.canonical) {
    return {
      ok: false,
      code: "identity_alias",
      message: `“${term.normalized}” ya es el canónico de ${dest.displayLabel}. No hace falta un alias identidad.`,
      normalized: term.normalized,
    };
  }

  const otherCanonical = lookup.keywords.find(
    (k) => k.canonical === term.normalized && k.id !== dest.id
  );
  if (otherCanonical) {
    return {
      ok: false,
      code: "canonical_collision",
      message: `“${term.normalized}” ya es la keyword canónica de ${otherCanonical.displayLabel}.`,
      normalized: term.normalized,
    };
  }

  const existing = lookup.aliases.find(
    (a) => a.aliasNormalized === term.normalized && a.id !== excludeAliasId
  );
  if (existing) {
    const owner = lookup.keywords.find((k) => k.id === existing.keywordId);
    const ownerLabel = owner?.displayLabel ?? existing.canonical;
    return {
      ok: false,
      code: "alias_exists",
      message: `“${term.normalized}” ya existe como alias de ${ownerLabel}.`,
      normalized: term.normalized,
    };
  }

  return { ok: true, normalized: term.normalized, dest, kind };
}

export function validateKeywordDraft(
  rawCanonical: string,
  rawDisplayLabel: string,
  kind: string | null,
  lookup: SearchVocabLookup,
  excludeKeywordId?: string
): KeywordValidationResult {
  const term = validateNormalizedTerm(rawCanonical);
  if (!term.ok) return term;

  let parsedKind: SearchKeywordKind | null = null;
  if (kind) {
    if (!isSearchKeywordKind(kind)) {
      return { ok: false, code: "invalid_kind", message: "Elegí un tipo de keyword válido." };
    }
    parsedKind = kind;
  }

  const existingKw = lookup.keywords.find(
    (k) => k.canonical === term.normalized && k.id !== excludeKeywordId
  );
  if (existingKw) {
    return {
      ok: false,
      code: "keyword_exists",
      message: `Ya existe la keyword “${existingKw.displayLabel}” (${existingKw.canonical}).`,
      normalized: term.normalized,
    };
  }

  const existingAlias = lookup.aliases.find(
    (a) => a.aliasNormalized === term.normalized && a.keywordId !== excludeKeywordId
  );
  if (existingAlias) {
    const owner = lookup.keywords.find((k) => k.id === existingAlias.keywordId);
    return {
      ok: false,
      code: "keyword_is_alias",
      message: `“${term.normalized}” ya es alias de ${owner?.displayLabel ?? existingAlias.canonical}.`,
      normalized: term.normalized,
    };
  }

  const displayLabel = rawDisplayLabel.trim() || titleCase(term.normalized);
  return { ok: true, canonical: term.normalized, displayLabel, kind: parsedKind };
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
