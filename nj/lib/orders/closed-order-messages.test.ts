import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isCustomerClosedNotificationKind,
  messageBellAllowsOrderSource,
} from "./closed-order-messages";

test("avisos de cierre se muestran aunque el pedido sea PAU/admin", () => {
  assert.equal(isCustomerClosedNotificationKind("customer_closed_cod"), true);
  assert.equal(messageBellAllowsOrderSource("customer_closed_cod", { source: "admin" }), true);
  assert.equal(messageBellAllowsOrderSource("customer_closed_transfer", { source: "pau" }), true);
  assert.equal(messageBellAllowsOrderSource("customer_closed_correo", { source: "customer" }), true);
});

test("espera y vencimiento siguen ocultos en pedidos admin/PAU", () => {
  assert.equal(messageBellAllowsOrderSource("local_wait_resolved", { source: "admin" }), false);
  assert.equal(messageBellAllowsOrderSource("expiry_warning", { source: "pau" }), false);
  assert.equal(messageBellAllowsOrderSource("local_wait_resolved", { source: "customer" }), true);
});
