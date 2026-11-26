import assert from "node:assert/strict";
import { test } from "node:test";
import { promoPosterTitle } from "./promo-posters";

test("2x1 se titula 2x1", () => {
  assert.equal(promoPosterTitle("2x1", null), "2x1");
});

test("2xMonto formatea el monto", () => {
  assert.equal(promoPosterTitle("2xMonto", 10000), "2x $10.000");
  assert.equal(promoPosterTitle("2xMonto", "28000"), "2x $28.000");
});
