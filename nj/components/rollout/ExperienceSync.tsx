"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { EXPERIENCE_MIRROR_COOKIE } from "@/lib/rollout/constants";
import { experienceFromMirror, readCookie } from "@/lib/rollout/client";

type Tagger = (...args: unknown[]) => void;

/**
 * Reaplica html[data-exp] tras navegaciones cliente (el middleware puede haber
 * cambiado la cookie espejo, p. ej. al activar kill) y etiqueta analytics.
 */
export default function ExperienceSync() {
  const pathname = usePathname();

  useEffect(() => {
    const { experience, source } = experienceFromMirror(readCookie(EXPERIENCE_MIRROR_COOKIE));
    const root = document.documentElement;
    if (root.getAttribute("data-exp") !== experience) root.setAttribute("data-exp", experience);

    const w = window as Window & { gtag?: Tagger; clarity?: Tagger };
    const rolloutSource = source ?? "none";
    try {
      w.gtag?.("set", "user_properties", { experience, rollout_source: rolloutSource });
      w.clarity?.("set", "experience", experience);
      w.clarity?.("set", "rollout_source", rolloutSource);
    } catch {
      // analytics nunca debe romper la navegación
    }
  }, [pathname]);

  return null;
}
