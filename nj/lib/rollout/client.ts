import {
  EXPERIENCE_MIRROR_COOKIE,
  parseMirrorValue,
  type Experience,
  type GrantSource,
} from "./constants";

export const ROLLOUT_UI_ENABLED = process.env.NEXT_PUBLIC_ROLLOUT_ENABLED === "1";

/** Clases que ocultan una variante según html[data-exp] (ver globals.css). */
export const EXP_FULL_ONLY = "exp-full-only";
export const EXP_CATALOG_ONLY = "exp-catalog-only";

export function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function clearCookie(name: string) {
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
}

/** Experiencia a pintar según la cookie espejo. Rollout apagado = full (nj actual). */
export function experienceFromMirror(raw: string | undefined): {
  experience: Experience;
  source: GrantSource | null;
} {
  if (!ROLLOUT_UI_ENABLED) return { experience: "full", source: null };
  return parseMirrorValue(raw) ?? { experience: "catalog", source: null };
}

/**
 * Script inline en <head>: fija html[data-exp] antes del primer paint para que
 * ninguna variante aparezca y desaparezca. Debe coincidir con experienceFromMirror.
 */
export function experienceBootScript(): string {
  const enabled = ROLLOUT_UI_ENABLED ? "1" : "";
  return `(function(){try{var d=document.documentElement,e="full";if("${enabled}"){var m=document.cookie.match(/(?:^|; )${EXPERIENCE_MIRROR_COOKIE}=([^;]*)/);e=m&&decodeURIComponent(m[1]).charAt(0)==="f"?"full":"catalog"}d.setAttribute("data-exp",e)}catch(_){}})();`;
}
