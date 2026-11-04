"use client";

import { useRef } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchNuevosIngresos } from "@/lib/banners/nuevos-ingresos";
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
  /** Tri-state SSR: present reserva; absent omite; unknown consulta sin afirmar ausencia. */
  expectedVisible?: BannerPresenceState;
};

export default function NuevosIngresosBanner({
  expectedVisible = "unknown",
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const enabled = shouldFetchBanner(expectedVisible);
  const reserve = shouldReserveBannerSlot(expectedVisible);

  const { data: products, isLoading, mutate } = useSWR(
    enabled ? "nuevos-ingresos-banner" : null,
    fetchNuevosIngresos,
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
  // unknown + loading: no reservar hueco grande (aparece al resolver SWR).
  if (showSkeleton && !reserve) return null;

  return (
    <section
      className={[
        "nuevos-ingresos-banner",
        "home-banner-slot",
        "home-banner-slot--carousel",
        showSkeleton ? "is-loading" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Nuevos ingresos"
      aria-busy={showSkeleton || undefined}
    >
      <div className="nuevos-ingresos-head">
        <h2 className="nuevos-ingresos-title">Nuevos ingresos</h2>
        <Link
          href="/coleccion/nuevos-ingresos"
          className="nuevos-ingresos-ver-todo"
          aria-label="Ver todos los nuevos ingresos"
        >
          Ver todo →
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
