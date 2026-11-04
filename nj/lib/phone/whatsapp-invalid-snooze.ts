const SNOOZE_MS = 12 * 60 * 60 * 1000;
const KEY_PREFIX = "fyl.waInvalid.snoozeUntil.";

export function whatsappInvalidSnoozeKey(customerId: string): string {
  return `${KEY_PREFIX}${customerId}`;
}

export function isWhatsappInvalidSnoozed(
  customerId: string,
  nowMs = Date.now()
): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    const raw = localStorage.getItem(whatsappInvalidSnoozeKey(customerId));
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return nowMs < until;
  } catch {
    return false;
  }
}

export function snoozeWhatsappInvalid(
  customerId: string,
  nowMs = Date.now(),
  durationMs = SNOOZE_MS
): number {
  const until = nowMs + durationMs;
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(whatsappInvalidSnoozeKey(customerId), String(until));
    } catch {
      // ignore quota / private mode
    }
  }
  return until;
}

export function clearWhatsappInvalidSnooze(customerId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(whatsappInvalidSnoozeKey(customerId));
  } catch {
    // ignore
  }
}

export const WHATSAPP_INVALID_SNOOZE_MS = SNOOZE_MS;
