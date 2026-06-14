/** Parse catalog date: ISO timestamptz or DD/MM/YYYY (FechaIngreso). */
export function parseCatalogDateMs(value: string | null | undefined): number {
  if (value == null || value === "") return 0;
  const text = String(value).trim();
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const d = new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
    if (
      d.getFullYear() === Number(dmy[3]) &&
      d.getMonth() === Number(dmy[2]) - 1 &&
      d.getDate() === Number(dmy[1])
    ) {
      return d.getTime();
    }
    return 0;
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : 0;
}

export function isWithinLastDays(ms: number, days: number): boolean {
  if (ms <= 0) return false;
  return Date.now() - ms <= days * 24 * 60 * 60 * 1000;
}

export function catalogRecencyMs(item: {
  FechaPublicacion?: string | null;
  FechaIngreso?: string | null;
}): number {
  return Math.max(
    parseCatalogDateMs(item.FechaPublicacion),
    parseCatalogDateMs(item.FechaIngreso)
  );
}

export function isCatalogItemRecentWithinDays(
  item: { FechaPublicacion?: string | null; FechaIngreso?: string | null },
  days: number
): boolean {
  return isWithinLastDays(catalogRecencyMs(item), days);
}

export const NUEVOS_INGRESOS_DAYS = 7;
/** Variantes publicadas juntas (±2 min) ≈ primera publicación batch desde admin. */
export const FIRST_PUBLISH_SYNC_MS = 2 * 60 * 1000;
