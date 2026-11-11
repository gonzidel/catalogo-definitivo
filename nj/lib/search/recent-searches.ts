const STORAGE_KEY = "fyl_search_recent_v1";
const MAX = 6;

export interface RecentSearch {
  q: string;
  at: number;
}

export function loadRecentSearches(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentSearch[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r && typeof r.q === "string" && r.q.trim().length >= 2)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function pushRecentSearch(q: string): void {
  if (typeof window === "undefined") return;
  const term = q.trim();
  if (term.length < 2) return;
  const prev = loadRecentSearches().filter(
    (r) => r.q.toLowerCase() !== term.toLowerCase()
  );
  const next = [{ q: term, at: Date.now() }, ...prev].slice(0, MAX);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

export function clearRecentSearches(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
