import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import {
  CATALOG_AVAILABLE_VIEW,
  CATALOG_SELECT,
  CATALOG_SOURCE,
  agruparProductos,
  catalogFeedBucket,
  colorDetailHasImage,
} from "@/lib/utils/catalog";
import { catalogRecencyMs } from "@/lib/banners/catalog-dates";
import {
  HOME_FEATURE_FLAGS_TABLE,
  HOME_OFFERS_BANNER_FLAG,
  offersBannerPreviewOverride,
} from "@/lib/banners/home-feature-flags";
import { fetchBannerPromotionPosters } from "@/lib/banners/banner-promotions";
import { fetchActivePromoPosters } from "@/lib/banners/promo-posters";
import { colorIsPurchasable } from "@/lib/stock/catalog-availability";
import { getColorEffectivePrice } from "@/lib/utils/variant-price";
import type { CatalogRow, ColorDetail, GroupedProduct } from "@/types/catalog";

/** Cantidad de productos que van primero, ordenados por publicación/actualización más reciente. */
export const OFERTAS_BANNER_TOP_RECENT = 5;
/** Tope de productos del carrusel. */
export const OFERTAS_BANNER_LIMIT = 24;
/** Filas de color a leer (hoy ~55 con oferta; margen amplio). */
const OFERTAS_BANNER_FETCH_ROWS = 500;

/** Un afiche de campaña: una imagen por oferta, aunque tenga varios colores. */
export type OfertaCampaignBanner = {
  campaignId: string;
  imageUrl: string;
  title: string;
  recencyMs: number;
  href: string;
};

/** Carrusel del inicio: afiches de campaña primero, después las tarjetas de producto. */
export type OfertasBannerFeed = {
  campaigns: OfertaCampaignBanner[];
  items: OfertaBannerItem[];
};

/** Un producto del banner: el artículo, el color EN OFERTA que se muestra y su recencia. */
export type OfertaBannerItem = {
  product: GroupedProduct;
  color: ColorDetail;
  /** Precio de oferta vigente del color mostrado. */
  price: number;
  /** Última publicación/actualización del color en oferta (ms epoch). */
  recencyMs: number;
};

function articuloKey(articulo: string): string {
  return articulo.trim().toLowerCase();
}

function colorKey(color: string): string {
  return String(color ?? "").trim().toLowerCase();
}

function offerRowActive(row: CatalogRow): boolean {
  return row.OfertaActiva === true || row.OfertaActiva === "true";
}

/**
 * Una tarjeta por campaña que tenga imagen. Varios colores de la misma oferta
 * no duplican el afiche. Orden: la campaña tocada más reciente primero.
 */
export function buildOfertaCampaignBanners(rows: CatalogRow[]): OfertaCampaignBanner[] {
  const map = new Map<string, OfertaCampaignBanner>();
  for (const row of rows) {
    if (!offerRowActive(row)) continue;
    const campaignId = String(row.OfferCampaignId ?? "").trim();
    const imageUrl = String(row.OfferImageUrl ?? "").trim();
    if (!campaignId || !imageUrl) continue;
    const key = campaignId.toLowerCase();
    const recencyMs = catalogRecencyMs(row);
    const title = String(row.OfferTitle ?? "").trim();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        campaignId,
        imageUrl,
        title: title || "Oferta",
        recencyMs,
        href: `/ofertas/campana/${encodeURIComponent(campaignId)}`,
      });
      continue;
    }
    if (recencyMs >= existing.recencyMs) {
      existing.recencyMs = recencyMs;
      existing.imageUrl = imageUrl;
      existing.campaignId = campaignId;
      existing.href = `/ofertas/campana/${encodeURIComponent(campaignId)}`;
      if (title) existing.title = title;
    } else if (title && existing.title === "Oferta") {
      existing.title = title;
    }
  }
  return [...map.values()].sort((a, b) => {
    const diff = b.recencyMs - a.recencyMs;
    return diff !== 0 ? diff : a.campaignId.localeCompare(b.campaignId);
  });
}

