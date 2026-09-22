import type { Metadata } from "next";
import PdpLoader from "@/components/pdp/PdpLoader";
import { loadPdpProductForSku } from "@/lib/pdp/load-product-ssr";

/** HTML dinámico por searchParams; el producto público usa Data Cache (60s). */
export const revalidate = 60;

interface PageProps {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ from?: string; color?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { sku } = await params;
  const decoded = decodeURIComponent(sku);
  return {
    title: `Art. ${decoded} — FYL Moda`,
    alternates: { canonical: `/producto/${encodeURIComponent(decoded)}` },
  };
}

export default async function PdpPage({ params, searchParams }: PageProps) {
  const { sku } = await params;
  const { from, color } = await searchParams;

  const decodedSku = decodeURIComponent(sku);
  const backUrl = from ? decodeURIComponent(from) : "/";
  const colorParam = color ? decodeURIComponent(color) : undefined;

  const ssrPayload = await loadPdpProductForSku(decodedSku, colorParam);

  return (
    <PdpLoader
      sku={decodedSku}
      backUrl={backUrl}
      initialColorFromUrl={colorParam}
      initialProduct={ssrPayload?.product ?? null}
      initialColor={ssrPayload?.initialColor}
    />
  );
}
