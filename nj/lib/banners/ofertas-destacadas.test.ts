import assert from "node:assert/strict";
import { test } from "node:test";
import { offersBannerPreviewOverride } from "./home-feature-flags";
import {
  OFERTAS_BANNER_LIMIT,
  OFERTAS_BANNER_TOP_RECENT,
  buildOfertasBannerItems,
  fetchHomeOffersBannerEnabled,
} from "./ofertas-destacadas";
import type { CatalogRow } from "@/types/catalog";

type RowOverrides = Partial<CatalogRow> & { Articulo: string; Color: string };

function row(o: RowOverrides): CatalogRow {
  return {
    Categoria: "Calzado",
    Descripcion: "",
    Numeracion: "36,37",
    FechaIngreso: "01/01/2026",
    FechaPublicacion: "2026-11-01T10:00:00.000Z",
    Mostrar: true,
    Oferta: "FALSE",
    Precio: "20000",
    "Imagen Principal": `https://img.test/${o.Articulo}-${o.Color}.jpg`,
    "Imagen 1": null,
    "Imagen 2": null,
    "Imagen 3": null,
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    OfertaActiva: true,
    PrecioOferta: "15000",
    PromoActiva: "",
    OfferCampaignId: null,
    OfferImageUrl: null,
    OfferTitle: null,
    ColorHex: null,
    ColorDisplayNumber: null,
    SupplierCode: "",
    ...o,
  };
}

/** n artículos de calzado con oferta, el i-ésimo publicado i horas después del anterior. */
function calzadoRows(n: number, start = 0): CatalogRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({
      Articulo: `C${start + i}`,
      Color: "Negro",
      FechaPublicacion: new Date(Date.UTC(2026, 10, 1, start + i)).toISOString(),
    })
  );
}

