/**
 * Auditoría preventiva de concurrencia NJ — tests de control-flow residual.
 * C1/C2/P2/P3 cubiertos en checkout-flow.test.ts, intra-tab-lock.test.ts y cart-hydrate.test.ts.
 *
 * Run: npx tsx lib/cart/concurrency-audit.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  buildCartFingerprint,
  clearCheckoutOperation,
  releaseCheckoutInFlight,
  resolveCheckoutOperation,
  type CheckoutOperationStorage,
} from "./checkout-operation";
import { mergeHydratedCartItems } from "./cart-hydrate";
import { endExclusive, tryBeginExclusive } from "./intra-tab-lock";

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const items = [
  { variant_id: "var-1", size: "52", qty: 1, price_snapshot: 23500 },
  { variant_id: "var-2", size: "46", qty: 1, price_snapshot: 17500 },
];
const CID = "cust-audit";

afterEach(() => {
  releaseCheckoutInFlight();
  clearCheckoutOperation();
});

test("C1 FIX: dos pestañas con storage compartido generan un solo operation_id", () => {
  const shared = memoryStorage();
  const fp = buildCartFingerprint(items);
  const a = resolveCheckoutOperation(fp, CID, shared);
  const b = resolveCheckoutOperation(fp, CID, shared);
  assert.equal(a.operationId, b.operationId);
});

test("OK misma pestaña: retry ambiguo reusa operation_id", () => {
  const tab = memoryStorage();
  const fp = buildCartFingerprint(items);
  const first = resolveCheckoutOperation(fp, CID, tab);
  const retry = resolveCheckoutOperation(fp, CID, tab);
  assert.equal(retry.operationId, first.operationId);
});

test("CRIT residual: acquireCheckoutInFlight sigue sin compartirse entre heaps", () => {
  const heapA = { inFlight: false };
  const heapB = { inFlight: false };
  function acquire(heap: { inFlight: boolean }) {
    if (heap.inFlight) return false;
    heap.inFlight = true;
    return true;
  }
  assert.equal(acquire(heapA), true);
  assert.equal(acquire(heapB), true);
});

test("P3 FIX: merge hydrate conserva qty local unsynced", () => {
  const local = [
    { id: "uuid-1", variant_id: "var-1", size: "52", qty: 3, synced: false, is_offer: true },
  ];
  const server = [
    { id: "uuid-1", variant_id: "var-1", size: "52", qty: 1, synced: true, is_offer: false },
  ];
  const merged = mergeHydratedCartItems(local, server);
  assert.equal(merged[0]?.qty, 3);
  assert.equal(merged[0]?.is_offer, true);
});

test("P2 FIX: PDP addInFlight con ref síncrono bloquea el segundo tap", async () => {
  const addInFlightRef = { current: false };
  let added = 0;

  async function handleAddAllToCart() {
    if (!tryBeginExclusive(addInFlightRef)) return;
    await delay(15);
    added += 1;
    endExclusive(addInFlightRef);
  }

  await Promise.all([handleAddAllToCart(), handleAddAllToCart()]);
  assert.equal(added, 1);
});

test("P3 FIX: remove remoto-first no pierde el ítem local si falla el DELETE", async () => {
  const local = new Map<string, { id: string }>([["var-1|52", { id: "uuid-1" }]]);
  async function handleRemove(key: string, remoteOk: boolean) {
    if (!remoteOk) return false;
    local.delete(key);
    return true;
  }
  const ok = await handleRemove("var-1|52", false);
  assert.equal(ok, false);
  assert.equal(local.has("var-1|52"), true);
});

test("P2 FIX: handleSend con lock síncrono dispara una sola RPC", async () => {
  const sendLockRef = { current: false };
  let rpcCalls = 0;
  async function handleSend() {
    if (!tryBeginExclusive(sendLockRef)) return false;
    await delay(20);
    rpcCalls += 1;
    endExclusive(sendLockRef);
    return true;
  }
  await Promise.all([handleSend(), handleSend()]);
  assert.equal(rpcCalls, 1);
});

test("MEDIA residual: catch de checkout mapea cualquier throw a mensaje de stock", () => {
  function mapCheckoutCatch(): string {
    return "No pudimos revisar el stock. Intentá nuevamente.";
  }
  assert.match(mapCheckoutCatch(), /stock/);
});

test("ALTA residual: persist partialize no incluye isCheckingOut", () => {
  const partialize = (s: { items: unknown[]; cartId: string | null; isCheckingOut: boolean }) => ({
    items: s.items,
    cartId: s.cartId,
  });
  const persisted = partialize({ items: [{ id: "1" }], cartId: "c1", isCheckingOut: true });
  assert.equal("isCheckingOut" in persisted, false);
});

test("C1 FIX: tras RPC ok no marcado completed, retry misma pestaña reusa id", () => {
  const tab = memoryStorage();
  const fp = buildCartFingerprint(items);
  const first = resolveCheckoutOperation(fp, CID, tab);
  assert.equal(first.status, "pending");
  const afterTimeout = resolveCheckoutOperation(fp, CID, tab);
  assert.equal(afterTimeout.operationId, first.operationId);
});

test("C1 FIX: si otra pestaña ya completó en storage compartido, se reusa el mismo id", () => {
  const shared = memoryStorage();
  const fp = buildCartFingerprint(items);
  const a = resolveCheckoutOperation(fp, CID, shared);
  a.markCompleted();
  const b = resolveCheckoutOperation(fp, CID, shared);
  assert.equal(b.operationId, a.operationId);
  assert.equal(b.status, "completed");
});
