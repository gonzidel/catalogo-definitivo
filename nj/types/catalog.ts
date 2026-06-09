// ─── Raw row from catalog_public_snapshot / catalog_public_available_view ────

export type CatalogImage =
  | string
  | { public_id: string; url?: string; secure_url?: string }
  | null;

export interface CatalogRow {
  Categoria: string;
  Articulo: string;
  Descripcion: string;
  Color: string;
  Numeracion: string | null;
  FechaIngreso: string | null;
  FechaPublicacion: string | null;
  Mostrar: boolean | null;
  Oferta: string | null;
  Precio: number | string | null;
  "Imagen Principal": CatalogImage;
  "Imagen 1": CatalogImage;
  "Imagen 2": CatalogImage;
  "Imagen 3": CatalogImage;
  Filtro1: string | null;
  Filtro2: string | null;
  Filtro3: string | null;
  OfertaActiva: boolean | string | null;
  PrecioOferta: string | null;
  PromoActiva: string | null;
  OfferCampaignId: string | null;
  OfferImageUrl: string | null;
  OfferTitle: string | null;
  ColorHex: string | null;
  ColorDisplayNumber: number | null;
  SupplierCode: string | null;
}

// ─── Grouped product (one per Articulo) ──────────────────────────────────────

export interface ColorDetail {
  color: string;
  hex_color: string | null;
  ColorDisplayNumber: number | null;
  talles: string[];
  images: CatalogImage[];
  OfertaActiva: boolean;
  PrecioOferta: string;
  PromoActiva: string;
}

export interface GroupedProduct {
  Articulo: string;
  Descripcion: string;
  Precio: number | string | null;
  VariantePrincipal: CatalogImage;
  Oferta: string;
  FechaIngreso: string;
  FechaPublicacion: string;
  Categoria: string;
  Filtro1: string;
  Filtro2: string;
  Filtro3: string;
  DetallesSimilitud: string;
  OfertaActiva: boolean;
  PrecioOferta: string;
  PromoActiva: string;
  DetalleColor: ColorDetail[];
  CommercialTags?: string[];
  SupplierCode?: string;
  // enriched with stock (optional — not in read-only phase)
  variantDetails?: VariantDetail[];
}

export interface VariantDetail {
  sku: string;
  talle: string;
  available: number | null;
  variantId: string;
  color: string;
}

// ─── PDP ─────────────────────────────────────────────────────────────────────

export interface PdpVariantSize {
  id: string;
  size: string;
  stock_qty: number;
  sku: string;
}

export interface PdpVariant {
  id: string;
  color: string;
  sku: string;
  price: number | null;
  images: CatalogImage[];
  sizes: PdpVariantSize[];
}

export interface PdpProduct extends GroupedProduct {
  variants: PdpVariant[];
}

// ─── Catalog query params ─────────────────────────────────────────────────────

export type CatalogCategoria =
  | "all"
  | "Calzado"
  | "Ropa"
  | "Lenceria"
  | "Marroquineria"
  | "Novedades"
  | "Ofertas";

export interface CatalogSearchParams {
  categoria?: string;
  talle?: string;
  q?: string;
  page?: string;
}
