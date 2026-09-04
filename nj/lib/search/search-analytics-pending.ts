const PENDING_KEY = "fyl_search_pending";
const PENDING_TTL_MS = 120_000;
const consumedIds = new Set<string>();

export interface PendingUiSearch {
  id: string;
  q: string;
  ts: number;
}

function normalizeKey(q: string): string {
  return q.trim().toLowerCase();
}

export function markUiSearchCommit(originalQuery: string): void {
  if (typeof window === "undefined") return;
  const q = originalQuery.trim();
  if (q.length < 2) return;
  const pending: PendingUiSearch = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    q,
    ts: Date.now(),
  };
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    /* quota / private mode */
  }
}

/** Una sola vez por commit de UI. Recarga o URL directa → null. */
export function consumeUiSearchCommit(currentQuery: string): PendingUiSearch | null {
  if (typeof window === "undefined") return null;
  const current = currentQuery.trim();
  if (current.length < 2) return null;

  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let pending: PendingUiSearch;
  try {
    pending = JSON.parse(raw) as PendingUiSearch;
  } catch {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }

  if (!pending?.id || !pending.q || Date.now() - pending.ts > PENDING_TTL_MS) {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }

  if (normalizeKey(pending.q) !== normalizeKey(current)) return null;
  if (consumedIds.has(pending.id)) return null;

  consumedIds.add(pending.id);
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
  return pending;
}

export function __resetPendingForTests(): void {
  consumedIds.clear();
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
  }
}
