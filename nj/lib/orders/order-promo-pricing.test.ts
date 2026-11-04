import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminOrder, AdminOrderItem } from "@/types/orders";
import {
  computeOrderPromoPricing,
  toBuenosAiresDate,
  type OrderPromoDefinition,
  type OrderPromoPricedItem,
} from "./order-promo-pricing";
import { buildSaleItems, getRetiroSaleTotals } from "./retiro-finalize-sale";

const promo2x28: OrderPromoDefinition = {
  promotion_id: "promo-28",
  promo_type: "2xMonto",
  fixed_amount: 28000,
  start_date: "2026-10-05",
  end_date: "2026-10-31",
  variant_ids: ["pr1-negro", "pr1-suela", "pr2-suela"],
};

function priced(id: string, variant: string, qty: number, loadedOn = "2026-10-06"): OrderPromoPricedItem {
  return { id, variant_id: variant, quantity: qty, price_snapshot: 16000, loaded_on: loadedOn };
}

test("2 productos de la promo: 1 oferta, descuento 4.000", () => {
  const pricing = computeOrderPromoPricing(
    [priced("a", "pr1-negro", 1), priced("b", "pr2-suela", 1)],
    [promo2x28]
  );
  assert.equal(pricing.discount, 4000);
  assert.deepEqual(pricing.lines.map((l) => [l.label, l.amount]), [["1 oferta 2x$28.000", 28000]]);
  assert.deepEqual(pricing.coveredQtyByItemId, { a: 1, b: 1 });
});

test("3 productos: 1 oferta y 1 suelto a precio normal", () => {
  const pricing = computeOrderPromoPricing(
    [priced("a", "pr1-negro", 1), priced("b", "pr2-suela", 1), priced("c", "pr1-suela", 1)],
    [promo2x28]
  );
  assert.equal(pricing.discount, 4000);
  assert.equal(pricing.lines[0].groups, 1);
  assert.equal(pricing.coveredQtyByItemId.c, undefined);
});

test("4 productos (o 3 + 1 agregado después): 2 ofertas", () => {
  const pricing = computeOrderPromoPricing(
    [
      priced("a", "pr1-negro", 1),
      priced("b", "pr2-suela", 1),
      priced("c", "pr1-suela", 1),
      priced("d", "pr1-negro", 1, "2026-10-08"),
    ],
    [promo2x28]
  );
  assert.equal(pricing.discount, 8000);
  assert.deepEqual(pricing.lines.map((l) => [l.label, l.amount]), [["2 ofertas 2x$28.000", 56000]]);
});

test("una línea con cantidad 3 se parte: 2 en la oferta y 1 suelta", () => {
  const pricing = computeOrderPromoPricing([priced("a", "pr1-negro", 3)], [promo2x28]);
  assert.equal(pricing.coveredQtyByItemId.a, 2);
  assert.equal(pricing.discount, 4000);
});

test("solo cuentan unidades cargadas mientras la promo estaba vigente", () => {
  const before = computeOrderPromoPricing(
    [priced("a", "pr1-negro", 1, "2026-10-04"), priced("b", "pr2-suela", 1)],
    [promo2x28]
  );
  assert.equal(before.discount, 0);
  assert.equal(before.lines.length, 0);

  const loadedDuringPromo = computeOrderPromoPricing(
    [priced("a", "pr1-negro", 1, "2026-10-31"), priced("b", "pr2-suela", 1, "2026-10-10")],
    [promo2x28]
  );
  assert.equal(loadedDuringPromo.discount, 4000);

  const afterEnd = computeOrderPromoPricing(
    [priced("a", "pr1-negro", 1, "2026-11-01"), priced("b", "pr2-suela", 1, "2026-11-01")],
    [promo2x28]
  );
  assert.equal(afterEnd.discount, 0);
});

test("fecha de carga en hora argentina", () => {
  assert.equal(toBuenosAiresDate("2026-10-05T02:30:00Z"), "2026-10-04");
  assert.equal(toBuenosAiresDate("2026-10-05T03:30:00Z"), "2026-10-05");
});

function orderItem(id: string, variant: string | null, qty: number, price: number, extra: Partial<AdminOrderItem> = {}): AdminOrderItem {
  return {
    id,
    order_id: "o1",
    variant_id: variant,
    product_name: variant ? "PR1" : "Extra",
    color: variant ? "Negro" : null,
    size: variant ? "39" : null,
    quantity: qty,
    price_snapshot: price,
    status: "picked",
    ...extra,
  };
}

const retiroOrder: AdminOrder = {
  id: "o1",
  order_number: "A1",
  status: "active",
  customer_id: "c1",
  total_amount: 0,
  notes: null,
  source: "admin",
  created_at: "2026-10-06T12:00:00Z",
  order_items: [
    orderItem("a", "pr1-negro", 3, 16000),
    orderItem("b", "otro", 1, 10000),
    orderItem("x", "pr1-negro", 1, 16000, { status: "missing" }),
  ],
};

test("cobro Retiro: unidades del par a $0 + línea de oferta; total con descuento", () => {
  const pricing = computeOrderPromoPricing([priced("a", "pr1-negro", 3)], [promo2x28]);
  const { items, totals } = buildSaleItems(retiroOrder, 0, 0, pricing);

  const prLines = items.filter((i) => i.variant_id === "pr1-negro");
  assert.deepEqual(
    prLines.map((i) => [i.qty, i.price, i.source?.venta_publico]),
    [
      [2, 0, 2],
      [1, 16000, 1],
    ]
  );
  const promoLine = items.find((i) => i.is_special_extra);
  assert.deepEqual([promoLine?.product_name, promoLine?.price], ["1 oferta 2x$28.000", 28000]);

  const linesSum = items.reduce((sum, i) => sum + i.qty * i.price, 0);
  assert.equal(linesSum, 28000 + 16000 + 10000);
  assert.equal(totals.total, linesSum);
  assert.equal(totals.promoDiscount, 4000);
  assert.equal(totals.productUnits, 4);
});

test("sin promos el cobro no cambia", () => {
  const totals = getRetiroSaleTotals(retiroOrder, 0, 0);
  assert.equal(totals.total, 3 * 16000 + 10000);
  assert.equal(totals.promoDiscount, 0);
});
