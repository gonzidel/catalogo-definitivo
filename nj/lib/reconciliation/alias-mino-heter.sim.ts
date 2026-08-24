/**
 * Simulación read-only MIÑO/HETER con aliases en memoria.
 * NO persiste. NO toca la rendición.
 * npx tsx nj/lib/reconciliation/alias-mino-heter.sim.ts
 */
import {
  buildIdentities,
  classifyRowFromCandidates,
  rankCandidatesForRow,
  scoreName,
  type TransportAliasHit,
} from "./matching";
import { normalizeCodAliasName } from "./name-normalize";

const TR = "50233ca9-94b9-41f2-a4f3-a30b7ed89c80";

const mino = {
  id: "634ab09a-4362-4f2e-a4e0-b3c9f59473a6",
  orderNumber: "A55090",
  customerId: "df912075-dcd9-4671-82e7-13a7847efdf8",
  customerDisplayName: "JESSICA MIÑO",
  customerNumber: null as string | null,
  labelCustomerName: "JESSICA MIÑO",
  expectedAmount: 268000,
  effectiveSentDate: "2026-07-17",
  sentDateOrigin: "sent_at" as const,
  effectiveTransportId: TR,
  transportName: "SEDE",
  identities: buildIdentities({
    labelCustomerName: "JESSICA MIÑO",
    titularFullName: "JESSICA MIÑO",
    additionalNames: null,
  }),
};

const heter = {
  id: "406014b9-eea5-43c7-84f9-f046a2bf52ac",
  orderNumber: "A55117",
  customerId: "0c34bdca-0ead-4588-b309-bb54ad95511e",
  customerDisplayName: "ROCIO HERTER",
  customerNumber: null as string | null,
  labelCustomerName: "ROCIO HERTER",
  expectedAmount: 97400,
  effectiveSentDate: "2026-07-17",
  sentDateOrigin: "sent_at" as const,
  effectiveTransportId: TR,
  transportName: "SEDE",
  identities: buildIdentities({
    labelCustomerName: "ROCIO HERTER",
    titularFullName: "ROCIO HERTER",
    additionalNames: null,
  }),
};

function sim(
  label: string,
  raw: string,
  amount: number,
  cand: typeof mino,
  customerId: string
) {
  const row = {
    id: "r",
    rowIndex: 0,
    rawCustomerNameText: raw,
    parsedTransportDate: "2026-07-17",
    parsedAmount: amount,
  };
  const alias: TransportAliasHit = {
    aliasId: `sim-${label}`,
    customerId,
    rawAlias: raw,
    normalizedAlias: normalizeCodAliasName(raw),
  };
  const ranked = rankCandidatesForRow(row, [cand], TR, "A", new Map());
  const without = classifyRowFromCandidates(row, ranked, false, null);
  const withAlias = classifyRowFromCandidates(row, ranked, false, alias);
  console.log(`\n${label}`);
  console.log("  namePts=", scoreName(raw, cand.identities).points);
  console.log("  sin alias →", without.rowStatus, without.autoMatchReason);
  console.log(
    "  con alias en memoria →",
    withAlias.rowStatus,
    withAlias.autoMatchReason,
    withAlias.orderNumberSnapshot
  );
  console.log("  metadata", {
    aliasId: withAlias.matchBreakdown.aliasId,
    aliasRaw: withAlias.matchBreakdown.aliasRaw,
    aliasCustomerId: withAlias.matchBreakdown.aliasCustomerId,
  });
}

sim("MIÑO", "MIÑO JESICA", 268000, mino, mino.customerId);
sim("HETER", "HETER ROCIO", 97400, heter, heter.customerId);
console.log("\nNorm:", {
  mino: normalizeCodAliasName("MIÑO JESICA"),
  heter: normalizeCodAliasName("HETER ROCIO"),
});
console.log("NO aliases persistidos. Rendición 1dcb352a… no mutada.\n");
