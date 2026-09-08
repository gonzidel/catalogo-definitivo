export const CHECKOUT_LOCK_TTL_MS = 45_000;

export type ExclusiveLock = {
  runExclusive: <T>(lockName: string, fn: () => Promise<T>) => Promise<T>;
};

export type LeaseStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export function checkoutLockName(customerId: string): string {
  return `fyl-nj-checkout:${customerId}`;
}

export function checkoutLeaseStorageKey(customerId: string): string {
  return `fyl-nj-checkout-lease:${customerId}`;
}

type Lease = { holderId: string; until: number };

function readLease(storage: LeaseStorage, key: string): Lease | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Lease;
    if (!parsed?.holderId || typeof parsed.until !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function broadcastLockEvent(lockName: string, type: "released"): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(`fyl-nj-lock:${lockName}`);
    channel.postMessage({ type });
    channel.close();
  } catch {
    /* Safari privado / entornos sin BC */
  }
}

function waitForLockRelease(lockName: string, timeoutMs: number): Promise<void> {
  if (typeof BroadcastChannel === "undefined") {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  }
  return new Promise((resolve) => {
    let channel: BroadcastChannel | null = null;
    const timer = setTimeout(finish, timeoutMs);
    try {
      channel = new BroadcastChannel(`fyl-nj-lock:${lockName}`);
      channel.onmessage = () => finish();
    } catch {
      /* poll only */
    }
    function finish() {
      clearTimeout(timer);
      try {
        channel?.close();
      } catch {
        /* ignore */
      }
      resolve();
    }
  });
}

/**
 * Mutex in-process: serializa callers del mismo lockName.
 * Sirve en tests y como fallback si Web Locks no existe y se comparte el heap.
 */
export function createMutexExclusiveLock(): ExclusiveLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async runExclusive<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(lockName) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        lockName,
        prev.then(() => mine)
      );
      await prev;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/**
 * Lease en storage compartido (localStorage). Si el holder desaparece,
 * otro tab puede tomar el lock cuando `until` vence.
 * BroadcastChannel acorta la espera; el TTL cubre tabs cerrados.
 */
export function createLeaseExclusiveLock(
  storage: LeaseStorage,
  opts?: {
    ttlMs?: number;
    pollMs?: number;
    now?: () => number;
    holderId?: string;
  }
): ExclusiveLock {
  const ttlMs = opts?.ttlMs ?? CHECKOUT_LOCK_TTL_MS;
  const pollMs = opts?.pollMs ?? 40;
  const now = opts?.now ?? (() => Date.now());
  const holderId =
    opts?.holderId ??
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `lease_${Math.random().toString(36).slice(2)}`);

  return {
    async runExclusive<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
      const key = checkoutLeaseStorageKeyFromLockName(lockName);
      const waitDeadline = now() + ttlMs + pollMs;
      while (now() <= waitDeadline) {
        const lease = readLease(storage, key);
        if (!lease || lease.until <= now() || lease.holderId === holderId) {
          storage.setItem(
            key,
            JSON.stringify({ holderId, until: now() + ttlMs } satisfies Lease)
          );
          const confirm = readLease(storage, key);
          if (confirm?.holderId === holderId) {
            try {
              return await fn();
            } finally {
              const cur = readLease(storage, key);
              if (cur?.holderId === holderId) storage.removeItem(key);
              broadcastLockEvent(lockName, "released");
            }
          }
        }
        await waitForLockRelease(lockName, pollMs);
      }
      throw new Error("checkout_lock_timeout");
    },
  };
}

function checkoutLeaseStorageKeyFromLockName(lockName: string): string {
  if (lockName.startsWith("fyl-nj-checkout:")) {
    return checkoutLeaseStorageKey(lockName.slice("fyl-nj-checkout:".length));
  }
  return `fyl-nj-checkout-lease:${lockName}`;
}

export function createBrowserExclusiveLock(storage: LeaseStorage): ExclusiveLock {
  const webLocks =
    typeof navigator !== "undefined"
      ? (
          navigator as Navigator & {
            locks?: {
              request: (name: string, fn: (lock: unknown) => Promise<unknown>) => Promise<unknown>;
            };
          }
        ).locks
      : undefined;

  if (webLocks && typeof webLocks.request === "function") {
    return {
      async runExclusive<T>(lockName: string, fn: () => Promise<T>): Promise<T> {
        return webLocks.request(lockName, () => fn()) as Promise<T>;
      },
    };
  }

  return createLeaseExclusiveLock(storage);
}
