"use client";

import useSWRInfinite from "swr/infinite";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  CATALOG_SOURCE,
  CATALOG_SELECT,
  agruparProductos,
  intercalarProductos,
  compareCatalogRecency,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct, ColorDetail } from "@/types/catalog";

// Rows fetched per SWR page (raw rows, not grouped products).
// The snapshot has ~1680 rows, ~2 rows/product on average.
// 1000 rows = ~500 products, loading most of the catalog in a single batch.
// This minimises the chance of an Articulo being split across page boundaries.
const ROWS_PER_FETCH = 1000;

interface CatalogPage {
  products: GroupedProduct[];
  hasMore: boolean;
}

interface FetchKey {
  _type: "catalog";
  categoria: string;
  tags: string[];
  page: number;
}

async function fetchPageFromSupabase(key: FetchKey): Promise<CatalogPage> {
  const { categoria, tags, page } = key;
  const supabase = getSupabaseBrowserClient();
  const offset = (page - 1) * ROWS_PER_FETCH;

  let query = supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .order("FechaPublicacion", { ascending: false, nullsFirst: false });

  if (categoria !== "all" && categoria !== "Novedades" && categoria !== "Ofertas") {
    if (categoria === "Lenceria") {
      query = query.eq("Categoria", "Otros").ilike("Filtro1", "lenceria");
    } else if (categoria === "Marroquineria") {
      query = query.eq("Categoria", "Otros").ilike("Filtro1", "marroquineria");
    } else {
      query = query.eq("Categoria", categoria);
    }
  }

  if (categoria === "Ofertas") {
    query = (query as any).eq("OfertaActiva", true);
  }

  if (tags.length > 0) {
    const tagFilters = tags
      .map((t) => `Filtro1.ilike.%${t}%,Filtro2.ilike.%${t}%,Filtro3.ilike.%${t}%`)
      .join(",");
    query = query.or(tagFilters);
  }

  query = query.range(offset, offset + ROWS_PER_FETCH - 1);

  const { data, error } = await query;
  if (error || !data) {
    console.warn("[useCatalog] Supabase error:", error?.message);
    return { products: [], hasMore: false };
  }

  const grouped = agruparProductos(data as unknown as CatalogRow[]);
  // hasMore is true if we received a full batch — there may be more rows in the DB
  const hasMore = data.length === ROWS_PER_FETCH;
  return { products: grouped, hasMore };
}

/**
 * Re-groups a flat list of GroupedProducts by Articulo, merging DetalleColor
 * entries from products that were split across SWR page boundaries.
 */
function mergeGroupedProducts(products: GroupedProduct[]): GroupedProduct[] {
  const byArticulo = new Map<string, GroupedProduct>();
  for (const p of products) {
    const existing = byArticulo.get(p.Articulo);
    if (!existing) {
      byArticulo.set(p.Articulo, { ...p, DetalleColor: [...p.DetalleColor] });
    } else {
      for (const dc of p.DetalleColor) {
        const key = dc.color.toLowerCase().trim();
        if (!existing.DetalleColor.some((d: ColorDetail) => d.color.toLowerCase().trim() === key)) {
          existing.DetalleColor.push(dc);
        }
      }
    }
  }
  return Array.from(byArticulo.values());
}

export function useCatalog({
  categoria = "all",
  tags = [] as string[],
  basePath: _basePath = "/catalogo", // kept for API compat, unused
  enabled = true,
}: {
  categoria?: string;
  tags?: string[];
  basePath?: string;
  /** When false, skip Supabase fetch (banner pages with a fixed product set). */
  enabled?: boolean;
}) {
  const getKey = (
    pageIndex: number,
    previousData: CatalogPage | null
  ): FetchKey | null => {
    if (!enabled) return null;
    if (previousData && !previousData.hasMore) return null;
    return { _type: "catalog", categoria, tags, page: pageIndex + 1 };
  };

  const { data, error, isLoading, size, setSize } = useSWRInfinite<CatalogPage>(
    getKey,
    fetchPageFromSupabase,
    {
      revalidateFirstPage: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      persistSize: true,
      dedupingInterval: 60_000,
    }
  );

  const pages = data ?? [];
  const hasMore = pages.length > 0 ? pages[pages.length - 1].hasMore : true;

  // Merge all pages: products at batch boundaries can be split across pages.
  // Re-group by Articulo to merge DetalleColor from different batches.
  const merged = mergeGroupedProducts(pages.flatMap((p) => p.products));

  const allProducts: GroupedProduct[] =
    categoria === "all" && tags.length === 0
      ? intercalarProductos(merged)
      : [...merged].sort(compareCatalogRecency);

  return {
    allProducts,
    hasMore,
    isLoading,
    isLoadingMore: isLoading || (size > 0 && data != null && data[size - 1] == null),
    error,
    loadMore: () => {
      if (!isLoading && hasMore) setSize((s) => s + 1);
    },
    pagesLoaded: size,
  };
}
