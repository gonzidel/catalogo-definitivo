"use client";

import { useRef } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchOfertasDestacadas } from "@/lib/banners/ofertas-destacadas";
import { GA_BANNER_SLOTS } from "@/lib/analytics/catalog-interactions";
import { useCatalogSnapshotRevalidate } from "@/lib/catalog/snapshot-version";
import {
  shouldFetchBanner,
  shouldReserveBannerSlot,
  type BannerPresenceState,
} from "@/lib/banners/home-banner-presence";
import { BannerCarouselSkeleton } from "@/components/banners/BannerCarouselCard";
import { OfertaCampaignCard } from "@/components/banners/OfertaCampaignCard";
import { OfertaCarouselCard } from "@/components/banners/OfertaCarouselCard";
import CarouselArrows from "@/components/banners/CarouselArrows";

type Props = {
  /** Tri-state SSR: present reserva; absent omite; unknown consulta (el fetch re-verifica el check). */
  expectedVisible?: BannerPresenceState;
};

/**
 * Banner de Ofertas del inicio. Se muestra solo con el check activo de
 * admin/offers.html (`home_feature_flags.home_offers_banner`) y al menos una oferta vigente.
 * Las campañas con imagen van primero; el resto sigue como foto + precio.
 */
export default function OfertasBanner({ expectedVisible = "unknown" }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const enabled = shouldFetchBanner(expectedVisible);
  const reserve = shouldReserveBannerSlot(expectedVisible);

  const { data, isLoading, mutate } = useSWR(
    enabled ? "ofertas-destacadas-banner" : null,
    fetchOfertasDestacadas,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300_000,
    }
  );
  useCatalogSnapshotRevalidate(mutate);

  if (!enabled) return null;

  const campaigns = data?.campaigns ?? [];
  const items = data?.items ?? [];
  if (!isLoading && campaigns.length + items.length === 0) return null;

  const showSkeleton = isLoading && campaigns.length + items.length === 0;
  // unknown + loading: no reservar hueco (aparece al resolver SWR si el check está activo).
  if (showSkeleton && !reserve) return null;

  return (
    <section
      className={[
        "ofertas-banner",
        "home-banner-slot",
        "home-banner-slot--ofertas",
        showSkeleton ? "is-loading" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Ofertas"
      data-ofertas-promos="1"
      aria-busy={showSkeleton || undefined}
      data-ga-banner={GA_BANNER_SLOTS.ofertas}
    >
      <div className="ofertas-banner__head">
        <h2 className="ofertas-banner__title">
          <span className="ofertas-banner__fire" aria-hidden="true">
            🔥
          </span>
          Ofertas
        </h2>
        <Link
          href="/ofertas"
          className="ofertas-banner__ver-todo"
          aria-label="Ver todas las ofertas"
        >
          Ver todo →
        </Link>
      </div>

      <div className="desktop-carousel">
        <div
          ref={scrollRef}
          className="fyl-originals-scroll orig-carousel"
          style={{ display: "flex", overflowX: "auto" }}
        >
          {showSkeleton
            ? Array.from({ length: 6 }).map((_, i) => (
                <BannerCarouselSkeleton key={i} />
              ))
            : (
              <>
                {campaigns.map((campaign) => (
                  <OfertaCampaignCard key={campaign.campaignId} campaign={campaign} />
                ))}
                {items.map((item) => (
                  <OfertaCarouselCard key={item.product.Articulo} item={item} />
                ))}
              </>
            )}
        </div>
        <CarouselArrows scrollerRef={scrollRef} />
      </div>
    </section>
  );
}
