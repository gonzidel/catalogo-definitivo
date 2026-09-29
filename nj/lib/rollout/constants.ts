export type Experience = "full" | "catalog";
export type RolloutMode = "paused" | "quota" | "open_all" | "kill";
export type GrantSource =
  | "quota"
  | "tester"
  | "tester_link"
  | "staff"
  | "admin"
  | "open_all"
  | "manual";

/** httpOnly. UUID del dispositivo, generado server-side. */
export const VISITOR_COOKIE = "fyl_vid";
/** httpOnly. Experiencia firmada con HMAC (ver cookie.ts). Única fuente que habilita /dashboard. */
export const EXPERIENCE_COOKIE = "fyl_exp";
/**
 * Legible por JS. Solo decide qué variante de UI se pinta (html[data-exp]).
 * Manipularla no habilita rutas protegidas: el middleware valida EXPERIENCE_COOKIE.
 */
export const EXPERIENCE_MIRROR_COOKIE = "fyl_x";
/** Legible por JS, vida corta: la cuenta logueada quedó en catalog. */
export const NOTICE_COOKIE = "fyl_notice";

export const ROLLOUT_TIMEZONE = "America/Argentina/Buenos_Aires";

export const VISITOR_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
export const FULL_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
export const NOTICE_COOKIE_MAX_AGE = 120;
/** Un `full` firmado se revalida contra la base cada tantos días (revocaciones, vínculo de cuenta). */
export const FULL_REVALIDATE_AFTER_DAYS = 7;

const SOURCE_CODES: Record<GrantSource, string> = {
  quota: "q",
  tester: "t",
  tester_link: "l",
  staff: "s",
  admin: "a",
  open_all: "o",
  manual: "m",
};

export const GRANT_SOURCE_BY_CODE = Object.fromEntries(
  Object.entries(SOURCE_CODES).map(([source, code]) => [code, source])
) as Record<string, GrantSource>;
const CODE_SOURCES = GRANT_SOURCE_BY_CODE;

export function sourceToCode(source: GrantSource | null): string {
  return source ? SOURCE_CODES[source] : "-";
}

export function codeToSource(code: string | undefined): GrantSource | null {
  return code ? CODE_SOURCES[code] ?? null : null;
}

export function isGrantSource(value: unknown): value is GrantSource {
  return typeof value === "string" && value in SOURCE_CODES;
}

export function isRolloutMode(value: unknown): value is RolloutMode {
  return value === "paused" || value === "quota" || value === "open_all" || value === "kill";
}

/** Valor de EXPERIENCE_MIRROR_COOKIE: `f.q`, `f.t`, … o `c`. */
export function buildMirrorValue(experience: Experience, source: GrantSource | null): string {
  return experience === "full" ? `f.${sourceToCode(source)}` : "c";
}

export function parseMirrorValue(raw: string | null | undefined): {
  experience: Experience;
  source: GrantSource | null;
} | null {
  if (!raw) return null;
  const [exp, code] = raw.split(".");
  if (exp === "f") return { experience: "full", source: codeToSource(code) };
  if (exp === "c") return { experience: "catalog", source: null };
  return null;
}
