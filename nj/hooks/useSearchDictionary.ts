"use client";

import { useEffect } from "react";
import useSWR, { mutate } from "swr";
import {
  SEARCH_DICTIONARY_SWR_KEY,
  SEARCH_DICT_CHANGED_EVENT,
  SEARCH_DICT_REV_KEY,
  bustSearchDictionaryCache,
  fetchSearchDictionary,
  getCachedSearchDictionary,
} from "@/lib/search/dictionary-store";
import type { SearchDictionary } from "@/lib/search/types";

export function useSearchDictionary(): SearchDictionary {
  const { data } = useSWR(SEARCH_DICTIONARY_SWR_KEY, fetchSearchDictionary, {
    fallbackData: getCachedSearchDictionary(),
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });

  useEffect(() => {
    const reload = () => {
      bustSearchDictionaryCache();
      void mutate(SEARCH_DICTIONARY_SWR_KEY);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === SEARCH_DICT_REV_KEY) reload();
    };
    window.addEventListener(SEARCH_DICT_CHANGED_EVENT, reload);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(SEARCH_DICT_CHANGED_EVENT, reload);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return data ?? getCachedSearchDictionary();
}
