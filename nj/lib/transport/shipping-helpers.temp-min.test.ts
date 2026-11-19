import assert from "node:assert/strict";
import { test } from "node:test";
import { TEMP_MIN_ONE_ENABLED } from "../config/temp-order-min";
import { getOrderCloseMinimumUnits } from "./shipping-helpers";

test("con TEMP_MIN_ONE_ENABLED el mínimo de cierre es 1 fuera de zona local", () => {
  assert.equal(TEMP_MIN_ONE_ENABLED, true);
  assert.equal(getOrderCloseMinimumUnits("Buenos Aires", "CABA"), 1);
  assert.equal(getOrderCloseMinimumUnits("Santa Fe", "Rosario"), 1);
});

test("con TEMP_MIN_ONE_ENABLED el mínimo también es 1 en zona retiro corto", () => {
  assert.equal(getOrderCloseMinimumUnits("Chaco", "Resistencia"), 1);
});
