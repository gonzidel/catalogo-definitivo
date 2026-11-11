"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { enrichGroupedProductsWithVariants } from "@/lib/utils/catalog-variant-enrich";
import type { GroupedProduct } from "@/types/catalog";

function articulosKey(products: GroupedProduct[]): string {
  return products.map((p) => p.Articulo).join("|");
}

/**
 * Enriquece variantes/colores + stock.
 * Ya no amplía a productos sin stock: la vista pública los excluye
 * (doc/catalogo/catalogo-visibilidad.md) y la RPC anónima fallaba por grants.
 */
export function useEnrichedCatalog(
  products: GroupedProduct[],
  _searchTerm: string
) {
  const baseKey = useMemo(() => articulosKey(products), [products]);
  const productsRef = useRef(products);
  productsRef.current = products;

  const [enriched, setEnriched] = useState<GroupedProduct[]>(products);
  const [isEnriching, setIsEnriching] = useState(false);

  useEffect(() => {
    const snapshot = productsRef.current;

    if (snapshot.length === 0) {
      setEnriched(snapshot);
      return;
    }

    setIsEnriching(true);
    let cancelled = false;
    enrichGroupedProductsWithVariants(getSupabaseBrowserClient(), snapshot)
      .then((next) => {
        if (!cancelled) {
          setEnriched(next);
          setIsEnriching(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsEnriching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [baseKey]);

  return {
    products: enriched,
    isEnriching,
    /** Siempre false: ya no hay fetch de extras OOS. */
    isSearchExtrasPending: false,
  };
}
