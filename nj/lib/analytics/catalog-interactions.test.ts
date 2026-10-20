import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BANNER_SWIPE_MIN_PX,
  CATALOG_GRID_LIST,
  buildBannerClickEvent,
  buildBannerSwipeEvent,
  buildBannerViewEvent,
  buildProductClickEvent,
  isBannerSwipe,
} from "./catalog-interactions";

const NUEVOS = { slot: "nuevos_ingresos", position: 2 };

test("banner_view y banner_swipe llevan banner y posición", () => {
  const view = buildBannerViewEvent({ ...NUEVOS, label: "Nuevos ingresos" });
  assert.equal(view.name, "banner_view");
  assert.deepEqual(view.params, {
    banner: "nuevos_ingresos",
    banner_position: 2,
    banner_label: "Nuevos ingresos",
  });
  assert.equal(buildBannerSwipeEvent(NUEVOS).name, "banner_swipe");
  assert.equal("banner_label" in buildBannerSwipeEvent(NUEVOS).params, false);
});

test("banner_click incluye el destino sin dominio", () => {
  const ev = buildBannerClickEvent(NUEVOS, "/coleccion/nuevos-ingresos");
  assert.equal(ev.name, "banner_click");
  assert.equal(ev.params.banner_target, "/coleccion/nuevos-ingresos");
});

test("clic en producto dentro de un banner usa la lista del banner", () => {
  const ev = buildProductClickEvent({ articulo: "A123", index: 3, banner: NUEVOS });
  assert.ok(ev);
  assert.equal(ev.name, "select_item");
  assert.equal(ev.params.item_list_id, "banner_nuevos_ingresos");
  assert.equal(ev.params.item_list_name, "Banner nuevos_ingresos");
  assert.equal(ev.params.banner, "nuevos_ingresos");
  assert.deepEqual(ev.params.items, [{ item_id: "A123", item_name: "A123", index: 3 }]);
});

test("clic en producto de la grilla usa catalog_grid y no marca banner", () => {
  const ev = buildProductClickEvent({ articulo: "A123", index: 1 });
  assert.ok(ev);
  assert.equal(ev.params.item_list_id, CATALOG_GRID_LIST);
  assert.equal("banner" in ev.params, false);
});

test("sin artículo no se envía select_item; el índice mínimo es 1", () => {
  assert.equal(buildProductClickEvent({ articulo: "  ", index: 1 }), null);
  const ev = buildProductClickEvent({ articulo: "A1", index: 0 });
  assert.ok(ev);
  assert.deepEqual(ev.params.items, [{ item_id: "A1", item_name: "A1", index: 1 }]);
});

test("el deslizamiento exige un mínimo de píxeles en cualquier sentido", () => {
  assert.equal(isBannerSwipe(0, BANNER_SWIPE_MIN_PX - 1), false);
  assert.equal(isBannerSwipe(0, BANNER_SWIPE_MIN_PX), true);
  assert.equal(isBannerSwipe(100, 100 - BANNER_SWIPE_MIN_PX), true);
});
