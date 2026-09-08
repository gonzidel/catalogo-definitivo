import assert from "node:assert/strict";
import { test } from "node:test";
import { endExclusive, tryBeginExclusive } from "./intra-tab-lock";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("doble tap PDP: una sola mutación remota/local", async () => {
  const addInFlightRef = { current: false };
  let added = 0;

  async function handleAddAllToCart() {
    if (!tryBeginExclusive(addInFlightRef)) return;
    try {
      await delay(20);
      added += 1;
    } finally {
      endExclusive(addInFlightRef);
    }
  }

  await Promise.all([handleAddAllToCart(), handleAddAllToCart()]);
  assert.equal(added, 1);
});

test("doble tap handleSend: una sola RPC", async () => {
  const sendLockRef = { current: false };
  let rpcCalls = 0;

  async function handleSend() {
    if (!tryBeginExclusive(sendLockRef)) return false;
    try {
      await delay(20);
      rpcCalls += 1;
      return true;
    } finally {
      endExclusive(sendLockRef);
    }
  }

  const [a, b] = await Promise.all([handleSend(), handleSend()]);
  assert.equal(rpcCalls, 1);
  assert.deepEqual([a, b].sort(), [false, true]);
});

test("doble tap cancelar unidades: una sola RPC", async () => {
  const qtyChangeLockRef = { current: false };
  let rpcCalls = 0;

  async function confirmQtyChange() {
    if (!tryBeginExclusive(qtyChangeLockRef)) return;
    try {
      await delay(15);
      rpcCalls += 1;
    } finally {
      endExclusive(qtyChangeLockRef);
    }
  }

  await Promise.all([confirmQtyChange(), confirmQtyChange()]);
  assert.equal(rpcCalls, 1);
});
