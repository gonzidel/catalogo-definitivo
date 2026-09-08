import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECKOUT_LOCK_TTL_MS,
  checkoutLeaseStorageKey,
  checkoutLockName,
  createLeaseExclusiveLock,
  createMutexExclusiveLock,
} from "./checkout-lock";
import { runCustomerCheckout } from "./checkout-flow";
import {
  buildCartFingerprint,
  markCheckoutCompleted,
  markCheckoutFailed,
  peekCheckoutOperation,
  resolveCheckoutOperation,
  type CheckoutOperationStorage,
} from "./checkout-operation";

const CID = "cust-lock-tests";
const items = [
  { variant_id: "var-1", size: "52", qty: 1, price_snapshot: 23500 },
  { variant_id: "var-2", size: "46", qty: 1, price_snapshot: 17500 },
];

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

test("dos tabs, mismo carrito, click simultáneo: un operation_id y una RPC", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  let syncCalls = 0;
  let rpcCalls = 0;
  const seenIds = new Set<string>();

  async function tabCheckout() {
    return runCustomerCheckout({
      customerId: CID,
      items,
      storage,
      lock,
      syncNow: async () => {
        syncCalls += 1;
        await delay(20);
        return true;
      },
      rpc: async ({ operationId }) => {
        rpcCalls += 1;
        seenIds.add(operationId);
        await delay(20);
        return { error: null };
      },
    });
  }

  const [a, b] = await Promise.all([tabCheckout(), tabCheckout()]);
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.equal(seenIds.size, 1);
  assert.equal(a.operationId, b.operationId);
  assert.equal(rpcCalls, 1);
  assert.equal(syncCalls, 1);
  const skipped = a.skipped || b.skipped;
  assert.equal(skipped, true);
  assert.equal(peekCheckoutOperation(CID, storage)?.status, "completed");
});

test("dos tabs generan un solo operation_id sobre storage compartido", () => {
  const storage = memoryStorage();
  const fp = buildCartFingerprint(items);
  const a = resolveCheckoutOperation(fp, CID, storage);
  const b = resolveCheckoutOperation(fp, CID, storage);
  assert.equal(a.operationId, b.operationId);
});

test("tab A completa, tab B no re-sync ni llama RPC", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  const first = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => true,
    rpc: async () => ({ error: null }),
  });
  assert.equal(first.success, true);
  assert.equal(first.skipped, undefined);

  const second = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => {
      throw new Error("no-sync");
    },
    rpc: async () => {
      throw new Error("no-rpc");
    },
  });
  assert.equal(second.success, true);
  assert.equal(second.skipped, true);
  assert.equal(second.syncCalls, 0);
  assert.equal(second.rpcCalls, 0);
  assert.equal(second.operationId, first.operationId);
});

test("tab A falla antes del RPC y tab B puede recuperar con un operation_id nuevo", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  const failed = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => false,
    rpc: async () => {
      throw new Error("rpc-should-not-run");
    },
  });
  assert.equal(failed.success, false);
  assert.equal(failed.rpcCalls, 0);
  assert.equal(peekCheckoutOperation(CID, storage)?.status, "failed");
  const failedId = failed.operationId;

  const recovered = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => true,
    rpc: async () => ({ error: null }),
  });
  assert.equal(recovered.success, true);
  assert.notEqual(recovered.operationId, failedId);
  assert.equal(recovered.rpcCalls, 1);
});

test("tab A deja lock huérfano y tab B recupera después del TTL", async () => {
  const storage = memoryStorage();
  const clock = { t: 1_000 };
  const lockB = createLeaseExclusiveLock(storage, {
    now: () => clock.t,
    ttlMs: 100,
    pollMs: 10,
    holderId: "tab-b",
  });
  storage.setItem(
    checkoutLeaseStorageKey(CID),
    JSON.stringify({ holderId: "dead-tab", until: 1_050 })
  );

  let stolen = false;
  const pending = lockB.runExclusive(checkoutLockName(CID), async () => {
    stolen = true;
  });
  await delay(15);
  clock.t = 1_055;
  await pending;
  assert.equal(stolen, true);
});

test("refresh en medio del checkout reusa pending y no crea otro operation_id", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  const fp = buildCartFingerprint(items);
  const pending = resolveCheckoutOperation(fp, CID, storage);
  assert.equal(pending.status, "pending");

  const resumed = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => {
      throw new Error("resume-should-skip-initial-sync");
    },
    rpc: async ({ operationId }) => {
      assert.equal(operationId, pending.operationId);
      return { error: null };
    },
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.operationId, pending.operationId);
  assert.equal(resumed.syncCalls, 0);
  assert.equal(resumed.rpcCalls, 1);
});

test("refresh pending con carrito vacío en server: sync de recuperación y misma operation", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  const pending = resolveCheckoutOperation(buildCartFingerprint(items), CID, storage);
  let rpcAttempt = 0;

  const resumed = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => true,
    rpc: async ({ operationId }) => {
      rpcAttempt += 1;
      assert.equal(operationId, pending.operationId);
      if (rpcAttempt === 1) {
        return { error: { message: "No se encontró un carrito activo" } };
      }
      return { error: null };
    },
  });
  assert.equal(resumed.success, true);
  assert.equal(resumed.operationId, pending.operationId);
  assert.equal(resumed.rpcCalls, 2);
  assert.equal(resumed.syncCalls, 1);
});

test("replay después de completed no vuelve a sync ni RPC", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  const first = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => true,
    rpc: async () => ({ error: null }),
  });
  markCheckoutCompleted(CID, storage);
  assert.equal(peekCheckoutOperation(CID, storage)?.status, "completed");

  const replay = await runCustomerCheckout({
    customerId: CID,
    items,
    storage,
    lock,
    syncNow: async () => {
      throw new Error("replay-sync");
    },
    rpc: async () => {
      throw new Error("replay-rpc");
    },
  });
  assert.equal(replay.success, true);
  assert.equal(replay.skipped, true);
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.syncCalls, 0);
  assert.equal(replay.rpcCalls, 0);
});

test("locks de clientes distintos no se bloquean entre sí", async () => {
  const storage = memoryStorage();
  const lock = createMutexExclusiveLock();
  let overlapping = 0;
  let maxOverlap = 0;

  async function run(customerId: string) {
    return runCustomerCheckout({
      customerId,
      items,
      storage,
      lock,
      syncNow: async () => {
        overlapping += 1;
        maxOverlap = Math.max(maxOverlap, overlapping);
        await delay(30);
        overlapping -= 1;
        return true;
      },
      rpc: async () => ({ error: null }),
    });
  }

  const [a, b] = await Promise.all([run("cust-a"), run("cust-b")]);
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert.notEqual(a.operationId, b.operationId);
  assert.equal(maxOverlap, 2);
});

test("TTL de lock es 45s y no se usa como TTL del operation_id pending", () => {
  assert.equal(CHECKOUT_LOCK_TTL_MS, 45_000);
  const storage = memoryStorage();
  const first = resolveCheckoutOperation(buildCartFingerprint(items), CID, storage);
  markCheckoutFailed(CID, storage);
  assert.equal(peekCheckoutOperation(CID, storage)?.status, "failed");
  assert.equal(first.status, "pending");
});
