/**
 * Analytics del buscador. Capa única para UI.
 * GA4 = comportamiento. Supabase search_events = inteligencia operativa.
 * Nunca bloquea navegación. Si falla, la búsqueda sigue.
 */
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { clipGaParam, gaEvent } from "@/lib/analytics/ga";
import { resolveSearchQuery } from "@/lib/search/search-resolver";
import {
  consumeUiSearchCommit,
  markUiSearchCommit,
} from "@/lib/search/search-analytics-pending";
import {
  EMPTY_SEARCH_DICTIONARY,
  type ResolvedSearchQuery,
  type SearchDictionary,
  type SearchResolution,
} from "@/lib/search/types";
import type { SearchSuggestion } from "@/lib/utils/search";

export const SEARCH_EVENT_TYPES = [
  "search_committed",
  "suggestion_selected",
  "result_click",
] as const;

export type SearchEventType = (typeof SEARCH_EVENT_TYPES)[number];

export interface CompactResolution {
  input: string;
  canonical: string;
  reason: string;
}

export interface SearchEventRow {
  event_type: SearchEventType;
  query_original: string;
  query_normalized: string | null;
  query_resolved: string | null;
  result_count: number | null;
  resolutions: CompactResolution[];
  suggestion_type: string | null;
  suggestion_label: string | null;
  product_article: string | null;
  result_position: number | null;
}

const QUERY_MAX = 200;
const LABEL_MAX = 120;
const ARTICLE_MAX = 80;
const RESOLUTIONS_MAX = 12;

function clip(value: string, max: number): string {
  const t = String(value ?? "").trim();
  return t.length <= max ? t : t.slice(0, max);
}

function isDev(): boolean {
  return process.env.NODE_ENV !== "production";
}

function warnDev(message: string, detail?: unknown): void {
  if (!isDev()) return;
  if (detail !== undefined) console.warn("[search-analytics]", message, detail);
  else console.warn("[search-analytics]", message);
}

export function compactResolutions(resolutions: SearchResolution[]): CompactResolution[] {
  return resolutions.slice(0, RESOLUTIONS_MAX).map((r) => ({
    input: clip(r.input, 80),
    canonical: clip(r.canonical, 80),
    reason: clip(r.reason, 40),
  }));
}

export function rowFromResolved(
  eventType: SearchEventType,
  resolved: ResolvedSearchQuery,
  extra: Partial<SearchEventRow> = {}
): SearchEventRow {
  return {
    event_type: eventType,
    query_original: clip(resolved.originalQuery, QUERY_MAX),
    query_normalized: clip(resolved.normalizedQuery, QUERY_MAX) || null,
    query_resolved: clip(resolved.resolvedQuery, QUERY_MAX) || null,
    result_count: extra.result_count ?? null,
    resolutions: extra.resolutions ?? compactResolutions(resolved.resolutions),
    suggestion_type: extra.suggestion_type ?? null,
    suggestion_label: extra.suggestion_label ?? null,
    product_article: extra.product_article ?? null,
    result_position: extra.result_position ?? null,
  };
}

export function isValidSearchEventRow(row: SearchEventRow): boolean {
  if (!SEARCH_EVENT_TYPES.includes(row.event_type)) return false;
  if (!row.query_original || row.query_original.length > QUERY_MAX) return false;
  if (row.result_count != null && row.result_count < 0) return false;
  if (row.result_position != null && row.result_position < 1) return false;

  if (row.event_type === "search_committed") {
    return row.result_count != null && row.result_count >= 0;
  }
  if (row.event_type === "suggestion_selected") {
    return Boolean(row.suggestion_label && row.suggestion_type);
  }
  if (row.event_type === "result_click") {
    return Boolean(row.product_article && row.result_position);
  }
  return false;
}

async function insertSearchEvent(row: SearchEventRow): Promise<void> {
  if (!isValidSearchEventRow(row)) {
    warnDev("fila inválida, no se envía", row);
    return;
  }
  try {
    const { error } = await getSupabaseBrowserClient()
      .from("search_events")
      .insert(row);
    if (error) warnDev("insert falló", error.message);
  } catch (err) {
    warnDev("insert exception", err);
  }
}

function enqueueInsert(row: SearchEventRow): void {
  void insertSearchEvent(row);
}

/** Enter / clic Buscar / suggestion textual. Marca pending + evento GA `search`. */
export function noteUiSearchCommit(
  rawQuery: string,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): void {
  const q = rawQuery.trim();
  if (q.length < 2) return;
  markUiSearchCommit(q);
  const resolved = resolveSearchQuery(q, dict);
  gaEvent("search", {
    search_term: clipGaParam(resolved.originalQuery),
    search_resolved: clipGaParam(resolved.resolvedQuery),
  });
}

/**
 * Llama CatalogShell cuando el conteo ya es estable.
 * Solo inserta en Supabase si hubo un commit de UI pendiente.
 */
export function flushPendingSearchCommitted(
  rawQuery: string,
  resultCount: number,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): void {
  const pending = consumeUiSearchCommit(rawQuery);
  if (!pending) return;
  const resolved = resolveSearchQuery(pending.q, dict);
  enqueueInsert(
    rowFromResolved("search_committed", resolved, {
      result_count: Math.max(0, Math.floor(resultCount)),
    })
  );
}

export function trackSuggestionSelected(
  typedQuery: string,
  suggestion: SearchSuggestion,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): void {
  const typed = typedQuery.trim();
  const resolved = resolveSearchQuery(typed || suggestion.query, dict);
  gaEvent("search_suggestion_select", {
    search_term: clipGaParam(typed || suggestion.query),
    suggestion_type: suggestion.type,
    suggestion_label: clipGaParam(suggestion.label),
  });
  enqueueInsert(
    rowFromResolved("suggestion_selected", resolved, {
      suggestion_type: suggestion.type,
      suggestion_label: clip(suggestion.label, LABEL_MAX),
    })
  );
}

export function trackAutocompleteProductSelected(
  typedQuery: string,
  article: string,
  position: number
): void {
  gaEvent("select_item", {
    item_list_id: "search_autocomplete",
    item_list_name: "Search autocomplete",
    items: [
      {
        item_id: clipGaParam(article, 80),
        item_name: clipGaParam(article, 80),
        index: position,
      },
    ],
  });
}

export function trackSearchResultClick(
  rawQuery: string,
  article: string,
  position: number,
  dict: SearchDictionary = EMPTY_SEARCH_DICTIONARY
): void {
  if (rawQuery.trim().length < 2 || !article || position < 1) return;
  const resolved = resolveSearchQuery(rawQuery, dict);
  gaEvent("select_item", {
    item_list_id: "search",
    item_list_name: "Search results",
    search_term: clipGaParam(resolved.originalQuery),
    items: [
      {
        item_id: clipGaParam(article, 80),
        item_name: clipGaParam(article, 80),
        index: position,
      },
    ],
  });
  enqueueInsert(
    rowFromResolved("result_click", resolved, {
      product_article: clip(article, ARTICLE_MAX),
      result_position: position,
    })
  );
}
