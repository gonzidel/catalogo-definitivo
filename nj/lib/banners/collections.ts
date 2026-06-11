import type { SupabaseClient } from "@supabase/supabase-js";
import type { GroupedProduct } from "@/types/catalog";
import { fetchFylOriginalsAll } from "@/lib/banners/fyl-originals";
import { fetchNuevosIngresosCollection } from "@/lib/banners/nuevos-ingresos";

export const COLLECTION_SLUGS = ["fyl-originals", "nuevos-ingresos"] as const;
export type CollectionSlug = (typeof COLLECTION_SLUGS)[number];

export interface CollectionMeta {
  title: string;
  subtitle: string;
}

export const COLLECTION_META: Record<CollectionSlug, CollectionMeta> = {
  "fyl-originals": {
    title: "F&L Originals",
    subtitle: "Fabricación propia",
  },
  "nuevos-ingresos": {
    title: "Nuevos ingresos",
    subtitle: "Primera publicación · últimos 7 días",
  },
};

export function isCollectionSlug(slug: string): slug is CollectionSlug {
  return (COLLECTION_SLUGS as readonly string[]).includes(slug);
}

export async function fetchCollectionProducts(
  supabase: SupabaseClient,
  slug: CollectionSlug
): Promise<GroupedProduct[]> {
  switch (slug) {
    case "fyl-originals":
      return fetchFylOriginalsAll(supabase);
    case "nuevos-ingresos":
      return fetchNuevosIngresosCollection(supabase);
    default:
      return [];
  }
}
