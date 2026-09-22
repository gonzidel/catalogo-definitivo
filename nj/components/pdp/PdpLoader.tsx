"use client";

import useSWR from "swr";
import { useMemo } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { pickDisplayColorDetail } from "@/lib/utils/catalog-variant-enrich";
import {
  applySellableHasStockToProduct,
  applySellableToPdpVariants,
  type PdpVariantInfo,
} from "@/lib/stock/sellable-stock";
import { useSellableStock } from "@/hooks/useSellableStock";
import { loadPdpProductBase } from "@/lib/pdp/load-product-base";
import type { GroupedProduct } from "@/types/catalog";
import PdpInteractive from "./PdpInteractive";
import PdpLoading from "@/app/producto/[sku]/loading";

interface PdpLoaderProps {
  sku: string;
  backUrl: string;
  initialColorFromUrl?: string;
  /** Producto ya resuelto en SSR (sin stock sellable). */
  initialProduct?: GroupedProduct | null;
  /** Color inicial resuelto en SSR (respeta ?color=). */
  initialColor?: string;
}

type PdpFetchResult = {
  product: GroupedProduct;
  initialColor?: string;
};

async function fetchProductForSku(sku: string): Promise<PdpFetchResult | null> {
  const supabase = getSupabaseBrowserClient();
  const base = await loadPdpProductBase(supabase, sku);
  if (!base) return null;

  let initialColor = base.skuResolvedColor;
  if (initialColor) {
    const exists = base.product.DetalleColor.some(
      (d) => d.color.toLowerCase() === initialColor!.toLowerCase()
    );
    if (!exists) initialColor = undefined;
  }
  if (!initialColor) {
    initialColor = pickDisplayColorDetail(base.product)?.color;
  }

  return { product: base.product, initialColor };
}

type PdpVariantCatalogRow = {
  variantId: string;
  color: string;
  sku: string;
  sizes: Array<{ size: string; sku: string }>;
};

async function fetchPdpVariantCatalog(
  articulo: string
): Promise<PdpVariantCatalogRow[]> {
  const supabase = getSupabaseBrowserClient();

  const { data: variants } = await supabase
    .from("product_variants")
    .select("id, color, sku, products!inner(name)")
    .eq("active", true)
    .eq("products.name", articulo.trim())
    .limit(30);

  if (!variants || variants.length === 0) return [];

  const variantIds = variants.map((v: { id: string }) => v.id);
  const { data: sizeRows } = await supabase
    .from("variant_sizes")
    .select("variant_id, size, sku")
    .in("variant_id", variantIds)
    .order("size");

  const sizeSkuByVariant = new Map<string, Array<{ size: string; sku: string }>>();
  for (const row of sizeRows ?? []) {
    const variantId = String(row.variant_id ?? "");
    if (!variantId) continue;
    const entry = sizeSkuByVariant.get(variantId) ?? [];
    entry.push({
      size: String(row.size ?? ""),
      sku: row.sku ?? "",
    });
    sizeSkuByVariant.set(variantId, entry);
  }

  return variants.map((v: { id: string; color?: string; sku?: string }) => ({
    variantId: v.id,
    color: v.color ?? "",
    sku: v.sku ?? "",
    sizes: sizeSkuByVariant.get(v.id) ?? [],
  }));
}

function PdpNotFound({ backUrl }: { backUrl: string }) {
  return (
    <div className="pdp-not-found">
      <h2 className="pdp-not-found__title">Producto no encontrado</h2>
      <p className="pdp-not-found__text">
        Este producto no está disponible o fue retirado del catálogo.
      </p>
      <Link href={backUrl} className="btn btn-primary">
        Volver al catálogo
      </Link>
    </div>
  );
}

export default function PdpLoader({
  sku,
  backUrl,
  initialColorFromUrl,
  initialProduct = null,
  initialColor,
}: PdpLoaderProps) {
  const ssrFallback: PdpFetchResult | undefined = initialProduct
    ? { product: initialProduct, initialColor }
    : undefined;

  const { data, isLoading, error, isValidating } = useSWR(
    `pdp:${sku}`,
    () => fetchProductForSku(sku),
    {
      fallbackData: ssrFallback,
      // Con SSR: no refetch inmediato del mismo producto (evita doble consulta + flash).
      // Sin SSR: fetch cliente como antes.
      revalidateOnMount: !ssrFallback,
      revalidateOnFocus: false,
      revalidateOnReconnect: !ssrFallback,
      dedupingInterval: 300_000,
    }
  );

  const resolvedInitialColor = useMemo(() => {
    if (initialColorFromUrl && data?.product) {
      const exists = data.product.DetalleColor.some(
        (d) => d.color.toLowerCase() === initialColorFromUrl.toLowerCase()
      );
      if (exists) return initialColorFromUrl;
    }
    return data?.initialColor ?? initialColor;
  }, [data, initialColorFromUrl, initialColor]);

  const { data: variantCatalog } = useSWR(
    data?.product ? `pdp-variant-catalog:${data.product.Articulo}` : null,
    () => fetchPdpVariantCatalog(data!.product.Articulo),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );
  const variantCatalogRows = variantCatalog ?? [];

  const sellableVariantIds = useMemo(
    () => variantCatalogRows.map((v) => v.variantId),
    [variantCatalogRows]
  );
  const {
    byVariant,
    queryFailed: sellableError,
    isLoading: sellableLoading,
  } = useSellableStock(sellableVariantIds);

  const variantSizes: PdpVariantInfo[] = useMemo(() => {
    if (!byVariant) return [];
    return applySellableToPdpVariants(variantCatalogRows, byVariant);
  }, [variantCatalogRows, byVariant]);

  const productWithSellable = useMemo(() => {
    if (!data?.product) return undefined;
    if (!byVariant) {
      return {
        ...data.product,
        DetalleColor: data.product.DetalleColor.map((dc) => ({
          ...dc,
          hasStock: undefined,
        })),
      };
    }
    return applySellableHasStockToProduct(data.product, variantSizes);
  }, [data?.product, byVariant, variantSizes]);

  // Skeleton solo si no hay SSR y aún no hay datos.
  if (!data && isLoading) return <PdpLoading />;
  if (error && !data) return <PdpNotFound backUrl={backUrl} />;
  if (!data || !productWithSellable) {
    // SSR ausente + fetch fallido, o producto sin colores.
    if (!isLoading && !isValidating) return <PdpNotFound backUrl={backUrl} />;
    return <PdpLoading />;
  }

  return (
    <PdpInteractive
      product={productWithSellable}
      variantSizes={variantSizes}
      sellableStatus={
        sellableError ? "error" : sellableLoading || !byVariant ? "loading" : "ready"
      }
      initialColor={resolvedInitialColor}
      backUrl={backUrl}
    />
  );
}
