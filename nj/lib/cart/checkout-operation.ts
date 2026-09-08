export const CHECKOUT_OP_STORAGE_KEY = "fyl-nj-checkout-op";

export type CheckoutRequest = {
  source: "dashboard-nj";
  action: "checkout_cart";
  cart_fingerprint: string;
};

export type PendingCheckoutOperation = {
  operationId: string;
  request: CheckoutRequest;
  status: "pending" | "completed";
};

export type ResolvedCheckoutOperation = PendingCheckoutOperation & {
  markCompleted: () => void;
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
let memoryFallback: string | null = null;

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
      sz: String(item.size ?? "").trim().toLowerCase(),
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
  if (typeof sessionStorage !== "undefined") return sessionStorage;
  return {
    getItem() {
      return memoryFallback;
    },
    setItem(_key, value) {
      memoryFallback = value;
    },
    removeItem() {
      memoryFallback = null;
    },
  };
}

function readStored(storage: CheckoutOperationStorage): PendingCheckoutOperation | null {
  const raw = storage.getItem(CHECKOUT_OP_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCheckoutOperation;
    if (!parsed?.operationId || !parsed.request?.cart_fingerprint) return null;
    if (parsed.request.source !== "dashboard-nj") return null;
    if (parsed.status !== "pending" && parsed.status !== "completed") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(storage: CheckoutOperationStorage, value: PendingCheckoutOperation) {
  storage.setItem(CHECKOUT_OP_STORAGE_KEY, JSON.stringify(value));
}

export function peekCheckoutOperation(
  storage: CheckoutOperationStorage = defaultStorage()
): PendingCheckoutOperation | null {
  return readStored(storage);
}

export function clearCheckoutOperation(
  storage: CheckoutOperationStorage = defaultStorage()
) {
  storage.removeItem(CHECKOUT_OP_STORAGE_KEY);
  memoryFallback = null;
}

export function resolveCheckoutOperation(
  fingerprint: string,
  storage: CheckoutOperationStorage = defaultStorage()
): ResolvedCheckoutOperation {
  const stored = readStored(storage);
  const persist = (next: PendingCheckoutOperation): ResolvedCheckoutOperation => {
    writeStored(storage, next);
    return {
      ...next,
      markCompleted() {
        writeStored(storage, { ...next, status: "completed" });
      },
    };
  };

  if (stored?.status === "pending") {
    return persist(stored);
  }

  if (stored?.status === "completed" && stored.request.cart_fingerprint === fingerprint) {
    return persist(stored);
  }

  const created: PendingCheckoutOperation = {
    operationId: generateOperationId(),
    status: "pending",
    request: {
      source: "dashboard-nj",
      action: "checkout_cart",
      cart_fingerprint: fingerprint,
    },
  };
  return persist(created);
}

export function acquireCheckoutInFlight(): boolean {
  if (inFlight) return false;
  inFlight = true;
  return true;
}

export function releaseCheckoutInFlight() {
  inFlight = false;
}

export const CHECKOUT_IN_FLIGHT_MESSAGE =
  "Ya hay un pedido en proceso. Esperá a que termine.";
