import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildClosedOrderCorreoMessage,
  buildClosedOrderTransferMessage,
  isCustomerClosedNotificationKind,
  messageBellAllowsOrderSource,
} from "./closed-order-messages";

test("datos de transferencia: alias y CBU con la etiqueta correcta", () => {
  const messages = [
    buildClosedOrderTransferMessage({ transporte: "Snaider", totalPedido: 1000 }),
    buildClosedOrderCorreoMessage({ totalPedido: 1000, costoEnvio: 500 }),
  ];
  for (const msg of messages) {
    assert.match(msg, /Alias: calzados\.fyl\.2025\n/);
    assert.match(msg, /CBU\/CVU: 0170218940000003684953\n/);
  }
});

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
