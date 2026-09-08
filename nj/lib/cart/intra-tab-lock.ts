export type SyncLock = { current: boolean };

export function tryBeginExclusive(lock: SyncLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endExclusive(lock: SyncLock): void {
  lock.current = false;
}
