/**
 * Precios/ofertas por color — agrupado, derivación y líneas de carrito.
 * Run: npx tsx lib/utils/variant-price.selftest.ts
 */
import type { CatalogRow, ColorDetail, GroupedProduct } from "../../types/catalog";
import { agruparProductos } from "./catalog";
import {
  cartPriceForColor,
  getColorEffectivePrice,
  hasValidCatalogPrice,
} from "./variant-price";

let failed = 0;

function check(name: string, cond: boolean) {
  if (!cond) {
    failed += 1;
    console.log(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function row(partial: Partial<CatalogRow> & Pick<CatalogRow, "Articulo" | "Color">): CatalogRow {
  return {
    Categoria: "Calzado",
    Descripcion: "",
    Numeracion: "36,37,38",
    FechaIngreso: null,
    FechaPublicacion: null,
    Mostrar: true,
    Oferta: "FALSE",
    Precio: "",
    "Imagen Principal": "https://img.example/a.jpg",
    "Imagen 1": null,
    "Imagen 2": null,
    "Imagen 3": null,
    Filtro1: null,
    Filtro2: null,
    Filtro3: null,
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    OfferCampaignId: null,
    OfferImageUrl: null,
    OfferTitle: null,
    ColorHex: null,
    ColorDisplayNumber: null,
    SupplierCode: null,
    ...partial,
  };
}

function colorOf(product: GroupedProduct, color: string): ColorDetail | null {
  const key = color.toLowerCase();
  return (
    product.DetalleColor.find((c) => c.color.toLowerCase() === key) ?? null
  );
}

// ── A: 8000 estado actual (workaround: Suela price más bajo, sin oferta DB) ──

const art8000current = agruparProductos([
  row({
    Articulo: "8000",
    Color: "suela",
    Precio: "20000.00",
    OfertaActiva: false,
    variant_id: "var-suela",
    FechaPublicacion: "2026-09-02T11:37:33Z",
  }),
  row({
    Articulo: "8000",
    Color: "Negro",
    Precio: "28500.00",
    OfertaActiva: false,
    variant_id: "var-negro",
    FechaPublicacion: "2026-09-01T11:54:32Z",
  }),
]);

const p8000 = art8000current[0];
const suelaNow = getColorEffectivePrice(colorOf(p8000, "suela"), p8000);
const negroNow = getColorEffectivePrice(colorOf(p8000, "Negro"), p8000);

check("A group exists", art8000current.length === 1);
check("A suela effective 20000 no offer", suelaNow.effectivePrice === 20000 && !suelaNow.isOffer);
check("A negro effective 28500 no offer", negroNow.effectivePrice === 28500 && !negroNow.isOffer);
check("A group hint must not override negro", negroNow.effectivePrice !== suelaNow.effectivePrice);

const cart8000now = [
  { color: "suela", variant_id: "var-suela", ...cartPriceForColor(p8000.DetalleColor, "suela") },
  { color: "Negro", variant_id: "var-negro", ...cartPriceForColor(p8000.DetalleColor, "Negro") },
];
check(
  "A cart snapshots distinct",
  cart8000now[0].effectivePrice === 20000 && cart8000now[1].effectivePrice === 28500
);
check(
  "A cart subtotal 48500",
  cart8000now[0].effectivePrice + cart8000now[1].effectivePrice === 48500
);

// ── A2: 8000 fixture coherente (normal 28500 + oferta Suela 20000) ──

const art8000offer = agruparProductos([
  row({
    Articulo: "8000",
    Color: "suela",
    Precio: "28500.00",
    OfertaActiva: true,
    PrecioOferta: "20000",
    variant_id: "var-suela",
  }),
  row({
    Articulo: "8000",
    Color: "Negro",
    Precio: "28500.00",
    OfertaActiva: false,
    PrecioOferta: "",
    variant_id: "var-negro",
  }),
]);
const p8000o = art8000offer[0];
const suelaOff = getColorEffectivePrice(colorOf(p8000o, "suela"), p8000o);
const negroOff = getColorEffectivePrice(colorOf(p8000o, "Negro"), p8000o);

check("A2 group OfertaActiva is hint only", p8000o.OfertaActiva === true);
check("A2 suela offer 20000", suelaOff.isOffer && suelaOff.effectivePrice === 20000);
check("A2 suela normal 28500", suelaOff.normalPrice === 28500);
check("A2 suela savings 8500", suelaOff.savings === 8500);
check("A2 negro no offer 28500", !negroOff.isOffer && negroOff.effectivePrice === 28500);
check("A2 negro not contaminated", negroOff.offerPrice === null);

// ── B: oferta parcial real (51030) ──

const art51030 = agruparProductos([
  row({
    Articulo: "51030",
    Color: "Negro",
    Precio: "15000.00",
    OfertaActiva: true,
    PrecioOferta: "10000",
    variant_id: "v-51030-neg",
  }),
  row({
    Articulo: "51030",
    Color: "Suela",
    Precio: "18000.00",
    OfertaActiva: false,
    PrecioOferta: "",
    variant_id: "v-51030-sue",
  }),
]);
const p51030 = art51030[0];
const n51030 = getColorEffectivePrice(colorOf(p51030, "Negro"), p51030);
const s51030 = getColorEffectivePrice(colorOf(p51030, "Suela"), p51030);

check("B negro offer 10000", n51030.isOffer && n51030.effectivePrice === 10000);
check("B suela normal 18000", !s51030.isOffer && s51030.effectivePrice === 18000);
check(
  "B group PrecioOferta must not apply to Suela",
  s51030.effectivePrice !== n51030.effectivePrice
);

// ── C: varios colores sin oferta ──

const artPlain = agruparProductos([
  row({ Articulo: "PLAIN", Color: "Rojo", Precio: "12000", variant_id: "v-r" }),
  row({ Articulo: "PLAIN", Color: "Azul", Precio: "12000", variant_id: "v-a" }),
]);
const pPlain = artPlain[0];
const rojo = getColorEffectivePrice(colorOf(pPlain, "Rojo"), pPlain);
const azul = getColorEffectivePrice(colorOf(pPlain, "Azul"), pPlain);
check("C both 12000 no offer", !rojo.isOffer && !azul.isOffer);
check("C same effective", rojo.effectivePrice === 12000 && azul.effectivePrice === 12000);
check("C variant_ids kept", colorOf(pPlain, "Rojo")?.variant_id === "v-r");

// ── D: dos líneas del mismo artículo, precios independientes ──

const lineSuela = cartPriceForColor(p8000o.DetalleColor, "suela", p8000o);
const lineNegro = cartPriceForColor(p8000o.DetalleColor, "Negro", p8000o);
check("D suela snapshot 20000 offer", lineSuela.effectivePrice === 20000 && lineSuela.isOffer);
check("D negro snapshot 28500", lineNegro.effectivePrice === 28500 && !lineNegro.isOffer);
check("D subtotal 48500", lineSuela.effectivePrice + lineNegro.effectivePrice === 48500);

// ── Case fold: suela vs Suela ──

check(
  "case fold finds suela",
  cartPriceForColor(p8000o.DetalleColor, "Suela", p8000o).effectivePrice === 20000
);

// ── E: precio 0 explícito en color no hereda el del artículo ──

const zeroOwn = getColorEffectivePrice(
  { Precio: "0.00", OfertaActiva: false },
  { Precio: "11000.00" }
);
check("E color Precio 0 no hereda fallback", zeroOwn.effectivePrice === 0);
check("E hasValidCatalogPrice 0", hasValidCatalogPrice(0) === false);
check("E hasValidCatalogPrice 11000", hasValidCatalogPrice(11000) === true);
const missingOwn = getColorEffectivePrice(
  { Precio: "", OfertaActiva: false },
  { Precio: "11000.00" }
);
check("E sin Precio propio sí usa fallback", missingOwn.effectivePrice === 11000);

if (failed > 0) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nall ok");
