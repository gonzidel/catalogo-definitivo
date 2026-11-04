import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminOrder, AdminOrderItem } from "../../types/orders";
import {
  appendExtrasToOrderCardItems,
  buildCustomerOrderNoteExtras,
  countRegularProductUnits,
  filterOrderTotalItems,
  getOrderExtraDisplayName,
  isNoteExtraDisplayItem,
  isPickedOrderItem,
  isSpecialExtraItem,
} from "./domain";

function product(partial: Partial<AdminOrderItem> & Pick<AdminOrderItem, "id">): AdminOrderItem {
  return {
    order_id: "o1",
    variant_id: "v1",
    product_name: "R2545",
    color: "Chocolate",
    size: "Unico",
    quantity: 1,
    price_snapshot: 5000,
    status: "picked",
    ...partial,
  };
}

function specialExtra(partial: Partial<AdminOrderItem> & Pick<AdminOrderItem, "id" | "product_name">): AdminOrderItem {
  return {
    order_id: "o1",
    variant_id: null,
    color: null,
    size: null,
    quantity: 1,
    price_snapshot: 1500,
    status: "picked",
    is_special_extra: true,
    ...partial,
  };
}

test("un extra especial no cuenta como ítem apartado físico", () => {
  const extra = specialExtra({ id: "e1", product_name: "Caja de regalo" });
  assert.equal(isSpecialExtraItem(extra), true);
  assert.equal(isPickedOrderItem(extra), false);
});

test("la lista de la card incluye extras especiales filtrados y extras de notes", () => {
  const pickedProduct = product({ id: "p1" });
  const namedExtra = specialExtra({ id: "e1", product_name: "Caja de regalo" });
  const order = {
    id: "o1",
    notes: JSON.stringify({
      discount: 2000,
      extras_amount: 6000,
      extras_label: "Joyas",
    }),
    order_items: [pickedProduct, namedExtra],
  } as AdminOrder;

  const visible = appendExtrasToOrderCardItems([pickedProduct], order);
  assert.equal(visible.length, 4);
  assert.equal(visible[0].id, "p1");
  assert.equal(visible[1].product_name, "Caja de regalo");
  assert.equal(getOrderExtraDisplayName(visible[2]), "Descuento");
  assert.equal(getOrderExtraDisplayName(visible[3]), "Joyas");
  assert.equal(isNoteExtraDisplayItem(visible[2]), true);
  assert.equal(isNoteExtraDisplayItem(visible[3]), true);
});

test("si no hay extras, la lista visible no cambia", () => {
  const pickedProduct = product({ id: "p1" });
  const order = {
    id: "o1",
    notes: null,
    order_items: [pickedProduct],
  } as AdminOrder;
  const visible = appendExtrasToOrderCardItems([pickedProduct], order);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, "p1");
});

test("dashboard clienta: extra fijo de notes se lista y suma al total (A57414)", () => {
  const { rows, net } = buildCustomerOrderNoteExtras(
    JSON.stringify({ discount: 0, shipping: 0, extras_label: "ALHAJEROS", extras_amount: 8500 }),
    134900
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "ALHAJEROS");
  assert.equal(rows[0].amount, 8500);
  assert.equal(134900 + net, 143400);
});

test("dashboard clienta: descuento y porcentaje de notes ajustan el neto", () => {
  const { rows, net } = buildCustomerOrderNoteExtras(
    JSON.stringify({ discount: 5000, extras_percentage: 10 }),
    20000
  );
  assert.deepEqual(
    rows.map((r) => r.key),
    ["discount", "extras_percentage"]
  );
  assert.equal(net, -5000 + 2000);
});

test("dashboard clienta: notes sin extras no agrega filas", () => {
  assert.deepEqual(buildCustomerOrderNoteExtras(JSON.stringify({ pau_source: true }), 1000), {
    rows: [],
    net: 0,
  });
  assert.deepEqual(buildCustomerOrderNoteExtras(null, 1000), { rows: [], net: 0 });
});

test("filterOrderTotalItems excluye cancelados y vencidos del total", () => {
  const items = [
    { status: "picked", price_snapshot: 1000, quantity: 1 },
    { status: "cancelled", price_snapshot: 5000, quantity: 1 },
    { status: "expired", price_snapshot: 7000, quantity: 1 },
    { status: "missing", price_snapshot: 300, quantity: 1 },
    { status: null, price_snapshot: 200, quantity: 1 },
  ];
  assert.deepEqual(
    filterOrderTotalItems(items).map((i) => i.price_snapshot),
    [1000, 300, 200]
  );
});

test("countRegularProductUnits incluye extras especiales positivos (A56950)", () => {
  const items = [
    product({ id: "p1", quantity: 12 }),
    specialExtra({ id: "e1", product_name: "PERFUME", quantity: 1, price_snapshot: 6000 }),
    specialExtra({ id: "e2", product_name: "COLLAR", quantity: 1, price_snapshot: 6000 }),
    specialExtra({ id: "d1", product_name: "Descuento", quantity: 1, price_snapshot: -1000 }),
  ];
  assert.equal(countRegularProductUnits(items), 14);
});
