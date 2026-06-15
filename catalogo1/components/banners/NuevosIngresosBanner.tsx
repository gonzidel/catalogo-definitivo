"use client";

import { useRef } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchNuevosIngresos } from "@/lib/banners/nuevos-ingresos";
import {
  BannerCarouselCard,
  BannerCarouselSkeleton,
} from "@/components/banners/BannerCarouselCard";

export default function NuevosIngresosBanner() {
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: products, isLoading } = useSWR(
    "nuevos-ingresos-banner",
    fetchNuevosIngresos,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300_000,
    }
  );

  const visible = products ?? [];

  if (!isLoading && visible.length === 0) return null;

  return (
    <section
      className="nuevos-ingresos-banner"
      aria-label="Nuevos ingresos"
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
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => (
              <BannerCarouselSkeleton key={i} />
            ))
          : visible.map((p, i) => (
              <BannerCarouselCard key={p.Articulo} product={p} priority={i === 0} />
            ))}
      </div>
    </section>
  );
}
