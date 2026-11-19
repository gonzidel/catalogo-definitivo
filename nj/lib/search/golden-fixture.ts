import type { GroupedProduct } from "@/types/catalog";

function p(
  art: string,
  desc: string,
  cat: string,
  f1: string,
  f2: string,
  colors: Array<{ color: string; talles: string[] }>,
  extra: Partial<GroupedProduct> = {}
): GroupedProduct {
  return {
    Articulo: art,
    Descripcion: desc,
    Precio: "10000",
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "2026-01-01T00:00:00Z",
    Categoria: cat,
    Filtro1: f1,
    Filtro2: f2,
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    hasAnyStock: true,
    DetalleColor: colors.map((c) => ({
      color: c.color,
      hex_color: null,
      ColorDisplayNumber: null,
      talles: c.talles,
      images: ["x"],
      hasStock: true,
      OfertaActiva: false,
      PrecioOferta: "",
      PromoActiva: "",
    })),
    ...extra,
  };
}

/** Fixture compacto para golden + selftests del motor. */
export const GOLDEN_FIXTURE: GroupedProduct[] = [
  p("S1", "Sandalia chatita", "Calzado", "Sandalia", "Chatita", [{ color: "Negro", talles: ["36", "37", "38"] }]),
  p("S2", "Sandalia plataforma", "Calzado", "Sandalia", "Plataforma", [{ color: "Beige", talles: ["37", "38", "39"] }]),
  p("S3", "Sandalia dorada con aplique", "Calzado", "Sandalia", "Chatita", [{ color: "Dorado", talles: ["36", "38"] }]),
  p("380", "Sandalia gomon cruzada", "Calzado", "Sandalia", "Gomon", [{ color: "Negro", talles: ["39", "40"] }]),
  p("CH1", "Chatita", "Calzado", "Chatitas", "Chatita", [{ color: "Negro", talles: ["35", "36"] }]),
  p("Z1", "Zapatilla urbana", "Calzado", "Zapatilla", "Urbana", [{ color: "Negro", talles: ["38", "39", "40"] }]),
  p("Z2", "Zapatilla blanca", "Calzado", "Zapatilla", "Urbana", [{ color: "Blanco", talles: ["37", "38"] }]),
  p("B1", "Borcego acordonado", "Calzado", "Borcego", "Caja Baja", [{ color: "Negro", talles: ["38", "39"] }]),
  p("ST1", "Stiletto taco cuadrado", "Calzado", "Estileto", "Taco Cuadrado", [{ color: "Negro", talles: ["36", "37"] }]),
  p("N1", "Zapata Colegial Niño", "Calzado", "Niños", "Zapatillas", [{ color: "Negro", talles: ["28", "29"] }]),
  p("R1", "Remera", "Ropa", "Remera", "Remera", [{ color: "Blanco", talles: ["U"] }]),
  p("NUDO1", "Remera nudo moño", "Ropa", "Remera", "Remera", [{ color: "Negro", talles: ["U"] }]),
  p("J1", "Jean Recto", "Ropa", "Pantalón", "Jean", [{ color: "Azul", talles: ["38", "40"] }]),
  p("J2", "Jeans Cargo", "Ropa", "Pantalón", "Jean", [{ color: "Azul", talles: ["36", "38"] }]),
  p("PO1", "Pollera de Jean", "Ropa", "Pollera", "Jean", [{ color: "Azul", talles: ["U"] }]),
  p("CA1", "Calza larga", "Ropa", "Pantalón", "Calza", [{ color: "Negro", talles: ["U"] }]),
  p("C1", "Camisa bordado", "Ropa", "Camisa", "bordada", [{ color: "Blanco", talles: ["U"] }]),
  p("V1", "Vestidos Largos", "Ropa", "Vestido", "largo", [{ color: "Negro", talles: ["U"] }]),
  p("CP1", "Campera de Jean", "Ropa", "Campera", "Jean", [{ color: "Azul", talles: ["U"] }]),
  p("O1", "Ojota Gomon", "Calzado", "Ojota", "Goma", [{ color: "Negro", talles: ["37", "38"] }]),
];
