import { Suspense } from "react";
import { getCatalogPage } from "@/lib/supabase/queries";
import CatalogShell from "@/components/catalog/CatalogShell";
import SkeletonCard from "@/components/catalog/SkeletonCard";
import FylOriginalsBanner from "@/components/banners/FylOriginalsBanner";
import CuratedBanner from "@/components/banners/CuratedBanner";
import InfoBanner from "@/components/banners/InfoBanner";

export const revalidate = 300;

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

// Async child: all data fetched here, inside Suspense — page responds immediately
async function CatalogContent() {
  const { products } = await getCatalogPage("all", 1);

  return (
    <CatalogShell
      initialProducts={products}
      categoria="all"
      tags={[]}
      aboveGridSlot={
        <>
          <FylOriginalsBanner key="fyl-originals" />
          <InfoBanner key="info-banner" />
        </>
      }
      curatedSlot={<CuratedBanner key="curated-banner" />}
    />
  );
}

// NOT async — sends HTML immediately with skeleton fallback
export default function HomePage() {
  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <CatalogContent />
    </Suspense>
  );
}
