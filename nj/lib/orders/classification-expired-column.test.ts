/**
 * Tests: columna Vencido — clasificación y cooldown.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getOrderKanbanColumn,
  matchesExpiredTab,
  isExpiredPendingAdminDisassembly,
} from "./classification";
import {
  isExpiryWarnCooldownActive,
  isOrderExpiringWithinOneDay,
  EXPIRY_WARN_COOLDOWN_MS,
} from "./deadline";
import type { AdminOrder, AdminOrderItem } from "../../types/orders";

function baseOrder(overrides: Partial<AdminOrder> = {}): AdminOrder {
  const now = Date.now();
  return {
    id: "o1",
    order_number: "A00001",
    status: "active",
    customer_id: "c1",
    total_amount: 1000,
    notes: null,
    source: "customer",
    created_at: new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString(),
    dismantle_at: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "Prod",
        color: "Negro",
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "picked",
      } as AdminOrderItem,
    ],
    ...overrides,
  };
}

test("status=expired → columna expired", () => {
  const order = baseOrder({
    status: "expired",
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "Prod",
        color: null,
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "expired",
      } as AdminOrderItem,
    ],
  });
  assert.equal(matchesExpiredTab(order), true);
  assert.equal(getOrderKanbanColumn(order), "expired");
});

test("≤1 día para vencer → expired (no cancelled)", () => {
  const order = baseOrder();
  assert.equal(isOrderExpiringWithinOneDay(order), true);
  assert.equal(getOrderKanbanColumn(order), "expired");
});

test("cancelación real con stock pendiente → cancelled (no expired si no vence)", () => {
  const far = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const order = baseOrder({
    dismantle_at: far,
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "Prod",
        color: null,
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "cancelled",
        cancelled_from_status: "picked",
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      } as AdminOrderItem,
    ],
  });
  assert.equal(matchesExpiredTab(order), false);
  assert.equal(getOrderKanbanColumn(order), "cancelled");
});

test("missing→cancelled no manda a Cancelados si el resto está picked", () => {
  const far = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const order = baseOrder({
    dismantle_at: far,
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "A",
        color: null,
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "picked",
      } as AdminOrderItem,
      {
        id: "i2",
        order_id: "o1",
        variant_id: "v2",
        product_name: "B",
        color: null,
        size: "40",
        quantity: 1,
        price_snapshot: 1000,
        status: "cancelled",
        cancelled_from_status: "missing",
        order_item_stock_sources: [{ warehouse_id: "w1", qty: 1 }],
      } as AdminOrderItem,
    ],
  });
  assert.equal(getOrderKanbanColumn(order), "picked");
});

test("vencido pendiente de desarme → expired", () => {
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const order = baseOrder({
    created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    dismantle_at: past,
    status: "active",
    order_items: [
      {
        id: "i1",
        order_id: "o1",
        variant_id: "v1",
        product_name: "Prod",
        color: null,
        size: "38",
        quantity: 1,
        price_snapshot: 1000,
        status: "picked",
      } as AdminOrderItem,
    ],
  });
  assert.equal(isExpiredPendingAdminDisassembly(order), true);
  assert.equal(getOrderKanbanColumn(order), "expired");
});

test("cooldown activo dentro de 24h", () => {
  const sentAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(isExpiryWarnCooldownActive(sentAt), true);
});

test("cooldown expirado después de 24h", () => {
  const sentAt = new Date(Date.now() - EXPIRY_WARN_COOLDOWN_MS - 1000).toISOString();
  assert.equal(isExpiryWarnCooldownActive(sentAt), false);
});

test("cooldown null/invalid → false", () => {
  assert.equal(isExpiryWarnCooldownActive(null), false);
  assert.equal(isExpiryWarnCooldownActive("no-date"), false);
});
