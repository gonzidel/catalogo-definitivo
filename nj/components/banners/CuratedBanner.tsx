"use client";

import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { formatARS } from "@/lib/utils/catalog";
import { resolveImageSrc } from "@/lib/cloudinary";
import {
  enrichCuratedCardsWithProductColors,
  fetchCuratedVariantCards,
} from "@/lib/banners/curated-banner-fetch";
import {
  chunkPairPages,
  getCarouselCards,
  toColumnPairs,
} from "@/lib/banners/curated-banner-layout";
import type { CuratedBannerConfig, CuratedVariantCardEnriched } from "@/types/banners";

import { CURATED_TAG } from "@/lib/banners/curated-banner-tags";

async function fetchCuratedBanner(): Promise<{
  config: CuratedBannerConfig;
  cards: CuratedVariantCardEnriched[];
} | null> {
  const supabase = getSupabaseBrowserClient();

  const { data: config, error: cfgErr } = await supabase
    .from("custom_product_banners")
    .select(
      `id, title, slug, description, enabled, sort_order, tag_value,
       custom_product_banner_items ( product_variant_id, position )`
    )
    .eq("enabled", true)
    .eq("tag_value", CURATED_TAG)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (cfgErr || !config) return null;

  const items = (
    (config as CuratedBannerConfig).custom_product_banner_items ?? []
  )
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  if (items.length === 0) return null;

  const variantIds = items.map((i) => i.product_variant_id).filter(Boolean);
  const cards = await fetchCuratedVariantCards(variantIds, supabase);
  const enriched = await enrichCuratedCardsWithProductColors(cards, supabase);

  return {
    config: config as CuratedBannerConfig,
    cards: enriched,
  };
}

function VariantCard({ card }: { card: CuratedVariantCardEnriched }) {
  const imageSrc = resolveImageSrc(
    card["Imagen Principal"] as Parameters<typeof resolveImageSrc>[0]
  );
  const precio =
    card.OfertaActiva && card.PrecioOferta ? card.PrecioOferta : card.Precio;
  const colors = card.colors ?? [];

  return (
    <Link
      href={`/producto/${encodeURIComponent(card.Articulo)}`}
      className="custom-banner-card"
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div className="custom-banner-card-image-wrap">
        {imageSrc ? (
          <Image
            src={imageSrc}
            alt={card.Articulo}
            fill
            sizes="(max-width: 480px) 42vw, 180px"
            className="custom-banner-card-image"
            style={{ objectFit: "cover" }}
          />
        ) : (
          <div className="custom-banner-card-image skeleton-shimmer" aria-hidden="true" />
        )}
        <div className="custom-banner-badge">{card.Articulo}</div>
      </div>
      {colors.length > 0 && (
        <div className="custom-banner-colors">
          {colors.slice(0, 3).map((c) => (
            <span
              key={c.color}
              className="color-dot"
              style={{ background: c.hex_color ?? "#ccc" }}
              title={c.color}
            />
          ))}
          {colors.length > 3 && (
            <span className="color-dot color-dot-more" aria-hidden="true">
              +{colors.length - 3}
            </span>
          )}
        </div>
      )}
      <div className="custom-banner-card-content">
        <div className="custom-banner-card-price">{formatARS(precio)}</div>
        <div className="custom-banner-card-wholesale">Precio por Mayor</div>
      </div>
    </Link>
  );
}

function ColumnPair({ pair }: { pair: [CuratedVariantCardEnriched, CuratedVariantCardEnriched] }) {
  return (
    <div className="custom-banner-column-pair">
      {pair.map((card) => (
        <VariantCard key={card.variant_id} card={card} />
      ))}
    </div>
  );
}

function ScrollPage({
  pairs,
}: {
  pairs: [CuratedVariantCardEnriched, CuratedVariantCardEnriched][];
}) {
  return (
    <div className="custom-banner-grid-page" data-pairs={pairs.length}>
      {pairs.map((pair, index) => (
        <ColumnPair key={`${pair[0].variant_id}-${index}`} pair={pair} />
      ))}
    </div>
  );
}

function SkeletonScrollPage() {
  return (
    <div className="custom-banner-grid-page" data-pairs={2} aria-hidden="true">
      {Array.from({ length: 2 }).map((_, col) => (
        <div key={col} className="custom-banner-column-pair">
          {Array.from({ length: 2 }).map((__, row) => (
            <div key={row} className="custom-banner-card" style={{ pointerEvents: "none" }}>
              <div className="custom-banner-card-image-wrap">
                <div className="custom-banner-card-image skeleton-shimmer" />
              </div>
              <div className="custom-banner-card-content">
                <div
                  className="skeleton-shimmer"
                  style={{ width: "60%", height: 14, borderRadius: 4 }}
                />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function CuratedBanner() {
  const { data, isLoading } = useSWR("curated-banner", fetchCuratedBanner, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 300_000,
  });

  if (!isLoading && !data) return null;

  const config = data?.config;
  const allCards = data?.cards ?? [];
  const carouselCards = getCarouselCards(allCards);
  const pages = chunkPairPages(toColumnPairs(allCards));
  const verTodoHref = config
    ? `/banner/${encodeURIComponent(config.slug)}`
    : "#";

  if (!isLoading && allCards.length === 0) return null;

  const showGrid = isLoading || carouselCards.length > 0;

  return (
    <div className="custom-banner-wrapper curated-dynamic-banner">
      <div className="custom-banner-container" style={{ display: "block" }}>
        <div className="custom-banner-header">
          <h2 className="custom-banner-title">
            {config?.title ?? (
              <span
                className="skeleton-shimmer"
                style={{ display: "inline-block", width: 140, height: 20 }}
              />
            )}
          </h2>
          {config && (
            <Link href={verTodoHref} className="custom-banner-ver-todo-btn">
              Ver todo{" "}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                style={{ width: 16, height: 16 }}
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </Link>
          )}
        </div>

        {showGrid && (
          <div className="custom-banner-scroll">
            {isLoading ? (
              <SkeletonScrollPage />
            ) : (
              pages.map((pagePairs, index) => (
                <ScrollPage key={`page-${index}`} pairs={pagePairs} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Re-export helpers for tests
export { getCarouselCards, toColumnPairs, chunkPairPages };
