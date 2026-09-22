"use client";

import { useRef } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchFylOriginalsCurated } from "@/lib/banners/fyl-originals";
import { useCatalogSnapshotRevalidate } from "@/lib/catalog/snapshot-version";
import {
  shouldFetchBanner,
  shouldReserveBannerSlot,
  type BannerPresenceState,
} from "@/lib/banners/home-banner-presence";
import {
  BannerCarouselCard,
  BannerCarouselSkeleton,
} from "@/components/banners/BannerCarouselCard";

type Props = {
  expectedVisible?: BannerPresenceState;
};

export default function FylOriginalsBanner({
  expectedVisible = "unknown",
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const enabled = shouldFetchBanner(expectedVisible);
  const reserve = shouldReserveBannerSlot(expectedVisible);

  const { data: products, isLoading, mutate } = useSWR(
    enabled ? "fyl-originals" : null,
    fetchFylOriginalsCurated,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300_000,
    }
  );
  useCatalogSnapshotRevalidate(mutate);

  if (!enabled) return null;

  const visible = products ?? [];
  if (!isLoading && visible.length === 0) return null;

  const showSkeleton = isLoading && visible.length === 0;
  if (showSkeleton && !reserve) return null;

  return (
    <section
      className={[
        "orig-block",
        "fyl-originals-banner",
        "home-banner-slot",
        "home-banner-slot--carousel",
        showSkeleton ? "is-loading" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="F&L Originals — fabricación propia"
      aria-busy={showSkeleton || undefined}
    >
      <div className="orig-head">
        <h2 className="orig-title">
          F&amp;L Originals{" "}
          <span className="orig-subInline">• Fabricación propia</span>
        </h2>
        <Link
          href="/coleccion/fyl-originals"
          className="orig-ver-todo"
          aria-label="Ver colección completa"
        >
          Ver colección →
        </Link>
      </div>

      <div
        ref={scrollRef}
        className="fyl-originals-scroll orig-carousel"
        style={{ display: "flex", overflowX: "auto" }}
      >
        {showSkeleton
          ? Array.from({ length: 6 }).map((_, i) => (
              <BannerCarouselSkeleton key={i} />
            ))
          : visible.map((p) => (
              <BannerCarouselCard key={p.Articulo} product={p} />
            ))}
      </div>
    </section>
  );
}
