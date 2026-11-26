import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROMO_BANNER_ROTATE_MS,
  msUntilNextRotation,
  rotatePromoBanner,
  rotateByTimeWindow,
  stackPromosBeforeOffers,
} from "./promo-rotation";

const cards = ["a", "b", "c", "d"];

test("con una sola tarjeta no rota", () => {
  assert.deepEqual(rotateByTimeWindow(["a"], PROMO_BANNER_ROTATE_MS), ["a"]);
  assert.deepEqual(rotateByTimeWindow([], 0), []);
});

test("dentro de la primera ventana el orden no cambia", () => {
  assert.deepEqual(rotateByTimeWindow(cards, PROMO_BANNER_ROTATE_MS - 1), cards);
});

test("cada ventana corre un lugar y al dar la vuelta vuelve a empezar", () => {
  assert.deepEqual(rotateByTimeWindow(cards, PROMO_BANNER_ROTATE_MS), ["b", "c", "d", "a"]);
  assert.deepEqual(rotateByTimeWindow(cards, PROMO_BANNER_ROTATE_MS * 2), ["c", "d", "a", "b"]);
  assert.deepEqual(rotateByTimeWindow(cards, PROMO_BANNER_ROTATE_MS * 4), cards);
});

test("la misma ventana da el mismo orden", () => {
  const now = PROMO_BANNER_ROTATE_MS * 3 + 50_000;
  assert.deepEqual(rotateByTimeWindow(cards, now), rotateByTimeWindow(cards, now + 1_000));
});

test("avisa cuánto falta para la próxima ventana", () => {
  assert.equal(msUntilNextRotation(0), PROMO_BANNER_ROTATE_MS);
  assert.equal(msUntilNextRotation(1_000), PROMO_BANNER_ROTATE_MS - 1_000);
});

test("en el banner el corte es a las 6 de Argentina", () => {
  const sixArt = Date.parse("2026-11-26T09:00:00.000Z");
  assert.notDeepEqual(rotatePromoBanner(cards, sixArt - 1), rotatePromoBanner(cards, sixArt));
});

test("las promos quedan delante de las ofertas", () => {
  const promos = ["p1", "p2", "p3", "p4"];
  const offers = ["o1", "o2", "o3"];
  const sixArt = Date.parse("2026-11-26T09:00:00.000Z");
  const before = stackPromosBeforeOffers(promos, offers, sixArt - 1);
  const after = stackPromosBeforeOffers(promos, offers, sixArt);

  assert.notDeepEqual(before.slice(0, promos.length), after.slice(0, promos.length));
  for (const ordered of [before, after]) {
    const firstOffer = ordered.findIndex((card) => card.startsWith("o"));
    assert.ok(ordered.slice(0, firstOffer).every((card) => card.startsWith("p")));
    assert.equal(firstOffer, promos.length);
    assert.ok(ordered.slice(firstOffer).every((card) => card.startsWith("o")));
  }
});
