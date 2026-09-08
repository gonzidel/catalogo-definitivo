/**
 * Selftest Fase 2 — sellable stock helper.
 * Run: npx tsx lib/stock/sellable-stock.selftest.ts
 */
import {
  applySellableToPdpVariants,
  cartLineStockStatus,
  clampQtyToSellable,
  formatSellableRemaining,
  lookupSellableQty,
  normalizeSellableSize,
  resolveAddLinesFromFreshSellable,
  sellableStockKey,
  sellableSwrKey,
  variantHasSellableStock,
  type SellableByVariant,
} from "./sellable-stock";

let failed = 0;

function check(name: string, cond: boolean) {
  if (!cond) {
    failed += 1;
    console.log(`FAIL ${name}`);
    return;
  }
  console.log(`ok   ${name}`);
}

function expectNever(status: never): never {
  throw new Error(`unhandled status ${String(status)}`);
}

check("norm 35", normalizeSellableSize("35") === "35");
check("norm spaces", normalizeSellableSize(" 35 ") === "35");
check("norm 35.0", normalizeSellableSize("35.0") === "35");
check("norm S", normalizeSellableSize("S") === "S");
check("norm Unico case", normalizeSellableSize("Unico") === "Unico");
check("norm unico case", normalizeSellableSize("unico") === "unico");
check("norm range", normalizeSellableSize("39/40") === "39/40");
check("norm measure", normalizeSellableSize("125x3.5cm") === "125x3.5cm");

check(
  "key uses norm size",
  sellableStockKey("v1", "35.0") === "v1__35"
);
check("swr key sorted unique", sellableSwrKey(["b", "a", "a"])?.[1] === "a");
check("swr key empty", sellableSwrKey([]) === null);

const byVariant: SellableByVariant = new Map([
  [
    "negro",
    new Map([
      ["36", 0],
      ["37", 2],
    ]),
  ],
  ["chocolate", new Map([["36", 0], ["37", 0]])],
]);

check("lookup 35.0 → 36", lookupSellableQty(byVariant, "negro", "36.0") === 0);
check("lookup 37", lookupSellableQty(byVariant, "negro", "37") === 2);
check("lookup missing variant ≠ 0", lookupSellableQty(byVariant, "rojo", "36") === null);
check("lookup missing size ≠ 0", lookupSellableQty(byVariant, "negro", "38") === null);
check("color negro has stock", variantHasSellableStock(byVariant, "negro") === true);
check(
  "color chocolate no stock",
  variantHasSellableStock(byVariant, "chocolate") === false
);

const t1 = cartLineStockStatus(2, 5);
check("test1 disponible", t1.kind === "ok" && t1.sellable === 5);
const t2 = cartLineStockStatus(2, 2);
check("test2 disponible exactamente", t2.kind === "ok" && t2.sellable === 2);
const t3 = cartLineStockStatus(3, 2);
check("test3 insuficiente", t3.kind === "limited" && t3.sellable === 2);
const t4 = cartLineStockStatus(2, 0);
check("test4 sin stock", t4.kind === "out");
const tUnknown = cartLineStockStatus(2, null);
check("error ≠ sin stock", tUnknown.kind === "unknown");
check(
  "miss variant → unknown",
  cartLineStockStatus(1, lookupSellableQty(byVariant, "rojo", "36")).kind === "unknown"
);
check(
  "miss size → unknown",
  cartLineStockStatus(1, lookupSellableQty(byVariant, "negro", "38")).kind === "unknown"
);
check(
  "confirmed 0 → out",
  cartLineStockStatus(1, lookupSellableQty(byVariant, "negro", "36")).kind === "out"
);

check("format 2", formatSellableRemaining(2) === "Solo quedan 2 disponibles");
check("format 1", formatSellableRemaining(1) === "Solo queda 1 disponible");
check("format 0", formatSellableRemaining(0) === "Sin stock");

check("clamp 3 to 2", clampQtyToSellable(3, 2) === 2);
check("clamp 0 sellable", clampQtyToSellable(2, 0) === 0);
check("clamp no add if 0 qty", clampQtyToSellable(0, 5) === 0);

