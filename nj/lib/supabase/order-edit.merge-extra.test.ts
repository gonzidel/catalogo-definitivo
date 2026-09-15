import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSpecialExtraDraftItem,
  bumpDraftExtraQuantity,
  mergeDraftItem,
} from "./order-edit";

test("extra sin nombre queda como Extra y acepta cantidad", () => {
  const extra = buildSpecialExtraDraftItem("", 1500, 2);
  assert.equal(extra.product_name, "Extra");
  assert.equal(extra.quantity, 2);
  assert.equal(extra.price_snapshot, 1500);
  assert.equal(extra.is_special_extra, true);
});

test("extra con nombre Remera conserva el nombre y las unidades", () => {
  const extra = buildSpecialExtraDraftItem("remera", 2000, 2);
  assert.equal(extra.product_name, "remera");
  assert.equal(extra.quantity, 2);
});

test("merge suma unidades del mismo extra y mismo precio", () => {
  const first = buildSpecialExtraDraftItem("remera", 2000, 1);
  const second = buildSpecialExtraDraftItem("Remera", 2000, 1);
  const merged = mergeDraftItem(mergeDraftItem([], first), second);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].quantity, 2);
  assert.equal(merged[0].product_name, "remera");
});

test("no mezcla extras distintos o con otro precio", () => {
  const remera = buildSpecialExtraDraftItem("remera", 2000, 1);
  const extra = buildSpecialExtraDraftItem("", 2000, 1);
  const otherPrice = buildSpecialExtraDraftItem("remera", 2500, 1);
  const merged = mergeDraftItem(mergeDraftItem(mergeDraftItem([], remera), extra), otherPrice);
  assert.equal(merged.length, 3);
});

test("bumpDraftExtraQuantity sube y baja unidades", () => {
  const draft = [buildSpecialExtraDraftItem("remera", 2000, 1)];
  const up = bumpDraftExtraQuantity(draft, 0, 1);
  assert.equal(up[0].quantity, 2);
  const down = bumpDraftExtraQuantity(up, 0, -1);
  assert.equal(down[0].quantity, 1);
});
