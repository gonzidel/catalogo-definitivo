/**
 * Selftest Fase 4 — hasStock / presencia sellable.
 * Run: npx tsx lib/stock/catalog-availability.selftest.ts
 */
import type { ColorDetail, GroupedProduct } from "@/types/catalog";
import {
  colorIsPurchasable,
  colorsHaveAnySellable,
  productIsOutOfStock,
  productIsPurchasable,
  productStockPresence,
} from "./catalog-availability";

let failed = 0;

function check(name: string, cond: boolean) {
  if (!cond) {
    failed += 1;
    console.log(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function color(hasStock?: boolean, precio: number | string = 1000): ColorDetail {
  return {
    color: "X",
    hex_color: null,
    ColorDisplayNumber: null,
    talles: [],
    images: ["x"],
    Precio: precio,
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    hasStock,
  };
}

function product(
  colors: ColorDetail[],
  hasAnyStock?: boolean
): GroupedProduct {
  return {
    Articulo: "T",
    Descripcion: "",
    Precio: 1,
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "",
    Categoria: "",
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    DetalleColor: colors,
    hasAnyStock,
  };
}

check("1 [0,0,2] → true", colorsHaveAnySellable([
  color(false),
  color(false),
  color(true),
]) === true);

check("2 [0,0,0] → false", colorsHaveAnySellable([
  color(false),
  color(false),
  color(false),
]) === false);

check("3 [] → unknown, no true", colorsHaveAnySellable([]) === undefined);
check("3 empty product not purchasable", productIsPurchasable(product([])) === false);
check("3 empty product not OOS badge", productIsOutOfStock(product([])) === false);
check("3 empty presence unknown", productStockPresence(product([])) === undefined);

const partial = product([color(false), color(true)]);
check("4 variante A=0 B=2 → product true", productIsPurchasable(partial) === true);

const empty = product([color(false), color(false)], false);
check("5 producto 0 → false", productIsPurchasable(empty) === false);
check("5 producto 0 → OOS", productIsOutOfStock(empty) === true);

const fylNoEnrich = product([color(), color()]);
check("6 FYL sin flag → unknown ≠ true", productStockPresence(fylNoEnrich) === undefined);
check("6 FYL sin flag no comprable", productIsPurchasable(fylNoEnrich) === false);

const searchOos = product([color(false)], false);
check("7 búsqueda OOS flag false", productIsOutOfStock(searchOos) === true);
check("7 búsqueda OOS no comprable", productIsPurchasable(searchOos) === false);

check("color unknown ≠ purchasable", colorIsPurchasable(color()) === false);
check("color true", colorIsPurchasable(color(true)) === true);
check("color stock true precio 0 ≠ comprable", colorIsPurchasable(color(true, 0)) === false);
check("color stock true precio 0.00 ≠ comprable", colorIsPurchasable(color(true, "0.00")) === false);
check("hasAnyStock true + Precio producto", productIsPurchasable(product([], true)) === true);
check("hasAnyStock true sin precio producto ≠ comprable", productIsPurchasable({
  ...product([], true),
  Precio: 0,
}) === false);
check("hasAnyStock false gana", productIsPurchasable(product([color(true)], false)) === false);

const pricedPartial = product([color(true, 0), color(true, 11000)]);
check("variante $0 + variante con precio → comprable", productIsPurchasable(pricedPartial) === true);
check("solo variantes $0 → no comprable", productIsPurchasable(product([color(true, 0), color(true, "0.00")], true)) === false);

if (failed > 0) {
  console.log(`\n${failed} FAIL`);
  process.exit(1);
}
console.log("\nALL PASS");
