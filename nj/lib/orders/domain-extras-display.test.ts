import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminOrder, AdminOrderItem } from "../../types/orders";
import {
  appendExtrasToOrderCardItems,
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
