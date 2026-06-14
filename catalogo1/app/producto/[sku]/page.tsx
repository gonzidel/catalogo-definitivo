import type { Metadata } from "next";
import PdpLoader from "@/components/pdp/PdpLoader";

export const revalidate = 0; // PDP is fully client-side; no SSR product fetch

interface PageProps {
  params: Promise<{ sku: string }>;
  searchParams: Promise<{ from?: string; color?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { sku } = await params;
  const decoded = decodeURIComponent(sku);
  return {
    title: `Art. ${decoded} — FYL Moda`,
  };
}

export default async function PdpPage({ params, searchParams }: PageProps) {
  const { sku } = await params;
  const { from, color } = await searchParams;

  const backUrl = from ? decodeURIComponent(from) : "/";
  const colorParam = color ? decodeURIComponent(color) : undefined;

  return (
    <PdpLoader
      sku={decodeURIComponent(sku)}
      backUrl={backUrl}
      initialColorFromUrl={colorParam}
    />
  );
}
