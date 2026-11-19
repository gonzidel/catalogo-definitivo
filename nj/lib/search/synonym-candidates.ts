/**
 * Candidatos a alias (Fase D). Analytics / IA sugieren; el admin decide en /admin/search.
 * No se insertan solos.
 */
export interface SynonymCandidate {
  alias: string;
  destinationCanonical: string;
  kind: "plural" | "grammatical" | "abbreviation" | "commercial" | "typo" | "legacy_tag";
  source: "audit" | "ai" | "analytics";
  note: string;
}

export const INITIAL_SYNONYM_CANDIDATES: SynonymCandidate[] = [
  { alias: "chatas", destinationCanonical: "chatita", kind: "typo", source: "audit", note: "búsqueda frecuente sin resultados" },
  { alias: "falda", destinationCanonical: "pollera", kind: "commercial", source: "audit", note: "sinónimo comercial AR" },
  { alias: "faldas", destinationCanonical: "pollera", kind: "plural", source: "audit", note: "" },
  { alias: "leggings", destinationCanonical: "calza", kind: "commercial", source: "audit", note: "" },
  { alias: "legging", destinationCanonical: "calza", kind: "commercial", source: "audit", note: "" },
  { alias: "nene", destinationCanonical: "ninos", kind: "commercial", source: "audit", note: "requiere keyword ninos" },
  { alias: "nena", destinationCanonical: "ninos", kind: "commercial", source: "audit", note: "" },
  { alias: "chancleta", destinationCanonical: "ojota", kind: "commercial", source: "audit", note: "" },
  { alias: "chancletas", destinationCanonical: "ojota", kind: "plural", source: "audit", note: "" },
  { alias: "borceguies", destinationCanonical: "borcego", kind: "typo", source: "audit", note: "" },
  { alias: "texana", destinationCanonical: "texanas", kind: "grammatical", source: "audit", note: "keyword texanas si se crea" },
  { alias: "stiletto", destinationCanonical: "estileto", kind: "commercial", source: "audit", note: "" },
  { alias: "sandalia", destinationCanonical: "sandalia", kind: "commercial", source: "audit", note: "crear keyword sandalia" },
  { alias: "sandalias", destinationCanonical: "sandalia", kind: "plural", source: "audit", note: "" },
  { alias: "remera", destinationCanonical: "remera", kind: "commercial", source: "audit", note: "crear keyword remera" },
  { alias: "remeras", destinationCanonical: "remera", kind: "plural", source: "audit", note: "" },
  { alias: "bota", destinationCanonical: "bota", kind: "commercial", source: "audit", note: "crear keyword bota" },
  { alias: "botas", destinationCanonical: "bota", kind: "plural", source: "audit", note: "" },
];
