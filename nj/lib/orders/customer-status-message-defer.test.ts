import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMessageFromOrderAndDraft,
  shouldDeferDraftCustomerMessage,
} from "./customer-status-message";
import type { DraftChangesMap } from "./draft-changes";
import type { AdminOrderItem, WarehouseIds } from "@/types/orders";

const wh: WarehouseIds = { general: "wh-general", ventaPublico: "wh-vp" };

function item(id: string, status: string, warehouseId?: string): AdminOrderItem {
  return {
    id,
    order_id: "order-1",
    variant_id: null,
    product_name: `P-${id}`,
    color: "Negro",
    size: "38",
    quantity: 1,
    price_snapshot: 1000,
    status,
    order_item_stock_sources: warehouseId ? [{ warehouse_id: warehouseId, qty: 1 }] : [],
  };
}

const baseOrder = { created_at: "2026-10-08T10:00:00Z", order_number: "A1", dismantle_at: null };
const shipping = { ...baseOrder, local_deferred_pickup: false };
const localDeferred = { ...baseOrder, local_deferred_pickup: true };

test("pedido con espera local previa: el borrador de ✓/✕ difiere el mensaje", () => {
  const items = [item("a", "reserved", "wh-general"), item("b", "waiting", "wh-vp")];
  const pending: DraftChangesMap = { a: { kind: "picked" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, shipping), true);
  assert.equal(buildMessageFromOrderAndDraft(items, pending, wh, shipping), null);
});

test("espera fábrica previa en pedido normal cuenta como confirmado: el mensaje sale ya", () => {
  const items = [item("a", "reserved", "wh-general"), item("b", "waiting", "wh-general")];
  const pending: DraftChangesMap = { a: { kind: "picked" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, shipping), false);
  assert.match(
    buildMessageFromOrderAndDraft(items, pending, wh, shipping) ?? "",
    /Todos los productos de tu pedido ya están apartados/
  );
});

test("espera fábrica previa en local diferido difiere el mensaje", () => {
  const items = [item("a", "awaiting_apartado"), item("b", "waiting", "wh-general")];
  const pending: DraftChangesMap = { a: { kind: "picked" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, localDeferred), true);
});

test("sin esperas en el pedido ni en el borrador: se exige el mensaje", () => {
  const items = [item("a", "reserved", "wh-general"), item("b", "picked", "wh-general")];
  const pending: DraftChangesMap = { a: { kind: "missing" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, shipping), false);
});

test("borrador con espera local sigue difiriendo (comportamiento previo)", () => {
  const items = [item("a", "reserved", "wh-general"), item("b", "reserved", "wh-general")];
  const pending: DraftChangesMap = { a: { kind: "picked" }, b: { kind: "waiting-local" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, shipping), true);
});

test("borrador solo con espera fábrica en pedido normal no difiere (fábrica = confirmado)", () => {
  const items = [item("a", "reserved", "wh-general"), item("b", "reserved", "wh-general")];
  const pending: DraftChangesMap = { a: { kind: "picked" }, b: { kind: "waiting-fabrica" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, shipping), false);
});

test("ítems en espera cancelados no difieren el mensaje", () => {
  const items = [item("a", "reserved", "wh-general"), item("b", "cancelled", "wh-vp")];
  const pending: DraftChangesMap = { a: { kind: "picked" } };
  assert.equal(shouldDeferDraftCustomerMessage(items, pending, wh, shipping), false);
});
