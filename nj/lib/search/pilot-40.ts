/**
 * Piloto estratificado de 40 artículos (Fase B).
 * Correr contra search_profile_ai con provider=openai y provider=claude.
 * Comparar a ciegas: precisión, utilidad, alucinaciones, JSON, costo, latencia.
 *
 * Los Articulo se rellenan al ejecutar el piloto con datos live del snapshot.
 * Esta lista define la mezcla; el script de corrida completa IDs.
 */
export type PilotStratum =
  | "pobre"
  | "duplicado"
  | "desc_larga"
  | "sin_desc"
  | "rico_control";

export interface PilotSlot {
  stratum: PilotStratum;
  count: number;
  pickHint: string;
}

export const PILOT_STRATA: PilotSlot[] = [
  { stratum: "pobre", count: 15, pickHint: "≤3 tokens únicos en desc+tags" },
  { stratum: "duplicado", count: 10, pickHint: "misma desc+F1+F2 que otro" },
  { stratum: "desc_larga", count: 5, pickHint: ">6 palabras en descripción" },
  { stratum: "sin_desc", count: 5, pickHint: "Descripcion vacía" },
  { stratum: "rico_control", count: 5, pickHint: "tags+desc completos" },
];

export const PILOT_RUBRIC = [
  "precision_terminos",
  "utilidad_revendedora",
  "alucinacion_material",
  "json_valido",
  "costo_usd",
  "latencia_ms",
] as const;
