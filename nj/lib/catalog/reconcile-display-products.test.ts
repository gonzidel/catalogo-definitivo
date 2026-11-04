import assert from "node:assert/strict";
import { test } from "node:test";
import type { GroupedProduct } from "@/types/catalog";
import {
  markProductOutOfStock,
  neutralizePendingStock,
  reconcileDisplayProducts,
  reconcileForFilterKey,
  resolvePreviousForFilter,
  type PaintedGridState,
} from "./reconcile-display-products";

function product(
  articulo: string,
  opts: { hasStock?: boolean | undefined; colors?: number } = {}
): GroupedProduct {
  const n = opts.colors ?? 1;
  const hasStock = opts.hasStock;
  return {
    Articulo: articulo,
    Descripcion: articulo,
    Precio: "10000",
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "",
    Categoria: "Calzado",
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    hasAnyStock: hasStock,
    DetalleColor: Array.from({ length: n }, (_, i) => ({
      color: `C${i}`,
      hex_color: "#000",
      ColorDisplayNumber: i,
      talles: [],
      images: [{ public_id: `${articulo}-${i}`, url: `https://example.com/${articulo}-${i}.jpg` }],
      Precio: "10000",
      OfertaActiva: false,
      PrecioOferta: "",
      PromoActiva: "",
      hasStock,
    })),
  };
}

test("mientras enriquece: conserva orden y neutraliza stock", () => {
  const prev = [product("A", { hasStock: true }), product("B", { hasStock: true })];
  const out = reconcileDisplayProducts({
    previous: prev,
    nextPool: [product("C", { hasStock: true })],
    slotCount: 2,
    isEnriching: true,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].Articulo, "A");
  assert.equal(out[1].Articulo, "B");
  assert.equal(out[0].hasAnyStock, undefined);
  assert.equal(out[0].DetalleColor[0].hasStock, undefined);
});

test("OOS se reemplaza in-place sin colapsar slots", () => {
  const previous = [
    product("A", { hasStock: true }),
    product("B", { hasStock: true }),
    product("C", { hasStock: true }),
  ];
  const nextPool = [
    product("B", { hasStock: true }),
    product("C", { hasStock: true }),
    product("D", { hasStock: true }),
  ];
  const out = reconcileDisplayProducts({
    previous,
    nextPool,
    slotCount: 3,
    isEnriching: false,
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].Articulo, "D");
  assert.equal(out[1].Articulo, "B");
  assert.equal(out[2].Articulo, "C");
});

test("sin reemplazo: slot OOS permanece (no comprable) para geometría", () => {
  const previous = [product("A", { hasStock: true }), product("B", { hasStock: true })];
  const nextPool = [product("B", { hasStock: true })];
  const out = reconcileDisplayProducts({
    previous,
    nextPool,
    slotCount: 2,
    isEnriching: false,
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].Articulo, "A");
  assert.equal(out[0].hasAnyStock, false);
  assert.equal(out[0].DetalleColor[0].hasStock, false);
  assert.equal(out[1].Articulo, "B");
  assert.equal(out[1].hasAnyStock, true);
});

test("artículos nuevos solo llenan slots libres al final", () => {
  const previous = [product("A", { hasStock: true })];
  const nextPool = [
    product("A", { hasStock: true }),
    product("B", { hasStock: true }),
    product("C", { hasStock: true }),
  ];
  const out = reconcileDisplayProducts({
    previous,
    nextPool,
    slotCount: 3,
    isEnriching: false,
  });
  assert.deepEqual(
    out.map((p) => p.Articulo),
    ["A", "B", "C"]
  );
});

test("helpers neutralize / mark OOS", () => {
  const p = product("X", { hasStock: true });
  assert.equal(neutralizePendingStock(p).hasAnyStock, undefined);
  assert.equal(markProductOutOfStock(p).hasAnyStock, false);
});

test("resolvePreviousForFilter: clave distinta → previous vacío", () => {
  const state: PaintedGridState = {
    filterKey: "calzado|||" ,
    products: [product("OLD", { hasStock: true })],
  };
  assert.deepEqual(resolvePreviousForFilter(state, "ropa|||"), []);
  assert.equal(resolvePreviousForFilter(state, "calzado|||").length, 1);
});

test("cambio de talle con menos resultados: sin residuales del filtro anterior", () => {
  const painted: PaintedGridState = {
    filterKey: "calzado|||36",
    products: [
      product("A36", { hasStock: true }),
      product("B36", { hasStock: true }),
      product("C36", { hasStock: true }),
    ],
  };
  const nextPool = [product("X39", { hasStock: true })];
  const step = reconcileForFilterKey({
    painted,
    filterKey: "calzado|||39",
    nextPool,
    slotCount: 3,
    isEnriching: false,
  });
  assert.deepEqual(
    step.products.map((p) => p.Articulo),
    ["X39"]
  );
  assert.ok(!step.products.some((p) => p.Articulo.endsWith("36")));
  assert.ok(!step.products.some((p) => p.hasAnyStock === false));
  assert.equal(step.painted.filterKey, "calzado|||39");
});

test("cambio de categoría: no arrastra productos ni falso OOS", () => {
  const painted: PaintedGridState = {
    filterKey: "calzado|||",
    products: [
      product("SHOE1", { hasStock: true }),
      product("SHOE2", { hasStock: true }),
    ],
  };
  const step = reconcileForFilterKey({
    painted,
    filterKey: "ropa|||",
    nextPool: [product("TEE1", { hasStock: true }), product("TEE2", { hasStock: true })],
    slotCount: 2,
    isEnriching: false,
  });
  assert.deepEqual(
    step.products.map((p) => p.Articulo),
    ["TEE1", "TEE2"]
  );
  assert.ok(!step.products.some((p) => p.Articulo.startsWith("SHOE")));
  assert.ok(step.products.every((p) => p.hasAnyStock === true));
});

test("cambio de tags: limpia previous síncrono", () => {
  const painted: PaintedGridState = {
    filterKey: "all|Zapatilla||",
    products: [product("Z1", { hasStock: true }), product("Z2", { hasStock: true })],
  };
  const step = reconcileForFilterKey({
    painted,
    filterKey: "all|Sandalia||",
    nextPool: [product("S1", { hasStock: true })],
    slotCount: 2,
    isEnriching: false,
  });
  assert.deepEqual(
    step.products.map((p) => p.Articulo),
    ["S1"]
  );
  assert.ok(!step.products.some((p) => p.Articulo.startsWith("Z")));
});

test("cambio de búsqueda: sin productos residuales del filtro anterior", () => {
  const painted: PaintedGridState = {
    filterKey: "all|||",
    products: [
      product("HOME1", { hasStock: true }),
      product("HOME2", { hasStock: true }),
      product("HOME3", { hasStock: true }),
    ],
  };
  const step = reconcileForFilterKey({
    painted,
    filterKey: "all||botin|",
    nextPool: [product("BOT1", { hasStock: true })],
    slotCount: 14,
    isEnriching: false,
  });
  assert.deepEqual(
    step.products.map((p) => p.Articulo),
    ["BOT1"]
  );
  assert.ok(!step.products.some((p) => p.Articulo.startsWith("HOME")));
  assert.ok(
    !step.products.some((p) => p.hasAnyStock === false),
    "ningún residual marcado como falso OOS"
  );
});
