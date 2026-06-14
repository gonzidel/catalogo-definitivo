"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  enrichGroupedProductsWithVariants,
  searchProductsIncludingOutOfStock,
} from "@/lib/utils/catalog-variant-enrich";
import type { GroupedProduct } from "@/types/catalog";

function articulosKey(products: GroupedProduct[]): string {
  return products.map((p) => p.Articulo).join("|");
}

/** Enriquece variantes/colores + stock; amplía búsqueda a productos sin stock. */
export function useEnrichedCatalog(
  products: GroupedProduct[],
  searchTerm: string
) {
  const baseKey = useMemo(() => articulosKey(products), [products]);
  const productsRef = useRef(products);
  productsRef.current = products;

  const [enriched, setEnriched] = useState<GroupedProduct[]>(products);
  const [extraSearch, setExtraSearch] = useState<GroupedProduct[]>([]);

  // Reset + enriquecer cuando cambia el set de artículos (solo baseKey, no la ref del array).
  useEffect(() => {
    const snapshot = productsRef.current;
    setEnriched(snapshot);
    setExtraSearch([]);

    if (snapshot.length === 0) return;

    let cancelled = false;
    enrichGroupedProductsWithVariants(getSupabaseBrowserClient(), snapshot)
      .then((next) => {
        if (!cancelled) setEnriched(next);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [baseKey]);

  // Búsqueda ampliada (productos sin stock): solo term + baseKey, no re-disparar al enriquecer.
  useEffect(() => {
    const term = searchTerm.trim();
    if (term.length < 2) {
      setExtraSearch([]);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const exclude = new Set(productsRef.current.map((p) => p.Articulo));
      searchProductsIncludingOutOfStock(
        getSupabaseBrowserClient(),
        term,
        exclude
      )
        .then((found) => {
          if (!cancelled) setExtraSearch(found);
        })
        .catch(() => {
          if (!cancelled) setExtraSearch([]);
        });
    }, 280);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchTerm, baseKey]);

  const merged = useMemo(() => {
    if (extraSearch.length === 0) return enriched;
    const seen = new Set(enriched.map((p) => p.Articulo));
    const add = extraSearch.filter((p) => !seen.has(p.Articulo));
    return add.length ? [...enriched, ...add] : enriched;
  }, [enriched, extraSearch]);

  return { products: merged };
}
