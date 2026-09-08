import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  acquireCheckoutInFlight,
  buildCartFingerprint,
  clearCheckoutOperation,
  markCheckoutCompleted,
  markCheckoutFailed,
  peekCheckoutOperation,
  releaseCheckoutInFlight,
  resolveCheckoutOperation,
  shouldSkipCheckoutSync,
  type CheckoutOperationStorage,
} from "./checkout-operation";

const CID = "cust-op-tests";

function memoryStorage(): CheckoutOperationStorage {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, next) {
      values.set(key, next);
    },
    removeItem(key) {
      values.delete(key);
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
  const first = resolveCheckoutOperation(fingerprint, CID, storage);
  const retry = resolveCheckoutOperation(fingerprint, CID, storage);

  assert.equal(retry.operationId, first.operationId);
  assert.deepEqual(retry.request, first.request);
  assert.equal(retry.request.cart_fingerprint, fingerprint);
  assert.equal(retry.status, "pending");
});

test("keeps the original request fingerprint even if the local cart changed mid-flight", () => {
  const storage = memoryStorage();
  const first = resolveCheckoutOperation(buildCartFingerprint(sampleItems), CID, storage);
  const changed = resolveCheckoutOperation(
    buildCartFingerprint([{ ...sampleItems[0], qty: 99 }]),
    CID,
    storage
  );

  assert.equal(changed.operationId, first.operationId);
  assert.equal(changed.request.cart_fingerprint, first.request.cart_fingerprint);
});

test("replays the completed operation_id on accidental retry of the same cart", () => {
  const storage = memoryStorage();
  const fingerprint = buildCartFingerprint(sampleItems);
  const first = resolveCheckoutOperation(fingerprint, CID, storage);
  first.markCompleted();

  const accidental = resolveCheckoutOperation(fingerprint, CID, storage);
  assert.equal(accidental.operationId, first.operationId);
  assert.equal(accidental.status, "completed");
  assert.equal(shouldSkipCheckoutSync(CID, fingerprint, storage), true);
});

test("starts a new operation_id after a completed checkout when the cart is a new logical attempt", () => {
  const storage = memoryStorage();
  const first = resolveCheckoutOperation(buildCartFingerprint(sampleItems), CID, storage);
  first.markCompleted();
  clearCheckoutOperation(CID, storage);

  const next = resolveCheckoutOperation(
    buildCartFingerprint([{ ...sampleItems[0], qty: 1 }]),
    CID,
    storage
  );
  assert.notEqual(next.operationId, first.operationId);
});

test("failed operation does not reuse the same operation_id", () => {
  const storage = memoryStorage();
  const fingerprint = buildCartFingerprint(sampleItems);
  const first = resolveCheckoutOperation(fingerprint, CID, storage);
  markCheckoutFailed(CID, storage);
  const next = resolveCheckoutOperation(fingerprint, CID, storage);
  assert.notEqual(next.operationId, first.operationId);
  assert.equal(next.status, "pending");
});

test("two tabs sharing localStorage resolve a single operation_id", () => {
  const shared = memoryStorage();
  const fp = buildCartFingerprint(sampleItems);
  const a = resolveCheckoutOperation(fp, CID, shared);
  const b = resolveCheckoutOperation(fp, CID, shared);
  assert.equal(a.operationId, b.operationId);
});

test("operation state is keyed by customer, not global", () => {
  const shared = memoryStorage();
  const fp = buildCartFingerprint(sampleItems);
  const a = resolveCheckoutOperation(fp, "cust-a", shared);
  const b = resolveCheckoutOperation(fp, "cust-b", shared);
  assert.notEqual(a.operationId, b.operationId);
  assert.equal(peekCheckoutOperation("cust-a", shared)?.operationId, a.operationId);
  assert.equal(peekCheckoutOperation("cust-b", shared)?.operationId, b.operationId);
});

test("rejects a parallel checkout while one request is in flight", () => {
  assert.equal(acquireCheckoutInFlight(), true);
  assert.equal(acquireCheckoutInFlight(), false);
  releaseCheckoutInFlight();
  assert.equal(acquireCheckoutInFlight(), true);
});

test("peek returns null after clear", () => {
  const storage = memoryStorage();
  resolveCheckoutOperation(buildCartFingerprint(sampleItems), CID, storage);
  assert.ok(peekCheckoutOperation(CID, storage));
  clearCheckoutOperation(CID, storage);
  assert.equal(peekCheckoutOperation(CID, storage), null);
});

test("markCompleted does not get overwritten by markFailed", () => {
  const storage = memoryStorage();
  const first = resolveCheckoutOperation(buildCartFingerprint(sampleItems), CID, storage);
  markCheckoutCompleted(CID, storage);
  markCheckoutFailed(CID, storage);
  assert.equal(peekCheckoutOperation(CID, storage)?.status, "completed");
  assert.equal(peekCheckoutOperation(CID, storage)?.operationId, first.operationId);
});
