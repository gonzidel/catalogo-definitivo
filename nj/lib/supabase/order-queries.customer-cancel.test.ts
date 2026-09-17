import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCustomerCancelOrderResult } from "./order-queries";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";

test("acepta cancelación terminal conservada y verificada", () => {
  const result = parseCustomerCancelOrderResult(
    {
      ok: true,
      verified: true,
      idempotent_replay: false,
      order_id: ORDER_ID,
      order_number: "A56917",
      items_cancelled: 3,
      had_picked: false,
      order_status: "cancelled",
      order_deleted: false,
    },
    ORDER_ID
  );

  assert.equal(result.order_status, "cancelled");
  assert.equal(result.items_cancelled, 3);
});

test("acepta reintento verificado de un pedido ya archivado", () => {
  const result = parseCustomerCancelOrderResult(
    {
      ok: true,
      verified: true,
      idempotent_replay: true,
      order_id: ORDER_ID,
      order_number: "A56580",
      items_cancelled: 0,
      had_picked: false,
      order_status: "deleted",
      order_deleted: true,
    },
    ORDER_ID
  );

  assert.equal(result.idempotent_replay, true);
  assert.equal(result.order_deleted, true);
});

test("rechaza HTTP exitoso sin postcondición verificada", () => {
  assert.throws(
    () =>
      parseCustomerCancelOrderResult(
        {
          ok: true,
          order_id: ORDER_ID,
          order_status: "cancelled",
          order_deleted: false,
        },
        ORDER_ID
      ),
    /verificar|confirmación/
  );
});

test("rechaza pedido distinto o estado terminal incoherente", () => {
  assert.throws(() =>
    parseCustomerCancelOrderResult(
      {
        ok: true,
        verified: true,
        order_id: "22222222-2222-4222-8222-222222222222",
        order_status: "deleted",
        order_deleted: false,
      },
      ORDER_ID
    )
  );
});
