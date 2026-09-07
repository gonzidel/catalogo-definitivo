const STORAGE_KEY = "fyl-order-msg-bell-sent";

function readIds(): string[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function loadBellSentIds(): Set<string> {
  return new Set(readIds());
}

export function persistBellSentId(id: string): Set<string> {
  const next = new Set(readIds());
  next.add(id);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // cuota / modo privado
  }
  return next;
}
