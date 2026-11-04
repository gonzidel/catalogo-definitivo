import test from "node:test";
import assert from "node:assert/strict";
import { countsAsOpenOrderForCustomer } from "../admin/orders-domain.js";

test("retiro ya cobrado (closed + local_pickup_fulfilled_at) no cuenta como pedido abierto", () => {
  const order = {
    status: "closed",
    notes: JSON.stringify({
      pau_source: true,
      kanban_scope: "local_pickup",
      retiro_origin: "moved_from_orders",
      local_pickup_fulfilled_at: "2026-09-26T13:18:25.518Z",
    }),
  };
  assert.equal(countsAsOpenOrderForCustomer(order), false);
});

test("cerrado pendiente de envío sigue contando como abierto", () => {
  assert.equal(countsAsOpenOrderForCustomer({ status: "closed", notes: '{"pau_source":true}' }), true);
  assert.equal(countsAsOpenOrderForCustomer({ status: "closed", notes: null }), true);
});

test("retiro cerrado aún sin cobrar sigue contando como abierto", () => {
  const order = { status: "closed", notes: { kanban_scope: "local_pickup" } };
  assert.equal(countsAsOpenOrderForCustomer(order), true);
});

test("activo con local_pickup_fulfilled_at sigue abierto (el índice solo excluye closed)", () => {
  const order = { status: "active", notes: { local_pickup_fulfilled_at: "2026-09-26T13:18:25Z" } };
  assert.equal(countsAsOpenOrderForCustomer(order), true);
});
