import { mutate } from "swr";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  buildSearchDictionary,
  EMPTY_SEARCH_DICTIONARY,
} from "@/lib/search/dictionary";
import { buildSeedSearchDictionary } from "@/lib/search/seed-data";
import type { SearchDictionary, SearchDictionaryRow } from "@/lib/search/types";

let cached: SearchDictionary = EMPTY_SEARCH_DICTIONARY;
let inflight: Promise<SearchDictionary> | null = null;

export const SEARCH_DICTIONARY_SWR_KEY = "fyl-search-dictionary";
export const SEARCH_DICT_REV_KEY = "fyl_search_dict_rev";
export const SEARCH_DICT_CHANGED_EVENT = "fyl-search-dictionary-changed";

export function getCachedSearchDictionary(): SearchDictionary {
  return cached;
}

export function bustSearchDictionaryCache(): void {
  inflight = null;
}

/** Invalida el cache de módulo y avisa a otras pestañas / el hook SWR. */
export function publishSearchDictionaryChange(): void {
  bustSearchDictionaryCache();
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SEARCH_DICT_REV_KEY, String(Date.now()));
    window.dispatchEvent(new Event(SEARCH_DICT_CHANGED_EVENT));
  } catch {
    /* private mode / SSR */
  }
  void mutate(SEARCH_DICTIONARY_SWR_KEY, fetchSearchDictionary());
}

export async function fetchSearchDictionary(): Promise<SearchDictionary> {
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error } = await supabase
        .from("search_dictionary_public")
        .select("canonical, display_label, keyword_kind, alias, alias_normalized, alias_kind");

      if (error || !data) {
        cached = buildSeedSearchDictionary();
        return cached;
      }

      cached = buildSearchDictionary(data as SearchDictionaryRow[]);
      if (cached.byCanonical.size === 0) {
        cached = buildSeedSearchDictionary();
      }
      return cached;
    } catch {
      cached = buildSeedSearchDictionary();
      return cached;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
