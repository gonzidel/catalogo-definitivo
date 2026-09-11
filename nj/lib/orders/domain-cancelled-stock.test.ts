import assert from "node:assert/strict";
import test from "node:test";
import type { AdminOrder, AdminOrderItem } from "../../types/orders";
import {
  cancelledItemNeedsStockConfirmation,
  orderHasCancelledItemsPendingStockReturn,
} from "./domain";

function item(partial: Partial<AdminOrderItem>): AdminOrderItem {
  return {
    id: partial.id || "i1",
    order_id: "o1",
    product_name: "X",
    quantity: 1,
    status: "cancelled",
    ...partial,
  } as AdminOrderItem;
}

test("picked cancelado con fuentes pide ✓ aunque admin_confirmed_missing", () => {
  assert.equal(
    cancelledItemNeedsStockConfirmation(
      item({
        admin_confirmed_missing: true,
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      })
    ),
    true
  );
});

test("cancelado reserved/waiting sin fuentes no pide ✓", () => {
  assert.equal(
    cancelledItemNeedsStockConfirmation(
      item({
        admin_confirmed_missing: false,
        order_item_stock_sources: [],
      })
    ),
    false
  );
});

test("flag missing sin fuentes no pide ✓", () => {
  assert.equal(
    cancelledItemNeedsStockConfirmation(
      item({
        admin_confirmed_missing: true,
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 0 }],
      })
    ),
    false
  );
});

test("pedido con carga admin cancelada va a pendiente de stock", () => {
  const order = {
    id: "o1",
    order_items: [
      item({
        id: "cancelled-admin",
        admin_confirmed_missing: true,
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      }),
      item({
        id: "still-picked",
        status: "picked",
        admin_confirmed_missing: false,
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      }),
    ],
  } as AdminOrder;
  assert.equal(orderHasCancelledItemsPendingStockReturn(order), true);
});
