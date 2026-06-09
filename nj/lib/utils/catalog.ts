import type { CatalogRow, GroupedProduct, ColorDetail, CatalogImage } from "@/types/catalog";

// ─── Constants ────────────────────────────────────────────────────────────────

export const CATALOG_SOURCE = "catalog_public_snapshot";
export const CATALOG_AVAILABLE_VIEW = "catalog_public_available_view";

export const CATALOG_SELECT =
  '"Categoria","Articulo","Descripcion","Color","Numeracion","FechaIngreso","FechaPublicacion","Mostrar","Oferta","Precio","Imagen Principal","Imagen 1","Imagen 2","Imagen 3","Filtro1","Filtro2","Filtro3","OfertaActiva","PrecioOferta","PromoActiva","OfferCampaignId","OfferImageUrl","OfferTitle","ColorHex","ColorDisplayNumber","SupplierCode"';

export const CATEGORIAS_MAP: Record<string, string> = {
  calzado: "Calzado",
  ropa: "Ropa",
  lenceria: "Lenceria",
  marroquineria: "Marroquineria",
  novedades: "Novedades",
  ofertas: "Ofertas",
};

export const CATEGORIA_SLUGS = Object.keys(CATEGORIAS_MAP);

export function slugToCategoria(slug: string): string | null {
  return CATEGORIAS_MAP[slug.toLowerCase()] ?? null;
}

export function categoriaToSlug(cat: string): string {
  return cat.toLowerCase();
}

// ─── Group raw rows by Articulo ───────────────────────────────────────────────

function getColorKey(color: string): string {
  return String(color || "Sin color").trim().toLowerCase();
}

function mergeColorDetail(target: ColorDetail, source: ColorDetail): void {
  source.talles.forEach((t) => {
    if (t && !target.talles.includes(t)) target.talles.push(t);
  });
  source.images.forEach((img) => {
    if (img && !target.images.includes(img)) target.images.push(img);
  });
  if (source.OfertaActiva) target.OfertaActiva = true;
  if (!target.PrecioOferta && source.PrecioOferta)
    target.PrecioOferta = source.PrecioOferta;
  if (!target.PromoActiva && source.PromoActiva)
    target.PromoActiva = source.PromoActiva;
}

export function agruparProductos(rows: CatalogRow[]): GroupedProduct[] {
  if (!rows || rows.length === 0) return [];

  const grupos: Record<string, GroupedProduct> = {};

  for (const row of rows) {
    const art = row.Articulo?.trim();
    if (!art) continue;

    if (!grupos[art]) {
      grupos[art] = {
        Articulo: art,
        Descripcion: row.Descripcion ?? "",
        Precio: row.Precio ?? "",
        VariantePrincipal: row["Imagen Principal"],
        Oferta: row.Oferta ?? "",
        FechaIngreso: row.FechaIngreso ?? "",
        FechaPublicacion: row.FechaPublicacion ?? "",
        Categoria: row.Categoria ?? "",
        Filtro1: row.Filtro1 ?? "",
        Filtro2: row.Filtro2 ?? "",
        Filtro3: row.Filtro3 ?? "",
        DetallesSimilitud: "",
        OfertaActiva: false,
        PrecioOferta: "",
        PromoActiva: "",
        SupplierCode: row.SupplierCode ?? "",
        DetalleColor: [],
      };
    }

    const g = grupos[art];

    if (row.OfertaActiva === true || row.OfertaActiva === "true") {
      g.OfertaActiva = true;
      if (!g.PrecioOferta && row.PrecioOferta) g.PrecioOferta = row.PrecioOferta;
    }
    if (row.PromoActiva) g.PromoActiva = row.PromoActiva;

    const images: CatalogImage[] = [
      row["Imagen Principal"],
      row["Imagen 1"],
      row["Imagen 2"],
      row["Imagen 3"],
    ].filter(Boolean) as CatalogImage[];

    const colorDetail: ColorDetail = {
      color: (row.Color ?? "Sin color").trim(),
      hex_color: row.ColorHex ?? null,
      ColorDisplayNumber: row.ColorDisplayNumber ?? null,
      talles: row.Numeracion
        ? row.Numeracion.split(",").map((t) => t.trim()).filter(Boolean)
        : ["Único"],
      images,
      OfertaActiva: row.OfertaActiva === true || row.OfertaActiva === "true",
      PrecioOferta: row.PrecioOferta ?? "",
      PromoActiva: row.PromoActiva ?? "",
    };

    const colorKey = getColorKey(colorDetail.color);
    const existing = g.DetalleColor.find(
      (d) => getColorKey(d.color) === colorKey
    );
    if (existing) {
      mergeColorDetail(existing, colorDetail);
    } else {
      g.DetalleColor.push(colorDetail);
    }

    // Keep most recent FechaPublicacion
    if (
      row.FechaPublicacion &&
      row.FechaPublicacion > (g.FechaPublicacion ?? "")
    ) {
      g.FechaPublicacion = row.FechaPublicacion;
    }
  }

  // Sort DetalleColor: first by ColorDisplayNumber (explicit ordering), then by
  // number of talles descending (most complete variant first), then alphabetically.
  const result = Object.values(grupos);
  for (const g of result) {
    g.DetalleColor.sort((a, b) => {
      const na = a.ColorDisplayNumber;
      const nb = b.ColorDisplayNumber;
      if (na !== null && nb !== null) return na - nb;
      if (na !== null) return -1;
      if (nb !== null) return 1;
      // Both null: prefer the color with more talles (more complete)
      const diff = b.talles.length - a.talles.length;
      if (diff !== 0) return diff;
      return a.color.localeCompare(b.color);
    });
  }
  return result;
}

