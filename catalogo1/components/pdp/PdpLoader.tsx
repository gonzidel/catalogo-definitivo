"use client";

import useSWR from "swr";
import { useMemo } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, CATALOG_SELECT, agruparProductos } from "@/lib/utils/catalog";
import {
  enrichGroupedProductsWithVariants,
  pickDisplayColorDetail,
  stripColorsWithoutImages,
} from "@/lib/utils/catalog-variant-enrich";
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
    .select("name, description, category, price")
    .eq("name", articulo.trim())
    .eq("status", "active")
    .maybeSingle();

  if (!row) return null;

  return {
    Articulo: String(row.name ?? articulo).trim(),
    Descripcion: String(row.description ?? ""),
    Precio: row.price ?? "",
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

async function fetchVariantSizes(articulo: string) {
  const supabase = getSupabaseBrowserClient();

  const { data: variants } = await supabase
    .from("product_variants")
    .select("id, color, sku, products!inner(name)")
    .eq("active", true)
    .eq("products.name", articulo.trim())
    .limit(30);

  if (!variants || variants.length === 0) return [];

  const results = await Promise.all(
    variants.map(async (v: { id: string; color?: string; sku?: string }) => {
      const { data: sizes } = await supabase
        .from("variant_sizes")
        .select("size, sku, stock_qty")
        .eq("variant_id", v.id)
        .order("size");

      return {
        variantId: v.id,
        color: v.color ?? "",
        sku: v.sku ?? "",
        sizes: (sizes ?? []).map((s: { size?: string; sku?: string; stock_qty?: number }) => ({
          size: String(s.size ?? ""),
          sku: s.sku ?? "",
          stock_qty: Number(s.stock_qty ?? 0),
        })),
      };
    })
  );

  return results;
}

function PdpNotFound({ backUrl }: { backUrl: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        padding: "32px 16px",
        textAlign: "center",
      }}
    >
      <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8, color: "#333" }}>
        Producto no encontrado
      </h2>
      <p style={{ fontSize: 14, color: "#888", marginBottom: 24 }}>
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

  const { data: variantSizes = [] } = useSWR(
    data?.product ? `pdp-sizes:${data.product.Articulo}` : null,
    () => fetchVariantSizes(data!.product.Articulo),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    }
  );

  if (isLoading) return <PdpLoading />;
  if (error || !data) return <PdpNotFound backUrl={backUrl} />;

  return (
    <PdpInteractive
      product={data.product}
      variantSizes={variantSizes}
      initialColor={resolvedInitialColor}
      backUrl={backUrl}
    />
  );
}
