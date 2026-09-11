import assert from "node:assert/strict";
import { test } from "node:test";
import { getOrderKanbanColumn, isFinalOrderStatus } from "./classification";
import type { AdminOrder } from "@/types/orders";

function order(partial: Partial<AdminOrder>): AdminOrder {
  return {
    id: "o1",
    order_number: "A1",
    status: "closed",
    customer_id: "c1",
    total_amount: 1000,
    notes: null,
    source: "customer",
    created_at: "2026-09-11T00:00:00Z",
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "X",
        color: "Negro",
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "picked",
      },
    ],
    ...partial,
  } as AdminOrder;
}

test("retiro cobrado con fulfilled_at no queda en Apartados", () => {
  const closed = order({
    payment_method: "Efectivo",
    notes: JSON.stringify({ local_pickup_fulfilled_at: "2026-09-11T15:00:00Z" }),
    transportName: "Retira local",
  });
  assert.equal(isFinalOrderStatus(closed), true);
  assert.equal(getOrderKanbanColumn(closed), null);
});

test("retiro cerrado sin cobrar sigue en Apartados", () => {
  const awaiting = order({
    payment_method: "Pendiente",
    notes: null,
    local_deferred_pickup: false,
    transportName: "Retira local",
  });
  assert.equal(isFinalOrderStatus(awaiting), false);
  assert.equal(getOrderKanbanColumn(awaiting), "picked");
});
