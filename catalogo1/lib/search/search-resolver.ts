import { normalizeText, tokenizeNormalized } from "@/lib/search/normalize";
import { EMPTY_SEARCH_DICTIONARY } from "@/lib/search/dictionary";
import type {
  ResolvedSearchQuery,
  SearchDictionary,
  SearchResolution,
} from "@/lib/search/types";

export type { ResolvedSearchQuery, SearchResolution } from "@/lib/search/types";

/**
 * Interpreta la query del cliente ANTES de searchProducts().
 * 1) normaliza  2) aliases de frase (greedy, más largos primero)
 * 3) aliases por token  4) fallback = el mismo token
 */
export function resolveSearchQuery(
  rawQuery: string,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): ResolvedSearchQuery {
  const originalQuery = String(rawQuery ?? "");
  const normalizedQuery = normalizeText(originalQuery);
  const originalTokens = tokenizeNormalized(normalizedQuery);

  if (originalTokens.length === 0) {
    return {
      originalQuery,
      normalizedQuery,
      originalTokens,
      resolvedTokens: [],
      resolvedQuery: "",
      resolutions: [],
    };
  }

  const resolvedTokens: string[] = [];
  const resolutions: SearchResolution[] = [];
  let i = 0;

  while (i < originalTokens.length) {
    const phraseHit = matchPhraseAt(originalTokens, i, dict);
    if (phraseHit) {
      resolvedTokens.push(phraseHit.canonical);
      if (phraseHit.input !== phraseHit.canonical) {
        resolutions.push({
          input: phraseHit.input,
          canonical: phraseHit.canonical,
          reason: phraseHit.kind ?? "spacing",
        });
      }
      i += phraseHit.tokenCount;
      continue;
    }

    const token = originalTokens[i];
    const alias = dict.byAlias.get(token);
    if (alias && alias.canonical !== token) {
      resolvedTokens.push(alias.canonical);
      resolutions.push({
        input: token,
        canonical: alias.canonical,
        reason: alias.kind ?? "alias",
      });
    } else {
      resolvedTokens.push(alias?.canonical ?? token);
    }
    i += 1;
  }

  return {
    originalQuery,
    normalizedQuery,
    originalTokens,
    resolvedTokens,
    resolvedQuery: resolvedTokens.join(" "),
    resolutions,
  };
}

function matchPhraseAt(
  tokens: string[],
  index: number,
  dict: SearchDictionary
): { input: string; canonical: string; tokenCount: number; kind: SearchResolution["reason"] | null } | null {
  for (const phrase of dict.phrases) {
    if (phrase.tokenCount < 2 || index + phrase.tokenCount > tokens.length) continue;
    const slice = tokens.slice(index, index + phrase.tokenCount).join(" ");
    if (slice === phrase.aliasNormalized) {
      return {
        input: slice,
        canonical: phrase.canonical,
        tokenCount: phrase.tokenCount,
        kind: phrase.kind,
      };
    }
  }
  return null;
}

/** Tokens listos para searchProducts (AND, mínimo 2 caracteres). */
export function resolvedSearchTokens(
  rawQuery: string,
  dict?: SearchDictionary
): string[] {
  return resolveSearchQuery(rawQuery, dict).resolvedTokens.filter((t) => t.length >= 2);
}
