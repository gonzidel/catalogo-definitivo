import { unstable_cache } from "next/cache";
import { pickDisplayColorDetail } from "@/lib/utils/catalog-variant-enrich";
import { getPublicCatalogClient } from "@/lib/supabase/public-catalog";
import {
  loadPdpProductBase,
  normalizePdpSkuKey,
  type PdpProductBase,
} from "@/lib/pdp/load-product-base";
import type { GroupedProduct } from "@/types/catalog";

export type PdpProductPayload = {
  product: GroupedProduct;
  initialColor?: string;
};

/**
 * Data Cache del producto público por SKU (sin color de URL).
 * Clave: ['pdp-product-base', skuNormalizado] + argumento.
 * Tags: catalog-products + catalog-product:{sku}
 */
export async function getCachedPdpProductBase(
  sku: string
): Promise<PdpProductBase | null> {
  const key = normalizePdpSkuKey(sku);
  if (!key) return null;

  const cached = unstable_cache(
    async () => {
      const supabase = getPublicCatalogClient();
      return loadPdpProductBase(supabase, key);
    },
    ["pdp-product-base", key],
    {
      revalidate: 60,
      tags: ["catalog-products", `catalog-product:${key}`],
    }
  );

  return cached();
}

function pickInitialColor(
  product: GroupedProduct,
  colorFromUrl?: string,
  skuResolvedColor?: string
): string | undefined {
  if (colorFromUrl) {
    const exists = product.DetalleColor.some(
      (d) => d.color.toLowerCase() === colorFromUrl.toLowerCase()
    );
    if (exists) return colorFromUrl;
  }
  if (skuResolvedColor) {
    const exists = product.DetalleColor.some(
      (d) => d.color.toLowerCase() === skuResolvedColor.toLowerCase()
    );
    if (exists) return skuResolvedColor;
  }
  return pickDisplayColorDetail(product)?.color;
}

/**
 * SSR PDP: base cacheada + elección de color (no cacheada).
 * Stock sellable no se toca aquí.
 */
export async function loadPdpProductForSku(
  sku: string,
  colorFromUrl?: string
): Promise<PdpProductPayload | null> {
  try {
    const base = await getCachedPdpProductBase(sku);
    if (!base) return null;

    return {
      product: base.product,
      initialColor: pickInitialColor(
        base.product,
        colorFromUrl,
        base.skuResolvedColor
      ),
    };
  } catch (err) {
    console.warn("[pdp-ssr] loadPdpProductForSku failed:", err);
    return null;
  }
}
