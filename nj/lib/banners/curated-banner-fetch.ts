import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  CATALOG_AVAILABLE_VIEW,
  CATALOG_SOURCE,
  CATALOG_SELECT,
  agruparProductos,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct, ColorDetail } from "@/types/catalog";
import type { CuratedBannerConfig, CuratedVariantCard, CuratedVariantCardEnriched } from "@/types/banners";
import { CURATED_PUBLIC_TAGS, CURATED_TAG } from "@/lib/banners/curated-banner-tags";

export const CURATED_VARIANT_SELECT =
  'variant_id,Articulo,Descripcion,Color,Precio,"Imagen Principal",OfertaActiva,PrecioOferta,ColorHex';

export async function fetchCuratedVariantCards(
  variantIds: string[],
  supabase: SupabaseClient = getSupabaseBrowserClient()
): Promise<CuratedVariantCard[]> {
  if (variantIds.length === 0) return [];

  const { data: snapshotRows, error: snapshotErr } = await supabase
    .from(CATALOG_SOURCE)
    .select(CURATED_VARIANT_SELECT)
    .in("variant_id", variantIds);

  let rows = snapshotErr ? [] : (snapshotRows ?? []);
  const found = new Set(rows.map((r) => r.variant_id as string));
  const missing = variantIds.filter((id) => !found.has(id));

  if (missing.length > 0) {
    const { data: liveRows } = await supabase
      .from(CATALOG_AVAILABLE_VIEW)
      .select(CURATED_VARIANT_SELECT)
      .in("variant_id", missing);
    if (liveRows?.length) {
      rows = [...rows, ...liveRows];
    }
  }

  const byVariant = new Map<string, CuratedVariantCard>();
  for (const row of rows) {
    const id = String(row.variant_id ?? "");
    if (!id || byVariant.has(id)) continue;
    if (!row["Imagen Principal"]) continue;
    byVariant.set(id, row as unknown as CuratedVariantCard);
  }

  const cards: CuratedVariantCard[] = [];
  for (const id of variantIds) {
    const card = byVariant.get(id);
    if (card) cards.push(card);
  }
  return cards;
}

export async function enrichCuratedCardsWithProductColors(
  cards: CuratedVariantCard[],
  supabase: SupabaseClient = getSupabaseBrowserClient()
): Promise<CuratedVariantCardEnriched[]> {
  if (cards.length === 0) return [];

  const articulos = collectArticulosInBannerOrder(cards);
  const { data: snapshotRows } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .in("Articulo", articulos);

  let rows = (snapshotRows ?? []) as unknown as CatalogRow[];
  const foundArts = new Set(rows.map((r) => String(r.Articulo ?? "").trim().toLowerCase()));
  const missingArts = articulos.filter((a) => !foundArts.has(a.toLowerCase()));

  if (missingArts.length > 0) {
    const { data: liveRows } = await supabase
      .from(CATALOG_AVAILABLE_VIEW)
      .select(CATALOG_SELECT)
      .in("Articulo", missingArts);
    if (liveRows?.length) {
      rows = [...rows, ...(liveRows as unknown as CatalogRow[])];
    }
  }

  const grouped = agruparProductos(rows);
  const colorsByArticulo = new Map(
    grouped.map((p) => [p.Articulo.trim().toLowerCase(), p.DetalleColor ?? []])
  );

  return cards.map((card) => {
    const key = card.Articulo.trim().toLowerCase();
    const colors = colorsByArticulo.get(key);
    if (colors?.length) {
      return { ...card, colors };
    }
    const fallback: ColorDetail[] = card.Color
      ? [
          {
            color: card.Color,
            hex_color: card.ColorHex ?? null,
            ColorDisplayNumber: null,
            talles: [],
            images: [],
            OfertaActiva: card.OfertaActiva,
            PrecioOferta: card.PrecioOferta ? String(card.PrecioOferta) : "",
            PromoActiva: "",
          },
        ]
      : [];
    return { ...card, colors: fallback };
  });
}

export function collectArticulosInBannerOrder(cards: CuratedVariantCard[]): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    const art = String(card.Articulo ?? "").trim();
    if (!art || seen.has(art)) continue;
    seen.add(art);
    ordered.push(art);
  }
  return ordered;
}

export async function fetchCuratedGroupedProductsBySlug(
  supabase: SupabaseClient,
  slug: string,
  tagValue?: string
): Promise<{ config: CuratedBannerConfig; products: GroupedProduct[] } | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  let query = supabase
    .from("custom_product_banners")
    .select(
      `id, title, slug, description, enabled, sort_order, tag_value,
       custom_product_banner_items ( product_variant_id, position )`
    )
    .eq("slug", normalized);

  if (tagValue) {
    query = query.eq("tag_value", tagValue);
  } else {
    query = query.in("tag_value", [...CURATED_PUBLIC_TAGS]);
  }

  const { data: config, error } = await query.maybeSingle();

  if (error || !config) return null;

  const items = (
    (config as CuratedBannerConfig).custom_product_banner_items ?? []
  )
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const variantIds = items.map((i) => i.product_variant_id).filter(Boolean);
  const cards = await fetchCuratedVariantCards(variantIds, supabase);
  const articulos = collectArticulosInBannerOrder(cards);
  if (articulos.length === 0) {
    return { config: config as CuratedBannerConfig, products: [] };
  }

  const { data: catalogRows } = await supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .in("Articulo", articulos);

  let rows = (catalogRows ?? []) as unknown as CatalogRow[];
  const foundArts = new Set(rows.map((r) => String(r.Articulo ?? "").trim().toLowerCase()));
  const missingArts = articulos.filter((a) => !foundArts.has(a.toLowerCase()));

  if (missingArts.length > 0) {
    const { data: liveRows } = await supabase
      .from(CATALOG_AVAILABLE_VIEW)
      .select(CATALOG_SELECT)
      .in("Articulo", missingArts);
    if (liveRows?.length) {
      rows = [...rows, ...(liveRows as unknown as CatalogRow[])];
    }
  }

  const grouped = agruparProductos(rows);
  const order = new Map(articulos.map((art, i) => [art.toLowerCase(), i]));
  grouped.sort(
    (a, b) =>
      (order.get(a.Articulo.toLowerCase()) ?? 999) -
      (order.get(b.Articulo.toLowerCase()) ?? 999)
  );

  return {
    config: config as CuratedBannerConfig,
    products: grouped,
  };
}
