/**
 * Recortes reales de catalog_public_snapshot (2026-09-03).
 * Sirven para ranking/selftest, no son el catálogo completo.
 */
import type { GroupedProduct } from "../../types/catalog";

interface FixtureRow {
  Articulo: string;
  Descripcion: string;
  Filtro1: string;
  Filtro2: string;
  Filtro3?: string;
  Categoria: string;
  DetallesSimilitud?: string;
  FechaPublicacion?: string;
  colors: string;
  hasAnyStock?: boolean;
}

const ROWS: FixtureRow[] = [
  { Articulo: "122", Descripcion: "Pantubota con peluche", Filtro1: "Pantubota", Filtro2: "Bajas", Categoria: "Calzado", DetallesSimilitud: "Peluche", FechaPublicacion: "2026-07-02T11:37:54.992Z", colors: "Suela" },
  { Articulo: "BOTON", Descripcion: "Pantubota con corderito y boton", Filtro1: "Pantubota", Filtro2: "Bajas", Filtro3: "Frio", Categoria: "Calzado", DetallesSimilitud: "Frio,Peluche", FechaPublicacion: "2026-07-18T03:06:09.105Z", colors: "suela" },
  { Articulo: "PA22", Descripcion: "", Filtro1: "Pantubota", Filtro2: "Caña alta", Categoria: "Calzado", FechaPublicacion: "2026-08-22T12:24:35.255Z", colors: "Negro" },
  { Articulo: "PANT2", Descripcion: "Pantufla base de eva", Filtro1: "Pantufla", Filtro2: "Corderito", Categoria: "Calzado", DetallesSimilitud: "Frio", FechaPublicacion: "2026-08-13T19:54:57.756Z", colors: "Gris|Rosa" },
  { Articulo: "CONF", Descripcion: "Pantufla peluche super liviana Gummi", Filtro1: "Pantufla", Filtro2: "Corderito", Categoria: "Calzado", FechaPublicacion: "2026-07-21T02:45:00.412Z", colors: "Negro|Rosa" },
  { Articulo: "R2360", Descripcion: "Buzo corderoy", Filtro1: "Buzo", Filtro2: "Con peluche", Categoria: "Ropa", colors: "Beige" },
  { Articulo: "107", Descripcion: "Zapatilla de cuero vacuno", Filtro1: "Zapatilla", Filtro2: "Urbana", Categoria: "Calzado", FechaPublicacion: "2026-07-30T00:24:27.841Z", colors: "Negro" },
  { Articulo: "520", Descripcion: "zapatilla", Filtro1: "Zapatilla", Filtro2: "Deportivas", Categoria: "Calzado", FechaPublicacion: "2026-07-23T02:30:50.171Z", colors: "Negro" },
  { Articulo: "55", Descripcion: "Zapatilla", Filtro1: "Zapatilla", Filtro2: "Urbana", Filtro3: "Colegio", Categoria: "Calzado", DetallesSimilitud: "Colegio", FechaPublicacion: "2026-08-28T12:14:41.807Z", colors: "Negro" },
  { Articulo: "AD", Descripcion: "zapatilla deportiva", Filtro1: "Zapatilla", Filtro2: "Deportivas", Categoria: "Calzado", FechaPublicacion: "2026-03-11T12:09:30.471Z", colors: "Blanco|Negro" },
  { Articulo: "106", Descripcion: "Zapatilla con abrojos", Filtro1: "Zapatilla", Filtro2: "Urbana", Categoria: "Calzado", FechaPublicacion: "2026-08-21T00:15:01.189Z", colors: "Blanco|Negro" },
  { Articulo: "30", Descripcion: "Zapatilla deportiva de lona", Filtro1: "Zapatilla", Filtro2: "Deportivas", Categoria: "Calzado", FechaPublicacion: "2026-09-02T11:45:53.199Z", colors: "Gris|Negro" },
  { Articulo: "HBA", Descripcion: "zapatilla importada urbana con plataforma", Filtro1: "Zapatilla", Filtro2: "Urbana", Categoria: "Calzado", DetallesSimilitud: "hombre,Plataforma", FechaPublicacion: "2026-08-26T11:37:40.634Z", colors: "Blanco|Gris|Negro" },
  { Articulo: "2DD", Descripcion: "Zapatilla plataforma importada", Filtro1: "Zapatilla", Filtro2: "Urbana", Filtro3: "Bordada,Moda", Categoria: "Calzado", DetallesSimilitud: "Bordada,Moda", FechaPublicacion: "2026-05-09T11:29:19.084Z", colors: "Gris" },
  { Articulo: "839", Descripcion: "Zapatillas con plataforma", Filtro1: "Zapatilla", Filtro2: "Urbana", Categoria: "Calzado", DetallesSimilitud: "Plataforma", FechaPublicacion: "2026-08-13T19:54:57.756Z", colors: "Blanco" },
  { Articulo: "BA", Descripcion: "zapatilla importada urbana con plataforma", Filtro1: "Zapatilla", Filtro2: "Urbana", Categoria: "Calzado", DetallesSimilitud: "Plataforma", FechaPublicacion: "2026-08-26T11:37:40.634Z", colors: "Blanco|Gris|Rosa" },
  { Articulo: "111", Descripcion: "Sandalia plataforma chorcho", Filtro1: "Sandalia", Filtro2: "Plataforma", Categoria: "Calzado", FechaPublicacion: "2026-09-03T10:24:03.799Z", colors: "Chocolate|Negro" },
  { Articulo: "MAGDA3", Descripcion: "Bota con taco y plataforma", Filtro1: "Bota", Filtro2: "Media Caña", Categoria: "Calzado", FechaPublicacion: "2026-08-26T11:37:40.634Z", colors: "Negro" },
  { Articulo: "FLOR", Descripcion: "Borcego con plataforma", Filtro1: "Borcego", Filtro2: "Plataforma", Categoria: "Calzado", FechaPublicacion: "2026-08-15T00:36:32.549Z", colors: "Negro" },
  { Articulo: "J25", Descripcion: "Ojotas de goma, livianas y resistentes, con diseño clásico y suela antideslizante. Ideales para playa, pileta o uso diario.", Filtro1: "Ojota", Filtro2: "Basicas", Filtro3: "Full Plastic", Categoria: "Calzado", DetallesSimilitud: "Full Plastic", FechaPublicacion: "2026-08-05T01:00:31.534Z", colors: "Azul|Negro|Rosa|Verde" },
  { Articulo: "MR7", Descripcion: "Mochila urbana clásica, confeccionada en material resistente. Cuenta con múltiples compartimentos, bolsillos frontales con cierre y correas acolchadas regulables, ideal para uso diario, trabajo o estudio.", Filtro1: "Marroquineria", Filtro2: "Mochila", Categoria: "Otros", colors: "Negro" },
  { Articulo: "C21", Descripcion: "C21", Filtro1: "Cintos", Filtro2: "Eco Cuero", Categoria: "Otros", colors: "Negro" },
  { Articulo: "R1959", Descripcion: "Jean Oxford Elastizado", Filtro1: "Pantalón", Filtro2: "Jean", Categoria: "Ropa", FechaPublicacion: "2026-07-21T11:17:07.150Z", colors: "Azul" },
  { Articulo: "R2116", Descripcion: "Jean Especial", Filtro1: "Pantalón", Filtro2: "Jean", Categoria: "Ropa", FechaPublicacion: "2026-05-02T10:21:35.213Z", colors: "Azul|Negro" },
  { Articulo: "R1581", Descripcion: "Calza Larga", Filtro1: "Pantalón", Filtro2: "Calza", Categoria: "Ropa", FechaPublicacion: "2026-06-19T11:07:41.908Z", colors: "Negro" },
  { Articulo: "ALP", Descripcion: "Alpargatas ´", Filtro1: "Zapatilla", Filtro2: "Alpargatas", Categoria: "Calzado", FechaPublicacion: "2026-08-14T11:40:22.849Z", colors: "Beige|Negro" },
];

export function fixtureProduct(row: FixtureRow): GroupedProduct {
  return {
    Articulo: row.Articulo,
    Descripcion: row.Descripcion,
    Precio: "",
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: row.FechaPublicacion ?? "",
    Categoria: row.Categoria,
    Filtro1: row.Filtro1,
    Filtro2: row.Filtro2,
    Filtro3: row.Filtro3 ?? "",
    DetallesSimilitud: row.DetallesSimilitud ?? "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    DetalleColor: row.colors.split("|").filter(Boolean).map((color) => ({
      color,
      hex_color: null,
      ColorDisplayNumber: null,
      talles: [],
      images: [],
      OfertaActiva: false,
      PrecioOferta: "",
      PromoActiva: "",
    })),
    ...(row.hasAnyStock !== undefined ? { hasAnyStock: row.hasAnyStock } : {}),
  };
}

export const RANKING_FIXTURE: GroupedProduct[] = ROWS.map(fixtureProduct);
