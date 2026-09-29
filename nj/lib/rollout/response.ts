import type { NextResponse } from "next/server";
import {
  EXPERIENCE_COOKIE,
  EXPERIENCE_MIRROR_COOKIE,
  FULL_COOKIE_MAX_AGE,
  NOTICE_COOKIE,
  NOTICE_COOKIE_MAX_AGE,
  VISITOR_COOKIE,
  VISITOR_COOKIE_MAX_AGE,
  buildMirrorValue,
  type Experience,
  type GrantSource,
} from "./constants";
import { signExperience, type SignedExperience } from "./cookie";
import { secondsUntilRolloutDayEnds } from "./day";

export interface ExperienceCookieWrite {
  secure: boolean;
  visitorId: string;
  /** Emitir fyl_vid (visitante nuevo). */
  setVisitor: boolean;
  /** Valor a firmar en fyl_exp; null = no tocar la cookie firmada. */
  sign: SignedExperience | null;
  cookieSecret: string;
  /** Lo que se pinta (fyl_x). */
  display: Experience;
  displaySource: GrantSource | null;
  /** fyl_x actual de la request, para no reescribirla si no cambió. */
  currentMirror: string | undefined;
  notice?: boolean;
}

export async function writeExperienceCookies(res: NextResponse, w: ExperienceCookieWrite) {
  const base = { path: "/", sameSite: "lax" as const, secure: w.secure };
  const catalogMaxAge = secondsUntilRolloutDayEnds();

  if (w.setVisitor) {
    res.cookies.set(VISITOR_COOKIE, w.visitorId, {
      ...base,
      httpOnly: true,
      maxAge: VISITOR_COOKIE_MAX_AGE,
    });
  }

  if (w.sign) {
    res.cookies.set(EXPERIENCE_COOKIE, await signExperience(w.cookieSecret, w.visitorId, w.sign), {
      ...base,
      httpOnly: true,
      maxAge: w.sign.experience === "full" ? FULL_COOKIE_MAX_AGE : catalogMaxAge,
    });
  }

  const mirror = buildMirrorValue(w.display, w.displaySource);
  if (mirror !== w.currentMirror || w.sign) {
    res.cookies.set(EXPERIENCE_MIRROR_COOKIE, mirror, {
      ...base,
      httpOnly: false,
      maxAge: w.display === "full" ? FULL_COOKIE_MAX_AGE : catalogMaxAge,
    });
  }

  if (w.notice) {
    res.cookies.set(NOTICE_COOKIE, "account_pending", {
      ...base,
      httpOnly: false,
      maxAge: NOTICE_COOKIE_MAX_AGE,
    });
  }
}

export function markNoindex<T extends NextResponse>(res: T): T {
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
