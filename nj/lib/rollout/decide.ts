import { FULL_REVALIDATE_AFTER_DAYS, type Experience, type RolloutMode } from "./constants";
import type { SignedExperience } from "./cookie";
import { daysBetween } from "./day";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVisitorId(value: string | undefined | null): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Cookie firmada vigente:
 *  - catalog: solo el mismo día ART (al día siguiente vuelve a ser candidata).
 *  - full: siempre; `fresh` indica si toca revalidar contra la base.
 */
export function evaluateSigned(
  signed: SignedExperience | null,
  today: string
): { usable: boolean; fresh: boolean } {
  if (!signed) return { usable: false, fresh: false };
  if (signed.experience === "catalog") {
    const sameDay = signed.day === today;
    return { usable: sameDay, fresh: sameDay };
  }
  return { usable: true, fresh: daysBetween(signed.day, today) < FULL_REVALIDATE_AFTER_DAYS };
}

/** ¿Hay que llamar a rpc_rollout_resolve en esta request? */
export function shouldResolve(input: {
  mode: RolloutMode;
  current: SignedExperience | null;
  fresh: boolean;
  door: boolean;
  bot: boolean;
  /** Navegación de documento, o ruta que exige sesión con usuario ya verificado. */
  eligibleRequest: boolean;
}): boolean {
  if (input.mode === "kill" || input.bot || !input.eligibleRequest) return false;
  if (!input.current) return true;
  if (input.current.experience === "full") return !input.fresh;
  return input.door;
}

/** Experiencia que se pinta. kill manda sobre todo sin tocar la cookie firmada. */
export function displayExperience(
  mode: RolloutMode,
  current: SignedExperience | null
): Experience {
  if (mode === "kill") return "catalog";
  return current?.experience ?? "catalog";
}

/**
 * /dashboard exige `full` firmado. En kill queda cerrado para clientes aunque tengan
 * grant (el grant se conserva); solo pasa staff/admin verificado en public.admins.
 */
export function canEnterFullArea(
  mode: RolloutMode,
  current: SignedExperience | null,
  isVerifiedStaff: boolean
): boolean {
  if (mode === "kill") return isVerifiedStaff;
  return current?.experience === "full";
}
