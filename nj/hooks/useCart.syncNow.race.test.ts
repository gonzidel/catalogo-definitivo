/**
 * Replica el control-flow de syncNow() + handleCheckout() post-fix.
 * Debe mantenerse alineado con nj/hooks/useCart.ts y nj/components/cart/CartTab.tsx.
 *
 * Run: npx tsx hooks/useCart.syncNow.race.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const CART_SAVE_ERROR = "No pudimos guardar el carrito. Intentá nuevamente.";

type SyncNow = () => Promise<boolean>;

function createSyncNow(opts: {
  customerId: string | null;
  items: Array<{ variant_id: string; qty: number }>;
  persist: () => Promise<string | null>;
}): { syncNow: SyncNow; getInFlight: () => Promise<boolean> | null } {
  const itemsRef = { current: opts.items };
  const inFlight: { current: Promise<boolean> | null } = { current: null };

  function syncNow(): Promise<boolean> {
    if (inFlight.current) return inFlight.current;

    const run = (async (): Promise<boolean> => {
      if (!opts.customerId) return false;
      const currentItems = itemsRef.current;
      const toSync = currentItems.filter(
        (i) => i.variant_id && !i.variant_id.startsWith("local_") && i.qty > 0
      );
      if (toSync.length === 0) return false;
      const cid = await opts.persist();
      if (!cid) return false;
      return true;
    })();

    inFlight.current = run;
    void run.finally(() => {
      if (inFlight.current === run) inFlight.current = null;
    });
    return run;
  }

  return { syncNow, getInFlight: () => inFlight.current };
}

function createHandleCheckout(opts: {
  requireProfileComplete: () => Promise<boolean>;
  assertSellable: () => Promise<boolean>;
  syncNow: SyncNow;
}) {
  const checkoutLock = { current: false };
  let isCheckingOut = false;
  let checkoutError: string | null = null;
  let checkoutCartCalls = 0;
  let entered = 0;

  async function handleCheckout() {
    if (checkoutLock.current || isCheckingOut) return;
    entered += 1;
    checkoutLock.current = true;
    isCheckingOut = true;
    try {
      const profileOk = await opts.requireProfileComplete();
      if (!profileOk) return;
      checkoutError = null;
      const sellableOk = await opts.assertSellable();
      if (!sellableOk) return;
      const synced = await opts.syncNow();
      if (!synced) {
        checkoutError = CART_SAVE_ERROR;
        return;
      }
      checkoutCartCalls += 1;
    } finally {
      checkoutLock.current = false;
      isCheckingOut = false;
    }
  }

  return {
    handleCheckout,
    getError: () => checkoutError,
    getCheckoutCartCalls: () => checkoutCartCalls,
    getLock: () => checkoutLock.current,
    getEntered: () => entered,
    setStockError() {
      checkoutError = "No pudimos verificar el stock. Intentá nuevamente.";
    },
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("doble syncNow() concurrente → [true, true] y una sola persistencia", async () => {
  let persistStarted = 0;
  let persistFinished = 0;
  const { syncNow } = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => {
      persistStarted += 1;
      await delay(40);
      persistFinished += 1;
      return "cart-1";
    },
  });

  const results = await Promise.all([syncNow(), syncNow()]);

  assert.deepEqual(results, [true, true]);
  assert.equal(persistStarted, 1);
  assert.equal(persistFinished, 1);
});

test("el segundo syncNow espera la promesa en curso y no inicia otra persistencia", async () => {
  let persistCalls = 0;
  const { syncNow } = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => {
      persistCalls += 1;
      await delay(30);
      return "cart-1";
    },
  });

  const first = syncNow();
  const secondResult = await syncNow();
  const firstResult = await first;

  assert.equal(firstResult, true);
  assert.equal(secondResult, true);
  assert.equal(persistCalls, 1);
});

test("triple toque rápido de syncNow: una persistencia, sin ventana residual", async () => {
  let persistCalls = 0;
  const { syncNow, getInFlight } = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => {
      persistCalls += 1;
      await delay(40);
      return "cart-1";
    },
  });

  const results = await Promise.all([syncNow(), syncNow(), syncNow()]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(persistCalls, 1);
  assert.equal(getInFlight(), null);
});

test("doble toque Sí, hacer pedido con perfil lento: un solo checkout, segundo ignorado, lock liberado", async () => {
  const { syncNow } = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => {
      await delay(20);
      return "cart-1";
    },
  });

  const flow = createHandleCheckout({
    requireProfileComplete: async () => {
      await delay(30);
      return true;
    },
    assertSellable: async () => true,
    syncNow,
  });

  await Promise.all([flow.handleCheckout(), flow.handleCheckout()]);

  assert.equal(flow.getEntered(), 1);
  assert.equal(flow.getCheckoutCartCalls(), 1);
  assert.equal(flow.getError(), null);
  assert.equal(flow.getLock(), false);
});

test("perfil incompleto libera el lock", async () => {
  const flow = createHandleCheckout({
    requireProfileComplete: async () => {
      await delay(15);
      return false;
    },
    assertSellable: async () => {
      throw new Error("sellable no debería correr");
    },
    syncNow: async () => {
      throw new Error("syncNow no debería correr");
    },
  });

  await flow.handleCheckout();
  assert.equal(flow.getEntered(), 1);
  assert.equal(flow.getCheckoutCartCalls(), 0);
  assert.equal(flow.getLock(), false);
});

test("error de stock libera el lock y no llama checkout", async () => {
  const flow = createHandleCheckout({
    requireProfileComplete: async () => true,
    assertSellable: async () => {
      await delay(10);
      return false;
    },
    syncNow: async () => {
      throw new Error("syncNow no debería correr");
    },
  });

  await flow.handleCheckout();
  assert.equal(flow.getCheckoutCartCalls(), 0);
  assert.equal(flow.getLock(), false);
});

test("error de sync libera el lock y no crea pedido", async () => {
  const { syncNow } = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => null,
  });

  const flow = createHandleCheckout({
    requireProfileComplete: async () => true,
    assertSellable: async () => true,
    syncNow,
  });

  await flow.handleCheckout();
  assert.equal(flow.getError(), CART_SAVE_ERROR);
  assert.equal(flow.getCheckoutCartCalls(), 0);
  assert.equal(flow.getLock(), false);
});

test("checkout exitoso libera el lock y no duplica pedidos", async () => {
  const { syncNow } = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => "cart-1",
  });

  const flow = createHandleCheckout({
    requireProfileComplete: async () => true,
    assertSellable: async () => true,
    syncNow,
  });

  await Promise.all([
    flow.handleCheckout(),
    flow.handleCheckout(),
    flow.handleCheckout(),
  ]);

  assert.equal(flow.getEntered(), 1);
  assert.equal(flow.getCheckoutCartCalls(), 1);
  assert.equal(flow.getLock(), false);
  assert.equal(flow.getError(), null);
});

test("toSync vacío / sin customerId / persist null siguen devolviendo false", async () => {
  const empty = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "local_abc", qty: 1 }],
    persist: async () => "cart-1",
  });
  assert.equal(await empty.syncNow(), false);

  const noUser = createSyncNow({
    customerId: null,
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => "cart-1",
  });
  assert.equal(await noUser.syncNow(), false);

  const persistFail = createSyncNow({
    customerId: "user-1",
    items: [{ variant_id: "var-1", qty: 1 }],
    persist: async () => null,
  });
  assert.equal(await persistFail.syncNow(), false);
});

test("un false de persistencia no se presenta como error de conexión", async () => {
  assert.equal(CART_SAVE_ERROR.includes("conexión"), false);
  assert.equal(CART_SAVE_ERROR, "No pudimos guardar el carrito. Intentá nuevamente.");
});
