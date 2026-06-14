"use client";

import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { resolveImageSrc } from "@/lib/cloudinary";
import {
  enrichCuratedCardsWithProductColors,
  fetchCuratedVariantCards,
} from "@/lib/banners/curated-banner-fetch";
import {
  CURATED_SPECIAL_TAG,
  parseSpecialBannerMeta,
} from "@/lib/banners/curated-banner-tags";
import type { CuratedBannerConfig, CuratedVariantCardEnriched } from "@/types/banners";

async function fetchCuratedSpecialBanner(): Promise<{
  config: CuratedBannerConfig;
  heroCards: CuratedVariantCardEnriched[];
  totalCount: number;
} | null> {
  const supabase = getSupabaseBrowserClient();

  const { data: config, error: cfgErr } = await supabase
    .from("custom_product_banners")
    .select(
      `id, title, slug, description, enabled, sort_order, tag_value,
       custom_product_banner_items ( product_variant_id, position )`
    )
    .eq("enabled", true)
    .eq("tag_value", CURATED_SPECIAL_TAG)
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
    heroCards: enriched.slice(0, 3),
    totalCount: enriched.length,
  };
}

function HeroPhoto({
  card,
  index,
}: {
  card: CuratedVariantCardEnriched;
  index: number;
}) {
  const imageSrc = resolveImageSrc(
    card["Imagen Principal"] as Parameters<typeof resolveImageSrc>[0]
  );

  return (
    <div
      className="curated-special-banner__photo"
      data-index={index}
      aria-hidden={index > 0 ? undefined : false}
    >
      {imageSrc ? (
        <Image
          src={imageSrc}
          alt={card.Articulo}
          fill
          sizes="88px"
          className="curated-special-banner__photo-img"
          style={{ objectFit: "cover" }}
        />
      ) : (
        <div className="curated-special-banner__photo-img skeleton-shimmer" />
      )}
    </div>
  );
}

export default function CuratedSpecialBanner() {
  const { data, isLoading } = useSWR("curated-special-banner", fetchCuratedSpecialBanner, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 300_000,
  });

  if (!isLoading && !data) return null;
  if (!isLoading && data && data.heroCards.length === 0) return null;

  const config = data?.config;
  const meta = parseSpecialBannerMeta(config?.description);
  const title = config?.title ?? "Colección especial";
  const totalCount = data?.totalCount ?? 0;
  const verTodoHref = config
    ? `/banner/${encodeURIComponent(config.slug)}`
    : "#";

  return (
    <section className="curated-special-banner-wrap" aria-label={title}>
      <Link href={verTodoHref} className="curated-special-banner">
        <div className="curated-special-banner__photos" aria-hidden="true">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="curated-special-banner__photo" data-index={i}>
                <div className="curated-special-banner__photo-img skeleton-shimmer" />
              </div>
            ))
          ) : (
            data?.heroCards.map((card, index) => (
              <HeroPhoto key={card.variant_id} card={card} index={index} />
            ))
          )}
        </div>

        <div className="curated-special-banner__copy">
          {isLoading ? (
            <>
              <span
                className="curated-special-banner__overline skeleton-shimmer"
                style={{ display: "inline-block", width: 120, height: 12, borderRadius: 4 }}
              />
              <span
                className="curated-special-banner__title skeleton-shimmer"
                style={{ display: "block", width: "70%", height: 24, borderRadius: 6, marginTop: 8 }}
              />
            </>
          ) : (
            <>
              <span className="curated-special-banner__overline">{meta.overline}</span>
              <h2 className="curated-special-banner__title">{title}</h2>
              <p className="curated-special-banner__subtitle">
                {totalCount} producto{totalCount === 1 ? "" : "s"} seleccionado
                {totalCount === 1 ? "" : "s"}
              </p>
              <span className="curated-special-banner__cta">
                {meta.ctaLabel}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden="true">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
            </>
          )}
        </div>
      </Link>
    </section>
  );
}
