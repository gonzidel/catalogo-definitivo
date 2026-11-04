"use client";

import type { ReactNode } from "react";
import { useExperience } from "@/hooks/useExperience";

/**
 * Monta children solo en `full` y después de hidratar. Para piezas con efectos
 * (carrito, onboarding, notificaciones) que no deben correr en `catalog`.
 */
export default function FullOnly({ children }: { children: ReactNode }) {
  return useExperience() === "full" ? <>{children}</> : null;
}