function campaignIdByColor(rows: CatalogRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.OfferCampaignId ?? "").trim().toLowerCase();
    const art = row.Articulo?.trim();
    if (!id || !art) continue;
    map.set(`${articuloKey(art)}|${colorKey(row.Color)}`, id);
  }
  return map;
}

/**
 * Recencia por color en oferta, desde las filas crudas (una por color).
 * `GroupedProduct.FechaPublicacion` es el máximo de TODOS los colores del artículo, así que
 * una republicación de un color sin oferta no debe adelantar al artículo en este banner.
 */
export function buildOfferRecencyByColor(rows: CatalogRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    const offerActive = row.OfertaActiva === true || row.OfertaActiva === "true";
    if (!offerActive) continue;
    const art = row.Articulo?.trim();
    if (!art) continue;
    const key = `${articuloKey(art)}|${colorKey(row.Color)}`;
    const ms = catalogRecencyMs(row);
    map.set(key, Math.max(map.get(key) ?? 0, ms));
  }
  return map;
}

/**
 * Elige el color a mostrar: SOLO colores con oferta vigente, imagen y stock/precio vendible.
 * No usar `pickDisplayColorDetail`: elige el primer color comprable aunque no esté en oferta
 * y el banner terminaría mostrando un precio normal.
 * Entre varios colores en oferta gana el más recientemente publicado; el orden de
 * visualización del artículo (ya ordenado en `agruparProductos`) desempata.
 */
export function pickOfferColor(
  product: GroupedProduct,
  recencyByColor: Map<string, number>
): { color: ColorDetail; price: number; recencyMs: number } | null {
  let best: { color: ColorDetail; price: number; recencyMs: number } | null = null;

  for (const color of product.DetalleColor ?? []) {
    if (!colorDetailHasImage(color)) continue;
    if (!colorIsPurchasable(color)) continue;
    const pricing = getColorEffectivePrice(color, product);
    if (!pricing.isOffer || pricing.effectivePrice <= 0) continue;

    const recencyMs =
      recencyByColor.get(`${articuloKey(product.Articulo)}|${colorKey(color.color)}`) ??
      catalogRecencyMs(product);
    if (!best || recencyMs > best.recencyMs) {
      best = { color, price: pricing.effectivePrice, recencyMs };
    }
  }

  return best;
}

/**
 * Orden del banner:
 *  1. Los `topRecent` más recientes (publicados o actualizados), de más nuevo a más viejo.
 *  2. El resto mezclado por categoría Calzado/Ropa/Otros (round-robin determinístico,
 *     cada categoría de más nuevo a más viejo) para dar variedad sin aleatoriedad (SSR/SWR estables).
 */
export function orderOfertasBannerItems(
  items: OfertaBannerItem[],
  options: { topRecent?: number; limit?: number } = {}
): OfertaBannerItem[] {
  const topRecent = options.topRecent ?? OFERTAS_BANNER_TOP_RECENT;
  const limit = options.limit ?? OFERTAS_BANNER_LIMIT;

  const byRecency = [...items].sort((a, b) => {
    const diff = b.recencyMs - a.recencyMs;
    return diff !== 0 ? diff : a.product.Articulo.localeCompare(b.product.Articulo);
  });

  const head = byRecency.slice(0, topRecent);
  const tail = byRecency.slice(topRecent);

  const buckets = new Map<string, OfertaBannerItem[]>();
  for (const item of tail) {
    const bucket = catalogFeedBucket(item.product);
    const list = buckets.get(bucket) ?? [];
    list.push(item);
    buckets.set(bucket, list);
  }

  const lists = ["Calzado", "Ropa", "Otros"].map((b) => buckets.get(b) ?? []);
  const mixed: OfertaBannerItem[] = [];
  const idx = lists.map(() => 0);
  let pickedAny = true;
  while (pickedAny) {
    pickedAny = false;
    lists.forEach((list, i) => {
      if (idx[i] < list.length) {
        mixed.push(list[idx[i]++]);
        pickedAny = true;
      }
    });
  }

  return [...head, ...mixed].slice(0, limit);
}

