"use client";

import { useEffect } from "react";
import { captureFirstTouch } from "@/lib/analytics/attribution";

/** Guarda el primer toque (utm_*, fbclid) en cuanto carga cualquier página. */
export default function AttributionCapture() {
  useEffect(() => {
    captureFirstTouch();
  }, []);
  return null;
}
