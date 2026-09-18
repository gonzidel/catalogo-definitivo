import assert from "node:assert/strict";
import test from "node:test";
import type { AdminOrder, AdminOrderItem } from "../../types/orders";
import {
  cancelledItemNeedsStockConfirmation,
  getOperationalDisplayOrderItems,
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
        cancelled_from_status: "picked",
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      })
    ),
    true
  );
});

test("missing cancelado no pide ✓ aunque una fuente llegue tarde", () => {
  assert.equal(
    cancelledItemNeedsStockConfirmation(
      item({
        admin_confirmed_missing: true,
        cancelled_from_status: "missing",
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      })
    ),
    false
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
        cancelled_from_status: "picked",
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

// A56961: cancelado sin fuentes (ya resuelto) no debe listarse junto al picked
// del mismo producto re-agregado — el conteo ya lo excluía, el listado no.
test("getOperationalDisplayOrderItems oculta cancelados resueltos", () => {
  const order = {
    id: "o1",
    order_items: [
      item({
        id: "ghost-cancelled",
        status: "cancelled",
        cancelled_from_status: "picked",
        product_name: "220",
        color: "Negro",
        size: "36",
        order_item_stock_sources: [],
      }),
      item({
        id: "readded-picked",
        status: "picked",
        product_name: "220",
        color: "Negro",
        size: "36",
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      }),
    ],
  } as AdminOrder;
  const visible = getOperationalDisplayOrderItems(order);
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.id, "readded-picked");
});
