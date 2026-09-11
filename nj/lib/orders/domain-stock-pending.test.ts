import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isNetworkStockPendingReason,
  isTransientNetworkError,
  parseStockPendingReasonConflict,
} from "./domain";

test("Failed to fetch es red, no conflicto de stock", () => {
  const err = new TypeError("Failed to fetch");
  assert.equal(isTransientNetworkError(err), true);
  assert.equal(isNetworkStockPendingReason("TypeError: Failed to fetch"), true);
  assert.equal(parseStockPendingReasonConflict("TypeError: Failed to fetch"), null);
});

test("stock insuficiente no es red", () => {
  const msg =
    "rpc_apply_order_stock_deduction: stock insuficiente para variant=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee, size=38, warehouse=ffffffff-1111-2222-3333-444444444444: disponible=0, solicitado=1.";
  assert.equal(isTransientNetworkError(msg), false);
  assert.equal(isNetworkStockPendingReason(msg), false);
  assert.ok(parseStockPendingReasonConflict(msg)?.variant_id);
});
