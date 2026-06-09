"use client";

import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, formatARS } from "@/lib/utils/catalog";
import { resolveImageSrc } from "@/lib/cloudinary";
import type { CuratedBannerConfig, CuratedVariantCard } from "@/types/banners";

// ─── Constants ────────────────────────────────────────────────────────────────

const DYNAMIC_TAG = "__curated__";
const VARIANT_SELECT =
  'variant_id,Articulo,Descripcion,Color,Precio,"Imagen Principal",OfertaActiva,PrecioOferta';

// ─── Fetcher: config + products ───────────────────────────────────────────────

async function fetchCuratedBanner(): Promise<{
  config: CuratedBannerConfig;
  cards: CuratedVariantCard[];
} | null> {
  const supabase = getSupabaseBrowserClient();

  // 1. Fetch the first enabled banner with tag_value = "__curated__"
  const { data: config, error: cfgErr } = await supabase
    .from("custom_product_banners")
    .select(
      `id, title, slug, description, enabled, sort_order, tag_value,
       custom_product_banner_items ( product_variant_id, position )`
    )
    .eq("enabled", true)
    .eq("tag_value", DYNAMIC_TAG)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (cfgErr || !config) return null;

  const items: { product_variant_id: string; position: number }[] =
    ((config as any).custom_product_banner_items ?? [])
      .slice()
      .sort(
        (
          a: { position: number },
          b: { position: number }
        ) => (a.position ?? 0) - (b.position ?? 0)
      );

  if (items.length === 0) return null;

  const variantIds = items
    .map((i) => i.product_variant_id)
    .filter(Boolean);

  // 2. Fetch the actual product data for those variant IDs
  const { data: rows, error: rowErr } = await supabase
    .from(CATALOG_SOURCE)
    .select(VARIANT_SELECT)
    .in("variant_id", variantIds);

  if (rowErr || !rows || rows.length === 0) return null;

  // Deduplicate by variant_id (view may return multiple rows per variant, one per size)
  const seen = new Set<string>();
  const unique = (rows as any[]).filter((r) => {
    if (seen.has(r.variant_id)) return false;
    seen.add(r.variant_id);
    return true;
  });

  // Re-sort to match the curated position order
  const idxMap = new Map(variantIds.map((id, i) => [id, i]));
  const sorted = unique.sort(
    (a, b) =>
      (idxMap.get(a.variant_id) ?? 999) -
      (idxMap.get(b.variant_id) ?? 999)
  );

  return {
    config: config as unknown as CuratedBannerConfig,
    cards: sorted as unknown as CuratedVariantCard[],
  };
}

// ─── Card components ──────────────────────────────────────────────────────────

function VariantCard({ card }: { card: CuratedVariantCard }) {
  const imageSrc = resolveImageSrc(card["Imagen Principal"] as any);
  const precio =
    card.OfertaActiva && card.PrecioOferta ? card.PrecioOferta : card.Precio;

  return (
    <Link
      href={`/producto/${encodeURIComponent(card.Articulo)}`}
      className="custom-banner-card"
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <div style={{ position: "relative", width: "100%", height: 110 }}>
        {imageSrc ? (
          <Image
            src={imageSrc}
            alt={card.Articulo}
            fill
            sizes="110px"
            style={{ objectFit: "cover" }}
          />
        ) : (
          <div
            className="skeleton-shimmer"
            style={{ width: "100%", height: "100%" }}
          />
        )}
        <div className="custom-banner-badge">{card.Articulo}</div>
      </div>
      <div className="custom-banner-card-content">
        <div className="custom-banner-card-price">{formatARS(precio)}</div>
      </div>
    </Link>
  );
}

function SkeletonCards() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="custom-banner-card"
          style={{ pointerEvents: "none" }}
          aria-hidden="true"
        >
          <div className="skeleton-shimmer" style={{ width: "100%", height: 110 }} />
          <div className="custom-banner-card-content">
            <div
              className="skeleton-shimmer"
              style={{ width: "60%", height: 14, borderRadius: 4 }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function CuratedBanner() {
  const { data, isLoading } = useSWR("curated-banner", fetchCuratedBanner, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 300_000,
  });

  if (!isLoading && !data) return null;

  const config = data?.config;
  const cards = data?.cards ?? [];
  const verTodoHref = config
    ? `/banner/${encodeURIComponent(config.slug)}`
    : "#";

  return (
    <div className="custom-banner-wrapper">
      <div className="custom-banner-container" style={{ display: "block" }}>
        <div className="custom-banner-header">
          <h2 className="custom-banner-title">
            {config?.title ?? (
              <span className="skeleton-shimmer" style={{ display: "inline-block", width: 140, height: 20 }} />
            )}
          </h2>
          {config && (
            <Link
              href={verTodoHref}
              className="custom-banner-ver-todo-btn"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                color: "#CD844D",
                textDecoration: "none",
                fontSize: "0.9rem",
                fontWeight: 500,
              }}
            >
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

        <div className="custom-banner-scroll">
          {isLoading ? (
            <SkeletonCards />
          ) : (
            cards.map((card) => (
              <VariantCard key={card.variant_id} card={card} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
