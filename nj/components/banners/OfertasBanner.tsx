"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { msUntilNextPromoRotation, rotatePromoBanner } from "@/lib/banners/promo-rotation";

type Props = {
  /** Tri-state SSR: present reserva; absent omite; unknown consulta (el fetch re-verifica el check). */
  expectedVisible?: BannerPresenceState;
};

/**
 * Banner de Ofertas del inicio. Se muestra solo con el check activo de
 * admin/offers.html (`home_feature_flags.home_offers_banner`) y al menos una oferta vigente.
 * Los afiches y las ofertas rotan juntos cada 6 horas para que no queden siempre
 * escondidos los mismos. El afiche se distingue por el marco dorado.
 */
export default function OfertasBanner({ expectedVisible = "unknown" }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const enabled = shouldFetchBanner(expectedVisible);
  const reserve = shouldReserveBannerSlot(expectedVisible);

  useEffect(() => {
    const delay = msUntilNextPromoRotation(Date.now());
    const timer = window.setTimeout(() => setNowMs(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [nowMs]);

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

  const slots = useMemo(
    () =>
      rotatePromoBanner(
        [
          ...(data?.campaigns ?? []).map((campaign) => ({ kind: "campaign" as const, campaign })),
          ...(data?.items ?? []).map((item) => ({ kind: "item" as const, item })),
        ],
        nowMs
      ),
    [data, nowMs]
  );

  if (!enabled) return null;
  if (!isLoading && slots.length === 0) return null;

  const showSkeleton = isLoading && slots.length === 0;
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
            : slots.map((slot) => {
                switch (slot.kind) {
                  case "campaign":
                    return (
                      <OfertaCampaignCard
                        key={`promo-${slot.campaign.campaignId}`}
                        campaign={slot.campaign}
                      />
                    );
                  case "item":
                    return (
                      <OfertaCarouselCard
                        key={`oferta-${slot.item.product.Articulo}`}
                        item={slot.item}
                      />
                    );
                  default: {
                    const unexpected: never = slot;
                    return unexpected;
                  }
                }
              })}
        </div>
        <CarouselArrows scrollerRef={scrollRef} />
      </div>
    </section>
  );
}
