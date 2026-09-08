import {
  createBrowserExclusiveLock,
  checkoutLockName,
  checkoutLeaseStorageKey,
  type ExclusiveLock,
} from "./checkout-lock";

export const CHECKOUT_OP_STORAGE_KEY = "fyl-nj-checkout-op";

export type CheckoutRequest = {
  source: "dashboard-nj";
  action: "checkout_cart";
  cart_fingerprint: string;
};

export type CheckoutOperationStatus = "pending" | "completed" | "failed";

export type PendingCheckoutOperation = {
  operationId: string;
  request: CheckoutRequest;
  status: CheckoutOperationStatus;
  customerId: string;
  createdAt: number;
  updatedAt: number;
};

export type ResolvedCheckoutOperation = PendingCheckoutOperation & {
  markCompleted: () => void;
  markFailed: () => void;
};

export type CheckoutOperationStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type FingerprintableCartItem = {
  variant_id?: string | null;
  size?: string | null;
  qty?: number | null;
  price_snapshot?: number | null;
};

let inFlight = false;
const memoryFallback = new Map<string, string>();

function generateOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function buildCartFingerprint(items: FingerprintableCartItem[]): string {
  if (!items.length) return "empty";
  const lines = items
    .map((item) => ({
      vid: String(item.variant_id ?? "").trim(),
      sz: String(item.size ?? "")
        .trim()
        .toLowerCase(),
      qty: Number(item.qty ?? 0),
      price: Number(item.price_snapshot ?? 0),
    }))
    .sort((a, b) => {
      const k1 = `${a.vid}|${a.sz}`;
      const k2 = `${b.vid}|${b.sz}`;
      return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
    });
  const raw = JSON.stringify(lines);
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}

function defaultStorage(): CheckoutOperationStorage {
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  return {
    getItem(key) {
      return memoryFallback.get(key) ?? null;
    },
    setItem(key, value) {
      memoryFallback.set(key, value);
    },
    removeItem(key) {
      memoryFallback.delete(key);
    },
  };
}

export function checkoutOpStorageKey(customerId: string): string {
  return `${CHECKOUT_OP_STORAGE_KEY}:${customerId}`;
}

function readStored(
  storage: CheckoutOperationStorage,
  customerId: string
): PendingCheckoutOperation | null {
  const raw = storage.getItem(checkoutOpStorageKey(customerId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCheckoutOperation & {
      operation_id?: string;
    };
    const operationId = parsed?.operationId ?? parsed?.operation_id;
    if (!operationId || !parsed.request?.cart_fingerprint) return null;
    if (parsed.request.source !== "dashboard-nj") return null;
    if (
      parsed.status !== "pending" &&
      parsed.status !== "completed" &&
      parsed.status !== "failed"
    ) {
      return null;
    }
    if (parsed.customerId && parsed.customerId !== customerId) return null;
    return {
      operationId,
      request: parsed.request,
      status: parsed.status,
      customerId,
      createdAt: Number(parsed.createdAt ?? 0),
      updatedAt: Number(parsed.updatedAt ?? parsed.createdAt ?? 0),
    };
  } catch {
    return null;
  }
}

function writeStored(storage: CheckoutOperationStorage, value: PendingCheckoutOperation) {
  storage.setItem(checkoutOpStorageKey(value.customerId), JSON.stringify(value));
}

function withMutators(
  storage: CheckoutOperationStorage,
  value: PendingCheckoutOperation
): ResolvedCheckoutOperation {
  writeStored(storage, value);
  return {
    ...value,
    markCompleted() {
      writeStored(storage, {
        ...value,
        status: "completed",
        updatedAt: Date.now(),
      });
    },
    markFailed() {
      if (value.status === "completed") return;
      writeStored(storage, {
        ...value,
        status: "failed",
        updatedAt: Date.now(),
      });
    },
  };
}

export function peekCheckoutOperation(
  customerId: string,
  storage: CheckoutOperationStorage = defaultStorage()
): PendingCheckoutOperation | null {
  return readStored(storage, customerId);
}

export function shouldSkipCheckoutSync(
  customerId: string,
  fingerprint: string,
  storage: CheckoutOperationStorage = defaultStorage()
): boolean {
  const stored = readStored(storage, customerId);
  return stored?.status === "completed" && stored.request.cart_fingerprint === fingerprint;
}

export function clearCheckoutOperation(
  customerId?: string,
  storage: CheckoutOperationStorage = defaultStorage()
) {
  if (customerId) {
    storage.removeItem(checkoutOpStorageKey(customerId));
    return;
  }
  memoryFallback.clear();
}

export function resolveCheckoutOperation(
  fingerprint: string,
  customerId: string,
  storage: CheckoutOperationStorage = defaultStorage(),
  deps?: { uuid?: () => string; now?: () => number }
): ResolvedCheckoutOperation {
  const stored = readStored(storage, customerId);
  const now = deps?.now ?? Date.now;
  const uuid = deps?.uuid ?? generateOperationId;

  if (stored?.status === "pending") {
    return withMutators(storage, {
      ...stored,
      customerId,
      updatedAt: now(),
    });
  }

  if (stored?.status === "completed" && stored.request.cart_fingerprint === fingerprint) {
    return withMutators(storage, stored);
  }

  const created: PendingCheckoutOperation = {
    operationId: uuid(),
    status: "pending",
    customerId,
    createdAt: now(),
    updatedAt: now(),
    request: {
      source: "dashboard-nj",
      action: "checkout_cart",
      cart_fingerprint: fingerprint,
    },
  };
  return withMutators(storage, created);
}

export function markCheckoutCompleted(
  customerId: string,
  storage: CheckoutOperationStorage = defaultStorage()
): void {
  const stored = readStored(storage, customerId);
  if (!stored) return;
  writeStored(storage, {
    ...stored,
    status: "completed",
    updatedAt: Date.now(),
  });
}

export function markCheckoutFailed(
  customerId: string,
  storage: CheckoutOperationStorage = defaultStorage()
): void {
  const stored = readStored(storage, customerId);
  if (!stored || stored.status === "completed") return;
  writeStored(storage, {
    ...stored,
    status: "failed",
    updatedAt: Date.now(),
  });
}

export function acquireCheckoutInFlight(): boolean {
  if (inFlight) return false;
  inFlight = true;
  return true;
}

export function releaseCheckoutInFlight() {
  inFlight = false;
}

export function peekCheckoutInFlight(): boolean {
  return inFlight;
}

export async function withCustomerCheckoutLock<T>(
  customerId: string,
  fn: () => Promise<T>,
  opts?: {
    lock?: ExclusiveLock;
    storage?: CheckoutOperationStorage;
  }
): Promise<T> {
  const storage = opts?.storage ?? defaultStorage();
  const lock = opts?.lock ?? createBrowserExclusiveLock(storage);
  return lock.runExclusive(checkoutLockName(customerId), fn);
}

export const CHECKOUT_IN_FLIGHT_MESSAGE =
  "Ya hay un pedido en proceso. Esperá a que termine.";

export { checkoutLockName, checkoutLeaseStorageKey };