// ─── Intercalado por categoría (patrón 3/2/3/2/2/2) ─────────────────────────

export function intercalarProductos(productos: GroupedProduct[]): GroupedProduct[] {
  const sort = (arr: GroupedProduct[]) =>
    [...arr].sort((a, b) =>
      (b.FechaPublicacion ?? "") > (a.FechaPublicacion ?? "") ? 1 : -1
    );

  const calzado = sort(
    productos.filter((p) => p.Categoria.trim().toLowerCase() === "calzado")
  );
  const ropa = sort(
    productos.filter((p) => p.Categoria.trim().toLowerCase() === "ropa")
  );
  const marroquineria = sort(
    productos.filter(
      (p) =>
        p.Categoria.trim().toLowerCase() === "otros" &&
        (p.Filtro1 ?? "").trim().toLowerCase() === "marroquineria"
    )
  );
  const lenceria = sort(
    productos.filter(
      (p) =>
        p.Categoria.trim().toLowerCase() === "otros" &&
        (p.Filtro1 ?? "").trim().toLowerCase() === "lenceria"
    )
  );
  const resto = sort(
    productos.filter(
      (p) =>
        !["calzado", "ropa"].includes(p.Categoria.trim().toLowerCase()) &&
        !marroquineria.includes(p) &&
        !lenceria.includes(p)
    )
  );

  // Pattern: 3 calzado, 2 ropa, 3 calzado, 2 marroquineria, 2 calzado, 2 lenceria
  const result: GroupedProduct[] = [];
  let ic = 0, ir = 0, im = 0, il = 0, ie = 0;

  while (
    ic < calzado.length ||
    ir < ropa.length ||
    im < marroquineria.length ||
    il < lenceria.length ||
    ie < resto.length
  ) {
    const prevLen = result.length;

    for (let i = 0; i < 3 && ic < calzado.length; i++) result.push(calzado[ic++]);
    for (let i = 0; i < 2 && ir < ropa.length; i++) result.push(ropa[ir++]);
    for (let i = 0; i < 3 && ic < calzado.length; i++) result.push(calzado[ic++]);
    for (let i = 0; i < 2 && im < marroquineria.length; i++) result.push(marroquineria[im++]);
    for (let i = 0; i < 2 && ic < calzado.length; i++) result.push(calzado[ic++]);
    for (let i = 0; i < 2 && il < lenceria.length; i++) result.push(lenceria[il++]);
    for (let i = 0; i < 2 && ie < resto.length; i++) result.push(resto[ie++]);

    if (result.length === prevLen) break; // safety: avoid infinite loop
  }

  return result;
}

// ─── Price formatting ─────────────────────────────────────────────────────────

export function formatARS(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = typeof value === "string" ? parseFloat(value.replace(/[^\d.]/g, "")) : Number(value);
  if (isNaN(n)) return String(value);
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}
