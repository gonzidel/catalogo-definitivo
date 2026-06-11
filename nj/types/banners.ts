import type { ColorDetail } from "@/types/catalog";

export interface PromotionalBannerData {
  id: string;
  text: string;
  link: string;
  link_type: "url" | "category" | "tag";
  enabled: boolean;
  order: number;
}

export interface CuratedBannerItem {
  product_variant_id: string;
  position: number;
}

export interface CuratedBannerConfig {
  id: string;
  title: string;
  slug: string;
  description: string;
  enabled: boolean;
  sort_order: number;
  tag_value: string;
  custom_product_banner_items?: CuratedBannerItem[];
}

/** Producto individual de variante (usado en banners __curated__) */
export interface CuratedVariantCard {
  variant_id: string;
  Articulo: string;
  Descripcion: string;
  Color: string;
  Precio: number;
  "Imagen Principal": string | null;
  OfertaActiva: boolean;
  PrecioOferta: number | null;
  ColorHex?: string | null;
}

export type CuratedVariantCardEnriched = CuratedVariantCard & {
  colors: ColorDetail[];
};
