import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import CatalogShell from "@/components/catalog/CatalogShell";
import SkeletonCard from "@/components/catalog/SkeletonCard";
import { fetchOfferCampaignProducts, isOfferCampaignId } from "@/lib/banners/offer-campaign";

export const revalidate = 300;

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  if (!isOfferCampaignId(decoded)) {
    return { title: "Página no encontrada — FYL Moda", robots: { index: false, follow: false } };
  }
  const result = await fetchOfferCampaignProducts(decoded);
  const title = result?.title || "Oferta";
  return {
    alternates: { canonical: `/ofertas/campana/${encodeURIComponent(decoded)}` },
    title: `${title} — FYL Moda`,
    description: `Productos de la oferta ${title}. Catálogo mayorista de moda femenina.`,
  };
}

function CatalogSkeleton() {
  return (
    <div id="catalogo" className="catalogo">
      <div id="catalog-container">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

async function CampaignContent({ id }: { id: string }) {
  const result = await fetchOfferCampaignProducts(id);
  if (!result) notFound();

  return (
    <>
      <div style={{ padding: "10px 12px 0", display: "flex", alignItems: "center", gap: 12 }}>
        <Link
          href="/ofertas"
          style={{
            color: "#CD844D",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          ← Ofertas
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, color: "#1a1a1a" }}>
          {result.title}
        </h1>
      </div>

      {result.products.length === 0 ? (
        <p style={{ padding: "16px 12px", color: "#5c5346" }}>
          Esta oferta ya no tiene productos disponibles.
        </p>
      ) : (
        <CatalogShell
          initialProducts={result.products}
          categoria="all"
          tags={[]}
          fixedProductSet
        />
      )}
    </>
  );
}

export default async function OfferCampaignPage({ params }: PageProps) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  if (!isOfferCampaignId(decoded)) notFound();

  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <CampaignContent id={decoded} />
    </Suspense>
  );
}
