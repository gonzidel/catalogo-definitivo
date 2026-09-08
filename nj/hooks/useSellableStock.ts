"use client";

import useSWR from "swr";
import {
  fetchSellableByVariantOrThrow,
  sellableSwrKey,
  type SellableByVariant,
} from "@/lib/stock/sellable-stock";

const SELLABLE_SWR_OPTIONS = {
  revalidateOnFocus: true,
  revalidateOnReconnect: true,
  dedupingInterval: 8_000,
} as const;

export function useSellableStock(variantIds: readonly string[]) {
  const key = sellableSwrKey(variantIds);
  const { data, error, isValidating, isLoading, mutate } = useSWR(
    key,
    (swrKey: string[]) => fetchSellableByVariantOrThrow(swrKey.slice(1)),
    SELLABLE_SWR_OPTIONS
  );

  return {
    byVariant: (data ?? null) as SellableByVariant | null,
    queryFailed: Boolean(error),
    isLoading,
    isValidating,
    revalidate: mutate,
  };
}
