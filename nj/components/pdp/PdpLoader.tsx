"use client";

import useSWR from "swr";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, CATALOG_SELECT, agruparProductos } from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";
import PdpInteractive from "./PdpInteractive";
import PdpLoading from "@/app/producto/[sku]/loading";

interface PdpLoaderProps {
  sku: string;
  backUrl: string;
}

// ─── Client-side product fetch ────────────────────────────────────────────────

async function fetchProductForSku(sku: string): Promise<{
  product: GroupedProduct;
  initialColor?: string;
} | null> {
  const supabase = getSupabaseBrowserClient();

  // 1. Try as Articulo directly (most common — card links use Articulo)
  const { data: byArticulo } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .eq("Articulo", sku.trim())
    .limit(50);

  if (byArticulo && byArticulo.length > 0) {
    const grouped = agruparProductos(byArticulo as unknown as CatalogRow[]);
    if (grouped[0]) return { product: grouped[0] };
  }

  // 2. Try resolving SKU → variant → Articulo
  const { data: sizeData } = await supabase
    .from("variant_sizes")
    .select("variant_id, size")
    .eq("sku", sku.trim())
    .limit(1)
    .maybeSingle();

  let variantId: string | null = (sizeData as any)?.variant_id ?? null;

  if (!variantId) {
    const { data: variantData } = await supabase
      .from("product_variants")
      .select("id")
      .eq("sku", sku.trim())
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    variantId = (variantData as any)?.id ?? null;
  }

  if (!variantId) return null;

  const { data: variantFull } = await supabase
    .from("product_variants")
    .select("color, products!inner(name)")
    .eq("id", variantId)
    .limit(1)
    .maybeSingle();

  if (!variantFull) return null;

  const articulo: string = (variantFull as any).products?.name ?? "";
  const color: string = (variantFull as any).color ?? "";
  if (!articulo) return null;

  const { data: byResolved } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .eq("Articulo", articulo.trim())
    .limit(50);

  if (!byResolved || byResolved.length === 0) return null;
  const grouped = agruparProductos(byResolved as unknown as CatalogRow[]);
  if (!grouped[0]) return null;

  return { product: grouped[0], initialColor: color || undefined };
}

// ─── Client-side variant sizes fetch ─────────────────────────────────────────

async function fetchVariantSizes(articulo: string) {
  const supabase = getSupabaseBrowserClient();

  const { data: variants } = await supabase
    .from("product_variants")
    .select("id, color, sku, products!inner(name)")
    .eq("active", true)
    .eq("products.name", articulo.trim())
    .limit(20);

  if (!variants || variants.length === 0) return [];

  const results = await Promise.all(
    variants.map(async (v: any) => {
      const { data: sizes } = await supabase
        .from("variant_sizes")
        .select("size, sku, stock_qty")
        .eq("variant_id", v.id)
        .order("size");

      return {
        variantId: v.id,
        color: v.color ?? "",
        sku: v.sku ?? "",
        sizes: (sizes ?? []).map((s: any) => ({
          size: String(s.size ?? ""),
          sku: s.sku ?? "",
          stock_qty: Number(s.stock_qty ?? 0),
        })),
      };
    })
  );

  return results;
}

// ─── Not Found UI ─────────────────────────────────────────────────────────────

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
      <div style={{ fontSize: 48, marginBottom: 16 }}>🔍</div>
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

// ─── Main loader ──────────────────────────────────────────────────────────────

export default function PdpLoader({ sku, backUrl }: PdpLoaderProps) {
  const { data, isLoading, error } = useSWR(
    `pdp:${sku}`,
    () => fetchProductForSku(sku),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300_000,
    }
  );

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
      initialColor={data.initialColor}
      backUrl={backUrl}
    />
  );
}
