import { Suspense } from "react";
import type { Metadata } from "next";
import {
  getCatalogPage,
  hasActiveOfertas,
} from "@/lib/supabase/queries";
import {
  getHomeBannerPresence,
  shouldReserveBannerSlot,
  type HomeBannerPresence,
} from "@/lib/banners/home-banner-presence";
import CatalogShell from "@/components/catalog/CatalogShell";
import CatalogShellSkeleton from "@/components/catalog/CatalogShellSkeleton";
import FylOriginalsBanner from "@/components/banners/FylOriginalsBanner";
import NuevosIngresosBanner from "@/components/banners/NuevosIngresosBanner";
import CuratedSpecialBanner from "@/components/banners/CuratedSpecialBanner";
import CuratedBanner from "@/components/banners/CuratedBanner";
import InfoBanner from "@/components/banners/InfoBanner";
import HomeLaunchOnboarding from "@/components/guide/HomeLaunchOnboarding";
import FullOnly from "@/components/rollout/FullOnly";

export const revalidate = 300;

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

function HomeBannersSlot({
  presence,
}: {
  presence: HomeBannerPresence;
}) {
  return (
    <>
      <InfoBanner key="info-banner" />
      <NuevosIngresosBanner
        key="nuevos-ingresos"
        expectedVisible={presence.nuevosIngresos}
      />
      <FylOriginalsBanner
        key="fyl-originals"
        expectedVisible={presence.fylOriginals}
      />
      <CuratedSpecialBanner
        key="curated-special-banner"
        expectedVisible={presence.curatedSpecial}
      />
      <CuratedBanner
        key="curated-banner"
        expectedVisible={presence.curated}
      />
    </>
  );
}

/** Placeholders solo si SSR confirmó `present` (no unknown/absent). */
function HomeBannersSkeleton({
  presence,
}: {
  presence: HomeBannerPresence;
}) {
  return (
    <>
      <InfoBanner key="info-banner" />
      {shouldReserveBannerSlot(presence.nuevosIngresos) && (
        <section
          className="nuevos-ingresos-banner home-banner-slot home-banner-slot--carousel is-loading"
          aria-hidden
        />
      )}
      {shouldReserveBannerSlot(presence.fylOriginals) && (
        <section
          className="orig-block fyl-originals-banner home-banner-slot home-banner-slot--carousel is-loading"
          aria-hidden
        />
      )}
      {shouldReserveBannerSlot(presence.curatedSpecial) && (
        <section
          className="curated-special-banner-wrap home-banner-slot home-banner-slot--special is-loading"
          aria-hidden
        />
      )}
      {shouldReserveBannerSlot(presence.curated) && (
        <div
          className="custom-banner-wrapper curated-dynamic-banner home-banner-slot home-banner-slot--curated is-loading"
          aria-hidden
        />
      )}
    </>
  );
}

async function CatalogContent({
  hasOfertas,
  presence,
}: {
  hasOfertas: boolean;
  presence: HomeBannerPresence;
}) {
  const { products } = await getCatalogPage("all", 1);

  return (
    <CatalogShell
      initialProducts={products}
      categoria="all"
      tags={[]}
      hasOfertas={hasOfertas}
      aboveGridSlot={<HomeBannersSlot presence={presence} />}
    />
  );
}

export default async function HomePage() {
  // Señales ligeras fuera de Suspense → fallback estructural con mismas zonas.
  const [hasOfertas, presence] = await Promise.all([
    hasActiveOfertas(),
    getHomeBannerPresence(),
  ]);

  return (
    <>
      <FullOnly>
        <HomeLaunchOnboarding />
      </FullOnly>
      <Suspense
        fallback={
          <CatalogShellSkeleton
            categoria="all"
            hasOfertas={hasOfertas}
            bannersSlot={<HomeBannersSkeleton presence={presence} />}
          />
        }
      >
        <CatalogContent hasOfertas={hasOfertas} presence={presence} />
      </Suspense>
    </>
  );
}