test("solo entra el color con oferta vigente y se muestra el precio de oferta", () => {
  const items = buildOfertasBannerItems([
    row({ Articulo: "A1", Color: "Negro", OfertaActiva: false, PrecioOferta: "" }),
    row({ Articulo: "A1", Color: "Rojo", OfertaActiva: true, PrecioOferta: "12000" }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].color.color, "Rojo");
  assert.equal(items[0].price, 12000);
});

test("artículo sin ningún color en oferta no entra", () => {
  const items = buildOfertasBannerItems([
    row({ Articulo: "B1", Color: "Negro", OfertaActiva: false, PrecioOferta: "" }),
  ]);
  assert.equal(items.length, 0);
});

test("color en oferta sin imagen no entra", () => {
  const items = buildOfertasBannerItems([
    row({ Articulo: "D1", Color: "Negro", "Imagen Principal": null }),
  ]);
  assert.equal(items.length, 0);
});

test("oferta con precio 0 o vacío no entra", () => {
  const items = buildOfertasBannerItems([
    row({ Articulo: "E1", Color: "Negro", PrecioOferta: "0" }),
    row({ Articulo: "E2", Color: "Negro", PrecioOferta: "" }),
  ]);
  assert.equal(items.length, 0);
});

test("la recencia es la del color en oferta, no la de otro color del artículo", () => {
  const items = buildOfertasBannerItems([
    // Color sin oferta republicado hoy: no debe adelantar al artículo.
    row({
      Articulo: "F1",
      Color: "Negro",
      OfertaActiva: false,
      PrecioOferta: "",
      FechaPublicacion: "2026-11-10T09:00:00.000Z",
    }),
    row({
      Articulo: "F1",
      Color: "Rojo",
      FechaPublicacion: "2026-10-01T09:00:00.000Z",
    }),
    row({
      Articulo: "F2",
      Color: "Azul",
      FechaPublicacion: "2026-11-05T09:00:00.000Z",
    }),
  ]);
  assert.deepEqual(
    items.map((i) => i.product.Articulo),
    ["F2", "F1"]
  );
});

test("con varios colores en oferta se muestra el publicado más recientemente", () => {
  const items = buildOfertasBannerItems([
    row({ Articulo: "G1", Color: "Negro", FechaPublicacion: "2026-10-01T09:00:00.000Z" }),
    row({ Articulo: "G1", Color: "Rojo", FechaPublicacion: "2026-11-09T09:00:00.000Z" }),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].color.color, "Rojo");
});

test("los primeros 5 son los más recientes, de más nuevo a más viejo", () => {
  const items = buildOfertasBannerItems(calzadoRows(12));
  const firstFive = items.slice(0, OFERTAS_BANNER_TOP_RECENT).map((i) => i.product.Articulo);
  assert.deepEqual(firstFive, ["C11", "C10", "C9", "C8", "C7"]);
});

test("después de los 5 primeros se mezcla Calzado/Ropa/Otros", () => {
  const rows = [
    ...calzadoRows(5, 100), // los 5 más recientes (horas 100..104)
    ...calzadoRows(3, 0), // calzado viejo: C0..C2
    row({ Articulo: "R1", Categoria: "Ropa", Color: "Negro", FechaPublicacion: "2026-10-10T00:00:00.000Z" }),
    row({ Articulo: "R2", Categoria: "Ropa", Color: "Negro", FechaPublicacion: "2026-10-09T00:00:00.000Z" }),
    row({ Articulo: "O1", Categoria: "Otros", Color: "Negro", FechaPublicacion: "2026-10-08T00:00:00.000Z" }),
  ];
  const items = buildOfertasBannerItems(rows);
  const resto = items.slice(OFERTAS_BANNER_TOP_RECENT).map((i) => i.product.Categoria);
  // Round-robin: Calzado, Ropa, Otros, Calzado, Ropa, Calzado.
  assert.deepEqual(resto, ["Calzado", "Ropa", "Otros", "Calzado", "Ropa", "Calzado"]);
});

test("el orden es determinístico (mismo input, mismo resultado)", () => {
  const rows = [...calzadoRows(10), ...calzadoRows(3, 50)];
  const a = buildOfertasBannerItems(rows).map((i) => i.product.Articulo);
  const b = buildOfertasBannerItems(rows).map((i) => i.product.Articulo);
  assert.deepEqual(a, b);
});

test("respeta el tope de productos", () => {
  const items = buildOfertasBannerItems(calzadoRows(OFERTAS_BANNER_LIMIT + 10));
  assert.equal(items.length, OFERTAS_BANNER_LIMIT);
});

test("sin filas devuelve vacío", () => {
  assert.deepEqual(buildOfertasBannerItems([]), []);
});

// ─── Flag: falla cerrado ─────────────────────────────────────────────────────

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
  };
  return { from: () => chain } as unknown as Parameters<typeof fetchHomeOffersBannerEnabled>[0];
}

test("override de preview muestra el banner sin leer el check", async () => {
  const prev = process.env.NEXT_PUBLIC_OFFERS_BANNER_PREVIEW;
  process.env.NEXT_PUBLIC_OFFERS_BANNER_PREVIEW = "1";
  try {
    assert.equal(offersBannerPreviewOverride(), true);
    assert.equal(
      await fetchHomeOffersBannerEnabled(fakeSupabase({ data: null, error: { message: "no table" } })),
      true
    );
  } finally {
    if (prev == null) delete process.env.NEXT_PUBLIC_OFFERS_BANNER_PREVIEW;
    else process.env.NEXT_PUBLIC_OFFERS_BANNER_PREVIEW = prev;
  }
});

test("flag activo → true", async () => {
  assert.equal(
    await fetchHomeOffersBannerEnabled(fakeSupabase({ data: { enabled: true }, error: null })),
    true
  );
});

test("flag apagado, ausente o con error → false (falla cerrado)", async () => {
  assert.equal(
    await fetchHomeOffersBannerEnabled(fakeSupabase({ data: { enabled: false }, error: null })),
    false
  );
  assert.equal(
    await fetchHomeOffersBannerEnabled(fakeSupabase({ data: null, error: null })),
    false
  );
  assert.equal(
    await fetchHomeOffersBannerEnabled(
      fakeSupabase({ data: null, error: { message: "relation does not exist" } })
    ),
    false
  );
});
