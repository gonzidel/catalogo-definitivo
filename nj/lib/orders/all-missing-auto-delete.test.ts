/**
 * Tests: aviso de auto-eliminación a los 5 días (pedido con todo sin stock).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getAllMissingAutoDeleteDate } from "./all-missing-auto-delete";

const base = {
  status: "active",
  created_at: "2026-11-10T16:48:52.784Z",
  local_deferred_pickup: false,
  order_items: [{ status: "missing" }, { status: "missing" }, { status: "missing" }],
};

test("todo missing, pedido normal: elimina a los 5 días de creado", () => {
  const d = getAllMissingAutoDeleteDate(base);
  assert.ok(d);
  assert.equal(d.toISOString(), "2026-11-15T16:48:52.784Z");
});

test("closing_soon también aplica", () => {
  assert.ok(getAllMissingAutoDeleteDate({ ...base, status: "closing_soon" }));
});

test("un ítem con stock (reserved) desactiva la regla", () => {
  const order = { ...base, order_items: [{ status: "missing" }, { status: "reserved" }] };
  assert.equal(getAllMissingAutoDeleteDate(order), null);
});

test("un ítem picked desactiva la regla", () => {
  const order = { ...base, order_items: [{ status: "missing" }, { status: "picked" }] };
  assert.equal(getAllMissingAutoDeleteDate(order), null);
});

test("un ítem cancelled desactiva la regla (espeja SQL)", () => {
  const order = { ...base, order_items: [{ status: "missing" }, { status: "cancelled" }] };
  assert.equal(getAllMissingAutoDeleteDate(order), null);
});

test("Retira Local diferido queda fuera", () => {
  assert.equal(getAllMissingAutoDeleteDate({ ...base, local_deferred_pickup: true }), null);
});

test("pedido vencido, cerrado o sin ítems no aplica", () => {
  assert.equal(getAllMissingAutoDeleteDate({ ...base, status: "expired" }), null);
  assert.equal(getAllMissingAutoDeleteDate({ ...base, status: "closed" }), null);
  assert.equal(getAllMissingAutoDeleteDate({ ...base, order_items: [] }), null);
});

test("fecha de creación inválida no aplica", () => {
  assert.equal(getAllMissingAutoDeleteDate({ ...base, created_at: "no-es-fecha" }), null);
  assert.equal(getAllMissingAutoDeleteDate(null), null);
});
