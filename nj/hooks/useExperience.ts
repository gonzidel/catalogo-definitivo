"use client";

import { useSyncExternalStore } from "react";
import type { Experience } from "@/lib/rollout/constants";
import { ROLLOUT_UI_ENABLED } from "@/lib/rollout/client";

export type ExperienceState = Experience | "unknown";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-exp"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): ExperienceState {
  return document.documentElement.getAttribute("data-exp") === "full" ? "full" : "catalog";
}

function getServerSnapshot(): ExperienceState {
  return ROLLOUT_UI_ENABLED ? "unknown" : "full";
}

/**
 * Experiencia pintada (html[data-exp]). Con rollout activo, en SSR y durante la
 * hidratación vale "unknown": los componentes deben renderizar ambas variantes con
 * EXP_FULL_ONLY / EXP_CATALOG_ONLY, o nada si tienen efectos (FullOnly).
 * Rollout apagado: siempre "full" (nj actual, sin cambios de SSR).
 */
export function useExperience(): ExperienceState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
