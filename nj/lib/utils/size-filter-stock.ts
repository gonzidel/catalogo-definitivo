import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSize } from "@/lib/utils/size-normalizer";
import { expandCombinedSizes } from "@/lib/utils/size-filter-catalog";
import {
  buildInitialSizeAvailability,
  catalogSizesNeedingStockQuery,
  isPhysicalAlwaysAvailable,
  normSizeKey,
} from "@/lib/utils/size-filter-physical";

export interface SizeAvailability {
  exists: boolean;
  hasStock: boolean;
}

export { isPhysicalAlwaysAvailable, buildInitialSizeAvailability };

/**
 * Stock por talle (solo consulta los que no son físicos fijos).
 * Parte de mapa optimista; refina en background.
 */
export async function fetchSizeAvailabilityForArticulos(
  supabase: SupabaseClient,
  articulos: string[],
  catalogSizes: string[],
  categoria: string
): Promise<Map<string, SizeAvailability>> {
  const result = buildInitialSizeAvailability(catalogSizes, categoria);
  const toQuery = catalogSizesNeedingStockQuery(catalogSizes, categoria);

  for (const s of toQuery) {
    result.set(normSizeKey(s), { exists: true, hasStock: false });
  }

  if (toQuery.length === 0 || articulos.length === 0) {
    return result;
  }

  const queryKeys = new Set(toQuery.map((s) => normSizeKey(s)));

  const chunkSize = 80;
  for (let i = 0; i < articulos.length; i += chunkSize) {
    const chunk = articulos.slice(i, i + chunkSize);
    const { data: products, error: pErr } = await supabase
      .from("products")
      .select("id")
      .in("name", chunk)
      .eq("status", "active");

    if (pErr || !products?.length) continue;

    const productIds = products.map((p) => p.id);
    const { data: variants, error: vErr } = await supabase
      .from("product_variants")
      .select("id")
      .in("product_id", productIds)
      .eq("active", true);

    if (vErr || !variants?.length) continue;

    const variantIds = variants.map((v) => v.id);
    const { data: sizes, error: sErr } = await supabase
      .from("variant_sizes")
      .select("size, stock_qty")
      .in("variant_id", variantIds);

    if (sErr || !sizes?.length) continue;

    for (const row of sizes) {
      const raw = String(row.size ?? "").trim();
      if (!raw) continue;
      const stock = Number(row.stock_qty ?? 0);
      for (const part of expandCombinedSizes([raw])) {
        const key = normSizeKey(part);
        if (!queryKeys.has(key)) continue;
        const prev = result.get(key) ?? { exists: true, hasStock: false };
        result.set(key, {
          exists: true,
          hasStock: prev.hasStock || stock > 0,
        });
      }
    }
  }

  return result;
}

export function sizeHasStock(
  size: string,
  availability: Map<string, SizeAvailability>,
  categoria?: string
): boolean {
  if (categoria && isPhysicalAlwaysAvailable(size, categoria)) {
    return true;
  }

  const key = normSizeKey(size);
  const direct = availability.get(key);
  if (direct) return direct.hasStock;

  if (size.includes("/")) {
    return expandCombinedSizes([size]).some((p) => {
      if (categoria && isPhysicalAlwaysAvailable(p, categoria)) return true;
      return availability.get(normSizeKey(p))?.hasStock ?? false;
    });
  }
  return false;
}
