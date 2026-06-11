import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getCuratedBanners } from "@/lib/supabase/queries";
import { fetchCuratedGroupedProductsBySlug } from "@/lib/banners/curated-banner-fetch";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import CatalogShell from "@/components/catalog/CatalogShell";
import SkeletonCard from "@/components/catalog/SkeletonCard";

export const revalidate = 300;

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);
  const banners = await getCuratedBanners();
  const banner = banners.find((b) => b.slug === decoded);
  if (!banner) return { title: "Colección — FYL Moda" };
  return {
    title: `${banner.title} — FYL Moda`,
    description:
      banner.description ||
      `Colección ${banner.title}. Catálogo mayorista de moda femenina.`,
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

async function BannerContent({ slug }: { slug: string }) {
  const supabase = await createSupabaseServerClient();
  const result = await fetchCuratedGroupedProductsBySlug(supabase, slug);

  if (!result) notFound();

  const { banner, products } = {
    banner: result.config,
    products: result.products,
  };

  return (
    <>
      {/* Back link + title */}
      <div style={{ padding: "10px 12px 0", display: "flex", alignItems: "center", gap: 12 }}>
        <Link
          href="/"
          style={{
            color: "#CD844D",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          ← Inicio
        </Link>
        <h1 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 700, color: "#1a1a1a" }}>
          {banner.title}
        </h1>
      </div>

      <CatalogShell
        initialProducts={products}
        categoria="all"
        tags={[]}
        fixedProductSet
      />
    </>
  );
}

export default async function BannerPage({ params }: PageProps) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <BannerContent slug={decoded} />
    </Suspense>
  );
}
