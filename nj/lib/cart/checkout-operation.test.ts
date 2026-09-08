import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  acquireCheckoutInFlight,
  buildCartFingerprint,
  clearCheckoutOperation,
  peekCheckoutOperation,
  releaseCheckoutInFlight,
  resolveCheckoutOperation,
  type CheckoutOperationStorage,
} from "./checkout-operation";

function memoryStorage(initial?: string): CheckoutOperationStorage {
  let value = initial ?? null;
  return {
    getItem() {
      return value;
    },
    setItem(_key, next) {
      value = next;
    },
    removeItem() {
      value = null;
    },
  };
}

const sampleItems = [
  {
    id: "ci-1",
    variant_id: "var-1",
    product_name: "Botin",
    color: "negro",
    size: "36",
    qty: 2,
    price_snapshot: 10000,
  },
];

afterEach(() => {
  releaseCheckoutInFlight();
  clearCheckoutOperation();
});

test("reuses the same operation_id after an ambiguous/network retry", () => {
  const storage = memoryStorage();
  const fingerprint = buildCartFingerprint(sampleItems);
  const first = resolveCheckoutOperation(fingerprint, storage);
  const retry = resolveCheckoutOperation(fingerprint, storage);

  assert.equal(retry.operationId, first.operationId);
  assert.deepEqual(retry.request, first.request);
  assert.equal(retry.request.cart_fingerprint, fingerprint);
});

test("keeps the original request fingerprint even if the local cart changed mid-flight", () => {
  const storage = memoryStorage();
  const first = resolveCheckoutOperation(buildCartFingerprint(sampleItems), storage);
  const changed = resolveCheckoutOperation(
    buildCartFingerprint([{ ...sampleItems[0], qty: 99 }]),
    storage
  );

  assert.equal(changed.operationId, first.operationId);
  assert.equal(changed.request.cart_fingerprint, first.request.cart_fingerprint);
});

test("replays the completed operation_id on accidental retry of the same cart", () => {
  const storage = memoryStorage();
  const fingerprint = buildCartFingerprint(sampleItems);
  const first = resolveCheckoutOperation(fingerprint, storage);
  first.markCompleted();

  const accidental = resolveCheckoutOperation(fingerprint, storage);
  assert.equal(accidental.operationId, first.operationId);
});

test("starts a new operation_id after a completed checkout when the cart is a new logical attempt", () => {
  const storage = memoryStorage();
  const first = resolveCheckoutOperation(buildCartFingerprint(sampleItems), storage);
  first.markCompleted();
  clearCheckoutOperation(storage);

  const next = resolveCheckoutOperation(
    buildCartFingerprint([{ ...sampleItems[0], qty: 1 }]),
    storage
  );
  assert.notEqual(next.operationId, first.operationId);
});

test("rejects a parallel checkout while one request is in flight", () => {
  assert.equal(acquireCheckoutInFlight(), true);
  assert.equal(acquireCheckoutInFlight(), false);
  releaseCheckoutInFlight();
  assert.equal(acquireCheckoutInFlight(), true);
});

test("peek returns null after clear", () => {
  const storage = memoryStorage();
  resolveCheckoutOperation(buildCartFingerprint(sampleItems), storage);
  assert.ok(peekCheckoutOperation(storage));
  clearCheckoutOperation(storage);
  assert.equal(peekCheckoutOperation(storage), null);
});
