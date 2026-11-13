"use client";

import useSWR from "swr";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { SearchProfilePublic } from "@/lib/search/search-profiles-types";

export const SEARCH_PROFILES_SWR_KEY = "fyl-search-profiles-public";

async function fetchSearchProfiles(): Promise<Map<string, SearchProfilePublic>> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("product_search_profiles_public")
    .select(
      "articulo, search_terms, style_terms, occasion_terms, color_families, audience, season"
    );
  const map = new Map<string, SearchProfilePublic>();
  if (error || !data) return map;
  for (const row of data as SearchProfilePublic[]) {
    if (row.articulo) map.set(row.articulo, row);
  }
  return map;
}

export function useSearchProfiles(): Map<string, SearchProfilePublic> {
  const { data } = useSWR(SEARCH_PROFILES_SWR_KEY, fetchSearchProfiles, {
    fallbackData: new Map(),
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
  return data ?? new Map();
}
