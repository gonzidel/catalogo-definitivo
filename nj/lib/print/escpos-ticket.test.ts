import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEscposTicketText } from "./escpos-ticket";

test("el ticket ESC/POS de Retiro tiene el mismo encabezado que public-sales", () => {
  const text = buildEscposTicketText({
    saleNumber: "V-100",
    createdAt: "2026-09-05T18:00:00.000Z",
    customerName: "Luis Cuadrado",
    orderNumber: "A56457",
    payMethod: "Efectivo",
    items: [{ product_name: "161", color: "Negro", size: "38", qty: 2, price: 26000 }],
    total: 52000,
  });
  assert.match(text, /FYL moda/);
  assert.match(text, /Venta: V-100/);
  assert.match(text, /Pedido: A56457/);
  assert.match(text, /Pago: Efectivo/);
  assert.match(text, /161 - Negro \(38\)/);
  assert.match(text, /TOTAL:/);
  assert.match(text, /DOCUMENTO NO VALIDO/);
});
