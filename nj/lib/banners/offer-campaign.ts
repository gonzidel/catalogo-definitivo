import { getPublicCatalogClient } from "@/lib/supabase/public-catalog";
import {
  CATALOG_AVAILABLE_VIEW,
  CATALOG_SELECT,
  CATALOG_SOURCE,
  agruparProductos,
} from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";

const CAMPAIGN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOfferCampaignId(value: string): boolean {
  return CAMPAIGN_ID_RE.test(value.trim());
}

async function loadCampaignRows(source: string, campaignId: string): Promise<CatalogRow[]> {
  const { data, error } = await getPublicCatalogClient()
    .from(source)
    .select(CATALOG_SELECT)
    .eq("OfferCampaignId", campaignId)
    .eq("OfertaActiva", true)
    .limit(500);
  if (error || !data) return [];
  return data as unknown as CatalogRow[];
}

/**
 * Productos vigentes de una campaña. null si el id no es un uuid.
 * Sin filas: la oferta venció o no existe; la página muestra vacío, no el catálogo entero.
 */
export async function fetchOfferCampaignProducts(
  campaignId: string
): Promise<{ title: string; products: GroupedProduct[] } | null> {
  const id = campaignId.trim();
  if (!isOfferCampaignId(id)) return null;

  let rows = await loadCampaignRows(CATALOG_SOURCE, id);
  if (rows.length === 0) rows = await loadCampaignRows(CATALOG_AVAILABLE_VIEW, id);

  const title =
    rows.map((row) => String(row.OfferTitle ?? "").trim()).find(Boolean) || "Oferta";
  return { title, products: agruparProductos(rows) };
}
