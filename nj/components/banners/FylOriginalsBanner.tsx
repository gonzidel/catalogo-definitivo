"use client";

import { useRef } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetchFylOriginalsCurated } from "@/lib/banners/fyl-originals";
import {
  BannerCarouselCard,
  BannerCarouselSkeleton,
} from "@/components/banners/BannerCarouselCard";

export default function FylOriginalsBanner() {
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: products, isLoading } = useSWR(
    "fyl-originals",
    fetchFylOriginalsCurated,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300_000,
    }
  );

  const visible = products ?? [];

  if (!isLoading && visible.length === 0) return null;

  return (
    <section className="orig-block fyl-originals-banner" aria-label="F&L Originals — fabricación propia">
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
        {isLoading
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
