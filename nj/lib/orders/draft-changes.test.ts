import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