/** Filas del catálogo → items del banner (agrupa, filtra a color en oferta, ordena y recorta). */
export function buildOfertasBannerItems(
  rows: CatalogRow[],
  options: { topRecent?: number; limit?: number } = {}
): OfertaBannerItem[] {
  if (rows.length === 0) return [];
  const recencyByColor = buildOfferRecencyByColor(rows);
  const imagedCampaigns = new Set(
    buildOfertaCampaignBanners(rows).map((campaign) => campaign.campaignId.toLowerCase())
  );
  const campaignOfColor = campaignIdByColor(rows);
  const eligible: OfertaBannerItem[] = [];

  for (const product of agruparProductos(rows)) {
    const colors = (product.DetalleColor ?? []).filter((color) => {
      const campaignId = campaignOfColor.get(
        `${articuloKey(product.Articulo)}|${colorKey(color.color)}`
      );
      return !campaignId || !imagedCampaigns.has(campaignId);
    });
    const picked = pickOfferColor({ ...product, DetalleColor: colors }, recencyByColor);
    if (picked) eligible.push({ product, ...picked });
  }

  return orderOfertasBannerItems(eligible, options);
}

/**
 * Flag del admin. Falla CERRADO: error de red, tabla inexistente (migración 383 pendiente),
 * fila ausente o `enabled = false` → el banner no se muestra.
 */
export async function fetchHomeOffersBannerEnabled(
  supabase: SupabaseClient
): Promise<boolean> {
  if (offersBannerPreviewOverride()) return true;
  const { data, error } = await supabase
    .from(HOME_FEATURE_FLAGS_TABLE)
    .select("enabled")
    .eq("key", HOME_OFFERS_BANNER_FLAG)
    .maybeSingle();
  if (error) return false;
  return data?.enabled === true;
}

async function loadOfferRows(
  supabase: SupabaseClient,
  source: string
): Promise<CatalogRow[]> {
  const { data, error } = await supabase
    .from(source)
    .select(CATALOG_SELECT)
    .eq("OfertaActiva", true)
    .order("FechaPublicacion", { ascending: false, nullsFirst: false })
    .limit(OFERTAS_BANNER_FETCH_ROWS);
  if (error || !data) return [];
  return data as unknown as CatalogRow[];
}

/** Afiches + tarjetas a partir de las mismas filas del catálogo. */
export function buildOfertasBannerFeed(rows: CatalogRow[]): OfertasBannerFeed {
  return {
    campaigns: buildOfertaCampaignBanners(rows),
    items: buildOfertasBannerItems(rows),
  };
}

/** Carrusel del inicio: flag activo + ofertas vigentes. Snapshot primero; vista viva si el snapshot no trae ofertas. */
export async function fetchOfertasDestacadas(): Promise<OfertasBannerFeed> {
  const supabase = getSupabaseBrowserClient();
  if (!(await fetchHomeOffersBannerEnabled(supabase))) return { campaigns: [], items: [] };

  let rows = await loadOfferRows(supabase, CATALOG_SOURCE);
  if (rows.length === 0) rows = await loadOfferRows(supabase, CATALOG_AVAILABLE_VIEW);
  const feed = buildOfertasBannerFeed(rows);
  const [promos, bannerPromos] = await Promise.all([
    fetchActivePromoPosters(supabase),
    fetchBannerPromotionPosters(supabase),
  ]);
  return {
    campaigns: [
      ...bannerPromos.map((promo) => ({
        campaignId: promo.id,
        imageUrl: promo.imageUrl,
        title: promo.title,
        recencyMs: promo.recencyMs,
        href: `/ofertas/promocion/${encodeURIComponent(promo.id)}`,
      })),
      ...promos.map((promo) => ({
        campaignId: promo.id,
        imageUrl: promo.imageUrl,
        title: promo.title,
        recencyMs: promo.recencyMs,
        href: `/ofertas/promo/${encodeURIComponent(promo.id)}`,
      })),
      ...feed.campaigns,
    ],
    items: feed.items,
  };
}
