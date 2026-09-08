"use client";

import useSWR from "swr";
import { useMemo } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, CATALOG_SELECT, agruparProductos } from "@/lib/utils/catalog";
import { calculateRecommendedPrice } from "@/lib/products/pricing";
import {
  enrichGroupedProductsWithVariants,
  pickDisplayColorDetail,
  stripColorsWithoutImages,
} from "@/lib/utils/catalog-variant-enrich";
import {
  applySellableHasStockToProduct,
  applySellableToPdpVariants,
  type PdpVariantInfo,
} from "@/lib/stock/sellable-stock";
import { useSellableStock } from "@/hooks/useSellableStock";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";
import PdpInteractive from "./PdpInteractive";
import PdpLoading from "@/app/producto/[sku]/loading";

interface PdpLoaderProps {
  sku: string;
  backUrl: string;
  initialColorFromUrl?: string;
}

async function stubFromProductsTable(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  articulo: string
): Promise<GroupedProduct | null> {
  const { data: row } = await supabase
    .from("products")
    .select("name, description, category, cost, price_percentage, logistic_amount")
    .eq("name", articulo.trim())
    .eq("status", "active")
    .maybeSingle();

  if (!row) return null;

  const precio = calculateRecommendedPrice(
    Number(row.cost ?? 0),
    Number(row.price_percentage ?? 0),
    Number(row.logistic_amount ?? 0)
  );

  return {
    Articulo: String(row.name ?? articulo).trim(),
    Descripcion: String(row.description ?? ""),
    Precio: precio || "",
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "",
    Categoria: String(row.category ?? ""),
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    DetalleColor: [],
    hasAnyStock: false,
  };
}

async function loadGroupedByArticulo(
  supabase: ReturnType<typeof getSupabaseBrowserClient>,
  articulo: string
): Promise<GroupedProduct | null> {
  const { data: rows } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .eq("Articulo", articulo.trim())
    .limit(80);

  if (rows?.length) {
    const grouped = agruparProductos(rows as unknown as CatalogRow[]);
    if (grouped[0]) return grouped[0];
  }

  return stubFromProductsTable(supabase, articulo);
}

async function fetchProductForSku(sku: string): Promise<{
  product: GroupedProduct;
  initialColor?: string;
} | null> {
  const supabase = getSupabaseBrowserClient();
  const key = sku.trim();
  let requestedColor: string | undefined;

  let base: GroupedProduct | null = await loadGroupedByArticulo(supabase, key);

  if (!base) {
    const { data: sizeData } = await supabase
      .from("variant_sizes")
      .select("variant_id, size")
      .eq("sku", key)
      .limit(1)
      .maybeSingle();

    let variantId: string | null = (sizeData as { variant_id?: string })?.variant_id ?? null;

    if (!variantId) {
      const { data: variantData } = await supabase
        .from("product_variants")
        .select("id")
        .eq("sku", key)
        .eq("active", true)
        .limit(1)
        .maybeSingle();
      variantId = (variantData as { id?: string })?.id ?? null;
    }

    if (variantId) {
      const { data: variantFull } = await supabase
        .from("product_variants")
        .select("color, products!inner(name)")
        .eq("id", variantId)
        .limit(1)
        .maybeSingle();

      const articulo = (variantFull as { products?: { name?: string } })?.products?.name ?? "";
      requestedColor = (variantFull as { color?: string })?.color ?? undefined;
      if (articulo) {
        base = await loadGroupedByArticulo(supabase, articulo);
      }
    }
  }

  if (!base) return null;

  const [enriched] = await enrichGroupedProductsWithVariants(supabase, [base]);
  if (!enriched) return null;

  const product = stripColorsWithoutImages(enriched);
  if (product.DetalleColor.length === 0) return null;

  let initialColor = requestedColor;
  if (initialColor) {
    const exists = product.DetalleColor.some(
      (d) => d.color.toLowerCase() === initialColor!.toLowerCase()
    );
    if (!exists) initialColor = undefined;
  }
  if (!initialColor) {
    initialColor = pickDisplayColorDetail(product)?.color;
  }

  return { product, initialColor };
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

export default function PdpLoader({ sku, backUrl, initialColorFromUrl }: PdpLoaderProps) {
  const { data, isLoading, error } = useSWR(`pdp:${sku}`, () => fetchProductForSku(sku), {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 300_000,
  });

  const resolvedInitialColor = useMemo(() => {
    if (initialColorFromUrl && data?.product) {
      const exists = data.product.DetalleColor.some(
        (d) => d.color.toLowerCase() === initialColorFromUrl.toLowerCase()
      );
      if (exists) return initialColorFromUrl;
    }
    return data?.initialColor;
  }, [data, initialColorFromUrl]);

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

  if (isLoading) return <PdpLoading />;
  if (error || !data || !productWithSellable) return <PdpNotFound backUrl={backUrl} />;

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
