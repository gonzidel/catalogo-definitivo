import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectDraftZeroStockTargets,
  draftChangeLabel,
  draftDefersCustomerMessage,
  draftHasWaitingFabrica,
  draftHasWaitingLocal,
  type DraftChangesMap,
} from "./draft-changes";

const mixedSplit: DraftChangesMap = {
  item: {
    kind: "split",
    nPicked: 0,
    nWaiting: 2,
    nMissing: 0,
    waitingSource: "fabrica",
    nFabrica: 1,
    nLocal: 1,
  },
};

test("draftHasWaitingLocal es true si el split mezcla 1 local y 1 fábrica", () => {
  assert.equal(draftHasWaitingLocal(mixedSplit), true);
});

test("draftHasWaitingFabrica sigue siendo true en un split mixto", () => {
  assert.equal(draftHasWaitingFabrica(mixedSplit), true);
});

test("draftDefersCustomerMessage oculta Mensaje/Enviar si hay al menos una unidad local", () => {
  assert.equal(draftDefersCustomerMessage(mixedSplit, { local_deferred_pickup: false }), true);
});

test("draftHasWaitingLocal es false si el split es solo fábrica", () => {
  assert.equal(
    draftHasWaitingLocal({
      item: { kind: "split", nWaiting: 2, waitingSource: "fabrica", nFabrica: 2, nLocal: 0 },
    }),
    false
  );
});

test("draftHasWaitingLocal es true si el split es solo local", () => {
  assert.equal(
    draftHasWaitingLocal({
      item: { kind: "split", nWaiting: 2, waitingSource: "local", nFabrica: 0, nLocal: 2 },
    }),
    true
  );
});

test("draftChangeLabel muestra fábrica y local cuando el split está mezclado", () => {
  const label = draftChangeLabel(mixedSplit.item, "Local");
  assert.match(label, /1 espera \(Fábrica\)/);
  assert.match(label, /1 espera \(Local\)/);
});

test("en Retiro el split mixto también oculta Mensaje/Enviar y etiqueta Depósito", () => {
  assert.equal(draftDefersCustomerMessage(mixedSplit, { local_deferred_pickup: false }), true);
  const label = draftChangeLabel(mixedSplit.item, "Depósito");
  assert.match(label, /1 espera \(Fábrica\)/);
  assert.match(label, /1 espera \(Depósito\)/);
});

const stockItems = [
  { id: "a", variant_id: "v1", size: "38" },
  { id: "b", variant_id: "v1", size: "38" },
  { id: "c", variant_id: "v2", size: " 40 " },
  { id: "d", variant_id: null, size: "39" },
  { id: "e", variant_id: "v3", size: "" },
  { id: "f", variant_id: "v4", size: "36" },
];

test("collectDraftZeroStockTargets toma solo los 'sin stock' con zeroStock (✕ y repartos)", () => {
  const targets = collectDraftZeroStockTargets(
    {
      a: { kind: "missing", zeroStock: true },
      c: { kind: "split", nPicked: 1, nWaiting: 0, nMissing: 1, zeroStock: true },
      f: { kind: "missing", zeroStock: false },
    },
    stockItems
  );
  assert.deepEqual(targets, [
    { itemId: "a", variantId: "v1", size: "38" },
    { itemId: "c", variantId: "v2", size: "40" },
  ]);
});

test("collectDraftZeroStockTargets deduplica variante+talle y conserva el primer ítem", () => {
  const targets = collectDraftZeroStockTargets(
    { a: { kind: "missing", zeroStock: true }, b: { kind: "missing", zeroStock: true } },
    stockItems
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].itemId, "a");
});

test("collectDraftZeroStockTargets ignora ítems sin variante/talle, inexistentes y splits sin unidades sin stock", () => {
  const targets = collectDraftZeroStockTargets(
    {
      d: { kind: "missing", zeroStock: true },
      e: { kind: "missing", zeroStock: true },
      zzz: { kind: "missing", zeroStock: true },
      f: { kind: "split", nPicked: 1, nWaiting: 0, nMissing: 0, zeroStock: true },
      b: { kind: "picked", zeroStock: true },
    },
    stockItems
  );
  assert.deepEqual(targets, []);
});

test("draftChangeLabel avisa cuando el sin stock también deja el stock en 0", () => {
  assert.equal(draftChangeLabel({ kind: "missing" }), "Sin stock");
  assert.equal(draftChangeLabel({ kind: "missing", zeroStock: true }), "Sin stock · stock a 0");
  assert.match(
    draftChangeLabel({ kind: "split", nPicked: 1, nMissing: 1, zeroStock: true }),
    /1 sin stock \(stock a 0\)/
  );
});
