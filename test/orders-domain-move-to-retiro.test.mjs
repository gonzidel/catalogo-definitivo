import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMoveToRetiroNotes,
  isRetiroBoardOrderForLegacyPedidos,
  MOVE_TO_RETIRO_ALLOWED_STATUSES,
} from "../admin/orders-domain.js";

test("enviar al local marca el pedido como Retiro y conserva el resto de las notes", () => {
  const notes = buildMoveToRetiroNotes(JSON.stringify({ shipping: 1500, pau_source: true }));
  const parsed = JSON.parse(notes);
  assert.equal(parsed.kanban_scope, "local_pickup");
  assert.equal(parsed.retiro_origin, "moved_from_orders");
  assert.equal(parsed.shipping, 1500);
  assert.equal(parsed.pau_source, true);
});

test("enviar al local funciona con notes vacías o inválidas", () => {
  for (const raw of [null, undefined, "", "texto libre"]) {
    const parsed = JSON.parse(buildMoveToRetiroNotes(raw));
    assert.equal(parsed.kanban_scope, "local_pickup");
    assert.equal(parsed.retiro_origin, "moved_from_orders");
  }
});

test("enviar al local pisa un kanban_scope=shipping previo", () => {
  const parsed = JSON.parse(buildMoveToRetiroNotes({ kanban_scope: "shipping" }));
  assert.equal(parsed.kanban_scope, "local_pickup");
});

test("el pedido movido es reconocido como Retiro y sale de Pedidos", () => {
  const order = { status: "active", notes: buildMoveToRetiroNotes(null) };
  assert.equal(isRetiroBoardOrderForLegacyPedidos(order), true);
});

test("solo se mueve a Retiro desde estados activos; nunca desde sent/closed/etc.", () => {
  assert.deepEqual(MOVE_TO_RETIRO_ALLOWED_STATUSES, ["active", "closing_soon"]);
  for (const s of ["sent", "closed", "cancelled", "expired", "stock_pending", "devolución"]) {
    assert.equal(MOVE_TO_RETIRO_ALLOWED_STATUSES.includes(s), false);
  }
});
