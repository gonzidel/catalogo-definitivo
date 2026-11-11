/**
 * Runner del piloto 40 artículos (Fase B).
 * No llama APIs hasta que existan product_ids live + Edge deployada.
 *
 * Uso (después de aprobar 409 + deploy search_profile_ai):
 *   npx tsx lib/search/pilot-run.ts --dry-run
 *   npx tsx lib/search/pilot-run.ts --provider=openai --ids=uuid1,uuid2
 */
import { PILOT_RUBRIC, PILOT_STRATA } from "./pilot-40";

export interface PilotCompareRow {
  articulo: string;
  stratum: string;
  openai?: Record<string, unknown>;
  claude?: Record<string, unknown>;
  notes?: string;
}

export function pilotPlanSummary(): string {
  const total = PILOT_STRATA.reduce((n, s) => n + s.count, 0);
  const lines = [
    `Piloto estratificado: ${total} artículos`,
    ...PILOT_STRATA.map((s) => `  - ${s.stratum}: ${s.count} (${s.pickHint})`),
    `Rúbrica: ${PILOT_RUBRIC.join(", ")}`,
    "Comparar a ciegas ambos providers; elegir con datos.",
    "No reescribe products.description.",
  ];
  return lines.join("\n");
}

export function emptyScorecard(): Record<(typeof PILOT_RUBRIC)[number], number | null> {
  return {
    precision_terminos: null,
    utilidad_revendedora: null,
    alucinacion_material: null,
    json_valido: null,
    costo_usd: null,
    latencia_ms: null,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const dry = process.argv.includes("--dry-run");
  console.log(pilotPlanSummary());
  if (dry) {
    console.log("\nDry-run OK — sin llamadas a IA.");
    process.exit(0);
  }
  console.log(
    "\nPara correr live: aprobar migración 409 + deploy search_profile_ai, luego pasar --provider y --ids."
  );
  process.exit(0);
}
