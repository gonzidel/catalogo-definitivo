import { ROLLOUT_TIMEZONE } from "./constants";

const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: ROLLOUT_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function artParts(now: Date) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(now).map((p) => [p.type, p.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    secondsIntoDay:
      Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

/** Día calendario ART (YYYY-MM-DD). Mismo criterio que public.fn_rollout_today(). */
export function rolloutDay(now: Date = new Date()): string {
  return artParts(now).day;
}

/** Segundos hasta la medianoche ART (mínimo 60 para no emitir cookies ya vencidas). */
export function secondsUntilRolloutDayEnds(now: Date = new Date()): number {
  return Math.max(60, 86400 - artParts(now).secondsIntoDay);
}

/** Días calendario entre dos fechas YYYY-MM-DD (b - a). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : Number.POSITIVE_INFINITY;
}