const applied = applySellableToPdpVariants(
  [
    {
      variantId: "negro",
      color: "Negro",
      sku: "n",
      sizes: [
        { size: "36", sku: "n36" },
        { size: "37", sku: "n37" },
      ],
    },
  ],
  byVariant
);
check("pdp 36 disabled source", applied[0]?.sizes[0]?.sellable_qty === 0);
check("pdp 37 buyable", applied[0]?.sizes[1]?.sellable_qty === 2);

const appliedMissing = applySellableToPdpVariants(
  [
    {
      variantId: "rojo",
      color: "Rojo",
      sku: "r",
      sizes: [{ size: "36", sku: "r36" }],
    },
  ],
  byVariant
);
check("pdp miss variant → null", appliedMissing[0]?.sizes[0]?.sellable_qty === null);

const selected = [
  { variantId: "negro", size: "37", qty: 1, color: "Negro" },
];

const addOk = resolveAddLinesFromFreshSellable(selected, {
  ok: true,
  byVariant,
});
check("add fresh stock 1", addOk.ok && addOk.ok && addOk.lines[0]?.qty === 1);

const addStaleThenZero = resolveAddLinesFromFreshSellable(
  [{ variantId: "negro", size: "37", qty: 1, color: "Negro" }],
  {
    ok: true,
    byVariant: new Map([["negro", new Map([["37", 0]])]]),
  }
);
check(
  "add after profile stock 0",
  addStaleThenZero.ok && addStaleThenZero.lines.length === 0
);

const addClamp = resolveAddLinesFromFreshSellable(
  [{ variantId: "negro", size: "37", qty: 2, color: "Negro" }],
  { ok: true, byVariant }
);
check(
  "add qty 2 stock 2 stays limited not out",
  addClamp.ok && addClamp.lines[0]?.qty === 2
);
const addClampLow = resolveAddLinesFromFreshSellable(
  [{ variantId: "negro", size: "37", qty: 3, color: "Negro" }],
  { ok: true, byVariant }
);
check("add qty 3 stock 2 clamps", addClampLow.ok && addClampLow.lines[0]?.qty === 2);

const addQty2Stock1 = resolveAddLinesFromFreshSellable(
  [{ variantId: "negro", size: "37", qty: 2, color: "Negro" }],
  { ok: true, byVariant: new Map([["negro", new Map([["37", 1]])]]) }
);
check(
  "add qty 2 stock 1 clamps to 1",
  addQty2Stock1.ok && addQty2Stock1.lines[0]?.qty === 1
);
check("cart qty 2 stock 1 is limited not out", cartLineStockStatus(2, 1).kind === "limited");

const addMissVariant = resolveAddLinesFromFreshSellable(selected, {
  ok: true,
  byVariant: new Map(),
});
check("add empty map → incomplete", !addMissVariant.ok && addMissVariant.reason === "incomplete");

const addMissSize = resolveAddLinesFromFreshSellable(
  [{ variantId: "negro", size: "38", qty: 1, color: "Negro" }],
  { ok: true, byVariant }
);
check("add miss size → incomplete", !addMissSize.ok && addMissSize.reason === "incomplete");

const addQueryFail = resolveAddLinesFromFreshSellable(selected, {
  ok: false,
  error: { kind: "query_failed", message: "down" },
});
check("add query fail", !addQueryFail.ok && addQueryFail.reason === "query_failed");

const addMix = resolveAddLinesFromFreshSellable(
  [
    { variantId: "negro", size: "37", qty: 1, color: "Negro" },
    { variantId: "rojo", size: "36", qty: 1, color: "Rojo" },
  ],
  { ok: true, byVariant }
);
check(
  "add mix confirmed + miss: only confirmed",
  addMix.ok && addMix.lines.length === 1 && addMix.lines[0]?.variantId === "negro"
);

for (const status of [t1, t2, t3, t4, tUnknown]) {
  switch (status.kind) {
    case "ok":
    case "limited":
    case "out":
    case "unknown":
      break;
    default:
      expectNever(status);
  }
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
