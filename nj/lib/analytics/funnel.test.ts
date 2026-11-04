import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAddToCartEvent,
  buildBeginCheckoutEvent,
  buildLoginSuccessEvent,
  buildViewItemEvent,
} from "./funnel";

test("view_item lleva moneda ARS, valor e ítem estándar de GA4", () => {
  const ev = buildViewItemEvent({ articulo: "M700", price: 25990, category: "Calzado" });
  assert.equal(ev?.name, "view_item");
  assert.equal(ev?.params.currency, "ARS");
  assert.equal(ev?.params.value, 25990);
  assert.deepEqual(ev?.params.items, [
    { item_id: "M700", item_name: "M700", price: 25990, item_category: "Calzado" },
  ]);
});

test("view_item sin artículo no genera evento", () => {
  assert.equal(buildViewItemEvent({ articulo: "  ", price: 100 }), null);
});

test("view_item con precio inválido manda 0 y no NaN", () => {
  const ev = buildViewItemEvent({ articulo: "M700", price: Number.NaN });
  assert.equal(ev?.params.value, 0);
});

test("add_to_cart junta varias líneas en un solo evento con el valor total", () => {
  const ev = buildAddToCartEvent([
    { articulo: "M700", color: "Negro", size: "38", qty: 2, price: 1000 },
    { articulo: "M700", color: "Negro", size: "39", qty: 1, price: 1000 },
  ]);
  assert.equal(ev?.name, "add_to_cart");
  assert.equal(ev?.params.value, 3000);
  const items = ev?.params.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.equal(items[0].item_variant, "Negro / 38");
  assert.equal(items[0].quantity, 2);
});

test("add_to_cart sin líneas válidas no genera evento", () => {
  assert.equal(buildAddToCartEvent([]), null);
  assert.equal(buildAddToCartEvent([{ articulo: "", qty: 1, price: 10 }]), null);
});

test("cantidad inválida se toma como 1", () => {
  const ev = buildAddToCartEvent([{ articulo: "X", qty: 0, price: 500 }]);
  const items = ev?.params.items as Array<Record<string, unknown>>;
  assert.equal(items[0].quantity, 1);
  assert.equal(ev?.params.value, 500);
});

test("begin_checkout usa la misma forma que add_to_cart", () => {
  const ev = buildBeginCheckoutEvent([{ articulo: "R3100", qty: 4, price: 2500 }]);
  assert.equal(ev?.name, "begin_checkout");
  assert.equal(ev?.params.value, 10000);
});

test("login_success lleva el método y usa 'unknown' si falta", () => {
  assert.deepEqual(buildLoginSuccessEvent("google").params, { method: "google" });
  assert.deepEqual(buildLoginSuccessEvent("").params, { method: "unknown" });
});

test("el evento no incluye datos personales", () => {
  const ev = buildAddToCartEvent([{ articulo: "M700", qty: 1, price: 1 }]);
  assert.doesNotMatch(JSON.stringify(ev), /@|phone|email|dni/i);
});
